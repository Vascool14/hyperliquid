// run `npm run bench` for 42k positions and 21k triggers
import { describe, it } from "vitest";
import { aggregateLiquidations, aggregateTpsl, chooseGrid } from "../src/model/aggregate";
import type { IPositionRecord, ITriggerOrderRecord } from "../src/types";

function random(seed: number) {
    return () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
    };
}

const next = random(42);
const MARK = 81_800;

const positions: IPositionRecord[] = Array.from({ length: 42_000 }, (_, i) => {
    const long = next() < 0.74;
    const distance = 0.02 + next() * 0.4;
    return {
        id: `BTC:${i}`,
        coin: "BTC",
        address: `0x${i}`,
        side: long ? "long" : "short",
        size: long ? 1 : -1,
        // mostly small positions with a few large ones
        notional: Math.exp(next() * 16),
        entryPx: MARK,
        leverageType: "cross",
        leverage: 10,
        liquidationPx: next() < 0.15 ? null : MARK * (long ? 1 - distance : 1 + distance),
        fundingPnl: 0,
        accountValue: 1
    };
});

const orders: ITriggerOrderRecord[] = Array.from({ length: 21_000 }, (_, i) => {
    const triggerPx = MARK * (0.7 + next() * 0.6);
    const dynamic = next() < 0.32;
    return {
        id: String(i),
        coin: "BTC",
        user: "0x",
        side: next() < 0.5 ? "buy" : "sell",
        kind: next() < 0.58 ? "tp" : "sl",
        orderType: "Stop Market",
        isTrailing: false,
        triggerPx,
        triggerPxRaw: String(triggerPx),
        limitPx: triggerPx,
        limitPxRaw: "",
        size: dynamic ? 0 : next(),
        sizeRaw: "",
        sizeKnown: !dynamic,
        triggerCondition: "",
        isPositionTpsl: dynamic,
        reduceOnly: true,
        createdMs: null
    };
});

const filter = {
    showTakeProfit: true,
    showStopLoss: true,
    showBuy: true,
    showSell: true
};

// report the median after warm-up, no timing assertions
function measure(name: string, run: () => void, iterations = 60) {
    for (let i = 0; i < 10; i++) {
        run();
    }
    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        run();
        samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    console.log(`${name.padEnd(46)} median ${median.toFixed(2)} ms  p95 ${p95.toFixed(2)} ms`);
}

describe("aggregation at observed BTC scale", () => {
    it("reports timings", () => {
        const fine = chooseGrid(1_000, 600);
        const wide = chooseGrid(40_000, 600);
        measure("liquidations, 42k positions, $2 rows", () =>
            aggregateLiquidations(positions, 100_000, fine)
        );
        measure("liquidations, 42k positions, all sizes, $100 rows", () =>
            aggregateLiquidations(positions, 0, wide)
        );
        measure("TP/SL, 21k orders, $2 rows", () => aggregateTpsl(orders, filter, fine));
        measure("TP/SL, 21k orders, $100 rows", () => aggregateTpsl(orders, filter, wide));
    });
});
