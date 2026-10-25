// poll cheap metadata and fetch new snapshots in batches through the shared gateway quota
// only replace the current snapshot after the whole response decodes and validates

import type { IDataStatus, TDataStatusReason, IPositionsSnapshot } from "../types";
import { decodePositionsResponse } from "./decode-snapshots";
import { createStatus, isNewerSnapshotId, patchStatus, POSITIONS_STALE_MS } from "./status";
import { InfoError, postInfo, postInfoJson, type IClock } from "./transport";
import { parseTimestampMs, WireError } from "./wire";

interface IPositionsCoinEntry {
    refs: number;
    committed: IPositionsSnapshot | null;
    receivedAtMs: number | null;
    retryAtMs: number;
    lastError: { reason: TDataStatusReason; detail: string | null } | null;
    status: IDataStatus;
}

export interface IPositionsFeedOptions {
    infoUrl: string;
    pollMs: number;
    clock: IClock;
    isVisible: () => boolean;
    onChange: (coin: string) => void;
}

const BATCH_DELAY_MS = 60;
const MAX_BACKOFF_MS = 120_000;

export class PositionsFeed {
    private readonly options: IPositionsFeedOptions;
    private readonly coins = new Map<string, IPositionsCoinEntry>();
    private available: { id: string; timeMs: number } | null = null;
    private pollTimer: unknown = null;
    private polling = false;
    private fetchTimer: unknown = null;
    private inFlight: AbortController | null = null;
    private failures = 0;
    private destroyed = false;

    constructor(options: IPositionsFeedOptions) {
        this.options = options;
    }

    acquire(coin: string): void {
        let entry = this.coins.get(coin);
        if (!entry) {
            entry = {
                refs: 0,
                committed: null,
                receivedAtMs: null,
                retryAtMs: 0,
                lastError: null,
                status: createStatus("loading", "initial-load")
            };
            this.coins.set(coin, entry);
        }
        entry.refs++;
        this.ensurePolling();
        this.scheduleFetch(BATCH_DELAY_MS);
    }

    // cache the last good snapshot so a quick remount does not spend quota again
    release(coin: string): void {
        const entry = this.coins.get(coin);
        if (entry && entry.refs > 0) {
            entry.refs--;
        }
        if (this.activeCoins().length === 0) {
            this.stopPolling();
        }
    }

    snapshot(coin: string): IPositionsSnapshot | null {
        return this.coins.get(coin)?.committed ?? null;
    }

    status(coin: string): IDataStatus {
        return this.coins.get(coin)?.status ?? createStatus();
    }

    // refresh when the page becomes visible again
    wake(): void {
        this.stopPolling();
        this.ensurePolling();
    }

    destroy(): void {
        this.destroyed = true;
        this.stopPolling();
        this.options.clock.clearTimeout(this.fetchTimer);
        this.inFlight?.abort();
    }

    private activeCoins(): string[] {
        return [...this.coins].filter(([, entry]) => entry.refs > 0).map(([coin]) => coin);
    }

    private ensurePolling(): void {
        if (this.polling || this.destroyed || this.activeCoins().length === 0) {
            return;
        }
        this.polling = true;
        void this.poll();
    }

    private stopPolling(): void {
        this.polling = false;
        this.options.clock.clearTimeout(this.pollTimer);
        this.pollTimer = null;
    }

    private async poll(): Promise<void> {
        if (!this.polling) {
            return;
        }
        if (this.options.isVisible()) {
            await this.pollMetadata();
        }
        if (!this.polling || this.destroyed) {
            return;
        }
        this.pollTimer = this.options.clock.setTimeout(() => void this.poll(), this.options.pollMs);
    }

    private async pollMetadata(): Promise<void> {
        try {
            const body = await postInfoJson(
                this.options.infoUrl,
                { type: "perpSnapshotTimestamp" },
                AbortSignal.timeout(15_000)
            );
            const meta = body as Record<string, unknown>;
            const seconds = parseTimestampMs(meta.timestamp);
            if (typeof meta.snapshot_id === "string" && seconds !== null) {
                // metadata timestamps are in seconds
                this.available = {
                    id: meta.snapshot_id,
                    timeMs: seconds * 1000
                };
            }
        } catch {
            // a failed poll must not make the cached data look newer
        }
        if (this.destroyed) {
            return;
        }
        for (const coin of this.activeCoins()) {
            this.attachSourceTime(this.coins.get(coin)!);
            this.update(coin);
        }
        this.scheduleFetch(0);
    }

    // fill in the snapshot time only when metadata confirms the same ID
    private attachSourceTime(entry: IPositionsCoinEntry): void {
        const committed = entry.committed;
        if (committed && committed.sourceTimeMs === null && this.available?.id === committed.snapshotId) {
            entry.committed = {
                ...committed,
                sourceTimeMs: this.available.timeMs
            };
        }
    }

    private needsFetch(entry: IPositionsCoinEntry): boolean {
        if (!entry.committed) {
            return true;
        }
        return this.available !== null && isNewerSnapshotId(this.available.id, entry.committed.snapshotId);
    }

    private scheduleFetch(delayMs: number): void {
        if (this.destroyed || this.inFlight) {
            return;
        }
        this.options.clock.clearTimeout(this.fetchTimer);
        this.fetchTimer = this.options.clock.setTimeout(() => {
            this.fetchTimer = null;
            void this.fetchSnapshots();
        }, delayMs);
    }

