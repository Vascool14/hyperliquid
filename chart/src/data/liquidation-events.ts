// executed fills stay separate from estimated exposure
// share one liquidationFills subscription, merge REST history and dedupe by trade ID

import type { IDataStatus, ILiquidationEventRecord } from "../types";
import { createStatus, patchStatus } from "./status";
import {
    InfoError,
    postInfoJson,
    type IClock,
    type SocketTransport,
    type ITransportStatus
} from "./transport";
import { parseAddress, parseDecimal, parseTimestampMs, parseUintId } from "./wire";

export const DEFAULT_HISTORY_WINDOW_MS = 3 * 24 * 3_600_000;
// the gateway allows up to 7 days per request
export const MAX_HISTORY_WINDOW_MS = 7 * 24 * 3_600_000;
const MIN_HISTORY_WINDOW_MS = 3_600_000;
// history arrives newest first, each page reaches further back
const HISTORY_LIMIT = 1000;
const MAX_HISTORY_PAGES = 20;
const MAX_EVENTS_PER_COIN = 20_000;

interface ICoinEventStore {
    refs: number;
    byId: Map<string, ILiquidationEventRecord>;
    sorted: ILiquidationEventRecord[] | null;
    status: IDataStatus;
    controller: AbortController | null;
    retryTimer: unknown;
    version: number;
}

export interface ILiquidationEventsOptions {
    infoUrl: string;
    transport: SocketTransport;
    clock: IClock;
    historyWindowMs: number;
    onChange: (coin: string) => void;
}

// only count the liquidated owner, ignore the counterparty fill
// A is a forced sell from a long, B is a forced buy from a short
export function normalizeLiquidationFill(value: unknown, owner: unknown): ILiquidationEventRecord | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const fill = value as Record<string, unknown>;
    const details = fill.liquidation as Record<string, unknown> | undefined;
    const user = parseAddress(owner ?? fill.user);
    const liquidated = parseAddress(details?.liquidatedUser);
    const id = parseUintId(fill.tid);
    const px = parseDecimal(fill.px);
    const sz = parseDecimal(fill.sz);
    const timeMs = parseTimestampMs(fill.time);

    if (
        !details ||
        user === null ||
        user !== liquidated ||
        id === null ||
        typeof fill.coin !== "string" ||
        px === null ||
        px <= 0 ||
        sz === null ||
        sz <= 0 ||
        timeMs === null ||
        (fill.side !== "A" && fill.side !== "B")
    ) {
        return null;
    }

    return {
        id,
        coin: fill.coin,
        user,
        side: fill.side === "A" ? "long" : "short",
        timeMs,
        px,
        size: sz,
        notional: px * sz,
        markPx: parseDecimal(details.markPx),
        method: typeof details.method === "string" ? details.method : ""
    };
}

export class LiquidationEventsFeed {
    private readonly options: ILiquidationEventsOptions;
    private readonly coins = new Map<string, ICoinEventStore>();
    private unsubscribe: (() => void) | null = null;
    private generation = 0;
    private historyWindowMs: number;

    constructor(options: ILiquidationEventsOptions) {
        this.options = options;
        this.historyWindowMs = clampWindow(options.historyWindowMs);
    }

    // load missing history when the window grows, drop old events when it shrinks
    setHistoryWindow(windowMs: number): void {
        const next = clampWindow(windowMs);
        if (next === this.historyWindowMs) {
            return;
        }
        const grew = next > this.historyWindowMs;
        this.historyWindowMs = next;
        const cutoff = this.options.clock.now() - next;
        for (const [coin, entry] of this.coins) {
            let removed = false;
            for (const [id, event] of entry.byId) {
                if (event.timeMs < cutoff) {
                    entry.byId.delete(id);
                    removed = true;
                }
            }
            if (removed) {
                entry.sorted = null;
                entry.version++;
                this.options.onChange(coin);
            }
            if (grew) {
                void this.loadHistory(coin, entry, null);
            }
        }
    }

