import type {
    TCandleInterval,
    TChartEvent,
    DeepPartial,
    ILayerOptions,
    TTpslMetric
} from "hydromancer-charts";

export const MARKETS = ["BTC", "ETH", "SOL", "HYPE"];

// each chart keeps its own market, interval and layer settings
export interface IPaneConfig {
    coin: string;
    interval: TCandleInterval;
    showLiq: boolean;
    minNotional: number;
    showTpsl: boolean;
    metric: TTpslMetric;
    showTakeProfit: boolean;
    showStopLoss: boolean;
    showBuy: boolean;
    showSell: boolean;
    showEvents: boolean;
    eventMinNotional: number;
    historyIndex: number;
    showMark: boolean;
}

export function formatPreset(value: number): string {
    return value >= 1e6 ? `$${value / 1e6}M` : `$${value / 1e3}K`;
}

// log slider for the executed liquidation threshold
const EVENT_MIN = 10_000;
const EVENT_MAX = 10_000_000;
export const SLIDER_STEPS = 60;

// round to 2 significant figures to keep slider labels readable
export function sliderToNotional(step: number): number {
    const raw = EVENT_MIN * (EVENT_MAX / EVENT_MIN) ** (step / SLIDER_STEPS);
    const magnitude = 10 ** (Math.floor(Math.log10(raw)) - 1);
    return Math.round(raw / magnitude) * magnitude;
}

// history windows in hours, with wider steps further back
const HOUR_MS = 3_600_000;
export const HISTORY_WINDOWS = [1, 2, 4, 6, 12, 24, 48, 72, 120, 168].map((h) => h * HOUR_MS);
const DEFAULT_HISTORY_INDEX = 7;

export function formatWindow(ms: number): string {
    const hours = ms / HOUR_MS;
    return hours < 24 ? `${hours}h` : `${hours / 24}d`;
}

export function notionalToSlider(value: number): number {
    const share = Math.log(value / EVENT_MIN) / Math.log(EVENT_MAX / EVENT_MIN);
    return Math.round(share * SLIDER_STEPS);
}

export function defaultPane(coin: string, interval: TCandleInterval): IPaneConfig {
    return {
        coin,
        interval,
        showLiq: true,
        minNotional: 100_000,
        showTpsl: true,
        metric: "count",
        showTakeProfit: true,
        showStopLoss: true,
        showBuy: true,
        showSell: true,
        showEvents: true,
        eventMinNotional: 50_000,
        historyIndex: DEFAULT_HISTORY_INDEX,
        showMark: true
    };
}

export function paneLayers(pane: IPaneConfig): DeepPartial<ILayerOptions> {
    return {
        liquidations: { visible: pane.showLiq, minPositionNotional: pane.minNotional },
        tpsl: {
            visible: pane.showTpsl,
            metric: pane.metric,
            showTakeProfit: pane.showTakeProfit,
            showStopLoss: pane.showStopLoss,
            showBuy: pane.showBuy,
            showSell: pane.showSell
        },
        liquidationEvents: {
            visible: pane.showEvents,
            minNotional: pane.eventMinNotional,
            historyMs: HISTORY_WINDOWS[pane.historyIndex]!
        },
        markPrice: { visible: pane.showMark }
    };
}

export function describeEvent(event: TChartEvent): string | null {
    switch (event.type) {
        case "status":
            return Object.entries(event.status)
                .map(([name, s]) => `${name}=${s.state}${s.reason === "ok" ? "" : `(${s.reason})`}`)
                .join(" ");
        case "selection":
            return event.selection
                ? `selected ${event.selection.layer} ${event.selection.priceFrom}–${event.selection.priceTo} (${event.selection.resolution})`
                : "selection cleared";
        case "error":
            return `error ${event.code}: ${event.message}`;
    }
}
