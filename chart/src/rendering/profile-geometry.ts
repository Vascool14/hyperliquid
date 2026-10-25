// reuse viewport geometry for drawing and hit testing so the hit areas match the bars

import type {
    IChartApi,
    IPrimitivePaneRenderer,
    IPrimitivePaneView,
    ISeriesApi,
    ISeriesPrimitive,
    ISeriesPrimitiveAxisView,
    PrimitiveHoveredItem,
    SeriesAttachedParameter,
    Time
} from "lightweight-charts";
import { chooseGrid, type PriceGrid } from "../model/aggregate";
import type { IOverlayPalette } from "../types";

type TRenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];
type TCanvasContext = CanvasRenderingContext2D;

export type TLayerId = "liquidations" | "tpsl";

// bars and text use x0 to x1, the whole lane slot runs from left to right
export interface ILaneBounds {
    x0: number;
    x1: number;
    left: number;
    right: number;
}

// gaps before, between and after the lanes
const LEADING_GAP = 6;
const LANE_GAP = 6;
const TRAILING_GAP = 3;

export interface ISegment {
    length: number;
    color: string;
    alpha: number;
}

export interface IProfileRow<TBucket> {
    bucket: TBucket;
    index: number;
    top: number;
    bottom: number;
    value: number;
}

export interface IHighlight {
    layer: TLayerId;
    priceFrom: number;
    priceTo: number;
}

// shared viewport info, refresh when price scale, pane size or gutter width changes
export class ProfileViewport {
    paneWidth = 0;
    paneHeight = 0;
    topPrice = 0;
    bottomPrice = 0;
    grid: PriceGrid | null = null;
    // hidden layers take no lane space
    lanes: Partial<Record<TLayerId, ILaneBounds>> | null = null;
    showText = true;
    // bump when the projection changes so lanes can invalidate cached rows
    version = 0;
    private series: ISeriesApi<"Candlestick"> | null = null;
    private chart: IChartApi | null = null;
    private readonly gutterWidth: () => number;
    private readonly visibleLayers: () => TLayerId[];
    private signature = "";

    // lanes ordered left to right
    constructor(gutterWidth: () => number, visibleLayers: () => TLayerId[]) {
        this.gutterWidth = gutterWidth;
        this.visibleLayers = visibleLayers;
    }

    bind(chart: IChartApi, series: ISeriesApi<"Candlestick">): void {
        this.chart = chart;
        this.series = series;
    }

    y(price: number): number | null {
        return this.series?.priceToCoordinate(price) ?? null;
    }

    refresh(): void {
        if (!this.chart || !this.series) {
            return;
        }
        const size = this.chart.paneSize(0);
        const top = this.series.coordinateToPrice(0);
        const bottom = this.series.coordinateToPrice(size.height);
        const gutter = Math.min(this.gutterWidth(), Math.floor(size.width * 0.4));
        const layers = this.visibleLayers();
        const signature = `${size.width}:${size.height}:${top}:${bottom}:${gutter}:${layers}`;
        if (signature === this.signature) {
            return;
        }
        this.signature = signature;
        this.version++;
        this.paneWidth = size.width;
        this.paneHeight = size.height;

        if (top === null || bottom === null || size.height <= 0) {
            this.grid = null;
            this.lanes = null;
            return;
        }
        this.topPrice = Math.max(top, bottom);
        this.bottomPrice = Math.min(top, bottom);

        const previous = this.grid;
        const next = chooseGrid(this.topPrice - this.bottomPrice, size.height);
        this.grid = previous && previous.key() === next.key() ? previous : next;

        const gutterLeft = size.width - gutter;
        const gaps = LEADING_GAP + TRAILING_GAP + LANE_GAP * (layers.length - 1);
        const laneWidth = layers.length > 0 ? (gutter - gaps) / layers.length : 0;
        this.lanes = {};
        let x = gutterLeft + LEADING_GAP;
        layers.forEach((layer, index) => {
            const isFirst = index === 0;
            const isLast = index === layers.length - 1;
            this.lanes![layer] = {
                x0: x,
                x1: x + laneWidth,
                left: isFirst ? gutterLeft : x - LANE_GAP / 2,
                right: isLast ? size.width : x + laneWidth + LANE_GAP / 2
            };
            x += laneWidth + LANE_GAP;
        });
        this.gutterLeft = gutterLeft;
        this.showText = laneWidth >= 60;
    }