    acquire(coin: string): void {
        let entry = this.coins.get(coin);
        if (!entry) {
            entry = {
                refs: 0,
                byId: new Map(),
                sorted: null,
                status: createStatus("loading", "initial-load"),
                controller: null,
                retryTimer: null,
                version: 0
            };
            this.coins.set(coin, entry);
        }
        entry.refs++;
        if (entry.refs === 1) {
            void this.loadHistory(coin, entry, null);
        }
        this.ensureSubscribed();
    }

    release(coin: string): void {
        const entry = this.coins.get(coin);
        if (!entry) {
            return;
        }
        entry.refs--;
        if (entry.refs <= 0) {
            entry.controller?.abort();
            this.options.clock.clearTimeout(entry.retryTimer);
            this.coins.delete(coin);
        }
        if (this.coins.size === 0) {
            this.unsubscribe?.();
            this.unsubscribe = null;
        }
    }

    events(coin: string): readonly ILiquidationEventRecord[] {
        const entry = this.coins.get(coin);
        if (!entry) {
            return [];
        }
        entry.sorted ??= [...entry.byId.values()].sort((a, b) => a.timeMs - b.timeMs);
        return entry.sorted;
    }

    version(coin: string): number {
        return this.coins.get(coin)?.version ?? 0;
    }

    status(coin: string): IDataStatus {
        return this.coins.get(coin)?.status ?? createStatus();
    }

    // repair reconnect gaps from REST history, the stream does not replay them
    onTransport(status: ITransportStatus): void {
        if (status.state === "closed") {
            for (const [coin, entry] of this.coins) {
                this.setStatus(coin, entry, {
                    state: status.fatal ? "unavailable" : "reconnecting",
                    reason: status.fatal ? "permission-denied" : "socket-closed",
                    retryAtMs: status.retryAtMs
                });
            }
            return;
        }
        if (status.state === "open" && status.generation !== this.generation) {
            const isReconnect = this.generation !== 0;
            this.generation = status.generation;
            if (!isReconnect) {
                return;
            }
            for (const [coin, entry] of this.coins) {
                const last = this.events(coin).at(-1);
                void this.loadHistory(coin, entry, last?.timeMs ?? null);
            }
        }
    }

    destroy(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        for (const entry of this.coins.values()) {
            entry.controller?.abort();
            this.options.clock.clearTimeout(entry.retryTimer);
        }
        this.coins.clear();
    }

    private ensureSubscribed(): void {
        if (this.unsubscribe) {
            return;
        }
        this.generation = this.options.transport.getStatus().generation;
        this.unsubscribe = this.options.transport.subscribe(
            { type: "liquidationFills" },
            (_data, message) => this.onFills(message.fills),
            (detail) => {
                for (const [coin, entry] of this.coins) {
                    this.setStatus(coin, entry, {
                        state: "unavailable",
                        reason: "permission-denied",
                        detail
                    });
                }
            }
        );
    }

    private onFills(fills: unknown): void {
        if (!Array.isArray(fills)) {
            return;
        }
        const changed = new Set<string>();
        for (const pair of fills) {
            if (!Array.isArray(pair) || pair.length !== 2) {
                continue;
            }
            const event = normalizeLiquidationFill(pair[1], pair[0]);
            const entry = event ? this.coins.get(event.coin) : undefined;
            if (event && entry && this.add(entry, event)) {
                changed.add(event.coin);
            }
        }
        for (const coin of changed) {
            this.options.onChange(coin);
        }
    }

    private add(entry: ICoinEventStore, event: ILiquidationEventRecord): boolean {
        if (entry.byId.has(event.id)) {
            return false;
        }
        entry.byId.set(event.id, event);
        entry.sorted = null;
        entry.version++;
        if (entry.byId.size > MAX_EVENTS_PER_COIN) {
            const oldest = this.oldestIds(entry, entry.byId.size - MAX_EVENTS_PER_COIN);
            for (const id of oldest) {
                entry.byId.delete(id);
            }
        }
        return true;
    }

    private oldestIds(entry: ICoinEventStore, count: number): string[] {
        return [...entry.byId.values()]
            .sort((a, b) => a.timeMs - b.timeMs)
            .slice(0, count)
            .map((event) => event.id);
    }

