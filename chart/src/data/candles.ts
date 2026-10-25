// live candles replace the whole bar, merge by open time and keep the newest copy

import type { ICandleBar, TCandleChange, TCandleInterval } from "../types";

export const INTERVAL_MS: Record<TCandleInterval, number> = {
    "15s": 15_000,
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000
};

export class CandleStore {
    private readonly bars = new Map<number, ICandleBar>();
    private sorted: ICandleBar[] = [];
    private dirty = false;
    private readonly maxBars: number;

    constructor(maxBars: number = 3000) {
        this.maxBars = maxBars;
    }

    // update means the latest bar changed or a new one arrived, older changes need a full reset
    applyLive(bar: ICandleBar): TCandleChange {
        const last = this.last();
        this.bars.set(bar.timeMs, bar);

        if (last === null || bar.timeMs >= last.timeMs) {
            if (!this.dirty) {
                if (last !== null && bar.timeMs === last.timeMs) {
                    this.sorted[this.sorted.length - 1] = bar;
                } else {
                    this.sorted.push(bar);
                }
            }
            this.trim();
            return "update";
        }
        this.dirty = true;
        return "reset";
    }

    mergeHistory(bars: readonly ICandleBar[]): void {
        for (const bar of bars) {
            this.bars.set(bar.timeMs, bar);
        }
        this.dirty = true;
        this.trim();
    }

    clear(): void {
        this.bars.clear();
        this.sorted = [];
        this.dirty = false;
    }

    last(): ICandleBar | null {
        const sorted = this.toArray();
        return sorted[sorted.length - 1] ?? null;
    }

    toArray(): readonly ICandleBar[] {
        if (this.dirty) {
            this.sorted = [...this.bars.values()].sort((a, b) => a.timeMs - b.timeMs);
            this.dirty = false;
        }
        return this.sorted;
    }

    private trim(): void {
        if (this.bars.size <= this.maxBars) {
            return;
        }
        const sorted = this.toArray();
        const excess = sorted.length - this.maxBars;
        for (const bar of sorted.slice(0, excess)) {
            this.bars.delete(bar.timeMs);
        }
        this.sorted = sorted.slice(excess);
    }
}
