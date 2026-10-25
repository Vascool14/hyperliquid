// charts share this client and release their data views when they unmount

import type {
    TCandleChange,
    TCandleInterval,
    ICandleView,
    IHydromancerClient,
    IHydromancerClientOptions,
    IMarketView
} from "../types";
import { CANDLE_INTERVALS } from "../types";
import { CandleFeed } from "./candle-feed";
import { DEFAULT_HISTORY_WINDOW_MS, LiquidationEventsFeed } from "./liquidation-events";
import { MarkFeed } from "./mark-feed";
import { PositionsFeed } from "./positions";
import { TpslFeed } from "./tpsl-feed";
import { SocketTransport, systemClock, type ITransportStatus } from "./transport";

const COIN_PATTERN = /^[A-Za-z0-9]{1,20}(:[A-Za-z0-9]{1,20})?$/;

export class ClientError extends Error {
    readonly code: "disposed" | "unsupported-market" | "unsupported-interval";

    constructor(code: ClientError["code"], message: string) {
        super(message);
        this.name = "ClientError";
        this.code = code;
    }
}

export function isSupportedCoin(coin: string): boolean {
    return COIN_PATTERN.test(coin);
}

export function createHydromancerClient(options: IHydromancerClientOptions = {}): IHydromancerClient {
    const infoUrl = options.infoUrl ?? "/api/hydromancer/info";
    const socketUrl = resolveSocketUrl(options.socketUrl ?? "/api/hydromancer/ws");
    const clock = systemClock;
    const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

    const marketListeners = new Map<string, Set<() => void>>();
    const notifyMarket = (coin: string) => {
        for (const listener of marketListeners.get(coin) ?? []) {
            safely(listener);
        }
    };

    let tpsl: TpslFeed | null = null;
    let candles: CandleFeed | null = null;
    let marks: MarkFeed | null = null;
    let events: LiquidationEventsFeed | null = null;

    const transport = new SocketTransport({
        url: socketUrl,
        clock,
        onStatus: (status: ITransportStatus) => {
            tpsl?.onTransport(status);
            candles?.onTransport(status);
            marks?.onTransport(status);
            events?.onTransport(status);
        }
    });

    const positions = new PositionsFeed({
        infoUrl,
        pollMs: options.positionsPollMs ?? 10_000,
        clock,
        isVisible,
        onChange: notifyMarket
    });
    tpsl = new TpslFeed({
        infoUrl,
        transport,
        clock,
        verifyMs: options.tpslVerifyMs ?? 120_000,
        isVisible,
        onChange: (coins) => {
            for (const coin of coins) {
                notifyMarket(coin);
            }
        }
    });
    candles = new CandleFeed({
        infoUrl,
        transport,
        clock,
        historyBars: options.candleHistoryBars ?? 1000
    });
    marks = new MarkFeed({
        transport,
        now: () => clock.now(),
        onChange: notifyMarket
    });

    events = new LiquidationEventsFeed({
        infoUrl,
        transport,
        clock,
        historyWindowMs: options.liquidationHistoryMs ?? DEFAULT_HISTORY_WINDOW_MS,
        onChange: notifyMarket
    });

    const onVisibility = () => {
        if (isVisible()) {
            positions.wake();
        }
    };
    if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibility);
    }

    let destroyed = false;
    const assertAlive = () => {
        if (destroyed) {
            throw new ClientError("disposed", "The client was destroyed.");
        }
    };

    function acquireMarket(coin: string): IMarketView {
        assertAlive();
        if (!isSupportedCoin(coin)) {
            throw new ClientError("unsupported-market", `Invalid coin ${coin}.`);
        }
        positions.acquire(coin);
        tpsl!.acquire(coin);
        marks!.acquire(coin);
        events!.acquire(coin);

        const own = new Set<() => void>();
        let released = false;

        return {
            coin,
            positions: () => positions.snapshot(coin),
            orders: () => tpsl!.orders(coin),
            ordersVersion: () => tpsl!.version(coin),
            tpslHeight: () => tpsl!.height(coin),
            markPx: () => marks!.markPx(coin),
            events: () => events!.events(coin),
            eventsVersion: () => events!.version(coin),
            status: (dataset) => {
                switch (dataset) {
                    case "positions":
                        return positions.status(coin);
                    case "tpsl":
                        return tpsl!.status(coin);
                    case "events":
                        return events!.status(coin);
                    default:
                        return marks!.status(coin);
                }
            },
            subscribe(listener) {
                if (released) {
                    return () => {};
                }
                let set = marketListeners.get(coin);
                if (!set) {
                    set = new Set();
                    marketListeners.set(coin, set);
                }
                set.add(listener);
                own.add(listener);
                return () => {
                    set.delete(listener);
                    own.delete(listener);
                };
            },
            release() {
                if (released || destroyed) {
                    released = true;
                    return;
                }
                released = true;
                const set = marketListeners.get(coin);
                for (const listener of own) {
                    set?.delete(listener);
                }
                own.clear();
                positions.release(coin);
                tpsl!.release(coin);
                marks!.release(coin);
                events!.release(coin);
            }
        };
    }

    function acquireCandles(coin: string, interval: TCandleInterval): ICandleView {
        assertAlive();
        if (!isSupportedCoin(coin)) {
            throw new ClientError("unsupported-market", `Invalid coin ${coin}.`);
        }
        if (!CANDLE_INTERVALS.includes(interval)) {
            throw new ClientError("unsupported-interval", `Unsupported interval ${interval}.`);
        }
        const entry = candles!.acquire(coin, interval);
        const own = new Set<(change: TCandleChange) => void>();
        let released = false;

        return {
            coin,
            interval,
            bars: () => entry.store.toArray(),
            status: () => entry.status,
            subscribe(listener) {
                if (released) {
                    return () => {};
                }
                const wrapped = (change: TCandleChange) => safely(() => listener(change));
                entry.listeners.add(wrapped);
                own.add(wrapped);
                return () => {
                    entry.listeners.delete(wrapped);
                    own.delete(wrapped);
                };
            },
            release() {
                if (released || destroyed) {
                    released = true;
                    return;
                }
                released = true;
                for (const listener of own) {
                    entry.listeners.delete(listener);
                }
                candles!.release(entry);
            }
        };
    }

    return {
        acquireMarket,
        acquireCandles,
        setLiquidationHistoryWindow(windowMs: number) {
            assertAlive();
            events!.setHistoryWindow(windowMs);
        },
        simulateDisconnect() {
            transport.drop();
        },
        destroy() {
            if (destroyed) {
                return;
            }
            destroyed = true;
            if (typeof document !== "undefined") {
                document.removeEventListener("visibilitychange", onVisibility);
            }
            positions.destroy();
            tpsl!.destroy();
            candles!.destroy();
            marks!.destroy();
            events!.destroy();
            transport.destroy();
            marketListeners.clear();
        }
    };
}

// a failing subscriber must not break shared data updates
function safely(callback: () => void): void {
    try {
        callback();
    } catch (error) {
        console.error("[hydromancer-charts] listener failed", error);
    }
}

function resolveSocketUrl(url: string): string {
    if (/^wss?:\/\//.test(url) || typeof location === "undefined") {
        return url;
    }
    const resolved = new URL(url, location.href);
    resolved.protocol = resolved.protocol === "https:" ? "wss:" : "ws:";
    return resolved.toString();
}