    private async fetchSnapshots(): Promise<void> {
        const now = this.options.clock.now();
        const coins = this.activeCoins()
            .filter((coin) => {
                const entry = this.coins.get(coin)!;
                return this.needsFetch(entry) && entry.retryAtMs <= now;
            })
            .sort();
        if (coins.length === 0 || this.inFlight) {
            return;
        }

        const controller = new AbortController();
        this.inFlight = controller;
        try {
            const response = await postInfo(
                this.options.infoUrl,
                { type: "perpSnapshots", market_names: coins },
                AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)])
            );
            if (!this.destroyed) {
                this.accept(coins, response.bytes, response.headers);
            }
        } catch (error) {
            if (!this.destroyed) {
                this.reject(coins, error);
            }
        } finally {
            this.inFlight = null;
        }
        this.scheduleNextRetry();
    }

    private accept(coins: string[], bytes: Uint8Array, headers: Headers) {
        const now = this.options.clock.now();
        let results;
        try {
            results = decodePositionsResponse(bytes, headers.get("x-payload-format"), coins);
        } catch (error) {
            this.reject(coins, error);
            return;
        }
        this.failures = 0;

        const nextFetchMs = Number(headers.get("x-gateway-next-fetch-ms"));
        for (const coin of coins) {
            const entry = this.coins.get(coin)!;
            const result = results.get(coin);

            if (!result || !result.ok) {
                entry.retryAtMs = now + 60_000;
                entry.lastError = {
                    reason: "malformed-payload",
                    detail: result ? result.error.message : "Market missing."
                };
                this.update(coin);
                continue;
            }

            const market = result.market;
            if (isNewerSnapshotId(market.snapshotId, entry.committed?.snapshotId ?? null)) {
                entry.committed = {
                    coin,
                    snapshotId: market.snapshotId,
                    sourceTimeMs: this.available?.id === market.snapshotId ? this.available.timeMs : null,
                    positions: market.positions,
                    totalRows: market.totalRows,
                    unavailableLiquidationPx: market.unavailableLiquidationPx,
                    invalidRows: market.invalidRows + market.zeroSizeRows + market.duplicateRows
                };
                entry.receivedAtMs = now;
                entry.lastError = null;
            } else if (Number.isFinite(nextFetchMs) && nextFetchMs > 0) {
                // the gateway is serving cached data until quota recovers
                entry.retryAtMs = now + nextFetchMs;
                entry.lastError = { reason: "rate-limited", detail: null };
            }
            this.update(coin);
        }
    }

    private reject(coins: string[], error: unknown): void {
        if (error instanceof InfoError && error.code === "aborted") {
            return;
        }
        const now = this.options.clock.now();
        const backoff = Math.min(MAX_BACKOFF_MS, 5000 * 2 ** this.failures);

        for (const coin of coins) {
            const entry = this.coins.get(coin)!;
            const detail = error instanceof Error ? error.message : null;

            if (error instanceof InfoError && error.code === "rate-limited") {
                entry.retryAtMs = now + (error.retryAfterMs ?? 60_000);
                entry.lastError = { reason: "rate-limited", detail: null };
            } else if (error instanceof InfoError && error.code === "permission-denied") {
                // retrying will not fix missing permissions
                entry.retryAtMs = Number.POSITIVE_INFINITY;
                entry.lastError = { reason: "permission-denied", detail };
            } else {
                entry.retryAtMs = now + backoff;
                entry.lastError = {
                    reason:
                        error instanceof WireError
                            ? "malformed-payload"
                            : error instanceof InfoError && error.code === "network-error"
                              ? "network-error"
                              : "upstream-unavailable",
                    detail
                };
            }
            this.update(coin);
        }
        if (!(error instanceof InfoError && error.code === "rate-limited")) {
            this.failures++;
        }
    }

    // derive status from the stored data, a successful request does not make an old snapshot fresh
    private update(coin: string): void {
        const entry = this.coins.get(coin);
        if (!entry) {
            return;
        }
        const next = patchStatus(entry.status, this.deriveStatus(entry));
        if (next !== entry.status) {
            entry.status = next;
            this.options.onChange(coin);
        }
    }

    private deriveStatus(entry: IPositionsCoinEntry): Partial<IDataStatus> {
        const now = this.options.clock.now();
        const committed = entry.committed;
        const error = entry.lastError;
        const base = {
            sourceTimeMs: committed?.sourceTimeMs ?? null,
            receivedAtMs: entry.receivedAtMs,
            version: committed?.snapshotId ?? null,
            retryAtMs: Number.isFinite(entry.retryAtMs) && entry.retryAtMs > now ? entry.retryAtMs : null,
            detail: error?.detail ?? null
        };

        if (error?.reason === "permission-denied") {
            return { ...base, state: "unavailable", reason: error.reason };
        }
        if (!committed) {
            if (error?.reason === "rate-limited") {
                return {
                    ...base,
                    state: "waiting-for-quota",
                    reason: error.reason
                };
            }
            if (error) {
                return { ...base, state: "error", reason: error.reason };
            }
            return { ...base, state: "loading", reason: "initial-load" };
        }

        const sourceTime = committed.sourceTimeMs;
        if (sourceTime !== null && now - sourceTime > POSITIONS_STALE_MS) {
            return { ...base, state: "stale", reason: "snapshot-age" };
        }
        if (error && this.needsFetch(entry)) {
            return { ...base, state: "stale", reason: error.reason };
        }
        return { ...base, state: "live", reason: "ok", detail: null };
    }

    private scheduleNextRetry(): void {
        const now = this.options.clock.now();
        const pending = this.activeCoins()
            .map((coin) => this.coins.get(coin)!)
            .filter((entry) => this.needsFetch(entry))
            .map((entry) => entry.retryAtMs)
            .filter((at) => Number.isFinite(at));
        if (pending.length === 0) {
            return;
        }
        const soonest = Math.min(...pending);
        this.scheduleFetch(Math.max(0, soonest - now) + Math.random() * 1000);
    }
}
