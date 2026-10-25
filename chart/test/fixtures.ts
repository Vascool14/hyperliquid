// fake wallets and synthetic payloads using the provider's real wire format
import { zstdCompressSync } from "node:zlib";
import { Encoder } from "@msgpack/msgpack";

const encoder = new Encoder({ useBigInt64: true });

export function wallet(n: number): string {
    return `0x${n.toString(16).padStart(40, "0")}`;
}

export function msgpack(value: unknown): Uint8Array {
    return encoder.encode(value);
}

export function zstd(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(zstdCompressSync(bytes));
}

export function u32(value: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    return out;
}

export function u64(value: bigint): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, value, true);
    return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

export type TPositionTuple = [number, number, number, number, number, number, number, number];

// [size, notional, fundingPnl, entry, levFlag, leverage, liqPx, accountValue]
export function position(
    size: number,
    notional: number,
    liquidationPx: number,
    overrides: Partial<Record<number, unknown>> = {}
): unknown[] {
    const row: unknown[] = [size, notional, -1.5, 80000, 0, 20, liquidationPx, 25000];
    for (const [index, value] of Object.entries(overrides)) {
        row[Number(index)] = value;
    }
    return row;
}

export function positionMarket(
    coin: string,
    rows: unknown[],
    snapshotId = "20261023_1194200000",
    addresses?: unknown[]
): unknown[] {
    return [snapshotId, coin, rows, addresses ?? rows.map((_, i) => wallet(i + 1))];
}

export function multiFrame(blobs: Uint8Array[]): Uint8Array {
    return concat(u32(blobs.length), ...blobs.flatMap((blob) => [u32(blob.byteLength), blob]));
}

export function tpslTuple(
    oid: bigint,
    coin: string,
    options: {
        side?: "A" | "B";
        triggerPx?: string;
        sz?: string;
        orderType?: string;
        attached?: boolean;
        user?: number;
    } = {}
): unknown[] {
    const triggerPx = options.triggerPx ?? "90000";
    return [
        oid,
        coin,
        wallet(options.user ?? 7),
        options.side ?? "A",
        triggerPx,
        triggerPx,
        options.sz ?? "0.5",
        `Price above ${triggerPx}`,
        options.orderType ?? "Take Profit Market",
        options.attached ?? false,
        true,
        1792749394920n
    ];
}

export function tpslBook(
    height: bigint,
    markets: [string, unknown[][]][],
    timestampMs = 1792749394920n
): Uint8Array {
    const blobs = markets.map((market) => zstd(msgpack(market)));
    return concat(
        u32(blobs.length),
        u64(height),
        u64(timestampMs),
        ...blobs.flatMap((blob) => [u32(blob.byteLength), blob])
    );
}

export function addDiff(oid: number, coin: string, triggerPx = "91000") {
    return {
        type: "add",
        oid,
        coin,
        user: wallet(9),
        side: "B",
        triggerPx,
        limitPx: triggerPx,
        sz: "0",
        triggerCondition: `Price below ${triggerPx}`,
        orderType: "Stop Market",
        isPositionTpsl: true,
        reduceOnly: true,
        timestamp: 1792749694681
    };
}

export function removeDiff(oid: number, coin: string, reason = "canceled") {
    return { type: "remove", oid, coin, reason };
}
