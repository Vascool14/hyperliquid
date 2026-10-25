import type { IKindTotals, PriceGrid, ITpslBucket, ITpslProfile } from "../model/aggregate";
import { darkerShade } from "../themes";
import type { IOverlayPalette, TOrderSide, TTpslMetric, TTriggerKind } from "../types";
import { formatCount, formatPrice, formatUsd } from "./format";
import {
    ProfileLanePrimitive,
    type ILaneTheme,
    type ProfileViewport,
    type ISegment
} from "./profile-geometry";

export type TTpslSource = (grid: PriceGrid) => ITpslProfile | null;

const BAR_ALPHA = 0.9;

// one order kind and side, or all unclassified orders under Other
export interface ITpslPart {
    label: string;
    totals: IKindTotals;
    side: TOrderSide | null;
    color: string;
}

// hue shows order kind, a darker shade shows buys
export function tpslColor(palette: IOverlayPalette, kind: TTriggerKind, side: TOrderSide): string {
    const base = kind === "tp" ? palette.takeProfit : kind === "sl" ? palette.stopLoss : palette.unknown;
    return side === "buy" ? darkerShade(base) : base;
}

// share the left-to-right breakdown between lanes, tooltips and cards
export function tpslParts(
    bucket: Pick<ITpslBucket, "tp" | "sl" | "unknown">,
    palette: IOverlayPalette
): ITpslPart[] {
    const part = (label: string, totals: IKindTotals, kind: TTriggerKind, side: TOrderSide): ITpslPart => ({
        label,
        totals,
        side,
        color: tpslColor(palette, kind, side)
    });
    return [
        part("TP sell", bucket.tp, "tp", "sell"),
        part("TP buy", bucket.tp, "tp", "buy"),
        part("SL buy", bucket.sl, "sl", "buy"),
        part("SL sell", bucket.sl, "sl", "sell"),
        { label: "Other", totals: bucket.unknown, side: null, color: palette.unknown }
    ];
}

// order count or notional with a known size
export function tpslPartValue(part: ITpslPart, metric: TTpslMetric): number {
    const { totals, side } = part;
    if (metric === "count") {
        return side === null ? totals.count : side === "buy" ? totals.buyCount : totals.sellCount;
    }
    return side === null
        ? totals.knownNotional
        : side === "buy"
          ? totals.buyKnownNotional
          : totals.knownNotional - totals.buyKnownNotional;
}

// default to order count so dynamic position orders stay visible
export class TpslPrimitive extends ProfileLanePrimitive<ITpslBucket> {
    private readonly source: TTpslSource;
    private metric: TTpslMetric = "count";

    constructor(viewport: ProfileViewport, theme: ILaneTheme, source: TTpslSource) {
        super("tpsl", viewport, theme);
        this.source = source;
    }

    setMetric(metric: TTpslMetric): void {
        if (this.metric !== metric) {
            this.metric = metric;
            this.invalidate();
        }
    }

    protected buckets(grid: PriceGrid): readonly ITpslBucket[] | null {
        return this.source(grid)?.buckets ?? null;
    }

    protected rowValue(bucket: ITpslBucket): number {
        const kinds = [bucket.tp, bucket.sl, bucket.unknown];
        return this.metric === "count"
            ? kinds.reduce((sum, kind) => sum + kind.count, 0)
            : kinds.reduce((sum, kind) => sum + kind.knownNotional, 0);
    }

    // drawing starts at the price axis, reverse the breakdown to keep its left-to-right order
    protected segments(bucket: ITpslBucket, maxValue: number): ISegment[] {
        if (maxValue <= 0) {
            return [];
        }
        return tpslParts(bucket, this.theme.palette)
            .reverse()
            .map((part) => ({
                length: tpslPartValue(part, this.metric) / maxValue,
                color: part.color,
                alpha: BAR_ALPHA
            }))
            .filter((segment) => segment.length > 0);
    }

    protected title(): string {
        return this.metric === "count" ? "TP/SL orders" : "TP/SL known size";
    }

    protected formatValue(value: number): string {
        return this.metric === "count" ? formatCount(value) : formatUsd(value);
    }

    protected override formatAxisPrice(price: number): string {
        return formatPrice(price);
    }
}
