// fake HTTP and sockets so tests can drive reconnects without a network
import { vi } from "vitest";
import { msgpack, position, positionMarket, tpslBook, tpslTuple } from "./fixtures";

export class FakeSocket {
    static instances: FakeSocket[] = [];
    readyState = 0;
    sent: Record<string, unknown>[] = [];
    closedWith: number | null = null;
    onopen: ((event: unknown) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    readonly url: string;

    constructor(url: string) {
        this.url = url;
        FakeSocket.instances.push(this);
    }

    static latest(): FakeSocket {
        const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
        if (!socket) {
            throw new Error("No socket was created.");
        }
        return socket;
    }

    open(): void {
        this.readyState = 1;
        this.onopen?.({});
    }

    receive(message: unknown): void {
        this.onmessage?.({ data: JSON.stringify(message) });
    }

    send(data: string): void {
        this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }

    close(code = 1000, reason = ""): void {
        if (this.readyState === 3) {
            return;
        }
        this.readyState = 3;
        this.closedWith = code;
        this.onclose?.({ code, reason });
    }

    subscriptions(method = "subscribe") {
        return this.sent
            .filter((m) => m.method === method)
            .map((m) => m.subscription as Record<string, unknown>);
    }
}

export interface IFakeApi {
    calls: Record<string, unknown>[];
    count(type: string): number;
    respond: Partial<Record<string, (body: Record<string, unknown>) => Response>>;
    tpslHeight: bigint;
    snapshotId: string;
}

export function installFakeApi(): IFakeApi {
    const api: IFakeApi = {
        calls: [],
        count: (type) => api.calls.filter((c) => c.type === type).length,
        respond: {},
        tpslHeight: 100n,
        snapshotId: "20261023_1000"
    };

    const fetchImpl = async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        api.calls.push(body);
        const override = api.respond[String(body.type)];
        if (override) {
            return override(body);
        }
        switch (body.type) {
            case "perpSnapshotTimestamp":
                return Response.json({
                    snapshot_id: api.snapshotId,
                    timestamp: Math.floor(Date.now() / 1000)
                });
            case "perpSnapshots": {
                const coins = body.market_names as string[];
                const bytes = msgpack(
                    positionMarket(coins[0]!, [position(1, 250_000, 70_000)], api.snapshotId)
                );
                return new Response(new Uint8Array(bytes), {
                    headers: { "x-payload-format": "msgpack" }
                });
            }
            case "tpslBook": {
                const coins = body.coins as string[];
                return new Response(
                    new Uint8Array(
                        tpslBook(
                            api.tpslHeight,
                            coins.map((coin) => [coin, [tpslTuple(1n, coin)]])
                        )
                    )
                );
            }
            case "candleSnapshot":
                return Response.json([]);
            default:
                return new Response("{}", { status: 400 });
        }
    };

    vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("WebSocket", FakeSocket);
    FakeSocket.instances = [];
    return api;
}
