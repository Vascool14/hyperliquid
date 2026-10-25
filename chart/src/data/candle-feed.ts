// share candles by coin and interval, subscribe before fetching history
// repair missed bars with overlapping REST history after reconnecting

import type { TCandleChange, TCandleInterval, ICandleBar, IDataStatus, TDataStatusReason } from "../types";
import { CandleStore, INTERVAL_MS } from "./candles";
import { createStatus, patchStatus } from "./status";
import {
    InfoError,
    postInfoJson,
    type IClock,
    type SocketTransport,
    type ITransportStatus
} from "./transport";
import { normalizeCandle } from "./wire";

interface ICandleEntry {
    coin: string;
    interval: TCandleInterval;
    refs: number;
    store: CandleStore;
    status: IDataStatus;
    listeners: Set<(change: TCandleChange) => void>;
    unsubscribe: () => void;
    controller: AbortController | null;
    retryTimer: unknown;
    failures: number;
    // live candle times received while the REST request is in flight
    liveSinceRequest: Set<number>;
    generation: number;
}

export interface ICandleFeedOptions {
    infoUrl: string;
    transport: SocketTransport;
    clock: IClock;
    historyBars: number;
}

const OVERLAP_BARS = 3;
const MAX_BACKOFF_MS = 60_000;

export class CandleFeed {
    private readonly options: ICandleFeedOptions;
    private readonly entries = new Map<string, ICandleEntry>();

    constructor(options: ICandleFeedOptions) {
        this.options = options;
    }

    acquire(coin: string, interval: TCandleInterval): ICandleEntry {
        const key = `${coin}:${interval}`;
        const existing = this.entries.get(key);
        if (existing) {
            existing.refs++;
            return existing;
        }

        const entry: ICandleEntry = {
            coin,
            interval,
            refs: 1,
            store: new CandleStore(Math.max(this.options.historyBars * 2, 500)),
            status: createStatus("loading", "initial-load"),
            listeners: new Set(),
            unsubscribe: () => {},
            controller: null,
            retryTimer: null,
            failures: 0,
            liveSinceRequest: new Set(),
            generation: this.options.transport.getStatus().generation
        };
        this.entries.set(key, entry);

        entry.unsubscribe = this.options.transport.subscribe(
            { type: "candle", coin, interval },
            (data) => this.onLive(entry, data),
            (detail) =>
                this.setStatus(entry, {
                    state: "unavailable",
                    reason: "permission-denied",
                    detail
                })
        );
        void this.loadHistory(entry, null);
        return entry;
    }

    release(entry: ICandleEntry): void {
        entry.refs--;
        if (entry.refs > 0) {
            return;
        }
        entry.unsubscribe();
        entry.controller?.abort();
        this.options.clock.clearTimeout(entry.retryTimer);
        entry.listeners.clear();
        this.entries.delete(`${entry.coin}:${entry.interval}`);
    }

    onTransport(status: ITransportStatus): void {
        for (const entry of this.entries.values()) {
            if (status.state === "closed") {
                this.setStatus(entry, {
                    state: status.fatal ? "unavailable" : "reconnecting",
                    reason: status.fatal ? "permission-denied" : "socket-closed",
                    retryAtMs: status.retryAtMs,
                    detail: status.detail
                });
                continue;
            }
            if (status.state === "open" && status.generation !== entry.generation) {
                const isReconnect = entry.generation !== 0;
                entry.generation = status.generation;
                if (isReconnect) {
                    this.setStatus(entry, {
                        state: "resyncing",
                        reason: "socket-closed",
                        retryAtMs: null
                    });
                    const last = entry.store.last();
                    void this.loadHistory(entry, last?.timeMs ?? null);
                }
            }
        }
    }

    destroy(): void {
        for (const entry of this.entries.values()) {
            entry.refs = 1;
            this.release(entry);
        }
    }

    private onLive(entry: ICandleEntry, data: unknown): void {
        const bar = normalizeCandle(data, entry.coin, entry.interval);
        if (!bar) {
            return;
        }
        if (entry.controller) {
            entry.liveSinceRequest.add(bar.timeMs);
        }
        const change = entry.store.applyLive(bar);
        if (entry.status.state === "live") {
            this.notify(entry, change);
        } else if (entry.store.toArray().length > 0 && !entry.controller) {
            this.setStatus(entry, { state: "live", reason: "ok" });
            this.notify(entry, "reset");
        }
        this.touch(entry, bar);
    }

