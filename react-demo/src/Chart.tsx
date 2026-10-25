import { useEffect, useRef } from "react";
import {
    createChart,
    type TCandleInterval,
    type TChartEvent,
    type IChartHandle,
    type DeepPartial,
    type IHydromancerClient,
    type ILayerOptions,
    type TThemeName
} from "hydromancer-charts";

export interface IChartProps {
    client: IHydromancerClient;
    coin: string;
    interval: TCandleInterval;
    theme: TThemeName;
    layers: DeepPartial<ILayerOptions>;
    onEvent?: (event: TChartEvent) => void;
    onHandle?: (handle: IChartHandle | null) => void;
    className?: string;
}

export function Chart(props: IChartProps) {
    const { client, coin, interval, theme, layers, className } = props;
    const hostRef = useRef<HTMLDivElement>(null);
    const handleRef = useRef<IChartHandle | null>(null);
    const latest = useRef(props);
    latest.current = props;

    useEffect(() => {
        const host = hostRef.current;
        if (!host) {
            return;
        }
        const { coin, interval, theme, layers } = latest.current;
        const handle = createChart(host, {
            data: client,
            coin,
            interval,
            theme,
            layers,
            // the demo toolbar has its own Levels button
            showLevelsButton: false
        });
        handleRef.current = handle;
        latest.current.onHandle?.(handle);
        const unsubscribe = handle.subscribe((event) => latest.current.onEvent?.(event));

        return () => {
            unsubscribe();
            latest.current.onHandle?.(null);
            handleRef.current = null;
            handle.destroy();
        };
    }, [client]);

    useEffect(() => {
        handleRef.current?.setMarket(coin).catch(ignoreSuperseded);
    }, [coin]);

    useEffect(() => {
        handleRef.current?.setInterval(interval).catch(ignoreSuperseded);
    }, [interval]);

    useEffect(() => {
        handleRef.current?.applyOptions({ theme, layers });
    }, [theme, layers]);

    return <div ref={hostRef} className={className} />;
}

function ignoreSuperseded(error: { code?: string }) {
    if (error.code !== "superseded" && error.code !== "disposed") {
        console.error(error);
    }
}
