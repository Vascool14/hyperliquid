import {
    BAND_COUNT,
    type ILiquidationBucket,
    type ILiquidationProfile,
    type PriceGrid,
    type ISideTotals
} from "../model/aggregate";
import { formatPrice, formatUsd } from "./format";
import {
    ProfileLanePrimitive,
    type ILaneTheme,
    type ProfileViewport,
    type ISegment
} from "./profile-geometry";

// larger position bands get stronger color, with the same hue for each side
export const BAND_ALPHA = [0.2, 0.3, 0.42, 0.55, 0.7, 0.88];

export type TLiquidationSource = (grid: PriceGrid) => ILiquidationProfile | null;

// bar length is source notional on a shared linear scale across visible rows
export class LiquidationPrimitive extends ProfileLanePrimitive<ILiquidationBucket> {
    private readonly source: TLiquidationSource;

    constructor(viewport: ProfileViewport, theme: ILaneTheme, source: TLiquidationSource) {
        super("liquidations", viewport, theme);
        this.source = source;
    }

    protected buckets(grid: PriceGrid): readonly ILiquidationBucket[] | null {
        return this.source(grid)?.buckets ?? null;
    }

    protected rowValue(bucket: ILiquidationBucket): number {
        return bucket.long.notional + bucket.short.notional;
    }

    protected segments(bucket: ILiquidationBucket, maxValue: number): ISegment[] {
        const { long, short } = this.theme.palette;
        return [...sideSegments(bucket.long, long, maxValue), ...sideSegments(bucket.short, short, maxValue)];
    }

    protected title(): string {
        return "Liq. exposure";
    }

    protected formatValue(value: number): string {
        return formatUsd(value);
    }

    protected override formatAxisPrice(price: number): string {
        return formatPrice(price);
    }
}

// draw the largest band first at the lane edge
function sideSegments(side: ISideTotals, color: string, maxValue: number) {
    const segments: ISegment[] = [];
    if (side.notional <= 0 || maxValue <= 0) {
        return segments;
    }
    for (let band = BAND_COUNT - 1; band >= 0; band--) {
        const value = side.bands[band] ?? 0;
        if (value > 0) {
            segments.push({
                length: value / maxValue,
                color,
                alpha: BAND_ALPHA[band] ?? 0.5
            });
        }
    }
    return segments;
}
