import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    CANDLE_INTERVALS,
    createHydromancerClient,
    SIZE_PRESETS,
    type TChartEvent,
    type IChartHandle,
    type IHydromancerClient,
    type TThemeName
} from "hydromancer-charts";
import { Chart } from "./Chart";
import { Dropdown, Row, Toggle, Segmented } from "./components";
import {
    MARKETS,
    HISTORY_WINDOWS,
    SLIDER_STEPS,
    defaultPane,
    describeEvent,
    formatPreset,
    formatWindow,
    notionalToSlider,
    paneLayers,
    sliderToNotional,
    type IPaneConfig
} from "./utils";

export function App() {
    const [client, setClient] = useState<IHydromancerClient | null>(null);
    const [darkMode, setDarkMode] = useState(true);
    const theme: TThemeName = darkMode ? "dark" : "light";
    const [split, setSplit] = useState(false);
    const [showLog, setShowLog] = useState(false);
    const [panes, setPanes] = useState<IPaneConfig[]>([defaultPane("BTC", "15m"), defaultPane("ETH", "15m")]);
    const [log, setLog] = useState<string[]>([]);
    const handles = useRef<(IChartHandle | null)[]>([null, null]);

    // 1 client for every chart on the page owned here
    useEffect(() => {
        const next = createHydromancerClient();
        setClient(next);
        return () => next.destroy();
    }, []);

    const visiblePanes = split ? panes : panes.slice(0, 1);
    // the client loads one history for every chart, so it loads the longest window open.
    const historyMs = Math.max(...visiblePanes.map((pane) => HISTORY_WINDOWS[pane.historyIndex]!));

    useEffect(() => {
        client?.setLiquidationHistoryWindow(historyMs);
    }, [client, historyMs]);

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
    }, [theme]);

    const layers = useMemo(() => panes.map(paneLayers), [panes]);

    const onEvent = useCallback((pane: number, event: TChartEvent) => {
        const text = describeEvent(event);
        if (!text) {
            return;
        }
        const time = new Date().toLocaleTimeString();
        setLog((lines) => [`${time}  #${pane + 1}  ${text}`, ...lines].slice(0, 40));
    }, []);

    const updatePane = (index: number, patch: Partial<IPaneConfig>) => {
        setPanes((current) => current.map((pane, i) => (i === index ? { ...pane, ...patch } : pane)));
    };

    return (
        <div className="flex h-full flex-col">
            <nav className="flex flex-wrap items-center gap-4 border-b border-line p-2">
                <span>Hydromancer charts</span>
                <span className="flex-1" />
                <Toggle checked={showLog} onChange={setShowLog} label="Event log" />
                <Toggle checked={split} onChange={setSplit} label="Multichart" />
                <Toggle checked={darkMode} onChange={setDarkMode} label="Dark mode" />
                <button
                    className="btn"
                    onClick={() => client?.simulateDisconnect()}
                    title="Close the shared socket to exercise reconnect and resync"
                >
                    Drop connection
                </button>
            </nav>

            <main
                className={`grid min-h-0 flex-1 gap-px bg-line ${
                    split ? "grid-rows-2 lg:grid-cols-2 lg:grid-rows-1" : ""
                }`}
            >
                {client &&
                    visiblePanes.map((pane, index) => (
                        <section key={index} className="flex min-h-0 min-w-0 flex-col bg-bg">
                            <div className="flex flex-wrap items-center gap-1 border-b border-line p-2">
                                <select
                                    className="field"
                                    value={pane.coin}
                                    onChange={(e) => updatePane(index, { coin: e.target.value })}
                                    aria-label={`Market for chart ${index + 1}`}
                                >
                                    {MARKETS.map((coin) => (
                                        <option key={coin}>{coin}</option>
                                    ))}
                                </select>
                                <Segmented
                                    value={pane.interval}
                                    options={CANDLE_INTERVALS}
                                    onChange={(interval) => updatePane(index, { interval })}
                                />
                                <span className="flex-1" />
                                <Dropdown label="Executed liq" active={pane.showEvents}>
                                    <Toggle
                                        checked={pane.showEvents}
                                        onChange={(showEvents) => updatePane(index, { showEvents })}
                                        label="Show"
                                    />
                                    <Row
                                        label="Min"
                                        title="Smallest executed liquidation group shown, per candle and side"
                                    >
                                        <input
                                            type="range"
                                            min={0}
                                            max={SLIDER_STEPS}
                                            step={1}
                                            value={notionalToSlider(pane.eventMinNotional)}
                                            onChange={(e) =>
                                                updatePane(index, {
                                                    eventMinNotional: sliderToNotional(Number(e.target.value))
                                                })
                                            }
                                            aria-label="Minimum executed liquidation size"
                                            aria-valuetext={formatPreset(pane.eventMinNotional)}
                                        />
                                        <span className="w-12 tabular-nums">
                                            {formatPreset(pane.eventMinNotional)}
                                        </span>
                                    </Row>
                                    <Row
                                        label="History"
                                        title="How far back executed liquidations are loaded"
                                    >
                                        <input
                                            type="range"
                                            min={0}
                                            max={HISTORY_WINDOWS.length - 1}
                                            step={1}
                                            value={pane.historyIndex}
                                            onChange={(e) =>
                                                updatePane(index, { historyIndex: Number(e.target.value) })
                                            }
                                            aria-label="Executed liquidation history"
                                            aria-valuetext={formatWindow(HISTORY_WINDOWS[pane.historyIndex]!)}
                                        />
                                        <span className="w-12 tabular-nums">
                                            {formatWindow(HISTORY_WINDOWS[pane.historyIndex]!)}
                                        </span>
                                    </Row>
                                </Dropdown>
                                <Dropdown label="TP/SL" active={pane.showTpsl}>
                                    <Toggle
                                        checked={pane.showTpsl}
                                        onChange={(showTpsl) => updatePane(index, { showTpsl })}
                                        label="Show"
                                    />
                                    <Row label="Measure">
                                        <Segmented
                                            value={pane.metric}
                                            options={["count", "knownNotional"] as const}
                                            format={(v) => (v === "count" ? "Orders" : "Known size $")}
                                            onChange={(metric) => updatePane(index, { metric })}
                                        />
                                    </Row>
                                    {(
                                        [
                                            [
                                                "Kind",
                                                [
                                                    ["showTakeProfit", "TP"],
                                                    ["showStopLoss", "SL"]
                                                ]
                                            ],
                                            [
                                                "Side",
                                                [
                                                    ["showBuy", "Buy"],
                                                    ["showSell", "Sell"]
                                                ]
                                            ]
                                        ] as const
                                    ).map(([row, toggles]) => (
                                        <Row key={row} label={row}>
                                            {toggles.map(([key, label]) => (
                                                <Toggle
                                                    key={key}
                                                    checked={pane[key]}
                                                    onChange={(value) => updatePane(index, { [key]: value })}
                                                    label={label}
                                                />
                                            ))}
                                        </Row>
                                    ))}
                                </Dropdown>
                                <Dropdown label="Liquidations" active={pane.showLiq}>
                                    <Toggle
                                        checked={pane.showLiq}
                                        onChange={(showLiq) => updatePane(index, { showLiq })}
                                        label="Show"
                                    />
                                    <Row label="Min size">
                                        <Segmented
                                            value={pane.minNotional}
                                            options={[0, 50_000, ...SIZE_PRESETS]}
                                            format={(v) => (v === 0 ? "All" : formatPreset(v))}
                                            onChange={(minNotional) => updatePane(index, { minNotional })}
                                        />
                                    </Row>
                                </Dropdown>
                                <span className="divider" />
                                <Toggle
                                    checked={pane.showMark}
                                    onChange={(showMark) => updatePane(index, { showMark })}
                                    label="Mark line"
                                />
                                <span className="divider" />
                                <button
                                    className="btn"
                                    onClick={() => handles.current[index]?.fitLevels()}
                                    title="Widen the price scale to nearby liquidation levels"
                                >
                                    Fit levels
                                </button>
                                <button
                                    className="btn"
                                    onClick={() => handles.current[index]?.fitContent()}
                                    title="Default candle width at the latest candle, candle autoscale"
                                >
                                    Fit candles
                                </button>
                                <span className="divider" />
                                <button
                                    className="btn"
                                    onClick={() => handles.current[index]?.toggleLevels()}
                                    title="List the liquidation and TP/SL levels in view"
                                >
                                    Levels
                                </button>
                            </div>

                            <Chart
                                className="min-h-[320px] flex-1"
                                client={client}
                                coin={pane.coin}
                                interval={pane.interval}
                                theme={theme}
                                layers={layers[index]!}
                                onEvent={(event) => onEvent(index, event)}
                                onHandle={(handle) => (handles.current[index] = handle)}
                            />
                        </section>
                    ))}
            </main>

            {showLog && (
                <pre className="h-48 overflow-auto border-t border-line px-3 py-1 text-[11px] leading-4 text-muted">
                    {log.join("\n") || "No events yet."}
                </pre>
            )}
        </div>
    );
}
