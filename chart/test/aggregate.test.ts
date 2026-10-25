import { describe, expect, it } from "vitest";
import { aggregateLiquidations, aggregateTpsl, PriceGrid } from "../src/model/aggregate";
import type { IPositionRecord, ITriggerOrderRecord } from "../src/types";

let nextId = 0;

function pos(
    liquidationPx: number | null,
    notional: number,
    side: "long" | "short" = "long"
): IPositionRecord {
    const id = `BTC:${nextId++}`;
    return {
        id,
        coin: "BTC",
        address: id,
        side,
        size: side === "long" ? 1 : -1,
        notional,
        entryPx: 80_000,
        leverageType: "cross",
        leverage: 10,
        liquidationPx,
        fundingPnl: 0,
        accountValue: 1
    };
}

function order(
    triggerPx: number | null,
    kind: "tp" | "sl" | "unknown",
    size: number,
    side: "buy" | "sell" = "sell"
): ITriggerOrderRecord {
    const id = String(nextId++);
    return {
        id,
        coin: "BTC",
        user: "0x",
        side,
        kind,
        orderType: kind === "tp" ? "Take Profit Market" : "Stop Market",
        isTrailing: false,
        triggerPx,
        triggerPxRaw: String(triggerPx ?? 0),
        limitPx: triggerPx,
        limitPxRaw: "",
        size,
        sizeRaw: String(size),
        sizeKnown: size > 0,
        triggerCondition: "",
        isPositionTpsl: size === 0,
        reduceOnly: true,
        createdMs: null
    };
}

const FILTER = {
    showTakeProfit: true,
    showStopLoss: true,
    showBuy: true,
    showSell: true
};

describe("aggregateLiquidations", () => {
    it("conserves totals and keeps sides and bands separate", () => {
        const positions = [
            pos(70_010, 150_000),
            pos(70_050, 2_000_000),
            pos(70_090, 600_000, "short"),
            pos(70_100, 12_000_000),
            pos(null, 9_000_000),
            pos(70_010, 20_000)
        ];
        const profile = aggregateLiquidations(positions, 100_000, PriceGrid.forStep(100));
        const [first, second] = profile.buckets;

        expect(profile.buckets).toHaveLength(2);
        expect(first?.long.notional).toBe(2_150_000);
        expect(first?.short.notional).toBe(600_000);
        expect(first?.long.bands[1]).toBe(150_000);
        expect(first?.long.bands[3]).toBe(2_000_000);
        expect(second?.long.bands[5]).toBe(12_000_000);
        expect(profile.unavailableCount).toBe(1);
        expect(profile.belowThresholdCount).toBe(1);

        const total = profile.buckets.reduce((sum, b) => sum + b.long.notional + b.short.notional, 0);
        expect(total).toBe(profile.longNotional + profile.shortNotional);
        expect(profile.eligibleCount).toBe(4);
    });
});

describe("aggregateTpsl", () => {
    it("counts dynamic-size orders and sums only known-size notional", () => {
        const orders = [
            order(90_010, "tp", 0.5, "buy"),
            order(90_020, "tp", 0),
            order(90_030, "sl", 0, "buy"),
            order(90_040, "unknown", 1),
            order(null, "sl", 1)
        ];
        const profile = aggregateTpsl(orders, FILTER, PriceGrid.forStep(100));
        const bucket = profile.buckets[0]!;

        expect(bucket.tp.count).toBe(2);
        expect(bucket.tp.unknownSizeCount).toBe(1);
        expect(bucket.tp.knownNotional).toBe(45_005);
        expect(bucket.tp.buyKnownNotional).toBe(45_005);
        expect(bucket.sl.buyCount).toBe(1);
        expect(bucket.unknown.count).toBe(1);
        expect(profile.unplottedCount).toBe(1);
        expect(profile.unknownSizeCount).toBe(2);
    });
});
