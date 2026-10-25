// group fills by candle and liquidated side so bursts share one dot
// keep price, timing and account summaries for the inspector

import type { ILiquidationEventRecord, TPositionSide } from "../types";

// share of group notional used to find the concentrated time window
export const CONCENTRATION_SHARE = 0.8;

export interface IEventGroup {
    candleTimeMs: number;
    side: TPositionSide;
    notional: number;
    fillCount: number;
    minPx: number;
    maxPx: number;
    // average execution price weighted by size
    vwapPx: number;
    firstTimeMs: number;
    lastTimeMs: number;
    // shortest window containing CONCENTRATION_SHARE of the notional
    concentratedFromMs: number;
    concentratedMs: number;
    // count unique liquidated users, one position can produce many fills
    accountCount: number;
    largestAccountNotional: number;
    largestAccountFills: number;
    // fills handled by the backstop vault rather than the order book
    backstopCount: number;
}

// fixed intervals line up with the epoch, floor division gives the candle time
// only draw events whose candles are loaded
export function groupEventsByCandle(
    events: readonly ILiquidationEventRecord[],
    candleTimes: ReadonlySet<number>,
    intervalMs: number,
    minNotional: number
): IEventGroup[] {
    const buckets = new Map<string, ILiquidationEventRecord[]>();

    for (const event of events) {
        const candleTimeMs = Math.floor(event.timeMs / intervalMs) * intervalMs;
        if (!candleTimes.has(candleTimeMs)) {
            continue;
        }
        const key = `${candleTimeMs}:${event.side}`;
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = [];
            buckets.set(key, bucket);
        }
        bucket.push(event);
    }

    const groups: IEventGroup[] = [];
    for (const bucket of buckets.values()) {
        const notional = bucket.reduce((sum, event) => sum + event.notional, 0);
        if (notional >= minNotional) {
            groups.push(summarizeGroup(bucket, intervalMs, notional));
        }
    }
    return groups.sort((a, b) => a.candleTimeMs - b.candleTimeMs);
}

function summarizeGroup(
    events: ILiquidationEventRecord[],
    intervalMs: number,
    notional: number
): IEventGroup {
    const sorted = [...events].sort((a, b) => a.timeMs - b.timeMs);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const byAccount = new Map<string, { notional: number; fills: number }>();
    let minPx = Infinity;
    let maxPx = -Infinity;
    let baseSize = 0;
    let backstopCount = 0;

    for (const event of sorted) {
        minPx = Math.min(minPx, event.px);
        maxPx = Math.max(maxPx, event.px);
        baseSize += event.size;
        if (event.method === "backstop") {
            backstopCount++;
        }
        const account = byAccount.get(event.user) ?? { notional: 0, fills: 0 };
        account.notional += event.notional;
        account.fills++;
        byAccount.set(event.user, account);
    }

    let largestAccount = { notional: 0, fills: 0 };
    for (const account of byAccount.values()) {
        if (account.notional > largestAccount.notional) {
            largestAccount = account;
        }
    }
    const window = shortestWindow(sorted, notional * CONCENTRATION_SHARE);

    return {
        candleTimeMs: Math.floor(first.timeMs / intervalMs) * intervalMs,
        side: first.side,
        notional,
        fillCount: sorted.length,
        minPx,
        maxPx,
        vwapPx: notional / baseSize,
        firstTimeMs: first.timeMs,
        lastTimeMs: last.timeMs,
        concentratedFromMs: window.fromMs,
        concentratedMs: window.durationMs,
        accountCount: byAccount.size,
        largestAccountNotional: largestAccount.notional,
        largestAccountFills: largestAccount.fills,
        backstopCount
    };
}

// slide over time-sorted fills to find the shortest span reaching target
// notional is positive so the left edge only moves forward
function shortestWindow(
    sorted: ILiquidationEventRecord[],
    target: number
): { fromMs: number; durationMs: number } {
    let best = {
        fromMs: sorted[0]!.timeMs,
        durationMs: sorted[sorted.length - 1]!.timeMs - sorted[0]!.timeMs
    };
    let left = 0;
    let sum = 0;

    for (let right = 0; right < sorted.length; right++) {
        sum += sorted[right]!.notional;
        while (sum - sorted[left]!.notional >= target) {
            sum -= sorted[left]!.notional;
            left++;
        }
        const durationMs = sorted[right]!.timeMs - sorted[left]!.timeMs;
        if (sum >= target && durationMs < best.durationMs) {
            best = { fromMs: sorted[left]!.timeMs, durationMs };
        }
    }
    return best;
}
