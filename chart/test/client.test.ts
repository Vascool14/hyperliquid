import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHydromancerClient } from "../src/data/hydromancer-client";
import type { IHydromancerClient } from "../src/types";
import { addDiff, removeDiff } from "./fixtures";
import { FakeSocket, installFakeApi, type IFakeApi } from "./fake-network";

let api: IFakeApi;
let client: IHydromancerClient | null = null;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    api = installFakeApi();
});

afterEach(() => {
    client?.destroy();
    client = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function start() {
    client = createHydromancerClient({
        infoUrl: "http://test/info",
        socketUrl: "ws://test/ws"
    });
    return client;
}

function tpslFrame(seq: number, height: number, diffs: unknown[]) {
    return {
        type: "tpslUpdates",
        channel: "tpslUpdates",
        seq,
        data: { height, timestamp: height, diffs }
    };
}

async function settle(ms = 200) {
    await vi.advanceTimersByTimeAsync(ms);
}

describe("shared Hydromancer client", () => {
    it("resynchronizes TP/SL from a snapshot after a sequence gap", async () => {
        const c = start();
        const market = c.acquireMarket("BTC");
        await settle();
        const socket = FakeSocket.latest();
        socket.open();
        await settle();

        socket.receive(tpslFrame(1, 101, [addDiff(5, "BTC")]));
        expect(market.orders().has("5")).toBe(true);

        api.tpslHeight = 104n;
        socket.receive(tpslFrame(3, 103, [removeDiff(1, "BTC")]));
        expect(market.status("tpsl").state).toBe("resyncing");
        socket.receive(tpslFrame(4, 104, []));
        socket.receive(tpslFrame(5, 105, [addDiff(9, "BTC")]));
        await settle();

        expect(api.count("tpslBook")).toBe(2);
        expect(market.status("tpsl").state).toBe("live");
        // the snapshot covers height 104, only replay block 105
        expect([...market.orders().keys()].sort()).toEqual(["1", "9"]);
    });

    it("keeps last-good positions and honors retry-after on 429", async () => {
        const c = start();
        const market = c.acquireMarket("BTC");
        await settle();
        expect(market.status("positions").state).toBe("live");

        api.snapshotId = "20261023_2000";
        api.respond.perpSnapshots = () =>
            new Response('{"error":"quota"}', {
                status: 429,
                headers: { "retry-after": "120" }
            });
        await settle(10_000);

        const status = market.status("positions");
        expect(status.state).toBe("stale");
        expect(status.reason).toBe("rate-limited");
        expect(market.positions()?.snapshotId).toBe("20261023_1000");

        const attempts = api.count("perpSnapshots");
        await settle(60_000);
        expect(api.count("perpSnapshots")).toBe(attempts);
    });
});
