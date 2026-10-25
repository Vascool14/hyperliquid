// chart lifecycle, rendering and interaction live here, wire decoding stays in the data client

import {
    CandlestickSeries,
    createChart as createLightweightChart,
    LineStyle,
    type CandlestickData,
    type CandlestickSeriesPartialOptions,
    type ChartOptions,
    type DeepPartial,
    type IChartApi,
    type IPriceLine,
    type ISeriesApi,
    type MouseEventParams,
    type Time,
    type UTCTimestamp
} from "lightweight-charts";
import { ClientError, isSupportedCoin } from "./data/hydromancer-client";
import { INTERVAL_MS } from "./data/candles";
import { createStatus } from "./data/status";
import {
    aggregateLiquidations,
    aggregateTpsl,
    PriceGrid,
    type ILiquidationProfile,
    type ITpslProfile
} from "./model/aggregate";
import {
    isSameSelection,
    orderSignature,
    resolveLiquidationSelection,
    resolveTpslSelection,
    type ISelectionKey
} from "./model/selection";
import { groupEventsByCandle, type IEventGroup } from "./model/events";
import { formatUsd, priceDecimals } from "./rendering/format";
import {
    Inspector,
    type ICandleSummary,
    type IInspectorContext,
    type TLevelSummary
} from "./rendering/inspector";
import { LiquidationPrimitive } from "./rendering/liquidation-primitive";
import { ProfileViewport, type ILaneTheme, type TLayerId } from "./rendering/profile-geometry";
import { EventDotsPrimitive, type IEventDot } from "./rendering/event-dots-primitive";
import { ensureStyles } from "./rendering/styles";
import { TpslPrimitive } from "./rendering/tpsl-primitive";
import { THEMES } from "./themes";
import {
    CANDLE_INTERVALS,
    type ICandleBar,
    type TCandleInterval,
    type ICandleView,
    type TChartErrorCode,
    type TChartEvent,
    type IChartHandle,
    type TChartListener,
    type IChartState,
    type TDatasetName,
    type IDataStatus,
    type ILayerOptions,
    type IHydromancerChartOptions,
    type THydromancerChartUpdateOptions,
    type IMarketView,
    type IOverlayPalette,
    type TSelection,
    type TThemeName
} from "./types";

export class ChartError extends Error {
    readonly code: TChartErrorCode;

    constructor(code: TChartErrorCode, message: string) {
        super(message);
        this.name = "ChartError";
        this.code = code;
    }
}

export const DEFAULT_LAYERS: ILayerOptions = {
    liquidations: { visible: true, minPositionNotional: 100_000 },
    tpsl: {
        visible: true,
        metric: "count",
        showTakeProfit: true,
        showStopLoss: true,
        showBuy: true,
        showSell: true
    },
    liquidationEvents: { visible: true, minNotional: 50_000 },
    markPrice: { visible: true }
};

const DEFAULT_PROFILE_WIDTH = 220;
// use Lightweight Charts' candle spacing unless the host overrides it
const DEFAULT_BAR_SPACING = 6;
// show a dollar label once a bubble reaches this multiple of minNotional
const EVENT_LABEL_MULTIPLE = 5;
const NARROW_WIDTH = 560;

type TPlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is TPlainObject {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype
    );
}

// later values win, only plain objects get merged
export function mergeOptions<T>(...sources: unknown[]): T {
    const out: TPlainObject = {};
    for (const source of sources) {
        if (!isPlainObject(source)) {
            continue;
        }
        for (const [key, value] of Object.entries(source)) {
            if (value === undefined) {
                continue;
            }
            out[key] =
                isPlainObject(value) && isPlainObject(out[key])
                    ? mergeOptions(out[key], value)
                    : isPlainObject(value)
                      ? mergeOptions(value)
                      : value;
        }
    }
    return out as T;
}

interface IPendingLoad {
    resolve: () => void;
    reject: (error: ChartError) => void;
}

