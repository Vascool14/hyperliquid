import type {
    CandlestickSeriesPartialOptions,
    ChartOptions,
    DeepPartial,
    UTCTimestamp
} from "lightweight-charts";

export type { CandlestickSeriesPartialOptions, ChartOptions, DeepPartial, UTCTimestamp };

export type TCandleInterval = "15s" | "1m" | "5m" | "15m" | "1h";
export const CANDLE_INTERVALS: readonly TCandleInterval[] = ["15s", "1m", "5m", "15m", "1h"];

export type TThemeName = "dark" | "light";

export type TPositionSide = "long" | "short";

/** Hyperliquid uses A for sell and B for buy, this does not tell us TP or SL */
export type TOrderSide = "buy" | "sell";

export type TTriggerKind = "tp" | "sl" | "unknown";

export interface IPositionRecord {
    id: string;
    coin: string;
    address: string;
    side: TPositionSide;
    size: number;
    notional: number;
    entryPx: number;
    leverageType: "cross" | "isolated";
    leverage: number;
    /** liquidationPx is null when the provider gives no usable level, including NaN */
    liquidationPx: number | null;
    fundingPnl: number;
    /** account equity, not margin allocated to this position */
    accountValue: number | null;
}

/**
 * zero-size position orders close the whole position, so sizeKnown is false
 * inactive trailing stops have no triggerPx, check triggerCondition for their activation rule
 */
export interface ITriggerOrderRecord {
    id: string;
    coin: string;
    user: string;
    side: TOrderSide;
    kind: TTriggerKind;
    orderType: string;
    isTrailing: boolean;
    triggerPx: number | null;
    triggerPxRaw: string;
    limitPx: number | null;
    limitPxRaw: string;
    size: number;
    sizeRaw: string;
    sizeKnown: boolean;
    triggerCondition: string;
    isPositionTpsl: boolean;
    reduceOnly: boolean;
    createdMs: number | null;
}

/** the liquidated owner's forced fill, side refers to their position so a forced sell means long */
export interface ILiquidationEventRecord {
    id: string;
    coin: string;
    user: string;
    side: TPositionSide;
    timeMs: number;
    px: number;
    size: number;
    notional: number;
    markPx: number | null;
    method: string;
}

export type TDatasetName = "candles" | "positions" | "tpsl" | "mark" | "events";

export type TDataState =
    | "idle"
    | "loading"
    | "live"
    | "stale"
    | "reconnecting"
    | "resyncing"
    | "waiting-for-quota"
    | "unavailable"
    | "error";

export type TDataStatusReason =
    | "ok"
    | "initial-load"
    | "socket-closed"
    | "sequence-gap"
    | "buffer-overflow"
    | "unknown-diff"
    | "rate-limited"
    | "permission-denied"
    | "malformed-payload"
    | "network-error"
    | "upstream-unavailable"
    | "snapshot-age"
    | "no-market-data";

export interface IDataStatus {
    state: TDataState;
    reason: TDataStatusReason;
    /** provider time for the data, if known */
    sourceTimeMs: number | null;
    /** when this client last accepted data for the dataset */
    receivedAtMs: number | null;
    /** next automatic retry time, if one is scheduled */
    retryAtMs: number | null;
    /** snapshot ID or block height */
    version: string | null;
    detail: string | null;
}

export interface ILiquidationLayerOptions {
    visible: boolean;
    /** filter per position before bucketing, 0 includes every position */
    minPositionNotional: number;
}

export type TTpslMetric = "count" | "knownNotional";

export interface ITpslLayerOptions {
    visible: boolean;
    metric: TTpslMetric;
    showTakeProfit: boolean;
    showStopLoss: boolean;
    showBuy: boolean;
    showSell: boolean;
}

/** group executed liquidations by candle and side */
export interface ILiquidationEventLayerOptions {
    visible: boolean;
    /** minimum notional per candle and side */
    minNotional: number;
    /**
     * limit the history shown by this chart, leave unset to show everything loaded
     * setLiquidationHistoryWindow controls how much the shared client actually loads
     */
    historyMs?: number;
}

export interface ILayerOptions {
    liquidations: ILiquidationLayerOptions;
    tpsl: ITpslLayerOptions;
    liquidationEvents: ILiquidationEventLayerOptions;
    markPrice: { visible: boolean };
}

export interface IOverlayPalette {
    long: string;
    short: string;
    takeProfit: string;
    stopLoss: string;
    unknown: string;
    mark: string;
    laneBackground: string;
    laneDivider: string;
    selection: string;
}

export interface IChartPresentationOptions {
    theme: TThemeName;
    layers: ILayerOptions;
}

export interface IHydromancerChartOptions {
    data: IHydromancerClient;
    coin: string;
    interval?: TCandleInterval;
    theme?: TThemeName;
    layers?: DeepPartial<ILayerOptions>;
    /** apply host chart options after theme defaults */
    chart?: DeepPartial<ChartOptions>;
    candlestick?: CandlestickSeriesPartialOptions;
    palette?: Partial<IOverlayPalette>;
    /** gutter width in CSS pixels, each visible lane takes half and hidden lanes take none */
    profileWidth?: number;
    /** hide the built-in status bar if the host renders its own from subscribe events */
    showStatusBar?: boolean;
    /** hide this if the host has its own Levels button calling toggleLevels() */
    showLevelsButton?: boolean;
}

