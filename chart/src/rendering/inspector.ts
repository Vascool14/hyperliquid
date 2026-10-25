import { emptyKindTotals, SIZE_PRESETS } from "../model/aggregate";
import type { IKindTotals, ILiquidationBucket, ISideTotals, ITpslBucket } from "../model/aggregate";
import { CONCENTRATION_SHARE, type IEventGroup } from "../model/events";
import type {
    IDataStatus,
    TDatasetName,
    ILiquidationSelection,
    IOverlayPalette,
    IPositionRecord,
    TSelection,
    ITpslSelection,
    ITriggerOrderRecord,
    ICandleBar,
    TCandleInterval
} from "../types";
import {
    formatAge,
    formatClock,
    formatCount,
    formatDuration,
    formatIn,
    formatPercent,
    formatPrice,
    formatPriceRange,
    formatSize,
    formatTime,
    formatUsd,
    shortAddress
} from "./format";
import { BAND_ALPHA } from "./liquidation-primitive";
import { tpslColor, tpslPartValue, tpslParts } from "./tpsl-primitive";

export type TLevelSummary =
    { layer: "liquidations"; bucket: ILiquidationBucket } | { layer: "tpsl"; bucket: ITpslBucket };

export interface IInspectorContext {
    coin: string;
    markPx: number | null;
    now: number;
    status: Record<TDatasetName, IDataStatus>;
    minPositionNotional: number;
}

// one candle and its loaded liquidation fills
export interface ICandleSummary {
    coin: string;
    interval: TCandleInterval;
    bar: ICandleBar;
    longs: { notional: number; fills: number };
    shorts: { notional: number; fills: number };
}

export interface IInspectorCallbacks {
    onSelectLevel(level: TLevelSummary): void;
    onCloseCard(): void;
}

const MAX_RECORDS = 100;
const EXPLORER = "https://app.hyperliquid.xyz/explorer/address/";

type TChildNode = Node | string | null | false;

function createElement<K extends keyof HTMLElementTagNameMap>(
    doc: Document,
    tag: K,
    className: string | null,
    ...children: TChildNode[]
): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    if (className) {
        node.className = className;
    }
    for (const child of children) {
        if (child === null || child === false) {
            continue;
        }
        node.append(typeof child === "string" ? doc.createTextNode(child) : child);
    }
    return node;
}

export class Inspector {
    readonly statusBar: HTMLDivElement;
    private readonly doc: Document;
    private readonly callbacks: IInspectorCallbacks;
    private readonly tooltip: HTMLDivElement;
    private readonly candleTip: HTMLDivElement;
    private readonly card: HTMLDivElement;
    private readonly levels: HTMLDivElement;
    private readonly levelsButton: HTMLButtonElement;
    private readonly chips: HTMLSpanElement;
    private readonly legend: HTMLSpanElement;
    private readonly live: HTMLDivElement;
    private levelItems: TLevelSummary[] = [];
    private palette: IOverlayPalette;
    private legendLayers = { liquidations: true, tpsl: true };

