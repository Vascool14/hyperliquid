import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { InfoProxy } from "../src/rest.ts";
import { createGateway, INFO_PATH, WS_PATH } from "../src/server.ts";

const servers: { close: () => void }[] = [];

afterEach(() => {
    for (const server of servers.splice(0)) {
        server.close();
    }
});

async function start() {
    const proxy = new InfoProxy({
        apiKey: "test",
        fetchImpl: (async () =>
            new Response('{"snapshot_id":"x"}', {
                status: 200
            })) as typeof fetch
    });
    const server = createGateway({
        apiKey: "test",
        allowedOrigins: ["http://localhost:5173"],
        proxy,
        upstreamWsUrl: "ws://127.0.0.1:1"
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    return `127.0.0.1:${port}`;
}

describe("gateway HTTP boundary", () => {
    it("only forwards requests from allowed browser origins", async () => {
        const host = await start();
        const response = await fetch(`http://${host}${INFO_PATH}`, {
            method: "POST",
            headers: { origin: "https://evil.example" },
            body: '{"type":"perpSnapshotTimestamp"}'
        });
        expect(response.status).toBe(403);
        const allowed = await fetch(`http://${host}${INFO_PATH}`, {
            method: "POST",
            headers: { origin: "http://localhost:5173" },
            body: '{"type":"perpSnapshotTimestamp"}'
        });
        expect(allowed.status).toBe(200);
        expect(await allowed.json()).toEqual({ snapshot_id: "x" });
    });

    it("refuses WebSocket upgrades from unapproved origins", async () => {
        const host = await start();
        const socket = new WebSocket(`ws://${host}${WS_PATH}`, {
            origin: "https://evil.example"
        });
        const status = await new Promise<number>((resolve) => {
            socket.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
            socket.on("error", () => resolve(-1));
        });
        expect(status).toBe(403);
    });
});
