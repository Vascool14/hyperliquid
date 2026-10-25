// bucket records on a 1/2/5 price grid, count each eligible record once
// keep long/short and TP/SL totals separate, pixels must not change the amounts

import type { IPositionRecord, ITpslLayerOptions, ITriggerOrderRecord } from "../types";

/** size bands start at these thresholds, band 0 holds positions below $100k */
export const SIZE_PRESETS = [100_000, 500_000, 1_000_000, 5_000_000, 10_000_000];
export const BAND_COUNT = SIZE_PRESETS.length + 1;

export function sizeBand(notional: number): number {
    let band = 0;
    for (const edge of SIZE_PRESETS) {
        if (notional >= edge) {
            band++;
        }
    }
    return band;
}

const STEP_MANTISSAS = [1, 2, 5];

// use scaled integers so 0.15 / 0.05 lands in bucket 3 despite floating point rounding
export class PriceGrid {
    readonly step: number;
    private readonly scale: number;
    private readonly scaledStep: number;

    constructor(mantissa: number, exponent: number) {
        const digits = 6 + Math.max(0, -exponent);
        this.scale = 10 ** digits;
        this.scaledStep = mantissa * 10 ** (exponent + digits);
        this.step = this.scaledStep / this.scale;
    }

    static forStep(step: number): PriceGrid {
        if (!(step > 0) || !Number.isFinite(step)) {
            throw new RangeError("Bucket step must be a positive number.");
        }
        const exponent = Math.floor(Math.log10(step) + 1e-9);
        const mantissa = Math.round(step / 10 ** exponent);
        return new PriceGrid(mantissa, exponent);
    }

    index(price: number): number {
        return Math.floor(Math.round(price * this.scale) / this.scaledStep);
    }

    lower(index: number): number {
        return (index * this.scaledStep) / this.scale;
    }

    upper(index: number): number {
        return ((index + 1) * this.scaledStep) / this.scale;
    }

    key(): string {
        return `${this.scaledStep}/${this.scale}`;
    }
}

// pick the smallest 1/2/5 step that keeps rows at least minRowPx tall
export function chooseGrid(priceSpan: number, paneHeightPx: number, minRowPx: number = 6): PriceGrid {
    const span = priceSpan > 0 && Number.isFinite(priceSpan) ? priceSpan : 1;
    const rows = Math.max(1, paneHeightPx / minRowPx);
    const raw = span / rows;
    let exponent = Math.floor(Math.log10(raw));

    for (;;) {
        for (const mantissa of STEP_MANTISSAS) {
            if (mantissa * 10 ** exponent >= raw * (1 - 1e-9)) {
                return new PriceGrid(mantissa, exponent);
            }
        }
        exponent++;
    }
}

export interface ISideTotals {
    notional: number;
    count: number;
    // notional by size band, indexed by sizeBand
    bands: number[];
}

export interface ILiquidationBucket {
    index: number;
    priceFrom: number;
    priceTo: number;
    long: ISideTotals;
    short: ISideTotals;
}

export interface ILiquidationProfile {
    grid: PriceGrid;
    buckets: ILiquidationBucket[];
    eligibleCount: number;
    belowThresholdCount: number;
    unavailableCount: number;
    longNotional: number;
    shortNotional: number;
}

function emptySide(): ISideTotals {
    return {
        notional: 0,
        count: 0,
        bands: new Array<number>(BAND_COUNT).fill(0)
    };
}

// filter individual positions before adding them to buckets
export function isEligiblePosition(position: IPositionRecord, minNotional: number): boolean {
    return position.liquidationPx !== null && position.notional >= minNotional;
}

export function aggregateLiquidations(
    positions: readonly IPositionRecord[],
    minNotional: number,
    grid: PriceGrid
): ILiquidationProfile {
    const byIndex = new Map<number, ILiquidationBucket>();
    const profile: ILiquidationProfile = {
        grid,
        buckets: [],
        eligibleCount: 0,
        belowThresholdCount: 0,
        unavailableCount: 0,
        longNotional: 0,
        shortNotional: 0
    };

    for (const position of positions) {
        if (position.liquidationPx === null) {
            profile.unavailableCount++;
            continue;
        }
        if (position.notional < minNotional) {
            profile.belowThresholdCount++;
            continue;
        }

        const index = grid.index(position.liquidationPx);
        let bucket = byIndex.get(index);
        if (!bucket) {
            bucket = {
                index,
                priceFrom: grid.lower(index),
                priceTo: grid.upper(index),
                long: emptySide(),
                short: emptySide()
            };
            byIndex.set(index, bucket);
        }

        const side = position.side === "long" ? bucket.long : bucket.short;
        side.notional += position.notional;
        side.count++;
        side.bands[sizeBand(position.notional)]! += position.notional;

        profile.eligibleCount++;
        if (position.side === "long") {
            profile.longNotional += position.notional;
        } else {
            profile.shortNotional += position.notional;
        }
    }

    profile.buckets = [...byIndex.values()].sort((a, b) => a.index - b.index);
    return profile;
}

