import { expect, it } from "vitest";
import {
    decodePositionsResponse,
    decodeTpslBookResponse,
    decompressBounded
} from "../src/data/decode-snapshots";
import { WireError } from "../src/data/wire";
import {
    msgpack,
    multiFrame,
    position,
    positionMarket,
    tpslBook,
    tpslTuple,
    u32,
    concat,
    zstd
} from "./fixtures";

it("decodes position sides and notionals across raw, compressed and multi-market payloads", () => {
    const btc = msgpack(
        positionMarket("BTC", [position(0.5, 40_000, 70_000), position(-2, 160_000, 95_000)])
    );
    for (const bytes of [btc, zstd(btc)]) {
        const result = decodePositionsResponse(bytes, "msgpack", ["BTC"]).get("BTC");
        if (!result?.ok) throw new Error("expected BTC snapshot");
        expect(result.market.snapshotId).toBe("20261023_1194200000");
        expect(result.market.positions.map((p) => [p.side, p.notional])).toEqual([
            ["long", 40_000],
            ["short", 160_000]
        ]);
    }
    const multi = multiFrame([zstd(btc), zstd(msgpack(positionMarket("ETH", [position(-3, 9_000, 3_000)])))]);
    const result = decodePositionsResponse(multi, "multi-zstd", ["BTC", "ETH"]);
    expect([...result.keys()]).toEqual(["BTC", "ETH"]);
    expect(result.get("BTC")?.ok).toBe(true);
    expect(result.get("ETH")?.ok).toBe(true);
});

it("rejects mismatched owners, unrequested markets and corrupt position framing", () => {
    const mismatched = msgpack(
        positionMarket("BTC", [position(1, 1, 1), position(1, 1, 1)], "1", [
            "0x0000000000000000000000000000000000000001"
        ])
    );
    expect(decodePositionsResponse(mismatched, "msgpack", ["BTC"]).get("BTC")?.ok).toBe(false);
    expect(() =>
        decodePositionsResponse(msgpack(positionMarket("SOL", [position(1, 1, 1)])), "msgpack", ["BTC"])
    ).toThrow(WireError);
    const blob = zstd(msgpack(positionMarket("BTC", [position(1, 1, 1)])));
    for (const bytes of [
        concat(u32(1), u32(blob.byteLength + 10), blob),
        concat(multiFrame([blob]), new Uint8Array([0]))
    ]) {
        expect(() => decodePositionsResponse(bytes, "multi-zstd", ["BTC"])).toThrow(WireError);
    }
    expect(() =>
        decodePositionsResponse(new TextEncoder().encode("<html>oops</html>"), "msgpack", ["BTC"])
    ).toThrow(WireError);
    for (const bytes of [new Uint8Array(12), tpslBook(1n, [["BTC", [tpslTuple(1n, "BTC").slice(0, 11)]]])]) {
        expect(() => decodeTpslBookResponse(bytes, ["BTC"])).toThrow(WireError);
    }
    expect(() => decompressBounded(zstd(new Uint8Array(4096)), 1024)).toThrow(/exceeds/);
});
