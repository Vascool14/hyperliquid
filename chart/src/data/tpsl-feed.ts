// share one tpslUpdates subscription across all active coins

import type { IDataStatus, TDataStatusReason, ITriggerOrderRecord } from "../types";
import { decodeTpslBookResponse } from "./decode-snapshots";
import { createStatus, patchStatus } from "./status";
import {
    InfoError,
    postInfo,
    type IClock,
    type IDeliveryInfo,
    type SocketTransport,
    type ITransportStatus
} from "./transport";
import { parseTpslMessage, TpslBook, TpslSync } from "./tpsl";
import { WireError } from "./wire";

export interface ITpslFeedOptions {
    infoUrl: string;
    transport: SocketTransport;
    clock: IClock;
    verifyMs: number;
    isVisible: () => boolean;
    onChange: (coins: Iterable<string>) => void;
}

const UNION_DELAY_MS = 60;
const TOO_OLD_RETRY_MS = 3000;
const MAX_BACKOFF_MS = 120_000;

export class TpslFeed {
    private readonly options: ITpslFeedOptions;
    private readonly refs = new Map<string, number>();
    private readonly statuses = new Map<string, IDataStatus>();
    private readonly book = new TpslBook();
    private readonly sync = new TpslSync(this.book);
    private union: string[] = [];
    private unsubscribe: (() => void) | null = null;
    private unionTimer: unknown = null;
    private snapshotTimer: unknown = null;
    private verifyTimer: unknown = null;
    private fetchController: AbortController | null = null;
    private retryAtMs = 0;
    private failures = 0;
    private generation = 0;
    private destroyed = false;

    constructor(options: ITpslFeedOptions) {
        this.options = options;
    }

    acquire(coin: string): void {
        this.refs.set(coin, (this.refs.get(coin) ?? 0) + 1);
        if (!this.statuses.has(coin)) {
            this.statuses.set(coin, createStatus("loading", "initial-load"));
        }
        this.scheduleUnion();
    }

    release(coin: string): void {
        const count = (this.refs.get(coin) ?? 0) - 1;
        if (count > 0) {
            this.refs.set(coin, count);
        } else {
            this.refs.delete(coin);
        }
        this.scheduleUnion();
    }

    orders(coin: string): ReadonlyMap<string, ITriggerOrderRecord> {
        return this.book.getOrders(coin);
    }

    version(coin: string): number {
        return this.book.version(coin);
    }

    height(coin: string): number | null {
        return this.book.appliedHeight(coin);
    }

    status(coin: string): IDataStatus {
        return this.statuses.get(coin) ?? createStatus();
    }

    onTransport(status: ITransportStatus): void {
        if (this.union.length === 0) {
            return;
        }
        if (status.state === "open" && status.generation !== this.generation) {
            const isReconnect = this.generation !== 0;
            this.generation = status.generation;
            if (isReconnect) {
                // a new connection cannot prove it saw every block, rebuild from a snapshot
                this.startSync("socket-closed");
            }
            return;
        }
        if (status.state === "closed") {
            // stop applying diffs after a disconnect until a fresh snapshot fills the gap
            this.sync.reset();
            this.fetchController?.abort();
            this.options.clock.clearTimeout(this.snapshotTimer);
            this.setAll({
                state: status.fatal ? "unavailable" : "reconnecting",
                reason: status.fatal ? "permission-denied" : "socket-closed",
                retryAtMs: status.retryAtMs,
                detail: status.detail
            });
        }
    }

    destroy(): void {
        this.destroyed = true;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.fetchController?.abort();
        for (const timer of [this.unionTimer, this.snapshotTimer, this.verifyTimer]) {
            this.options.clock.clearTimeout(timer);
        }
    }

    private scheduleUnion(): void {
        this.options.clock.clearTimeout(this.unionTimer);
        this.unionTimer = this.options.clock.setTimeout(() => {
            this.unionTimer = null;
            this.applyUnion();
        }, UNION_DELAY_MS);
    }

    private applyUnion(): void {
        if (this.destroyed) {
            return;
        }
        const desired = [...this.refs.keys()].sort();
        if (desired.join(",") === this.union.join(",")) {
            return;
        }

        for (const coin of this.union) {
            if (!this.refs.has(coin)) {
                this.book.drop(coin);
                this.statuses.delete(coin);
            }
        }

        // removing coins needs no resync, the old subscription still covers what remains
        // adding coins needs a subscription for the new union
        const shrinkOnly =
            this.unsubscribe !== null &&
            desired.length > 0 &&
            desired.every((coin) => this.union.includes(coin));
        this.union = desired;
        if (shrinkOnly) {
            return;
        }

        this.unsubscribe?.();
        this.unsubscribe = null;
        if (desired.length === 0) {
            this.fetchController?.abort();
            this.options.clock.clearTimeout(this.snapshotTimer);
            this.options.clock.clearTimeout(this.verifyTimer);
            this.sync.reset();
            return;
        }

        this.unsubscribe = this.options.transport.subscribe(
            { type: "tpslUpdates", coins: desired },
            (data, _message, delivery) => this.onFrame(data, delivery),
            (detail) => this.onRejected(detail)
        );
        this.generation = this.options.transport.getStatus().generation;
        this.startSync("initial-load");
    }

