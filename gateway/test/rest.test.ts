import { describe, expect, it } from "vitest";
import { InfoProxy } from "../src/rest.ts";
import { validateInfoRequest, type TValidatedRequest } from "../src/validate.ts";

const KEY = "sk_test_key";

function request(body: unknown): TValidatedRequest {
    const result = validateInfoRequest(body);
    if (!result.ok) {
        throw new Error(result.error);
    }
    return result.request;
}

type TFetchCall = { url: string; init: RequestInit };

function fakeFetch(respond: (call: TFetchCall) => Response | Promise<Response>) {
    const calls: TFetchCall[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
        const call = { url: String(url), init: init ?? {} };
        calls.push(call);
        return respond(call);
    }) as typeof fetch;
    return { calls, impl };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

const PERP = { type: "perpSnapshots", market_names: ["BTC"] };

describe("InfoProxy", () => {
    it("injects the bearer key upstream and never forwards it", async () => {
        const { calls, impl } = fakeFetch(
            () =>
                new Response('{"snapshot_id":"1"}', {
                    status: 200,
                    headers: {
                        "content-encoding": "zstd",
                        "content-length": "999",
                        "x-payload-format": "msgpack",
                        "x-ratelimit-remaining": "4"
                    }
                })
        );
        const proxy = new InfoProxy({ apiKey: KEY, fetchImpl: impl });
        const result = await proxy.handle(request({ type: "perpSnapshotTimestamp" }));
        const headers = calls[0]!.init.headers as Record<string, string>;

        expect(headers.authorization).toBe(`Bearer ${KEY}`);
        expect(JSON.stringify(result.headers)).not.toContain(KEY);
        expect(result.headers["content-encoding"]).toBeUndefined();
        expect(result.headers["content-length"]).toBeUndefined();
        expect(result.headers["x-payload-format"]).toBe("msgpack");
        expect(result.headers["x-ratelimit-remaining"]).toBe("4");
    });

    it("shares and caches heavy requests even if one consumer aborts", async () => {
        const gate = deferred<Response>();
        const { calls, impl } = fakeFetch(() => gate.promise);
        const proxy = new InfoProxy({ apiKey: KEY, fetchImpl: impl });

        const controller = new AbortController();
        const first = proxy.handle(request(PERP), controller.signal);
        const second = proxy.handle(request(PERP));
        controller.abort(new Error("gone"));
        gate.resolve(new Response(new Uint8Array([1]), { status: 200 }));
        await expect(first).rejects.toThrow("gone");
        expect((await second).status).toBe(200);
        const third = await proxy.handle(request(PERP));

        expect(calls).toHaveLength(1);
        expect(third.headers["x-gateway-cache"]).toBe("hit");
    });

    it("shares one heavy budget across cache keys", async () => {
        let now = 0;
        const { calls, impl } = fakeFetch(() => new Response(new Uint8Array([1]), { status: 200 }));
        const proxy = new InfoProxy({
            apiKey: KEY,
            fetchImpl: impl,
            now: () => now,
            budgets: {
                perpSnapshots: {
                    capacity: 1,
                    windowMs: 600_000,
                    minSpacingMs: 0
                },
                tpslBook: { capacity: 1, windowMs: 300_000, minSpacingMs: 0 }
            }
        });

        await proxy.handle(request(PERP));
        now += 1000;
        const other = await proxy.handle(request({ type: "perpSnapshots", market_names: ["ETH"] }));

        expect(calls).toHaveLength(1);
        expect(other.status).toBe(429);
        expect(Number(other.headers["retry-after"])).toBe(599);
    });

    it("never caches errors and maps 429 retry metadata", async () => {
        const { calls, impl } = fakeFetch(
            () =>
                new Response(`{"error":"slow down ${KEY}"}`, {
                    status: 429,
                    headers: { "retry-after": "42" }
                })
        );
        const proxy = new InfoProxy({ apiKey: KEY, fetchImpl: impl });
        const result = await proxy.handle(request(PERP));
        const again = await proxy.handle(request(PERP));
        const text = new TextDecoder().decode(result.body);

        expect(result.status).toBe(429);
        expect(result.headers["retry-after"]).toBe("42");
        expect(text).not.toContain(KEY);
        expect(again.status).toBe(429);
        expect(calls).toHaveLength(1);
    });
});