    constructor(options: {
        root: HTMLElement;
        chartArea: HTMLElement;
        palette: IOverlayPalette;
        callbacks: IInspectorCallbacks;
    }) {
        this.doc = options.root.ownerDocument;
        this.callbacks = options.callbacks;
        this.palette = options.palette;
        const doc = this.doc;

        this.chips = createElement(doc, "span", "hlc-chips");
        this.chips.style.display = "inline-flex";
        this.chips.style.gap = "12px";
        this.legend = createElement(doc, "span", "hlc-legend");
        this.levelsButton = createElement(doc, "button", "hlc-btn", "Levels");
        this.levelsButton.type = "button";
        this.levelsButton.setAttribute("aria-expanded", "false");
        this.levelsButton.addEventListener("click", () => this.toggleLevels());
        this.statusBar = createElement(
            doc,
            "div",
            "hlc-status",
            this.chips,
            createElement(doc, "span", "hlc-spacer"),
            this.legend,
            this.levelsButton
        );
        this.statusBar.setAttribute("role", "status");

        this.tooltip = createElement(doc, "div", "hlc-tooltip");
        this.candleTip = createElement(doc, "div", "hlc-tooltip hlc-candle-tip");
        this.candleTip.hidden = true;
        this.tooltip.hidden = true;
        this.card = createElement(doc, "div", "hlc-card");
        this.card.hidden = true;
        this.card.setAttribute("role", "region");
        this.card.setAttribute("aria-label", "Level details");
        this.card.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                this.callbacks.onCloseCard();
            }
        });
        this.levels = createElement(doc, "div", "hlc-levels");
        this.levels.hidden = true;
        this.levels.setAttribute("role", "dialog");
        this.levels.setAttribute("aria-label", "Visible levels");
        this.levels.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                this.toggleLevels(false);
                this.levelsButton.focus();
            }
        });
        this.live = createElement(doc, "div", "hlc-sr");
        this.live.setAttribute("aria-live", "polite");

        options.chartArea.append(this.tooltip, this.candleTip, this.card, this.levels, this.live);
        this.renderLegend();
    }

    // hide legend entries along with their lanes
    setLegendLayers(liquidations: boolean, tpsl: boolean): void {
        if (this.legendLayers.liquidations === liquidations && this.legendLayers.tpsl === tpsl) {
            return;
        }
        this.legendLayers = { liquidations, tpsl };
        this.renderLegend();
    }

    setPalette(palette: IOverlayPalette): void {
        this.palette = palette;
        this.renderLegend();
    }

    showTooltip(level: TLevelSummary, x: number, y: number, context: IInspectorContext) {
        this.placeTooltip(this.summaryNodes(level, context, true), x, y);
    }

    showEventTooltip(group: IEventGroup, x: number, y: number, interval: string) {
        const doc = this.doc;
        const nodes = [
            createElement(doc, "div", "hlc-title", "Executed liquidations"),
            createElement(doc, "div", "hlc-sub", `${interval} candle from ${formatTime(group.candleTimeMs)}`),
            createKeyValueRow(
                doc,
                group.side === "long" ? "Longs liquidated" : "Shorts liquidated",
                formatUsd(group.notional)
            ),
            createKeyValueRow(
                doc,
                "Price range",
                group.minPx === group.maxPx
                    ? formatPrice(group.minPx)
                    : formatPriceRange(group.minPx, group.maxPx)
            ),
            createKeyValueRow(doc, "VWAP", formatPrice(group.vwapPx)),
            createKeyValueRow(
                doc,
                "Fills / accounts",
                `${formatCount(group.fillCount)} / ${formatCount(group.accountCount)}`
            ),
            createKeyValueRow(
                doc,
                "Largest account",
                `${formatUsd(group.largestAccountNotional)} (${share(
                    group.largestAccountNotional,
                    group.notional
                )}) · ${formatCount(group.largestAccountFills)} fills`
            ),
            createKeyValueRow(
                doc,
                "First – last fill",
                `${formatClock(group.firstTimeMs)} – ${formatClock(group.lastTimeMs)}`
            ),
            createKeyValueRow(
                doc,
                `${Math.round(CONCENTRATION_SHARE * 100)}% of notional in`,
                `${formatDuration(group.concentratedMs)} from ${formatClock(group.concentratedFromMs)}`
            )
        ];
        if (group.backstopCount > 0) {
            nodes.push(
                createKeyValueRow(
                    doc,
                    "Market / backstop",
                    `${formatCount(group.fillCount - group.backstopCount)} / ${formatCount(
                        group.backstopCount
                    )}`
                )
            );
        }
        this.placeTooltip(nodes, x, y);
    }

    private placeTooltip(nodes: Node[], x: number, y: number, tip = this.tooltip) {
        tip.replaceChildren(...nodes);
        tip.hidden = false;

        const area = tip.parentElement!;
        const width = tip.offsetWidth;
        const height = tip.offsetHeight;
        // open left of the pointer and stay inside the chart
        let left = x - width - 14;
        if (left < 4) {
            left = Math.min(x + 14, area.clientWidth - width - 4);
        }
        const top = Math.min(Math.max(4, y - height / 2), area.clientHeight - height - 4);
        tip.style.left = `${Math.max(4, left)}px`;
        tip.style.top = `${Math.max(4, top)}px`;
    }

    // a clicked candle tooltip stays pinned until the chart closes it

    showCandleTip(summary: ICandleSummary, x: number, y: number): void {
        const doc = this.doc;
        const { bar, coin } = summary;
        const change = bar.close - bar.open;
        const signed = (value: number) =>
            `${value < 0 ? "−" : value > 0 ? "+" : ""}${formatPrice(Math.abs(value), bar.close)}`;
        const nodes: Node[] = [
            createElement(doc, "div", "hlc-title", `${coin} ${summary.interval} candle`),
            createElement(doc, "div", "hlc-sub", formatTime(bar.timeMs)),
            createKeyValueRow(doc, "Open", formatPrice(bar.open, bar.close)),
            createKeyValueRow(doc, "High", formatPrice(bar.high, bar.close)),
            createKeyValueRow(doc, "Low", formatPrice(bar.low, bar.close)),
            createKeyValueRow(doc, "Close", formatPrice(bar.close)),
            createKeyValueRow(
                doc,
                "Change",
                `${signed(change)} (${formatPercent(bar.open ? change / bar.open : 0)})`
            ),
            createKeyValueRow(
                doc,
                "Range",
                `${formatPrice(bar.high - bar.low, bar.close)} (${(
                    ((bar.high - bar.low) / bar.low) *
                    100
                ).toFixed(2)}%)`
            ),
            createKeyValueRow(doc, "Volume", `${formatSize(bar.volume)} ${coin}`),
            createElement(doc, "div", "hlc-divider")
        ];
        const sides = [
            ["Longs liquidated", summary.longs],
            ["Shorts liquidated", summary.shorts]
        ] as const;
        if (sides.every(([, side]) => side.fills === 0)) {
            nodes.push(createElement(doc, "div", "hlc-sub", "No liqs in loaded history"));
        }
        for (const [label, side] of sides) {
            if (side.fills > 0) {
                nodes.push(
                    createKeyValueRow(
                        doc,
                        label,
                        `${formatUsd(side.notional)} · ${formatCount(side.fills)} fills`
                    )
                );
            }
        }
        this.placeTooltip(nodes, x, y, this.candleTip);
    }

    hideCandleTip(): void {
        this.candleTip.hidden = true;
    }

    hideTooltip(): void {
        this.tooltip.hidden = true;
    }

    showCard(selection: TSelection, context: IInspectorContext, rightInset: number) {
        const doc = this.doc;
        const close = createElement(doc, "button", "hlc-btn", "×");
        close.type = "button";
        close.setAttribute("aria-label", "Close details");
        close.addEventListener("click", () => this.callbacks.onCloseCard());

        const resolution =
            selection.resolution === "empty"
                ? createElement(doc, "span", "hlc-badge", "No longer present")
                : selection.resolution === "updated"
                  ? createElement(doc, "span", "hlc-badge", "Updated")
                  : null;
        resolution?.setAttribute("data-tone", "warn");

        const head = createElement(
            doc,
            "div",
            "hlc-card-head",
            createElement(
                doc,
                "div",
                null,
                createElement(
                    doc,
                    "div",
                    "hlc-title",
                    selection.layer === "liquidations"
                        ? "Estimated liquidation exposure"
                        : "Untriggered TP/SL orders",
                    resolution
                ),
                createElement(
                    doc,
                    "div",
                    "hlc-sub",
                    `${selection.coin} · ${formatPriceRange(selection.priceFrom, selection.priceTo)}`
                )
            ),
            close
        );

        const body =
            selection.layer === "liquidations"
                ? this.liquidationCard(selection, context)
                : this.tpslCard(selection, context);

        this.card.replaceChildren(head, body);
        this.card.style.right = `${rightInset}px`;
        this.card.hidden = false;
        this.live.textContent = `Selected ${selection.layer} ${formatPriceRange(
            selection.priceFrom,
            selection.priceTo
        )}`;
    }

    hideCard(): void {
        this.card.hidden = true;
        this.card.replaceChildren();
    }

    setLevels(levels: TLevelSummary[], context: IInspectorContext): void {
        this.levelItems = levels;
        if (!this.levels.hidden) {
            this.renderLevels(context);
        }
        this.levelsContext = context;
    }

    private levelsContext: IInspectorContext | null = null;

    setLevelsButtonVisible(visible: boolean): void {
        this.levelsButton.hidden = !visible;
    }

    toggleLevels(force?: boolean): void {
        const open = force ?? this.levels.hidden;
        this.levels.hidden = !open;
        this.levelsButton.setAttribute("aria-expanded", String(open));
        if (open && this.levelsContext) {
            this.renderLevels(this.levelsContext);
            (
                this.levels.querySelector<HTMLButtonElement>(".hlc-level") ??
                this.levels.querySelector("button")
            )?.focus();
        }
    }

    private renderLevels(context: IInspectorContext): void {
        const doc = this.doc;
        const items = [...this.levelItems].sort((a, b) => b.bucket.priceFrom - a.bucket.priceFrom);
        const close = createElement(doc, "button", "hlc-btn", "×");
        close.type = "button";
        close.setAttribute("aria-label", "Close levels");
        close.addEventListener("click", () => {
            this.toggleLevels(false);
            this.levelsButton.focus();
        });
        const nodes: Node[] = [
            createElement(
                doc,
                "div",
                "hlc-levels-head",
                createElement(doc, "div", "hlc-section-title", `${items.length} levels in view`),
                close
            )
        ];
        for (const level of items) {
            const button = createElement(
                doc,
                "button",
                "hlc-level",
                createElement(doc, "span", null, formatPrice(level.bucket.priceFrom)),
                createElement(doc, "span", "hlc-sub", levelLabel(level))
            );
            button.type = "button";
            button.setAttribute(
                "aria-label",
                `${level.layer === "tpsl" ? "TP/SL" : "Liquidations"} ${formatPriceRange(
                    level.bucket.priceFrom,
                    level.bucket.priceTo
                )}: ${levelLabel(level)}`
            );
            button.addEventListener("click", () => {
                this.callbacks.onSelectLevel(level);
                this.toggleLevels(false);
            });
            nodes.push(button);
        }
        if (items.length === 0) {
            nodes.push(createElement(doc, "div", "hlc-sub", emptyLevelsText(context)));
        }
        this.levels.replaceChildren(...nodes);
    }

    renderStatus(context: IInspectorContext): void {
        const doc = this.doc;
        const { status, now } = context;
        const chip = (name: string, data: IDataStatus, detail: string) =>
            createElement(
                doc,
                "span",
                "hlc-chip",
                dot(doc, data),
                createElement(doc, "b", null, name),
                detail
            );

        const candles = status.candles;
        const mark = status.mark;
        const positions = status.positions;
        const tpsl = status.tpsl;

        this.chips.replaceChildren(
            chip("Candles", candles, describe(candles, now)),
            chip(
                "Mark",
                mark,
                context.markPx !== null && mark.state === "live"
                    ? formatPrice(context.markPx)
                    : describe(mark, now)
            ),
            chip(
                "Liq snapshot",
                positions,
                positions.version !== null && positions.state !== "unavailable"
                    ? `${formatAge(positions.sourceTimeMs, now)}${
                          positions.state === "live" ? "" : ` · ${describe(positions, now)}`
                      }`
                    : describe(positions, now)
            ),
            chip("TP/SL", tpsl, describe(tpsl, now)),
            chip(
                "Liq fills",
                status.events,
                status.events.state === "live"
                    ? status.events.detail
                        ? "partial history"
                        : "live"
                    : describe(status.events, now)
            )
        );
    }

    destroy(): void {
        this.statusBar.remove();
        this.tooltip.remove();
        this.card.remove();
        this.levels.remove();
        this.live.remove();
    }

    private renderLegend(): void {
        const doc = this.doc;
        const swatch = (color: string, label: string) => {
            const box = createElement(doc, "i", "hlc-swatch");
            box.style.background = color;
            return createElement(doc, "span", null, box, label);
        };
        const ramp = createElement(doc, "span", "hlc-ramp");
        ramp.title = "Opacity by position size band: <100K, 100K, 500K, 1M, 5M, 10M+";
        for (const alpha of BAND_ALPHA) {
            const step = createElement(doc, "i", null);
            step.style.background = this.palette.long;
            step.style.opacity = String(alpha);
            ramp.append(step);
        }
        // match the lanes from left to right, TP/SL then liquidations
        const entries: Node[] = [];
        if (this.legendLayers.tpsl) {
            const tpEntry = swatch(this.palette.takeProfit, "TP");
            tpEntry.title = "Take profit orders; the darker shade is buy orders";
            const slEntry = swatch(this.palette.stopLoss, "SL");
            slEntry.title = "Stop loss orders; the darker shade is buy orders";
            entries.push(tpEntry, slEntry);
        }
        if (this.legendLayers.liquidations) {
            entries.push(
                swatch(this.palette.long, "Long"),
                swatch(this.palette.short, "Short"),
                createElement(doc, "span", null, "size", ramp)
            );
        }
        this.legend.replaceChildren(...entries);
    }

    private summaryNodes(level: TLevelSummary, context: IInspectorContext, hint: boolean) {
        const doc = this.doc;
        const { bucket } = level;
        const nodes: Node[] = [
            createElement(
                doc,
                "div",
                "hlc-head",
                createElement(
                    doc,
                    "div",
                    "hlc-title",
                    level.layer === "liquidations" ? "Liquidation exposure" : "TP/SL triggers"
                ),
                createElement(doc, "div", "hlc-sub", formatPriceRange(bucket.priceFrom, bucket.priceTo))
            )
        ];

        if (level.layer === "liquidations") {
            const { long, short } = level.bucket;
            nodes.push(
                this.exposureShareBar(long, short),
                createKeyValueRow(doc, "Longs", `${formatUsd(long.notional)} · ${formatCount(long.count)}`),
                createKeyValueRow(doc, "Shorts", `${formatUsd(short.notional)} · ${formatCount(short.count)}`)
            );
            const large = sumBands([long.bands, short.bands], 3);
            if (large > 0) {
                nodes.push(createKeyValueRow(doc, "From positions ≥ $1M", formatUsd(large)));
            }
        } else {
            const { tp, sl, unknown } = level.bucket;
            nodes.push(
                this.orderShareBar(level.bucket),
                createKeyValueRow(doc, "Take profit", kindText(tp)),
                createKeyValueRow(doc, "Stop loss", kindText(sl))
            );
            if (unknown.count > 0) {
                nodes.push(createKeyValueRow(doc, "Unclassified", kindText(unknown)));
            }
            const known = tp.knownNotional + sl.knownNotional + unknown.knownNotional;
            const dynamic = tp.unknownSizeCount + sl.unknownSizeCount + unknown.unknownSizeCount;
            nodes.push(
                createKeyValueRow(doc, "Known-size notional", formatUsd(known)),
                createKeyValueRow(
                    doc,
                    "Buy / sell orders",
                    `${tp.buyCount + sl.buyCount + unknown.buyCount} / ${
                        tp.sellCount + sl.sellCount + unknown.sellCount
                    }`
                )
            );
            if (dynamic > 0) {
                nodes.push(
                    createElement(
                        doc,
                        "div",
                        "hlc-note",
                        `${formatCount(dynamic)} orders have dynamic or unspecified size and are excluded from notional.`
                    )
                );
            }
        }

        const mid = (bucket.priceFrom + bucket.priceTo) / 2;
        if (context.markPx !== null) {
            nodes.push(
                createKeyValueRow(
                    doc,
                    "From mark",
                    `${formatPercent(mid / context.markPx - 1)} (${formatPrice(context.markPx)})`
                )
            );
        }
        const source =
            level.layer === "liquidations"
                ? `Snapshot ${formatAge(context.status.positions.sourceTimeMs, context.now)}`
                : `Book height ${context.status.tpsl.version ?? "–"}`;
        nodes.push(createElement(doc, "div", "hlc-note", hint ? `${source} · click to pin` : source));
        return nodes;
    }

    private liquidationCard(selection: ILiquidationSelection, context: IInspectorContext) {
        const doc = this.doc;
        const body = createElement(doc, "div", "hlc-card-body");
        const status = context.status.positions;

        body.append(
            createKeyValueRow(doc, "Long exposure", formatUsd(selection.longNotional)),
            createKeyValueRow(doc, "Short exposure", formatUsd(selection.shortNotional)),
            createKeyValueRow(doc, "Positions", formatCount(selection.positions.length)),
            createKeyValueRow(doc, "Min. position size", formatUsd(context.minPositionNotional)),
            createKeyValueRow(doc, "Snapshot", `${status.version ?? "–"}`),
            createKeyValueRow(doc, "Snapshot time", formatTime(status.sourceTimeMs)),
            createElement(
                doc,
                "div",
                "hlc-note",
                "Estimated from the latest positioning snapshot; not executed liquidations. Levels can move with funding, collateral and other positions."
            )
        );

        const list = createElement(
            doc,
            "div",
            "hlc-section",
            createElement(doc, "div", "hlc-section-title", "Positions by size")
        );
        for (const position of selection.positions.slice(0, MAX_RECORDS)) {
            list.append(this.positionRow(position, context));
        }
        if (selection.positions.length > MAX_RECORDS) {
            list.append(
                createElement(
                    doc,
                    "div",
                    "hlc-note",
                    `${selection.positions.length - MAX_RECORDS} smaller positions not listed.`
                )
            );
        }
        body.append(list);
        return body;
    }

    private positionRow(position: IPositionRecord, context: IInspectorContext) {
        const doc = this.doc;
        const side = createElement(doc, "span", "hlc-side", position.side);
        side.style.color = position.side === "long" ? this.palette.long : this.palette.short;

        const details = createElement(doc, "div", null);
        details.append(
            createKeyValueRow(doc, "Wallet", walletLink(doc, position.address)),
            createKeyValueRow(doc, "Size", `${formatSize(position.size)} ${position.coin}`),
            createKeyValueRow(doc, "Notional", formatUsd(position.notional)),
            createKeyValueRow(doc, "Entry", formatPrice(position.entryPx)),
            createKeyValueRow(
                doc,
                "Liquidation",
                position.liquidationPx === null ? "–" : formatPrice(position.liquidationPx)
            ),
            createKeyValueRow(
                doc,
                "Distance from mark",
                position.liquidationPx !== null && context.markPx !== null
                    ? formatPercent(position.liquidationPx / context.markPx - 1)
                    : "–"
            ),
            createKeyValueRow(doc, "Leverage", `${position.leverage}× ${position.leverageType}`),
            createKeyValueRow(doc, "Funding PnL", formatUsd(position.fundingPnl)),
            createKeyValueRow(
                doc,
                "Account value (account-level)",
                position.accountValue === null ? "–" : formatUsd(position.accountValue)
            )
        );

        return createElement(
            doc,
            "details",
            null,
            createElement(
                doc,
                "summary",
                null,
                side,
                createElement(doc, "span", "hlc-grow hlc-mono", shortAddress(position.address)),
                createElement(doc, "span", null, formatUsd(position.notional)),
                createElement(
                    doc,
                    "span",
                    "hlc-sub",
                    position.liquidationPx === null ? "–" : formatPrice(position.liquidationPx)
                )
            ),
            details
        );
    }

    private tpslCard(selection: ITpslSelection, context: IInspectorContext) {
        const doc = this.doc;
        const body = createElement(doc, "div", "hlc-card-body");

        body.append(
            this.orderShareBar(orderTotals(selection.orders)),
            createKeyValueRow(doc, "Take profit orders", formatCount(selection.takeProfitCount)),
            createKeyValueRow(doc, "Stop loss orders", formatCount(selection.stopLossCount))
        );
        if (selection.unknownCount > 0) {
            body.append(createKeyValueRow(doc, "Unclassified", formatCount(selection.unknownCount)));
        }
        body.append(
            createKeyValueRow(doc, "Known-size notional", formatUsd(selection.knownNotional)),
            createKeyValueRow(doc, "Dynamic / unspecified size", formatCount(selection.unknownSizeCount)),
            createKeyValueRow(doc, "Book height", context.status.tpsl.version ?? "–")
        );

        const list = createElement(doc, "div", "hlc-section");
        for (const order of selection.orders.slice(0, MAX_RECORDS)) {
            list.append(this.orderRow(order, context));
        }
        if (selection.orders.length > MAX_RECORDS) {
            list.append(
                createElement(
                    doc,
                    "div",
                    "hlc-note",
                    `${selection.orders.length - MAX_RECORDS} more orders not listed.`
                )
            );
        }
        body.append(list);
        return body;
    }

    // match the lane bar, longs then shorts with larger size bands first
    // use the same opacity steps and label each populated band
    private exposureShareBar(long: ISideTotals, short: ISideTotals) {
        const doc = this.doc;
        const sides = [
            { label: "Long", totals: long, color: this.palette.long },
            { label: "Short", totals: short, color: this.palette.short }
        ].filter((side) => side.totals.notional > 0);
        const total = long.notional + short.notional;

        const bar = createElement(doc, "div", "hlc-share-bar");
        const key = createElement(doc, "div", "hlc-share-key");
        for (const side of sides) {
            for (let band = BAND_ALPHA.length - 1; band >= 0; band--) {
                const value = side.totals.bands[band] ?? 0;
                if (value <= 0) {
                    continue;
                }
                const lower = SIZE_PRESETS[band - 1];
                const upper = SIZE_PRESETS[band];
                const range =
                    lower === undefined
                        ? `<${formatUsd(upper!)}`
                        : upper === undefined
                          ? `≥${formatUsd(lower)}`
                          : `${formatUsd(lower)}–<${formatUsd(upper)}`;
                const label = `${side.label} ${range} ${share(value, total)}`;
                const segment = createElement(doc, "span", null);
                segment.style.flexGrow = String(value);
                segment.style.background = side.color;
                segment.style.opacity = String(BAND_ALPHA[band]);
                segment.title = `${label}: ${formatUsd(value)}`;
                bar.append(segment);

                const swatch = createElement(doc, "i", "hlc-swatch");
                swatch.style.background = side.color;
                swatch.style.opacity = String(BAND_ALPHA[band]);
                key.append(createElement(doc, "span", null, swatch, label));
            }
        }

        const wrapper = createElement(doc, "div", "hlc-share", bar, key);
        wrapper.setAttribute("role", "img");
        wrapper.setAttribute("aria-label", Array.from(key.children, (entry) => entry.textContent).join(", "));
        return wrapper;
    }

    // use the same order breakdown and colors as the lane bar
    private orderShareBar(bucket: Pick<ITpslBucket, "tp" | "sl" | "unknown">) {
        const doc = this.doc;
        const parts = tpslParts(bucket, this.palette)
            .map((part) => ({ ...part, count: tpslPartValue(part, "count") }))
            .filter((part) => part.count > 0);
        const total = parts.reduce((sum, part) => sum + part.count, 0);

        const bar = createElement(doc, "div", "hlc-share-bar");
        const key = createElement(doc, "div", "hlc-share-key");
        for (const part of parts) {
            const percent = share(part.count, total);
            const segment = createElement(doc, "span", null);
            segment.style.flexGrow = String(part.count);
            segment.style.background = part.color;
            segment.title = `${part.label}: ${formatCount(part.count)} (${percent})`;
            bar.append(segment);

            const name = createElement(doc, "span", null, part.label);
            name.style.color = part.color;
            key.append(createElement(doc, "span", null, name, ` ${percent}`));
        }

        const wrapper = createElement(doc, "div", "hlc-share", bar, key);
        wrapper.setAttribute("role", "img");
        wrapper.setAttribute(
            "aria-label",
            parts.map((part) => `${part.label} ${share(part.count, total)}`).join(", ")
        );
        return wrapper;
    }

    private orderRow(order: ITriggerOrderRecord, context: IInspectorContext) {
        const doc = this.doc;
        const kind = createElement(
            doc,
            "span",
            "hlc-side",
            order.isTrailing ? "trail" : order.kind === "unknown" ? "?" : order.kind
        );
        kind.style.color =
            order.kind === "tp"
                ? this.palette.takeProfit
                : order.kind === "sl"
                  ? this.palette.stopLoss
                  : this.palette.unknown;

        const size = order.sizeKnown
            ? `${formatSize(order.size)} ${order.coin}`
            : order.isPositionTpsl
              ? "Dynamic (whole position)"
              : "Unspecified";

        // match the bar colors for kind and side, keep the side in the title and details too
        const sideName = order.side === "buy" ? "Buy" : "Sell";
        const value = createElement(
            doc,
            "span",
            null,
            order.sizeKnown && order.triggerPx !== null ? formatUsd(order.size * order.triggerPx) : "dynamic"
        );
        value.style.color = tpslColor(this.palette, order.kind, order.side);
        value.title = `${sideName} order`;
        value.setAttribute("aria-label", `${sideName} order, ${value.textContent}`);

        const details = createElement(doc, "div", null);
        details.append(
            createKeyValueRow(doc, "Wallet", walletLink(doc, order.user)),
            createKeyValueRow(doc, "Order type", order.orderType),
            createKeyValueRow(doc, "Side", order.side === "buy" ? "Buy" : "Sell"),
            createKeyValueRow(doc, "Trigger", order.triggerPxRaw),
            createKeyValueRow(doc, "Limit", order.limitPxRaw || "–"),
            createKeyValueRow(doc, "Size", size),
            createKeyValueRow(
                doc,
                "Distance from mark",
                order.triggerPx !== null && context.markPx !== null
                    ? formatPercent(order.triggerPx / context.markPx - 1)
                    : "–"
            ),
            createKeyValueRow(doc, "Position TP/SL", order.isPositionTpsl ? "Yes" : "No"),
            createKeyValueRow(doc, "Reduce only", order.reduceOnly ? "Yes" : "No"),
            createKeyValueRow(doc, "Created", formatTime(order.createdMs)),
            createKeyValueRow(doc, "Order ID", order.id),
            createElement(doc, "div", "hlc-note", order.triggerCondition)
        );

        return createElement(
            doc,
            "details",
            null,
            createElement(
                doc,
                "summary",
                null,
                kind,
                createElement(doc, "span", "hlc-grow hlc-mono", shortAddress(order.user)),
                value
            ),
            details
        );
    }
}