    private gutterLeft = 0;

    gutterStart(): number {
        return this.lanes ? this.gutterLeft : this.paneWidth;
    }
}

export interface ILaneTheme {
    palette: IOverlayPalette;
    textColor: string;
    // cover the header and footer with the chart background
    background: string;
}

// keep labels clear, do not draw or hit rows underneath
const HEADER_PX = 30;
const FOOTER_PX = 16;

// subclasses supply buckets, amounts and colors, this handles geometry and drawing
export abstract class ProfileLanePrimitive<
    TBucket extends {
        index: number;
        priceFrom: number;
        priceTo: number;
    }
> implements ISeriesPrimitive<Time> {
    readonly layer: TLayerId;
    protected readonly viewport: ProfileViewport;
    protected rows: IProfileRow<TBucket>[] = [];
    protected maxValue = 0;
    protected aboveValue = 0;
    protected belowValue = 0;
    protected visible = true;
    protected hoveredIndex: number | null = null;
    protected highlight: IHighlight | null = null;
    protected message: string | null = null;
    protected theme: ILaneTheme;
    private requestUpdate: (() => void) | null = null;
    private dataVersion = 0;
    private builtVersion = -1;
    private builtViewport = -1;
    private readonly views: readonly IPrimitivePaneView[];
    private axisViews: readonly ISeriesPrimitiveAxisView[] = [];

    constructor(layer: TLayerId, viewport: ProfileViewport, theme: ILaneTheme) {
        this.layer = layer;
        this.viewport = viewport;
        this.theme = theme;
        const guide: IPrimitivePaneView = {
            zOrder: () => "bottom",
            renderer: () => ({ draw: (target) => this.drawGuide(target) })
        };
        const bars: IPrimitivePaneView = {
            zOrder: () => "normal",
            renderer: () => ({ draw: (target) => this.drawLane(target) })
        };
        this.views = [guide, bars];
    }

    protected abstract buckets(grid: PriceGrid): readonly TBucket[] | null;
    protected abstract rowValue(bucket: TBucket): number;
    protected abstract segments(bucket: TBucket, maxValue: number): ISegment[];
    protected abstract title(): string;
    protected abstract formatValue(value: number): string;

    invalidate(): void {
        this.dataVersion++;
        this.requestUpdate?.();
    }

    setVisible(visible: boolean): void {
        if (this.visible !== visible) {
            this.visible = visible;
            this.requestUpdate?.();
        }
    }

    setTheme(theme: ILaneTheme): void {
        this.theme = theme;
        this.requestUpdate?.();
    }

    setHovered(index: number | null): void {
        if (this.hoveredIndex !== index) {
            this.hoveredIndex = index;
            this.requestUpdate?.();
        }
    }

    setHighlight(highlight: IHighlight | null): void {
        this.highlight = highlight?.layer === this.layer ? highlight : null;
        this.axisViews = this.highlight ? this.createAxisViews(this.highlight) : [];
        this.requestUpdate?.();
    }

    setMessage(message: string | null): void {
        if (this.message !== message) {
            this.message = message;
            this.requestUpdate?.();
        }
    }

    rowAt(x: number, y: number): IProfileRow<TBucket> | null {
        const lane = this.viewport.lanes?.[this.layer];
        if (!this.visible || !lane || x < lane.x0 - 2 || x > lane.x1 + 2) {
            return null;
        }
        if (this.viewport.showText && (y < HEADER_PX || y > this.viewport.paneHeight - FOOTER_PX)) {
            return null;
        }
        for (const row of this.rows) {
            if (y >= row.top - 1 && y <= row.bottom + 1) {
                return row;
            }
        }
        return null;
    }

    visibleRows(): readonly IProfileRow<TBucket>[] {
        return this.visible ? this.rows : [];
    }

    attached(param: SeriesAttachedParameter<Time>): void {
        this.requestUpdate = param.requestUpdate;
    }

    detached(): void {
        this.requestUpdate = null;
    }

    updateAllViews(): void {
        this.viewport.refresh();
        const grid = this.viewport.grid;
        if (!grid) {
            this.rows = [];
            return;
        }
        if (this.builtViewport !== this.viewport.version || this.builtVersion !== this.dataVersion) {
            this.build(grid);
        }
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this.views;
    }

    priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
        return this.axisViews;
    }

    hitTest(x: number, y: number): PrimitiveHoveredItem | null {
        const row = this.rowAt(x, y);
        if (!row) {
            return null;
        }
        return {
            externalId: `${this.layer}:${row.index}`,
            zOrder: "normal",
            cursorStyle: "pointer",
            hitTestPriority: 0,
            itemType: "primitive"
        };
    }

    private build(grid: PriceGrid): void {
        this.builtVersion = this.dataVersion;
        this.builtViewport = this.viewport.version;
        this.rows = [];
        this.maxValue = 0;
        this.aboveValue = 0;
        this.belowValue = 0;

        const buckets = this.buckets(grid);
        if (!buckets) {
            return;
        }
        const { topPrice, bottomPrice, paneHeight } = this.viewport;

        for (const bucket of buckets) {
            const value = this.rowValue(bucket);
            if (value <= 0) {
                continue;
            }
            if (bucket.priceFrom >= topPrice) {
                this.aboveValue += value;
                continue;
            }
            if (bucket.priceTo <= bottomPrice) {
                this.belowValue += value;
                continue;
            }
            const a = this.viewport.y(bucket.priceTo);
            const b = this.viewport.y(bucket.priceFrom);
            if (a === null || b === null) {
                continue;
            }
            const top = Math.max(0, Math.min(a, b));
            const bottom = Math.min(paneHeight, Math.max(a, b));
            if (bottom - top < 0.5) {
                continue;
            }
            this.rows.push({ bucket, index: bucket.index, top, bottom, value });
            this.maxValue = Math.max(this.maxValue, value);
        }
    }

    private drawGuide(target: TRenderTarget): void {
        const highlight = this.highlight;
        if (!this.visible || !highlight || !this.viewport.lanes) {
            return;
        }
        const a = this.viewport.y(highlight.priceTo);
        const b = this.viewport.y(highlight.priceFrom);
        if (a === null || b === null) {
            return;
        }
        target.useMediaCoordinateSpace(({ context }) => {
            const top = Math.min(a, b);
            const height = Math.max(1, Math.abs(b - a));
            context.globalAlpha = 0.07;
            context.fillStyle = this.theme.palette.selection;
            context.fillRect(0, top, this.viewport.gutterStart(), height);
        });
    }

    private drawLane(target: TRenderTarget): void {
        const lane = this.viewport.lanes?.[this.layer];
        if (!lane) {
            return;
        }
        target.useMediaCoordinateSpace(({ context }) => {
            if (!this.visible) {
                return;
            }
            this.drawBackground(context, lane);
            this.drawRows(context, lane);
            this.drawHighlight(context, lane);
            this.drawLabels(context, lane);
            if (this.rows.length === 0) {
                this.drawCenteredText(context, lane, this.message ?? "None in view");
            }
        });
    }

    private drawBackground(context: TCanvasContext, lane: ILaneBounds): void {
        const { palette } = this.theme;
        const { paneHeight } = this.viewport;
        context.fillStyle = palette.laneBackground;
        context.fillRect(lane.left, 0, lane.right - lane.left, paneHeight);
        if (lane.left === this.viewport.gutterStart()) {
            context.fillStyle = palette.laneDivider;
            context.fillRect(Math.round(lane.left), 0, 1, paneHeight);
        }
    }

    private drawRows(context: TCanvasContext, lane: ILaneBounds): void {
        const width = lane.x1 - lane.x0;
        for (const row of this.rows) {
            const height = row.bottom - row.top;
            const drawHeight = height >= 3 ? height - 1 : Math.max(1, height);
            let x = lane.x1;
            for (const segment of this.segments(row.bucket, this.maxValue)) {
                const length = segment.length * width;
                if (length <= 0) {
                    continue;
                }
                context.globalAlpha = segment.alpha;
                context.fillStyle = segment.color;
                context.fillRect(x - length, row.top, length, drawHeight);
                x -= length;
            }
            if (row.index === this.hoveredIndex) {
                context.globalAlpha = 0.9;
                context.strokeStyle = this.theme.palette.selection;
                context.lineWidth = 1;
                context.strokeRect(lane.x0 - 1.5, row.top - 0.5, width + 3, Math.max(2, height));
            }
        }
        context.globalAlpha = 1;
    }

    private drawHighlight(context: TCanvasContext, lane: ILaneBounds): void {
        if (!this.highlight) {
            return;
        }
        const a = this.viewport.y(this.highlight.priceTo);
        const b = this.viewport.y(this.highlight.priceFrom);
        if (a === null || b === null) {
            return;
        }
        context.globalAlpha = 1;
        context.strokeStyle = this.theme.palette.selection;
        context.lineWidth = 1.5;
        context.strokeRect(
            lane.x0 - 2.5,
            Math.min(a, b) - 1,
            lane.x1 - lane.x0 + 5,
            Math.max(3, Math.abs(b - a) + 2)
        );
    }

    private drawLabels(context: TCanvasContext, lane: ILaneBounds): void {
        if (!this.viewport.showText) {
            return;
        }
        const { paneHeight } = this.viewport;
        const left = lane.left;
        const width = lane.right - lane.left;
        context.globalAlpha = 1;
        context.fillStyle = this.theme.background;
        context.fillRect(left, 0, width, HEADER_PX);
        context.fillRect(left, paneHeight - FOOTER_PX, width, FOOTER_PX);

        context.font = "10px ui-sans-serif, system-ui, sans-serif";
        context.fillStyle = this.theme.textColor;
        context.textBaseline = "top";
        context.textAlign = "left";
        const laneWidth = lane.x1 - lane.x0;
        context.fillText(this.title(), lane.x0, 4, laneWidth);

        // show scale on the left and offscreen total on the right
        // drop the scale first if the lane is too narrow
        const scale = this.maxValue > 0 ? `max ${this.formatValue(this.maxValue)}` : "";
        const above = this.aboveValue > 0 ? `▲ ${this.formatValue(this.aboveValue)}` : "";
        const fits = context.measureText(scale).width + context.measureText(above).width + 6 <= laneWidth;
        if (scale && (fits || !above)) {
            context.fillText(scale, lane.x0, 16, laneWidth);
        }
        context.textAlign = "right";
        if (above) {
            context.fillText(above, lane.x1, 16, laneWidth);
        }
        if (this.belowValue > 0) {
            context.textBaseline = "bottom";
            context.fillText(`▼ ${this.formatValue(this.belowValue)}`, lane.x1, paneHeight - 3);
        }
    }

    private drawCenteredText(context: TCanvasContext, lane: ILaneBounds, text: string) {
        context.globalAlpha = 1;
        context.font = "10px ui-sans-serif, system-ui, sans-serif";
        context.fillStyle = this.theme.textColor;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(text, (lane.x0 + lane.x1) / 2, this.viewport.paneHeight / 2, lane.x1 - lane.x0);
    }

    private createAxisViews(highlight: IHighlight): ISeriesPrimitiveAxisView[] {
        const label = (price: number): ISeriesPrimitiveAxisView => ({
            coordinate: () => this.viewport.y(price) ?? -1000,
            text: () => this.formatAxisPrice(price),
            textColor: () => this.theme.palette.laneDivider,
            backColor: () => this.theme.palette.selection,
            visible: () => this.visible && this.viewport.y(price) !== null
        });
        return [label(highlight.priceTo), label(highlight.priceFrom)];
    }

    protected formatAxisPrice(price: number): string {
        return String(price);
    }
}