    private async loadHistory(coin: string, entry: ICoinEventStore, sinceMs: number | null): Promise<void> {
        entry.controller?.abort();
        const controller = new AbortController();
        entry.controller = controller;
        const endTime = this.options.clock.now();
        const startTime = Math.max(endTime - this.historyWindowMs, sinceMs === null ? 0 : sinceMs - 60_000);

        try {
            let pageEnd = endTime;
            let saturated = false;
            for (let page = 1; ; page++) {
                const rows = await this.fetchHistoryPage(coin, startTime, pageEnd, controller.signal);
                if (controller.signal.aborted) {
                    return;
                }
                const oldest = this.addHistoryRows(coin, entry, rows);
                if (rows.length < HISTORY_LIMIT || oldest === null) {
                    break;
                }
                // refetch and dedupe boundary timestamps, step past a page if every row has the same timestamp
                const nextEnd = oldest < pageEnd ? oldest : pageEnd - 1;
                if (nextEnd <= startTime) {
                    break;
                }
                if (page >= MAX_HISTORY_PAGES) {
                    saturated = true;
                    break;
                }
                pageEnd = nextEnd;
                this.options.onChange(coin);
            }
            entry.controller = null;
            // flag partial history when the page cap leaves older events unloaded
            this.setStatus(coin, entry, {
                state: "live",
                reason: "ok",
                retryAtMs: null,
                sourceTimeMs: this.events(coin).at(-1)?.timeMs ?? null,
                receivedAtMs: this.options.clock.now(),
                detail: saturated
                    ? `History limited to the newest ${MAX_HISTORY_PAGES * HISTORY_LIMIT} fills.`
                    : null
            });
            this.options.onChange(coin);
        } catch (error) {
            if (controller.signal.aborted) {
                return;
            }
            entry.controller = null;
            const rateLimited = error instanceof InfoError && error.code === "rate-limited";
            const delay = rateLimited ? ((error as InfoError).retryAfterMs ?? 60_000) : 30_000;
            this.setStatus(coin, entry, {
                state: "error",
                reason: rateLimited ? "rate-limited" : "upstream-unavailable",
                retryAtMs: this.options.clock.now() + delay,
                detail: error instanceof Error ? error.message : null
            });
            entry.retryTimer = this.options.clock.setTimeout(() => {
                if (this.coins.get(coin) === entry) {
                    void this.loadHistory(coin, entry, sinceMs);
                }
            }, delay);
        }
    }

    private async fetchHistoryPage(
        coin: string,
        startTime: number,
        endTime: number,
        signal: AbortSignal
    ): Promise<unknown[]> {
        const rows = await postInfoJson(
            this.options.infoUrl,
            {
                type: "liquidationHistoryByTime",
                coin,
                startTime,
                endTime,
                limit: HISTORY_LIMIT
            },
            AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        );
        if (!Array.isArray(rows)) {
            throw new InfoError("upstream-unavailable", "Expected a list.");
        }
        return rows;
    }

    // use the oldest row including counterparties as the next page boundary
    private addHistoryRows(coin: string, entry: ICoinEventStore, rows: unknown[]): number | null {
        let oldest: number | null = null;
        for (const row of rows) {
            const time = parseTimestampMs((row as Record<string, unknown> | null)?.time);
            if (time !== null && (oldest === null || time < oldest)) {
                oldest = time;
            }
            const event = normalizeLiquidationFill(row, null);
            if (event && event.coin === coin) {
                this.add(entry, event);
            }
        }
        return oldest;
    }

    private setStatus(coin: string, entry: ICoinEventStore, patch: Partial<IDataStatus>): void {
        const next = patchStatus(entry.status, patch);
        if (next !== entry.status) {
            entry.status = next;
            this.options.onChange(coin);
        }
    }
}

function clampWindow(windowMs: number): number {
    return Math.min(MAX_HISTORY_WINDOW_MS, Math.max(MIN_HISTORY_WINDOW_MS, windowMs));
}