/** presentation can change in place, data source ownership cannot */
export type THydromancerChartUpdateOptions = Omit<
    Partial<IHydromancerChartOptions>,
    "data" | "coin" | "interval"
>;

export type TSelectionResolution = "current" | "updated" | "empty";

interface ISelectionBase {
    coin: string;
    /** price range includes the lower bound and excludes the upper bound */
    priceFrom: number;
    priceTo: number;
    /** snapshot ID for positions or block height for orders */
    sourceVersion: string | null;
    resolution: TSelectionResolution;
}

export interface ILiquidationSelection extends ISelectionBase {
    layer: "liquidations";
    positions: IPositionRecord[];
    longNotional: number;
    shortNotional: number;
}

export interface ITpslSelection extends ISelectionBase {
    layer: "tpsl";
    orders: ITriggerOrderRecord[];
    takeProfitCount: number;
    stopLossCount: number;
    unknownCount: number;
    unknownSizeCount: number;
    knownNotional: number;
}

export type TSelection = ILiquidationSelection | ITpslSelection;

export interface IChartState {
    coin: string;
    interval: TCandleInterval;
    status: Record<TDatasetName, IDataStatus>;
    markPx: number | null;
    selection: TSelection | null;
    options: IChartPresentationOptions;
}

export type TChartErrorCode =
    | "unsupported-market"
    | "unsupported-interval"
    | "disposed"
    | "superseded"
    | "permission-denied"
    | "malformed-payload"
    | "recovery-failed";

export interface IChartEventMap {
    status: { status: Record<TDatasetName, IDataStatus> };
    selection: { selection: TSelection | null };
    error: { code: TChartErrorCode; message: string };
}

export type TChartEvent = {
    [K in keyof IChartEventMap]: { type: K } & IChartEventMap[K];
}[keyof IChartEventMap];

export type TChartListener = (event: TChartEvent) => void;

export interface IChartHandle {
    setMarket(coin: string): Promise<void>;
    setInterval(interval: TCandleInterval): Promise<void>;
    applyOptions(patch: THydromancerChartUpdateOptions): void;
    /** restore default candle spacing at the live edge and let candles set the price scale */
    fitContent(): void;
    /**
     * fit nearby exposure around mark price, call fitContent() to restore candle autoscale
     * Only do this on request, distant levels would otherwise flatten the candles
     */
    fitLevels(): void;
    scrollToLatest(): void;
    /** show or hide the visible levels list, omit the argument to toggle it */
    toggleLevels(open?: boolean): void;
    select(selection: TSelection | null): void;
    getState(): IChartState;
    subscribe(listener: TChartListener): () => void;
    destroy(): void;
}

export interface IHydromancerClientOptions {
    /** same-origin gateway routes, keep the API key out of the browser */
    infoUrl?: string;
    socketUrl?: string;
    /** how often to poll cheap snapshot metadata */
    positionsPollMs?: number;
    /** how often to verify the order book against a fresh snapshot */
    tpslVerifyMs?: number;
    candleHistoryBars?: number;
    /** load 3 days of executed liquidations by default, allowed range is 1 hour to 7 days */
    liquidationHistoryMs?: number;
}

export interface IPositionsSnapshot {
    coin: string;
    snapshotId: string;
    sourceTimeMs: number | null;
    positions: readonly IPositionRecord[];
    totalRows: number;
    unavailableLiquidationPx: number;
    invalidRows: number;
}

export interface IMarketView {
    readonly coin: string;
    positions(): IPositionsSnapshot | null;
    orders(): ReadonlyMap<string, ITriggerOrderRecord>;
    /** bump when this coin's orders change */
    ordersVersion(): number;
    tpslHeight(): number | null;
    markPx(): number | null;
    events(): readonly ILiquidationEventRecord[];
    /** bump when this coin's events change */
    eventsVersion(): number;
    status(dataset: "positions" | "tpsl" | "mark" | "events"): IDataStatus;
    subscribe(listener: () => void): () => void;
    release(): void;
}

export interface ICandleBar {
    timeMs: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

/** reset needs a full redraw, update only changes the latest bar, status only changes data health */
export type TCandleChange = "reset" | "update" | "status";

export interface ICandleView {
    readonly coin: string;
    readonly interval: TCandleInterval;
    bars(): readonly ICandleBar[];
    status(): IDataStatus;
    subscribe(listener: (change: TCandleChange) => void): () => void;
    release(): void;
}

export interface IHydromancerClient {
    acquireMarket(coin: string): IMarketView;
    acquireCandles(coin: string, interval: TCandleInterval): ICandleView;
    /** set the history window for every chart on this client, clamped to 1 hour through 7 days */
    setLiquidationHistoryWindow(windowMs: number): void;
    /** simulate a network drop for the demo or tests */
    simulateDisconnect(): void;
    destroy(): void;
}
