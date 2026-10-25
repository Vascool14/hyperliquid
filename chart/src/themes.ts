import {
    ColorType,
    CrosshairMode,
    LineStyle,
    type CandlestickSeriesPartialOptions,
    type ChartOptions,
    type DeepPartial
} from "lightweight-charts";
import type { IOverlayPalette, TThemeName } from "./types";

export interface IThemeOptions {
    chart: DeepPartial<ChartOptions>;
    candlestick: CandlestickSeriesPartialOptions;
    palette: IOverlayPalette;
    /** CSS variables for tooltips, cards, status and levels */
    css: Record<string, string>;
}

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

function chartOptions(
    background: string,
    text: string,
    grid: string,
    border: string,
    crosshair: string
): DeepPartial<ChartOptions> {
    return {
        layout: {
            background: { type: ColorType.Solid, color: background },
            textColor: text,
            fontFamily: FONT,
            fontSize: 11,
            attributionLogo: true
        },
        grid: {
            vertLines: { color: grid },
            horzLines: { color: grid }
        },
        rightPriceScale: { borderColor: border },
        timeScale: {
            borderColor: border,
            timeVisible: true,
            secondsVisible: false
        },
        crosshair: {
            mode: CrosshairMode.Normal,
            vertLine: { color: crosshair, style: LineStyle.Dashed },
            horzLine: { color: crosshair, style: LineStyle.Dashed }
        }
    };
}

// darken the kind color to distinguish buy orders
export function darkerShade(color: string): string {
    const hex = /^#([0-9a-f]{6})$/i.exec(color);
    if (!hex) {
        return `color-mix(in srgb, ${color} 78%, black)`;
    }
    const value = parseInt(hex[1]!, 16);
    const channel = (shift: number) =>
        Math.round(((value >> shift) & 0xff) * 0.78)
            .toString(16)
            .padStart(2, "0");
    return `#${channel(16)}${channel(8)}${channel(0)}`;
}

export const THEMES: Record<TThemeName, IThemeOptions> = {
    dark: {
        chart: chartOptions("#0e1014", "#9aa3ae", "rgba(255,255,255,0.035)", "#22262d", "#5b6573"),
        candlestick: {
            upColor: "#3e9e78",
            downColor: "#d0564f",
            borderUpColor: "#3e9e78",
            borderDownColor: "#d0564f",
            wickUpColor: "#3e9e78",
            wickDownColor: "#d0564f"
        },
        palette: {
            long: "#f0a63a",
            short: "#28cbc1",
            // magenta keeps SL distinct from blue TP for red-green color blindness without matching red candles
            takeProfit: "#5b8cff",
            stopLoss: "#d260c0",
            unknown: "#8b939e",
            mark: "#c9ced6",
            laneBackground: "rgba(14,16,20,0.86)",
            laneDivider: "#22262d",
            selection: "#e6e9ee"
        },
        css: {
            "--hlc-bg": "#0e1014",
            "--hlc-surface": "#14171c",
            "--hlc-border": "#262b33",
            "--hlc-text": "#d5dae1",
            "--hlc-muted": "#8a939f",
            "--hlc-accent": "#e6e9ee",
            "--hlc-ok": "#3e9e78",
            "--hlc-warn": "#e0a43a",
            "--hlc-bad": "#d0564f",
            "--hlc-shadow": "0 6px 24px rgba(0,0,0,0.45)"
        }
    },
    light: {
        chart: chartOptions("#ffffff", "#4b5563", "rgba(0,0,0,0.045)", "#e3e6ea", "#9aa3ae"),
        candlestick: {
            upColor: "#2f8a66",
            downColor: "#c4443d",
            borderUpColor: "#2f8a66",
            borderDownColor: "#c4443d",
            wickUpColor: "#2f8a66",
            wickDownColor: "#c4443d"
        },
        palette: {
            long: "#c97a00",
            short: "#099990",
            takeProfit: "#2f62e0",
            stopLoss: "#a8288f",
            unknown: "#6b7280",
            mark: "#374151",
            laneBackground: "rgba(255,255,255,0.88)",
            laneDivider: "#e3e6ea",
            selection: "#111827"
        },
        css: {
            "--hlc-bg": "#ffffff",
            "--hlc-surface": "#ffffff",
            "--hlc-border": "#dfe3e8",
            "--hlc-text": "#1f2937",
            "--hlc-muted": "#6b7280",
            "--hlc-accent": "#111827",
            "--hlc-ok": "#2f8a66",
            "--hlc-warn": "#b7791f",
            "--hlc-bad": "#c4443d",
            "--hlc-shadow": "0 6px 24px rgba(15,23,42,0.12)"
        }
    }
};