    private onFrame(data: unknown, delivery: IDeliveryInfo): void {
        if (delivery.seqGap) {
            this.startSync("sequence-gap");
        }
        const parsed = parseTpslMessage(data);
        if (!parsed.ok) {
            this.startSync(
                parsed.reason === "unknown-diff" ? "unknown-diff" : "malformed-payload",
                parsed.detail
            );
            return;
        }

        const result = this.sync.onBlock(parsed.block, new Set(this.union));
        if (result === "overflow") {
            this.startSync("buffer-overflow");
            this.sync.onBlock(parsed.block, new Set(this.union));
            return;
        }
        if (result.size > 0) {
            this.options.onChange(result);
        }
    }

    private onRejected(detail: string): void {
        this.setAll({
            state: "unavailable",
            reason: "permission-denied",
            detail
        });
    }

    // buffer blocks and schedule a snapshot, keep status live during routine verification
    private startSync(reason: TDataStatusReason | "verification", detail: string | null = null): void {
        this.sync.begin();
        this.fetchController?.abort();
        this.fetchController = null;

        const wait = Math.max(0, this.retryAtMs - this.options.clock.now());
        if (reason !== "verification") {
            for (const coin of this.union) {
                const hasData = this.book.has(coin);
                this.setStatus(coin, {
                    state: hasData ? "resyncing" : "loading",
                    reason: reason === "initial-load" ? "initial-load" : reason,
                    retryAtMs: wait > 0 ? this.retryAtMs : null,
                    detail
                });
            }
        }
        this.scheduleSnapshot(wait);
    }

    private scheduleSnapshot(delayMs: number): void {
        this.options.clock.clearTimeout(this.snapshotTimer);
        this.snapshotTimer = this.options.clock.setTimeout(() => {
            this.snapshotTimer = null;
            void this.fetchSnapshot();
        }, delayMs);
    }

    private async fetchSnapshot(): Promise<void> {
        const coins = [...this.union];
        if (coins.length === 0 || this.destroyed) {
            return;
        }
        const controller = new AbortController();
        this.fetchController = controller;

        try {
            const response = await postInfo(
                this.options.infoUrl,
                { type: "tpslBook", coins },
                AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)])
            );
            if (controller.signal.aborted || this.destroyed) {
                return;
            }
            const snapshot = decodeTpslBookResponse(response.bytes, coins);
            const changed = this.sync.completeSnapshot(snapshot, new Set(this.union));
            if (changed === "snapshot-too-old") {
                this.scheduleSnapshot(TOO_OLD_RETRY_MS);
                return;
            }

            this.failures = 0;
            const now = this.options.clock.now();
            for (const coin of changed) {
                this.setStatus(coin, {
                    state: "live",
                    reason: "ok",
                    sourceTimeMs: snapshot.timestampMs,
                    receivedAtMs: now,
                    retryAtMs: null,
                    version: String(snapshot.height),
                    detail:
                        snapshot.invalidOrders > 0
                            ? `${snapshot.invalidOrders} malformed orders excluded`
                            : null
                });
            }
            this.options.onChange(changed);
            this.scheduleVerify();
        } catch (error) {
            if (controller.signal.aborted || this.destroyed) {
                return;
            }
            this.onSnapshotError(error);
        } finally {
            if (this.fetchController === controller) {
                this.fetchController = null;
            }
        }
    }

    private onSnapshotError(error: unknown): void {
        const now = this.options.clock.now();

        if (error instanceof InfoError && error.code === "permission-denied") {
            this.setAll({
                state: "unavailable",
                reason: "permission-denied",
                retryAtMs: null,
                detail: error.message
            });
            return;
        }

        let reason: TDataStatusReason;
        let delay: number;
        if (error instanceof InfoError && error.code === "rate-limited") {
            reason = "rate-limited";
            delay = (error.retryAfterMs ?? 60_000) + Math.random() * 1000;
        } else {
            reason =
                error instanceof WireError
                    ? "malformed-payload"
                    : error instanceof InfoError && error.code === "network-error"
                      ? "network-error"
                      : "upstream-unavailable";
            delay = Math.min(MAX_BACKOFF_MS, 5000 * 2 ** this.failures);
            this.failures++;
        }

        this.retryAtMs = now + delay;
        for (const coin of this.union) {
            const hasData = this.book.has(coin);
            this.setStatus(coin, {
                state:
                    reason === "rate-limited" && !hasData
                        ? "waiting-for-quota"
                        : hasData
                          ? "resyncing"
                          : "error",
                reason,
                retryAtMs: this.retryAtMs,
                detail: error instanceof Error ? error.message : null
            });
        }
        this.scheduleSnapshot(delay);
    }

    private scheduleVerify(): void {
        this.options.clock.clearTimeout(this.verifyTimer);
        this.verifyTimer = this.options.clock.setTimeout(() => {
            this.verifyTimer = null;
            if (this.destroyed || this.union.length === 0) {
                return;
            }
            if (!this.options.isVisible() || this.sync.phase !== "synced") {
                this.scheduleVerify();
                return;
            }
            this.startSync("verification");
        }, this.options.verifyMs);
    }

    private setAll(patch: Partial<IDataStatus>): void {
        for (const coin of this.union) {
            this.setStatus(coin, patch);
        }
    }

    private setStatus(coin: string, patch: Partial<IDataStatus>): void {
        const current = this.statuses.get(coin) ?? createStatus();
        const next = patchStatus(current, patch);
        if (next !== current) {
            this.statuses.set(coin, next);
            this.options.onChange([coin]);
        }
    }
}