export interface IKindTotals {
    count: number;
    // zero reported size means dynamic or unspecified size
    unknownSizeCount: number;
    // triggerPx × known size is a display estimate, not executable volume or unique position exposure
    knownNotional: number;
    // buy share of knownNotional, the rest comes from sells
    buyKnownNotional: number;
    buyCount: number;
    sellCount: number;
}

export interface ITpslBucket {
    index: number;
    priceFrom: number;
    priceTo: number;
    tp: IKindTotals;
    sl: IKindTotals;
    unknown: IKindTotals;
}

export interface ITpslProfile {
    grid: PriceGrid;
    buckets: ITpslBucket[];
    eligibleCount: number;
    filteredOutCount: number;
    // orders with no usable trigger price, like inactive trailing stops
    unplottedCount: number;
    unknownSizeCount: number;
}

export function emptyKindTotals(): IKindTotals {
    return {
        count: 0,
        unknownSizeCount: 0,
        knownNotional: 0,
        buyKnownNotional: 0,
        buyCount: 0,
        sellCount: 0
    };
}

export type TTpslFilter = Pick<ITpslLayerOptions, "showTakeProfit" | "showStopLoss" | "showBuy" | "showSell">;

export function isEligibleOrder(order: ITriggerOrderRecord, filter: TTpslFilter): boolean {
    if (order.kind === "tp" && !filter.showTakeProfit) {
        return false;
    }
    if (order.kind === "sl" && !filter.showStopLoss) {
        return false;
    }
    if (order.side === "buy" && !filter.showBuy) {
        return false;
    }
    if (order.side === "sell" && !filter.showSell) {
        return false;
    }
    return true;
}

export function aggregateTpsl(
    orders: Iterable<ITriggerOrderRecord>,
    filter: TTpslFilter,
    grid: PriceGrid
): ITpslProfile {
    const byIndex = new Map<number, ITpslBucket>();
    const profile: ITpslProfile = {
        grid,
        buckets: [],
        eligibleCount: 0,
        filteredOutCount: 0,
        unplottedCount: 0,
        unknownSizeCount: 0
    };

    for (const order of orders) {
        if (!isEligibleOrder(order, filter)) {
            profile.filteredOutCount++;
            continue;
        }
        if (order.triggerPx === null) {
            profile.unplottedCount++;
            continue;
        }

        const index = grid.index(order.triggerPx);
        let bucket = byIndex.get(index);
        if (!bucket) {
            bucket = {
                index,
                priceFrom: grid.lower(index),
                priceTo: grid.upper(index),
                tp: emptyKindTotals(),
                sl: emptyKindTotals(),
                unknown: emptyKindTotals()
            };
            byIndex.set(index, bucket);
        }

        const totals = bucket[order.kind === "unknown" ? "unknown" : order.kind];
        totals.count++;
        if (order.sizeKnown) {
            const notional = order.triggerPx * order.size;
            totals.knownNotional += notional;
            if (order.side === "buy") {
                totals.buyKnownNotional += notional;
            }
        } else {
            totals.unknownSizeCount++;
            profile.unknownSizeCount++;
        }
        if (order.side === "buy") {
            totals.buyCount++;
        } else {
            totals.sellCount++;
        }
        profile.eligibleCount++;
    }

    profile.buckets = [...byIndex.values()].sort((a, b) => a.index - b.index);
    return profile;
}

export function positionsInRange(
    positions: readonly IPositionRecord[],
    minNotional: number,
    grid: PriceGrid,
    fromIndex: number,
    toIndex: number
): IPositionRecord[] {
    const out: IPositionRecord[] = [];
    for (const position of positions) {
        if (!isEligiblePosition(position, minNotional)) {
            continue;
        }
        const index = grid.index(position.liquidationPx!);
        if (index >= fromIndex && index <= toIndex) {
            out.push(position);
        }
    }
    return out.sort((a, b) => b.notional - a.notional);
}

export function ordersInRange(
    orders: Iterable<ITriggerOrderRecord>,
    filter: TTpslFilter,
    grid: PriceGrid,
    fromIndex: number,
    toIndex: number
): ITriggerOrderRecord[] {
    const out: ITriggerOrderRecord[] = [];
    for (const order of orders) {
        if (order.triggerPx === null || !isEligibleOrder(order, filter)) {
            continue;
        }
        const index = grid.index(order.triggerPx);
        if (index >= fromIndex && index <= toIndex) {
            out.push(order);
        }
    }
    return out.sort(
        (a, b) => (b.sizeKnown ? b.size * b.triggerPx! : 0) - (a.sizeKnown ? a.size * a.triggerPx! : 0)
    );
}
