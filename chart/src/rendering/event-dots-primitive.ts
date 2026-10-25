// built-in markers bottom out around 10px, draw our own so small liquidations can stay small

import type {
    IChartApi,
    IPrimitivePaneRenderer,
    IPrimitivePaneView,
    ISeriesApi,
    ISeriesPrimitive,
    PrimitiveHoveredItem,
    SeriesAttachedParameter,
    SeriesType,
    Time,
    UTCTimestamp
} from "lightweight-charts";
import type { IEventGroup } from "../model/events";

type TRenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

// scale radius logarithmically with notional, independent of zoom
// use MIN_RADIUS at the threshold and MAX_RADIUS at about 32× the threshold
const MIN_RADIUS = 2;
const MAX_RADIUS = 12;
const RADIUS_DECADES = 1.5;
// fallback size when the minimum is zero or tiny
const MIN_RADIUS_BASE = 1_000;
// gap between the wick and dot
const WICK_GAP = 4;
// extra room around a dot for pointer hits
const HIT_SLOP = 3;

// radius in CSS pixels, relative to the minimum visible group
export function dotRadius(notional: number, minNotional: number): number {
    const base = Math.max(minNotional, MIN_RADIUS_BASE);
    const decades = Math.log10(Math.max(notional, base) / base);
    const share = Math.min(1, decades / RADIUS_DECADES);
    return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * share;
}

export interface IEventDot {
    group: IEventGroup;
    time: UTCTimestamp;
    // shorts sit above the candle high, longs below the low
    high: number;
    low: number;
    color: string;
    label: string | null;
}

interface IPlacedDot {
    dot: IEventDot;
    x: number;
    y: number;
    radius: number;
}

export class EventDotsPrimitive implements ISeriesPrimitive<Time> {
    private dots: IEventDot[] = [];
    private minNotional = 0;
    private placed: IPlacedDot[] = [];
    private chart: IChartApi | null = null;
    private series: ISeriesApi<SeriesType> | null = null;
    private requestUpdate: (() => void) | null = null;
    private readonly views: readonly IPrimitivePaneView[];

    constructor() {
        this.views = [
            {
                zOrder: () => "normal",
                renderer: () => ({ draw: (target) => this.draw(target) })
            }
        ];
    }

    // the smallest visible group gets the smallest dot
    setDots(dots: IEventDot[], minNotional: number): void {
        this.dots = dots;
        this.minNotional = minNotional;
        this.requestUpdate?.();
    }

    // pick the topmost dot when hit areas overlap
    groupAt(x: number, y: number): IEventGroup | null {
        for (let index = this.placed.length - 1; index >= 0; index--) {
            const placed = this.placed[index]!;
            if (Math.hypot(placed.x - x, placed.y - y) <= placed.radius + HIT_SLOP) {
                return placed.dot.group;
            }
        }
        return null;
    }

    attached(param: SeriesAttachedParameter<Time>): void {
        this.chart = param.chart;
        this.series = param.series;
        this.requestUpdate = param.requestUpdate;
    }

    detached(): void {
        this.chart = null;
        this.series = null;
        this.requestUpdate = null;
    }

    updateAllViews(): void {
        this.placed = [];
        if (!this.chart || !this.series) {
            return;
        }
        const timeScale = this.chart.timeScale();
        for (const dot of this.dots) {
            const x = timeScale.timeToCoordinate(dot.time);
            const isShort = dot.group.side === "short";
            const wickY = this.series.priceToCoordinate(isShort ? dot.high : dot.low);
            if (x === null || wickY === null) {
                continue;
            }
            const radius = dotRadius(dot.group.notional, this.minNotional);
            const y = isShort ? wickY - WICK_GAP - radius : wickY + WICK_GAP + radius;
            this.placed.push({ dot, x, y, radius });
        }
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this.views;
    }

    hitTest(x: number, y: number): PrimitiveHoveredItem | null {
        const group = this.groupAt(x, y);
        if (!group) {
            return null;
        }
        return {
            externalId: `event:${group.side}:${group.candleTimeMs}`,
            zOrder: "normal",
            cursorStyle: "pointer",
            hitTestPriority: 2,
            itemType: "primitive"
        };
    }

    private draw(target: TRenderTarget): void {
        target.useMediaCoordinateSpace(({ context }) => {
            context.font = "10px ui-sans-serif, system-ui, sans-serif";
            context.textAlign = "center";
            for (const { dot, x, y, radius } of this.placed) {
                context.globalAlpha = 0.9;
                context.fillStyle = dot.color;
                context.beginPath();
                context.arc(x, y, radius, 0, 2 * Math.PI);
                context.fill();
                if (!dot.label) {
                    continue;
                }
                // put labels on the side facing away from the candle
                const isShort = dot.group.side === "short";
                context.globalAlpha = 1;
                context.textBaseline = isShort ? "bottom" : "top";
                context.fillText(dot.label, x, isShort ? y - radius - 2 : y + radius + 2);
            }
        });
    }
}