export function createChart(element: HTMLElement, options: IHydromancerChartOptions): IChartHandle {
    if (!(element instanceof HTMLElement)) {
        throw new TypeError("createChart requires a host HTMLElement.");
    }
    if (!isSupportedCoin(options.coin)) {
        throw new ChartError("unsupported-market", `Invalid coin ${options.coin}.`);
    }
    const initialInterval = options.interval ?? "15m";
    if (!CANDLE_INTERVALS.includes(initialInterval)) {
        throw new ChartError("unsupported-interval", `Unsupported interval ${initialInterval}.`);
    }

    const doc = element.ownerDocument;
    const client = options.data;
    let disposed = false;
    ensureStyles(doc);

    let themeName: TThemeName = options.theme ?? "dark";
    let layers = mergeOptions<ILayerOptions>(DEFAULT_LAYERS, options.layers);
    let hostChart = options.chart ?? {};
    let hostCandles = options.candlestick ?? {};
    let hostPalette = options.palette ?? {};
    let profileWidth = options.profileWidth ?? DEFAULT_PROFILE_WIDTH;
    let showStatusBar = options.showStatusBar ?? true;
    let showLevelsButton = options.showLevelsButton ?? true;
    const targetGutter = () => Math.round((profileWidth * visibleLayers().length) / 2);
    let gutter = profileWidth;

    const palette = (): IOverlayPalette => ({
        ...THEMES[themeName].palette,
        ...hostPalette
    });
    const laneTheme = (): ILaneTheme => ({
        palette: palette(),
        textColor: THEMES[themeName].css["--hlc-muted"] ?? "#888",
        background: THEMES[themeName].css["--hlc-bg"] ?? "#000"
    });

    const root = doc.createElement("div");
    root.className = "hlc-root";
    const chartArea = doc.createElement("div");
    chartArea.className = "hlc-chart";
    root.append(chartArea);
    element.append(root);

    const applyCssVariables = () => {
        for (const [name, value] of Object.entries(THEMES[themeName].css)) {
            root.style.setProperty(name, value);
        }
    };
    applyCssVariables();

    // apply sizing and gutter constraints last so host options cannot override them
    // leave rightOffsetPixels to syncGutter, reapplying it here would jump back to the live edge
    const chartOptions = (): DeepPartial<ChartOptions> =>
        mergeOptions(THEMES[themeName].chart, hostChart, { autoSize: true });
    const chart: IChartApi = createLightweightChart(
        chartArea,
        mergeOptions(chartOptions(), { timeScale: { rightOffsetPixels: gutter } })
    );

    let pricePrecision: number | null = null;
    const candleOptions = (): CandlestickSeriesPartialOptions => {
        const precision = pricePrecision ?? 2;
        return mergeOptions(
            THEMES[themeName].candlestick,
            {
                priceFormat: {
                    type: "price",
                    precision,
                    minMove: 10 ** -precision
                }
            },
            hostCandles
        );
    };
    const series: ISeriesApi<"Candlestick"> = chart.addSeries(CandlestickSeries, candleOptions());

    const visibleLayers = (): TLayerId[] => {
        const visible: TLayerId[] = [];
        if (layers.tpsl.visible) {
            visible.push("tpsl");
        }
        if (layers.liquidations.visible) {
            visible.push("liquidations");
        }
        return visible;
    };
    const viewport = new ProfileViewport(() => gutter, visibleLayers);
    viewport.bind(chart, series);

    let market: IMarketView | null = null;
    let candles: ICandleView | null = null;

    let liquidationProfileCache: { key: string; profile: ILiquidationProfile } | null = null;
    let tpslProfileCache: { key: string; profile: ITpslProfile } | null = null;

    const liquidationProfile = (grid: PriceGrid): ILiquidationProfile | null => {
        const snapshot = market?.positions() ?? null;
        if (!snapshot) {
            return null;
        }
        const min = layers.liquidations.minPositionNotional;
        const key = `${snapshot.coin}:${snapshot.snapshotId}:${snapshot.sourceTimeMs}:${min}:${grid.key()}`;
        if (liquidationProfileCache?.key !== key || liquidationProfileCache.profile.grid !== grid) {
            liquidationProfileCache = {
                key,
                profile: aggregateLiquidations(snapshot.positions, min, grid)
            };
        }
        return liquidationProfileCache.profile;
    };

    const tpslProfile = (grid: PriceGrid): ITpslProfile | null => {
        if (!market || market.tpslHeight() === null) {
            return null;
        }
        const filter = layers.tpsl;
        const key = [
            market.coin,
            market.ordersVersion(),
            filter.showTakeProfit,
            filter.showStopLoss,
            filter.showBuy,
            filter.showSell,
            grid.key()
        ].join(":");
        if (tpslProfileCache?.key !== key) {
            tpslProfileCache = {
                key,
                profile: aggregateTpsl(market.orders().values(), filter, grid)
            };
        }
        return tpslProfileCache.profile;
    };

    const liquidationPrimitive = new LiquidationPrimitive(viewport, laneTheme(), liquidationProfile);
    const tpslPrimitive = new TpslPrimitive(viewport, laneTheme(), tpslProfile);
    // attach dots first so the profile lanes can paint over them in the gutter
    const eventDots = new EventDotsPrimitive();
    series.attachPrimitive(eventDots);
    series.attachPrimitive(liquidationPrimitive);
    series.attachPrimitive(tpslPrimitive);

    const applyLayerOptions = () => {
        liquidationPrimitive.setVisible(layers.liquidations.visible);
        tpslPrimitive.setVisible(layers.tpsl.visible);
        tpslPrimitive.setMetric(layers.tpsl.metric);
        liquidationPrimitive.invalidate();
        tpslPrimitive.invalidate();
        inspector.setLegendLayers(layers.liquidations.visible, layers.tpsl.visible);
    };

    let markLine: IPriceLine | null = null;

    const listeners = new Set<TChartListener>();
    const emit = (event: TChartEvent) => {
        for (const listener of listeners) {
            try {
                listener(event);
            } catch (error) {
                console.error("[hydromancer-charts] subscriber failed", error);
            }
        }
    };

    let selectionKey: ISelectionKey | null = null;
    let selection: TSelection | null = null;

    const resolveSelection = (): TSelection | null => {
        if (!selectionKey || !market) {
            return null;
        }
        return selectionKey.layer === "liquidations"
            ? resolveLiquidationSelection(
                  selectionKey,
                  market.positions(),
                  layers.liquidations.minPositionNotional
              )
            : resolveTpslSelection(selectionKey, market.orders().values(), layers.tpsl, market.tpslHeight());
    };

    const refreshSelection = (force = false) => {
        const next = resolveSelection();
        const changed = force || !isSameSelection(selection, next);
        selection = next;
        const highlight = next
            ? {
                  layer: next.layer,
                  priceFrom: next.priceFrom,
                  priceTo: next.priceTo
              }
            : null;
        liquidationPrimitive.setHighlight(highlight);
        tpslPrimitive.setHighlight(highlight);

        if (!next) {
            inspector.hideCard();
        } else if (changed) {
            inspector.showCard(next, inspectorContext(), cardInset());
        }
        if (changed) {
            emit({ type: "selection", selection: next });
        }
    };

    const selectLevel = (layer: TLayerId, index: number) => {
        const grid = viewport.grid;
        if (!grid || !market) {
            return;
        }
        selectionKey = {
            layer,
            coin: market.coin,
            grid,
            fromIndex: index,
            toIndex: index,
            initialVersion: null
        };
        const resolved = resolveSelection();
        selectionKey.initialVersion =
            resolved?.layer === "tpsl" ? orderSignature(resolved.orders) : (resolved?.sourceVersion ?? null);
        refreshSelection(true);
    };

    const clearSelection = () => {
        if (selectionKey) {
            selectionKey = null;
            refreshSelection(true);
        }
    };

    const inspector = new Inspector({
        root,
        chartArea,
        palette: palette(),
        callbacks: {
            onSelectLevel: (level: TLevelSummary) => selectLevel(level.layer, level.bucket.index),
            onCloseCard: clearSelection
        }
    });
    root.insertBefore(inspector.statusBar, chartArea);
    inspector.statusBar.hidden = !showStatusBar;
    inspector.setLevelsButtonVisible(showLevelsButton);

    const cardInset = () => gutter + chart.priceScale("right").width() + 8;

    const statusSnapshot = (): Record<TDatasetName, IDataStatus> => ({
        candles: candles?.status() ?? createStatus(),
        positions: market?.status("positions") ?? createStatus(),
        tpsl: market?.status("tpsl") ?? createStatus(),
        mark: market?.status("mark") ?? createStatus(),
        events: market?.status("events") ?? createStatus()
    });

    const inspectorContext = (): IInspectorContext => ({
        coin: market?.coin ?? options.coin,
        markPx: market?.markPx() ?? null,
        now: Date.now(),
        status: statusSnapshot(),
        minPositionNotional: layers.liquidations.minPositionNotional
    });

    let frame: number | null = null;
    let candleReset = false;
    let candleUpdate = false;
    let marketDirty = false;
    let lastStatusKey = "";

    const scheduleFrame = () => {
        if (frame === null && !disposed) {
            frame = requestAnimationFrame(runFrame);
        }
    };

    const toChartBar = (bar: ICandleBar): CandlestickData<UTCTimestamp> => ({
        time: Math.floor(bar.timeMs / 1000) as UTCTimestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close
    });

    function runFrame() {
        frame = null;
        if (disposed) {
            return;
        }
        if (candles && (candleReset || candleUpdate)) {
            applyCandles();
        }
        if (marketDirty) {
            marketDirty = false;
            liquidationPrimitive.invalidate();
            tpslPrimitive.invalidate();
            updateMarkLine();
            refreshSelection();
        }
        updateEventDots();
        updateCandleTip();
        updateLaneMessages();
        updateStatus();
        root.toggleAttribute("data-narrow", root.clientWidth < NARROW_WIDTH);
        inspector.setLevels(collectLevels(), inspectorContext());
    }

    function applyCandles() {
        const bars = candles!.bars();
        const last = bars[bars.length - 1];
        if (pricePrecision === null && last && !hostCandles.priceFormat) {
            pricePrecision = priceDecimals(last.close);
            series.applyOptions(candleOptions());
        }
        if (candleReset) {
            // setData keeps the logical range so the user's viewport stays put
            series.setData(bars.map(toChartBar));
        } else if (last) {
            try {
                series.update(toChartBar(last));
            } catch {
                series.setData(bars.map(toChartBar));
            }
        }
        candleReset = false;
        candleUpdate = false;
    }

    // one dot per candle and liquidated side, regroup when events, bars or options change
    // dots follow the high and low of the candle as it forms
    let eventGroupsKey = "";
    let eventGroups: IEventGroup[] = [];
    let eventDotsKey = "";

    function updateEventDots() {
        const options = layers.liquidationEvents;
        const bars = candles?.bars() ?? [];
        // move the cutoff once per candle instead of regrouping every frame
        const cutoffMs =
            options.historyMs === undefined
                ? -Infinity
                : Math.floor((Date.now() - options.historyMs) / INTERVAL_MS[interval]) *
                  INTERVAL_MS[interval];
        const key = [
            market?.coin,
            market?.eventsVersion() ?? -1,
            bars.length,
            bars[0]?.timeMs,
            bars[bars.length - 1]?.timeMs,
            interval,
            options.visible,
            options.minNotional,
            cutoffMs,
            themeName,
            hostPalette.long,
            hostPalette.short
        ].join(":");
        const last = bars[bars.length - 1];
        const dotsKey = `${key}:${last?.high}:${last?.low}`;
        if (dotsKey === eventDotsKey) {
            return;
        }
        eventDotsKey = dotsKey;

        if (!options.visible || !market || bars.length === 0) {
            eventGroups = [];
            eventGroupsKey = key;
            eventDots.setDots([], options.minNotional);
            return;
        }
        const barsByTime = new Map(bars.map((bar) => [bar.timeMs, bar]));
        if (key !== eventGroupsKey) {
            eventGroupsKey = key;
            eventGroups = groupEventsByCandle(
                market.events().filter((event) => event.timeMs >= cutoffMs),
                new Set(barsByTime.keys()),
                INTERVAL_MS[interval],
                options.minNotional
            );
        }
        const colors = palette();
        const labelFrom = options.minNotional * EVENT_LABEL_MULTIPLE;
        const dots: IEventDot[] = [];
        for (const group of eventGroups) {
            const bar = barsByTime.get(group.candleTimeMs)!;
            dots.push({
                group,
                time: Math.floor(group.candleTimeMs / 1000) as UTCTimestamp,
                high: bar.high,
                low: bar.low,
                color: group.side === "long" ? colors.long : colors.short,
                label: group.notional >= labelFrom ? formatUsd(group.notional) : null
            });
        }
        eventDots.setDots(dots, options.minNotional);
    }

    function updateMarkLine() {
        const markPx = market?.markPx() ?? null;
        if (!layers.markPrice.visible || markPx === null) {
            if (markLine) {
                series.removePriceLine(markLine);
                markLine = null;
            }
            return;
        }
        if (!markLine) {
            markLine = series.createPriceLine({
                price: markPx,
                color: palette().mark,
                lineWidth: 1,
                lineStyle: LineStyle.Dotted,
                axisLabelVisible: true,
                title: "Mark"
            });
            return;
        }
        markLine.applyOptions({ price: markPx, color: palette().mark });
    }

    function laneMessage(dataset: IDataStatus, filtered: string): string | null {
        switch (dataset.state) {
            case "loading":
            case "idle":
                return "Loading…";
            case "waiting-for-quota":
                return "Waiting for quota";
            case "unavailable":
                return "Unavailable";
            case "error":
                return "Failed to load";
            default:
                return filtered;
        }
    }

    function updateLaneMessages() {
        const min = layers.liquidations.minPositionNotional;
        liquidationPrimitive.setMessage(
            laneMessage(
                market?.status("positions") ?? createStatus(),
                min > 0 ? `None ≥ $${compact(min)} in view` : "None in view"
            )
        );
        tpslPrimitive.setMessage(laneMessage(market?.status("tpsl") ?? createStatus(), "None in view"));
    }

    function updateStatus() {
        const status = statusSnapshot();
        const key = (Object.keys(status) as TDatasetName[])
            .map((name) => {
                const s = status[name];
                return `${name}:${s.state}:${s.reason}:${s.version}:${s.retryAtMs}`;
            })
            .join("|");
        if (showStatusBar) {
            inspector.renderStatus(inspectorContext());
        }
        if (key !== lastStatusKey) {
            lastStatusKey = key;
            emit({ type: "status", status });
            checkPendingLoads(status);
        }
    }

    function collectLevels(): TLevelSummary[] {
        const levels: TLevelSummary[] = [];
        for (const row of liquidationPrimitive.visibleRows()) {
            levels.push({ layer: "liquidations", bucket: row.bucket });
        }
        for (const row of tpslPrimitive.visibleRows()) {
            levels.push({ layer: "tpsl", bucket: row.bucket });
        }
        return levels;
    }

    const hitLevel = (x: number, y: number): TLevelSummary | null => {
        const liq = liquidationPrimitive.rowAt(x, y);
        if (liq) {
            return { layer: "liquidations", bucket: liq.bucket };
        }
        const tpsl = tpslPrimitive.rowAt(x, y);
        return tpsl ? { layer: "tpsl", bucket: tpsl.bucket } : null;
    };

    const onCrosshairMove = (param: MouseEventParams<Time>) => {
        const point = param.point;
        const group = point ? eventDots.groupAt(point.x, point.y) : null;
        if (group && point) {
            inspector.showEventTooltip(group, point.x, point.y, interval);
            return;
        }
        const level = point ? hitLevel(point.x, point.y) : null;
        liquidationPrimitive.setHovered(level?.layer === "liquidations" ? level.bucket.index : null);
        tpslPrimitive.setHovered(level?.layer === "tpsl" ? level.bucket.index : null);
        if (!level || !point) {
            inspector.hideTooltip();
            return;
        }
        inspector.showTooltip(level, point.x, point.y, inspectorContext());
    };

    // allow a few pixels around flat candles so they can still be hit
    const hitCandle = (param: MouseEventParams<Time>): ICandleBar | null => {
        const point = param.point;
        if (!point || param.time === undefined) {
            return null;
        }
        const timeMs = (param.time as number) * 1000;
        const bar = candles?.bars().find((candle) => candle.timeMs === timeMs);
        const x = chart.timeScale().timeToCoordinate(param.time);
        const top = bar ? series.priceToCoordinate(bar.high) : null;
        const bottom = bar ? series.priceToCoordinate(bar.low) : null;
        if (!bar || x === null || top === null || bottom === null) {
            return null;
        }
        // param.time already picks the nearest candle, allow for thin candles and pixel rounding
        const halfWidth = chart.timeScale().options().barSpacing / 2 + 1;
        const inColumn = Math.abs(point.x - x) <= halfWidth;
        const inBody = point.y >= top - 3 && point.y <= bottom + 3;
        return inColumn && inBody ? bar : null;
    };

    // anchor the pinned tooltip to time and price so it follows the candle when scrolling or zooming
    let candleTip: { timeMs: number; price: number } | null = null;

    const candleSummary = (bar: ICandleBar): ICandleSummary => {
        const intervalMs = INTERVAL_MS[interval];
        const longs = { notional: 0, fills: 0 };
        const shorts = { notional: 0, fills: 0 };
        for (const event of market?.events() ?? []) {
            if (Math.floor(event.timeMs / intervalMs) * intervalMs !== bar.timeMs) {
                continue;
            }
            const side = event.side === "long" ? longs : shorts;
            side.notional += event.notional;
            side.fills += 1;
        }
        return { coin, interval, bar, longs, shorts };
    };

    function updateCandleTip() {
        if (!candleTip) {
            return;
        }
        const { timeMs, price } = candleTip;
        const bar = candles?.bars().find((candle) => candle.timeMs === timeMs);
        const x = chart.timeScale().timeToCoordinate((timeMs / 1000) as UTCTimestamp);
        const y = series.priceToCoordinate(price);
        const width = chart.paneSize(0).width;
        if (!bar || x === null || y === null || x < 0 || x > width - gutter) {
            inspector.hideCandleTip();
            return;
        }
        inspector.showCandleTip(candleSummary(bar), x, y);
    }

    function clearCandleTip() {
        candleTip = null;
        inspector.hideCandleTip();
    }

    const onClick = (param: MouseEventParams<Time>) => {
        const point = param.point;
        if (!point) {
            return;
        }
        const level = hitLevel(point.x, point.y);
        if (level) {
            inspector.hideTooltip();
            clearCandleTip();
            selectLevel(level.layer, level.bucket.index);
            return;
        }
        clearSelection();
        const bar = hitCandle(param);
        const price = series.coordinateToPrice(point.y);
        if (!bar || price === null) {
            clearCandleTip();
            return;
        }
        candleTip = { timeMs: bar.timeMs, price };
        updateCandleTip();
    };

    // scrollToRealTime uses the bar offset, restore the pixel gutter afterwards
    const scrollToLatest = () => {
        const spacing = chart.timeScale().options().barSpacing;
        chart.timeScale().scrollToPosition(gutter / spacing, false);
    };

    chart.subscribeCrosshairMove(onCrosshairMove);
    chart.subscribeClick(onClick);
    chart.subscribeDblClick(scrollToLatest);
    chart.timeScale().subscribeVisibleLogicalRangeChange(updateCandleTip);

    // keep the gutter aligned with the plot width
    const syncGutter = () => {
        const width = chart.paneSize(0).width;
        const next = Math.max(0, Math.min(targetGutter(), Math.floor(width * 0.4)));
        if (next !== gutter) {
            // keep the user's place unless they were already at the live edge
            const timeScale = chart.timeScale();
            const spacing = timeScale.options().barSpacing;
            const position = timeScale.scrollPosition();
            const atLiveEdge = Math.abs(position - gutter / spacing) < 0.5;
            gutter = next;
            chart.applyOptions({ timeScale: { rightOffsetPixels: gutter } });
            if (!atLiveEdge) {
                timeScale.scrollToPosition(position, false);
            }
        }
        scheduleFrame();
    };
    chart.timeScale().subscribeSizeChange(syncGutter);
    applyLayerOptions();
    syncGutter();

    const statusTimer = setInterval(() => {
        if (showStatusBar) {
            inspector.renderStatus(inspectorContext());
        }
    }, 1000);

    let coin = options.coin;
    let interval: TCandleInterval = initialInterval;
    let marketUnsubscribe: (() => void) | null = null;
    let candleUnsubscribe: (() => void) | null = null;
    let pendingLoads: IPendingLoad[] = [];

    const onMarketChange = () => {
        marketDirty = true;
        scheduleFrame();
    };

    function acquireMarket(nextCoin: string) {
        marketUnsubscribe?.();
        market?.release();
        market = client.acquireMarket(nextCoin);
        marketUnsubscribe = market.subscribe(onMarketChange);
        liquidationProfileCache = null;
        tpslProfileCache = null;
        marketDirty = true;
    }

    function acquireCandles(nextCoin: string, nextInterval: TCandleInterval) {
        candleUnsubscribe?.();
        candles?.release();
        candles = client.acquireCandles(nextCoin, nextInterval);
        candleUnsubscribe = candles.subscribe((change) => {
            if (change === "reset") {
                candleReset = true;
            } else if (change === "update") {
                candleUpdate = true;
            }
            scheduleFrame();
        });
        candleReset = true;
    }

    // candles make the chart usable, overlays report their own status while snapshot quota recovers
    function checkPendingLoads(status: Record<TDatasetName, IDataStatus>) {
        const candleStatus = status.candles;
        if (candleStatus.state === "live") {
            const loads = pendingLoads;
            pendingLoads = [];
            for (const load of loads) {
                load.resolve();
            }
            return;
        }
        if (candleStatus.state === "unavailable") {
            failPendingLoads(
                new ChartError("permission-denied", candleStatus.detail ?? "Candles are unavailable.")
            );
        }
    }

    function failPendingLoads(error: ChartError) {
        const loads = pendingLoads;
        pendingLoads = [];
        for (const load of loads) {
            load.reject(error);
        }
        if (error.code !== "superseded" && error.code !== "disposed") {
            emit({ type: "error", code: error.code, message: error.message });
        }
    }

    function waitForLoad(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            pendingLoads.push({ resolve, reject });
            lastStatusKey = "";
            scheduleFrame();
        });
    }

    // clear the old price range when switching markets
    function resetCandleView() {
        series.setData([]);
        pricePrecision = hostCandles.priceFormat ? pricePrecision : null;
        chart.priceScale("right").setAutoScale(true);
    }

    acquireMarket(coin);
    acquireCandles(coin, interval);
    scheduleFrame();

    const assertAlive = () => {
        if (disposed) {
            throw new ChartError("disposed", "The chart was destroyed.");
        }
    };

    const handle: IChartHandle = {
        setMarket(nextCoin: string): Promise<void> {
            if (disposed) {
                return Promise.reject(new ChartError("disposed", "The chart was destroyed."));
            }
            if (!isSupportedCoin(nextCoin)) {
                return Promise.reject(new ChartError("unsupported-market", `Invalid coin ${nextCoin}.`));
            }
            if (nextCoin === coin) {
                return pendingLoads.length > 0 ? waitForLoad() : Promise.resolve();
            }
            failPendingLoads(new ChartError("superseded", `Superseded by ${nextCoin}.`));
            coin = nextCoin;
            selectionKey = null;
            refreshSelection(true);
            inspector.hideTooltip();
            clearCandleTip();
            resetCandleView();
            try {
                acquireMarket(nextCoin);
                acquireCandles(nextCoin, interval);
            } catch (error) {
                return Promise.reject(asChartError(error));
            }
            return waitForLoad();
        },

        setInterval(nextInterval: TCandleInterval): Promise<void> {
            if (disposed) {
                return Promise.reject(new ChartError("disposed", "The chart was destroyed."));
            }
            if (!CANDLE_INTERVALS.includes(nextInterval)) {
                return Promise.reject(
                    new ChartError("unsupported-interval", `Unsupported interval ${nextInterval}.`)
                );
            }
            if (nextInterval === interval) {
                return Promise.resolve();
            }
            failPendingLoads(new ChartError("superseded", `Superseded by ${nextInterval}.`));
            interval = nextInterval;
            clearCandleTip();
            series.setData([]);
            try {
                acquireCandles(coin, nextInterval);
            } catch (error) {
                return Promise.reject(asChartError(error));
            }
            return waitForLoad();
        },

        applyOptions(patch: THydromancerChartUpdateOptions): void {
            assertAlive();
            if (patch.theme !== undefined) {
                themeName = patch.theme;
            }
            if (patch.chart !== undefined) {
                hostChart = mergeOptions(hostChart, patch.chart);
            }
            if (patch.candlestick !== undefined) {
                hostCandles = mergeOptions(hostCandles, patch.candlestick);
            }
            if (patch.palette !== undefined) {
                hostPalette = { ...hostPalette, ...patch.palette };
            }
            if (patch.layers !== undefined) {
                layers = mergeOptions<ILayerOptions>(layers, patch.layers);
            }
            if (patch.profileWidth !== undefined) {
                profileWidth = patch.profileWidth;
            }
            if (patch.showStatusBar !== undefined) {
                showStatusBar = patch.showStatusBar;
                inspector.statusBar.hidden = !showStatusBar;
            }
            if (patch.showLevelsButton !== undefined) {
                showLevelsButton = patch.showLevelsButton;
                inspector.setLevelsButtonVisible(showLevelsButton);
            }

            applyCssVariables();
            chart.applyOptions(chartOptions());
            series.applyOptions(candleOptions());
            liquidationPrimitive.setTheme(laneTheme());
            tpslPrimitive.setTheme(laneTheme());
            inspector.setPalette(palette());
            applyLayerOptions();
            if (markLine) {
                series.removePriceLine(markLine);
                markLine = null;
            }
            updateMarkLine();
            syncGutter();
            refreshSelection(true);
        },

        // fitting all loaded history crushes candle width, restore the default spacing at the live edge instead
        fitContent(): void {
            assertAlive();
            const timeScale = chart.timeScale();
            timeScale.applyOptions({
                barSpacing: chartOptions().timeScale?.barSpacing ?? DEFAULT_BAR_SPACING
            });
            scrollToLatest();
            chart.priceScale("right").setAutoScale(true);
        },

        fitLevels(): void {
            assertAlive();
            const bars = candles?.bars() ?? [];
            const reference = market?.markPx() ?? bars[bars.length - 1]?.close;
            if (reference === undefined) {
                return;
            }
            scrollToLatest();
            const distance = exposureDistance(
                market?.positions()?.positions ?? [],
                reference,
                layers.liquidations.minPositionNotional
            );
            chart.priceScale("right").setAutoScale(false);
            chart.priceScale("right").setVisibleRange({
                from: reference * (1 - distance),
                to: reference * (1 + distance)
            });
        },

        scrollToLatest(): void {
            assertAlive();
            scrollToLatest();
        },

        toggleLevels(open?: boolean): void {
            assertAlive();
            inspector.toggleLevels(open);
        },

        select(next: TSelection | null): void {
            assertAlive();
            if (!next) {
                clearSelection();
                return;
            }
            const grid = PriceGrid.forStep(next.priceTo - next.priceFrom);
            const fromIndex = grid.index(next.priceFrom);
            selectionKey = {
                layer: next.layer,
                coin: next.coin,
                grid,
                fromIndex,
                toIndex: fromIndex,
                initialVersion: next.sourceVersion
            };
            refreshSelection(true);
        },

        getState(): IChartState {
            return {
                coin,
                interval,
                status: statusSnapshot(),
                markPx: market?.markPx() ?? null,
                selection,
                options: { theme: themeName, layers }
            };
        },

        subscribe(listener: TChartListener): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        destroy(): void {
            if (disposed) {
                return;
            }
            failPendingLoads(new ChartError("disposed", "The chart was destroyed."));
            disposed = true;
            if (frame !== null) {
                cancelAnimationFrame(frame);
                frame = null;
            }
            clearInterval(statusTimer);
            chart.unsubscribeCrosshairMove(onCrosshairMove);
            chart.unsubscribeClick(onClick);
            chart.unsubscribeDblClick(scrollToLatest);
            chart.timeScale().unsubscribeVisibleLogicalRangeChange(updateCandleTip);
            chart.timeScale().unsubscribeSizeChange(syncGutter);
            marketUnsubscribe?.();
            candleUnsubscribe?.();
            market?.release();
            candles?.release();
            market = null;
            candles = null;
            series.detachPrimitive(eventDots);
            series.detachPrimitive(liquidationPrimitive);
            series.detachPrimitive(tpslPrimitive);
            inspector.destroy();
            listeners.clear();
            chart.remove();
            root.remove();
        }
    };

    return handle;

    function asChartError(error: unknown): ChartError {
        if (error instanceof ChartError) {
            return error;
        }
        if (error instanceof ClientError) {
            return new ChartError(error.code, error.message);
        }
        return new ChartError("recovery-failed", String(error));
    }
}

// cover 60% of nearby exposure, limited to a price range between ±3% and ±20%
function exposureDistance(
    positions: readonly { liquidationPx: number | null; notional: number }[],
    reference: number,
    minNotional: number
): number {
    const near: { distance: number; notional: number }[] = [];
    let total = 0;
    for (const position of positions) {
        if (position.liquidationPx === null || position.notional < minNotional) {
            continue;
        }
        const distance = Math.abs(position.liquidationPx / reference - 1);
        if (distance <= 0.2) {
            near.push({ distance, notional: position.notional });
            total += position.notional;
        }
    }
    near.sort((a, b) => a.distance - b.distance);
    let covered = 0;
    for (const item of near) {
        covered += item.notional;
        if (covered >= total * 0.6) {
            return Math.max(0.03, item.distance * 1.05);
        }
    }
    return 0.05;
}

function compact(value: number): string {
    return value >= 1e6 ? `${value / 1e6}M` : `${value / 1e3}K`;
}
