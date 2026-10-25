// activeAssetCtx supplies mark price, keep it distinct from the candle close

import type { IDataStatus } from "../types";
import { createStatus, patchStatus } from "./status";
import type { SocketTransport, ITransportStatus } from "./transport";
import { parseDecimal } from "./wire";

interface IMarkEntry {
    refs: number;
    markPx: number | null;
    receivedAtMs: number | null;
    status: IDataStatus;
    unsubscribe: () => void;
}

export interface IMarkFeedOptions {
    transport: SocketTransport;
    now: () => number;
    onChange: (coin: string) => void;
}

export class MarkFeed {
    private readonly options: IMarkFeedOptions;
    private readonly entries = new Map<string, IMarkEntry>();

    constructor(options: IMarkFeedOptions) {
        this.options = options;
    }

    acquire(coin: string): void {
        const existing = this.entries.get(coin);
        if (existing) {
            existing.refs++;
            return;
        }
        const entry: IMarkEntry = {
            refs: 1,
            markPx: null,
            receivedAtMs: null,
            status: createStatus("loading", "initial-load"),
            unsubscribe: () => {}
        };
        this.entries.set(coin, entry);
        entry.unsubscribe = this.options.transport.subscribe(
            { type: "activeAssetCtx", coin },
            (data) => this.onContext(coin, data),
            (detail) =>
                this.setStatus(coin, {
                    state: "unavailable",
                    reason: "permission-denied",
                    detail
                })
        );
    }

    release(coin: string): void {
        const entry = this.entries.get(coin);
        if (!entry) {
            return;
        }
        entry.refs--;
        if (entry.refs <= 0) {
            entry.unsubscribe();
            this.entries.delete(coin);
        }
    }

    markPx(coin: string): number | null {
        return this.entries.get(coin)?.markPx ?? null;
    }

    // merge receipt time on read so each tick does not trigger a status change
    status(coin: string): IDataStatus {
        const entry = this.entries.get(coin);
        if (!entry) {
            return createStatus();
        }
        return { ...entry.status, receivedAtMs: entry.receivedAtMs };
    }

    onTransport(status: ITransportStatus): void {
        if (status.state !== "closed") {
            return;
        }
        for (const coin of this.entries.keys()) {
            this.setStatus(coin, {
                state: status.fatal ? "unavailable" : "reconnecting",
                reason: status.fatal ? "permission-denied" : "socket-closed",
                retryAtMs: status.retryAtMs
            });
        }
    }

    destroy(): void {
        for (const entry of this.entries.values()) {
            entry.unsubscribe();
        }
        this.entries.clear();
    }

    private onContext(coin: string, data: unknown): void {
        const entry = this.entries.get(coin);
        if (!entry || typeof data !== "object" || data === null) {
            return;
        }
        const payload = data as Record<string, unknown>;
        const ctx = payload.ctx as Record<string, unknown> | undefined;
        if (payload.coin !== coin || !ctx) {
            return;
        }
        const markPx = parseDecimal(ctx.markPx);
        if (markPx === null || markPx <= 0) {
            return;
        }
        entry.markPx = markPx;
        entry.receivedAtMs = this.options.now();
        entry.status = patchStatus(entry.status, {
            state: "live",
            reason: "ok",
            retryAtMs: null,
            detail: null
        });
        this.options.onChange(coin);
    }

    private setStatus(coin: string, patch: Partial<IDataStatus>): void {
        const entry = this.entries.get(coin);
        if (!entry) {
            return;
        }
        const next = patchStatus(entry.status, patch);
        if (next !== entry.status) {
            entry.status = next;
            this.options.onChange(coin);
        }
    }
}