    // no sinceMs means recent history, otherwise overlap the last known bar to repair gaps
    private async loadHistory(entry: ICandleEntry, sinceMs: number | null): Promise<void> {
        entry.controller?.abort();
        const controller = new AbortController();
        entry.controller = controller;
        entry.liveSinceRequest = new Set();

        const intervalMs = INTERVAL_MS[entry.interval];
        const endTime = this.options.clock.now() + intervalMs;
        const maxSpan = intervalMs * this.options.historyBars;
        const startTime =
            sinceMs === null
                ? endTime - maxSpan
                : Math.max(endTime - maxSpan, sinceMs - OVERLAP_BARS * intervalMs);

        try {
            const body = await postInfoJson(
                this.options.infoUrl,
                {
                    type: "candleSnapshot",
                    req: {
                        coin: entry.coin,
                        interval: entry.interval,
                        startTime,
                        endTime
                    }
                },
                AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
            );
            if (controller.signal.aborted) {
                return;
            }
            if (!Array.isArray(body)) {
                throw new InfoError("upstream-unavailable", "Expected a list.");
            }

            const bars: ICandleBar[] = [];
            for (const value of body) {
                const bar = normalizeCandle(value, entry.coin, entry.interval);
                // keep live replacements when they are newer than the REST copy
                if (bar && !entry.liveSinceRequest.has(bar.timeMs)) {
                    bars.push(bar);
                }
            }
            entry.store.mergeHistory(bars);
            entry.failures = 0;
            entry.controller = null;

            const last = entry.store.last();
            this.setStatus(entry, {
                state: "live",
                reason: entry.store.toArray().length > 0 ? "ok" : "no-market-data",
                retryAtMs: null,
                detail: null,
                sourceTimeMs: last?.timeMs ?? null,
                receivedAtMs: this.options.clock.now()
            });
            this.notify(entry, "reset");
        } catch (error) {
            if (controller.signal.aborted) {
                return;
            }
            entry.controller = null;
            this.onHistoryError(entry, error, sinceMs);
        }
    }

    private onHistoryError(entry: ICandleEntry, error: unknown, sinceMs: number | null) {
        const rateLimited = error instanceof InfoError && error.code === "rate-limited";
        const denied = error instanceof InfoError && error.code === "permission-denied";
        const delay = rateLimited
            ? ((error as InfoError).retryAfterMs ?? 60_000)
            : Math.min(MAX_BACKOFF_MS, 2000 * 2 ** entry.failures);
        entry.failures++;

        const reason: TDataStatusReason = denied
            ? "permission-denied"
            : rateLimited
              ? "rate-limited"
              : error instanceof InfoError && error.code === "network-error"
                ? "network-error"
                : "upstream-unavailable";
        const hasBars = entry.store.toArray().length > 0;

        this.setStatus(entry, {
            state: denied ? "unavailable" : rateLimited ? "waiting-for-quota" : hasBars ? "stale" : "error",
            reason,
            retryAtMs: denied ? null : this.options.clock.now() + delay,
            detail: error instanceof Error ? error.message : null
        });
        if (denied) {
            return;
        }
        entry.retryTimer = this.options.clock.setTimeout(() => {
            entry.retryTimer = null;
            if (entry.refs > 0) {
                void this.loadHistory(entry, sinceMs);
            }
        }, delay);
    }

    private touch(entry: ICandleEntry, bar: ICandleBar): void {
        // transport status handles freshness, keep source time without notifying on every tick
        entry.status = { ...entry.status, sourceTimeMs: bar.timeMs };
    }

    private notify(entry: ICandleEntry, change: TCandleChange): void {
        for (const listener of entry.listeners) {
            listener(change);
        }
    }

    private setStatus(entry: ICandleEntry, patch: Partial<IDataStatus>): void {
        const next = patchStatus(entry.status, patch);
        if (next !== entry.status) {
            entry.status = next;
            this.notify(entry, "status");
        }
    }
}

export type { ICandleEntry };
