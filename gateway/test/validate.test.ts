import { expect, it } from "vitest";
import { validateClientSocketMessage, validateInfoRequest } from "../src/validate.ts";

const NOW = Date.UTC(2026, 9, 23);

it("blocks trading, invalid markets and unbounded or invalid history requests", () => {
    const candle = {
        coin: "BTC",
        interval: "1m",
        startTime: NOW - 5000 * 60_000,
        endTime: NOW
    };
    const history = {
        type: "liquidationHistoryByTime",
        coin: "BTC",
        startTime: NOW - 3_600_000,
        endTime: NOW
    };
    expect(validateInfoRequest({ type: "candleSnapshot", req: candle }, NOW).ok).toBe(true);
    expect(validateInfoRequest({ ...history, limit: 1000 }, NOW).ok).toBe(true);
    const rejected = [
        null,
        { type: "order" },
        { type: "clearinghouseState" },
        { type: "tpslBook" },
        { type: "tpslBook", coins: ["A", "B", "C", "D", "E"] },
        { type: "tpslBook", coins: ["BTC;DROP"] },
        { type: "candleSnapshot", req: { ...candle, startTime: NOW - 5001 * 60_000 } },
        { type: "candleSnapshot", req: { ...candle, interval: "7m" } },
        { type: "candleSnapshot", req: { ...candle, startTime: NOW } },
        { ...history, limit: 1001 }
    ];
    for (const body of rejected) {
        expect(validateInfoRequest(body, NOW).ok, JSON.stringify(body)).toBe(false);
    }
});

it("blocks account and firehose subscriptions and malformed frames", () => {
    for (const subscription of [
        { type: "userFills", user: "0x0" },
        { type: "tpslUpdates" },
        { type: "l4BookUpdates", coin: "BTC" },
        { type: "candle", coin: "BTC", interval: "3d" }
    ]) {
        const text = JSON.stringify({ method: "subscribe", subscription });
        expect(validateClientSocketMessage(text).ok, text).toBe(false);
    }
    expect(validateClientSocketMessage("not json").ok).toBe(false);
});
