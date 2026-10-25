// buffer live blocks, replace the book from a snapshot at H, then replay blocks above H
// apply each block atomically, duplicate adds and removes are safe

import type { ITriggerOrderRecord } from "../types";
import { normalizeTriggerOrder, parseTimestampMs, parseUintId } from "./wire";
import type { IDecodedTpslBook } from "./decode-snapshots";

export type TTpslDiff =
    | { type: "add"; order: ITriggerOrderRecord }
    | { type: "remove"; id: string; coin: string; reason: string };

export interface ITpslBlock {
    height: number;
    timestampMs: number;
    diffs: TTpslDiff[];
}

export type TParsedTpslMessage =
    { ok: true; block: ITpslBlock } | { ok: false; reason: "malformed" | "unknown-diff"; detail: string };

export function parseTpslMessage(data: unknown): TParsedTpslMessage {
    if (typeof data !== "object" || data === null) {
        return malformed("TP/SL frame data must be an object.");
    }
    const frame = data as Record<string, unknown>;
    const height = parseTimestampMs(frame.height);
    const timestampMs = parseTimestampMs(frame.timestamp);
    if (height === null || timestampMs === null || !Array.isArray(frame.diffs)) {
        return malformed("TP/SL frame needs height, timestamp and diffs.");
    }

    const diffs: TTpslDiff[] = [];
    for (const value of frame.diffs) {
        if (typeof value !== "object" || value === null) {
            return malformed("TP/SL diff must be an object.");
        }
        const diff = value as Record<string, unknown>;

        if (diff.type === "add") {
            const order = normalizeTriggerOrder({
                oid: diff.oid,
                coin: diff.coin,
                user: diff.user,
                side: diff.side,
                triggerPx: diff.triggerPx,
                limitPx: diff.limitPx,
                sz: diff.sz,
                triggerCondition: diff.triggerCondition,
                orderType: diff.orderType,
                isPositionTpsl: diff.isPositionTpsl,
                reduceOnly: diff.reduceOnly,
                timestamp: diff.timestamp
            });
            if (order === null) {
                return malformed("Invalid TP/SL add diff.");
            }
            diffs.push({ type: "add", order });
            continue;
        }

        if (diff.type === "remove") {
            const id = parseUintId(diff.oid);
            if (id === null || typeof diff.coin !== "string") {
                return malformed("Invalid TP/SL remove diff.");
            }
            diffs.push({
                type: "remove",
                id,
                coin: diff.coin,
                reason: typeof diff.reason === "string" ? diff.reason : ""
            });
            continue;
        }

        // resync on unknown operations rather than silently leaving the book wrong
        return {
            ok: false,
            reason: "unknown-diff",
            detail: `Unknown TP/SL diff type ${String(diff.type)}.`
        };
    }

    return { ok: true, block: { height, timestampMs, diffs } };
}

function malformed(detail: string): TParsedTpslMessage {
    return { ok: false, reason: "malformed", detail };
}

export class TpslBook {
    private readonly orders = new Map<string, Map<string, ITriggerOrderRecord>>();
    private readonly applied = new Map<string, number>();
    private readonly sourceTime = new Map<string, number>();
    private readonly versions = new Map<string, number>();

    // bump this when the orders for a coin change
    version(coin: string): number {
        return this.versions.get(coin) ?? 0;
    }

    private bump(coin: string): void {
        this.versions.set(coin, this.version(coin) + 1);
    }

    getOrders(coin: string): ReadonlyMap<string, ITriggerOrderRecord> {
        return this.orders.get(coin) ?? EMPTY;
    }

    appliedHeight(coin: string): number | null {
        return this.applied.get(coin) ?? null;
    }

    sourceTimeMs(coin: string): number | null {
        return this.sourceTime.get(coin) ?? null;
    }

    has(coin: string): boolean {
        return this.applied.has(coin);
    }