function share(count: number, total: number): string {
    return total > 0 ? `${Math.round((count / total) * 100)}%` : "0%";
}

// sum orders by kind using the same shape as a price bucket
function orderTotals(orders: readonly ITriggerOrderRecord[]) {
    const totals = {
        tp: emptyKindTotals(),
        sl: emptyKindTotals(),
        unknown: emptyKindTotals()
    };
    for (const order of orders) {
        const kind = totals[order.kind];
        kind.count++;
        if (order.side === "buy") {
            kind.buyCount++;
        } else {
            kind.sellCount++;
        }
    }
    return totals;
}

function createKeyValueRow(doc: Document, label: string, value: string | Node) {
    return createElement(
        doc,
        "div",
        "hlc-kv",
        createElement(doc, "span", null, label),
        createElement(doc, "span", null, value)
    );
}

function walletLink(doc: Document, address: string) {
    const link = createElement(doc, "a", "hlc-mono", shortAddress(address));
    link.href = `${EXPLORER}${address}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = address;
    return link;
}

function dot(doc: Document, status: IDataStatus) {
    const node = createElement(doc, "span", "hlc-dot");
    node.setAttribute("data-tone", tone(status));
    return node;
}

function tone(status: IDataStatus): string {
    switch (status.state) {
        case "live":
            return "ok";
        case "loading":
        case "idle":
            return "idle";
        case "stale":
        case "reconnecting":
        case "resyncing":
        case "waiting-for-quota":
            return "warn";
        default:
            return "bad";
    }
}

function describe(status: IDataStatus, now: number): string {
    const retry = status.retryAtMs !== null ? ` · retry ${formatIn(status.retryAtMs, now)}` : "";
    switch (status.state) {
        case "live":
            return status.reason === "no-market-data" ? "no data" : "live";
        case "loading":
            return "loading";
        case "stale":
            return status.reason === "snapshot-age" ? "stale" : `stale (${status.reason})${retry}`;
        case "reconnecting":
            return `reconnecting${retry}`;
        case "resyncing":
            return `resyncing (${status.reason})${retry}`;
        case "waiting-for-quota":
            return `waiting for quota${retry}`;
        case "unavailable":
            return status.reason === "permission-denied" ? "no permission" : "unavailable";
        case "error":
            return `error (${status.reason})${retry}`;
        default:
            return status.state;
    }
}

function kindText(kind: IKindTotals): string {
    if (kind.count === 0) {
        return "0";
    }
    const dynamic = kind.unknownSizeCount > 0 ? ` (${kind.unknownSizeCount} dynamic)` : "";
    return `${formatCount(kind.count)}${dynamic}`;
}

function sumBands(sides: number[][], fromBand: number): number {
    let total = 0;
    for (const bands of sides) {
        for (let band = fromBand; band < bands.length; band++) {
            total += bands[band] ?? 0;
        }
    }
    return total;
}

function levelLabel(level: TLevelSummary): string {
    if (level.layer === "liquidations") {
        const { long, short } = level.bucket;
        return `L ${formatUsd(long.notional)} / S ${formatUsd(short.notional)}`;
    }
    const { tp, sl } = level.bucket;
    return `TP ${tp.count} / SL ${sl.count}`;
}

function emptyLevelsText(context: IInspectorContext): string {
    if (context.minPositionNotional >= (SIZE_PRESETS[SIZE_PRESETS.length - 1] ?? 0)) {
        return "No levels in view at this size filter.";
    }
    return "No levels in view.";
}