    replace(coin: string, orders: readonly ITriggerOrderRecord[], height: number, timestampMs: number): void {
        const map = new Map<string, ITriggerOrderRecord>();
        for (const order of orders) {
            map.set(order.id, order);
        }
        this.orders.set(coin, map);
        this.applied.set(coin, height);
        this.sourceTime.set(coin, timestampMs);
        this.bump(coin);
    }

    drop(coin: string): void {
        this.orders.delete(coin);
        this.applied.delete(coin);
        this.sourceTime.delete(coin);
        this.bump(coin);
    }

    // apply the block to synced coins behind its height and return the coins that changed
    applyBlock(block: ITpslBlock, coins: ReadonlySet<string>): Set<string> {
        const changed = new Set<string>();
        const advanced = new Set<string>();

        for (const coin of coins) {
            const applied = this.applied.get(coin);
            if (applied === undefined || block.height <= applied) {
                continue;
            }
            this.applied.set(coin, block.height);
            this.sourceTime.set(coin, block.timestampMs);
            advanced.add(coin);
        }

        for (const diff of block.diffs) {
            const coin = diff.type === "add" ? diff.order.coin : diff.coin;
            const map = this.orders.get(coin);
            if (!map || !advanced.has(coin)) {
                continue;
            }
            if (diff.type === "add") {
                map.set(diff.order.id, diff.order);
                changed.add(coin);
            } else if (map.delete(diff.id)) {
                changed.add(coin);
            }
        }
        for (const coin of changed) {
            this.bump(coin);
        }
        return changed;
    }
}

const EMPTY: ReadonlyMap<string, ITriggerOrderRecord> = new Map();

export type TSyncPhase = "unsynced" | "buffering" | "synced";

export const MAX_BUFFERED_BLOCKS = 4000;

// buffer while fetching a snapshot, start over if the buffer overflows
export class TpslSync {
    phase: TSyncPhase = "unsynced";
    private buffer: ITpslBlock[] = [];
    private readonly book: TpslBook;
    private readonly maxBuffered: number;

    constructor(book: TpslBook, maxBuffered: number = MAX_BUFFERED_BLOCKS) {
        this.book = book;
        this.maxBuffered = maxBuffered;
    }

    begin(): void {
        this.phase = "buffering";
        this.buffer = [];
    }

    reset(): void {
        this.phase = "unsynced";
        this.buffer = [];
    }

    // return changed coins or overflow when sync needs to restart
    onBlock(block: ITpslBlock, coins: ReadonlySet<string>): Set<string> | "overflow" {
        if (this.phase === "buffering") {
            if (this.buffer.length >= this.maxBuffered) {
                this.reset();
                return "overflow";
            }
            this.buffer.push(block);
            // keep applying live blocks to coins that are only being verified
            return this.book.applyBlock(block, coins);
        }
        if (this.phase === "synced") {
            return this.book.applyBlock(block, coins);
        }
        return new Set();
    }

    // replace only the snapshot coins and replay blocks above H
    // reject snapshots older than the buffer, the missing blocks cannot be recovered
    completeSnapshot(
        snapshot: IDecodedTpslBook,
        coins: ReadonlySet<string>
    ): Set<string> | "snapshot-too-old" {
        const first = this.buffer[0];
        if (first && snapshot.height + 1 < first.height) {
            return "snapshot-too-old";
        }

        const changed = new Set<string>();
        for (const [coin, orders] of snapshot.markets) {
            if (!coins.has(coin)) {
                continue;
            }
            this.book.replace(coin, orders, snapshot.height, snapshot.timestampMs);
            changed.add(coin);
        }
        const replayCoins = new Set([...changed].filter((coin) => coins.has(coin)));
        for (const block of this.buffer) {
            if (block.height > snapshot.height) {
                this.book.applyBlock(block, replayCoins);
            }
        }
        this.buffer = [];
        this.phase = "synced";
        return changed;
    }
}
