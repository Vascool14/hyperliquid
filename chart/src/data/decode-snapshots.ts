// positions and TP/SL share decoding helpers but use different wire formats

import { Decoder } from "@msgpack/msgpack";
import { Decompress } from "fzstd";
import type { IPositionRecord, ITriggerOrderRecord } from "../types";
import {
    normalizePositionRow,
    normalizeTriggerOrder,
    orderFieldsFromTuple,
    parseTimestampMs,
    WireError
} from "./wire";

// local safety limits for our small market set, these are not provider limits
export const DECODE_LIMITS = {
    maxWireBytes: 32 * 1024 * 1024,
    maxDecodedBytes: 128 * 1024 * 1024,
    maxBlobs: 64
};

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const TPSL_HEADER_BYTES = 20;

const msgpack = new Decoder({ useBigInt64: true });

export function hasZstdMagic(bytes: Uint8Array): boolean {
    return ZSTD_MAGIC.every((value, index) => bytes[index] === value);
}

export function decompressBounded(
    bytes: Uint8Array,
    maxBytes: number = DECODE_LIMITS.maxDecodedBytes
): Uint8Array {
    if (!hasZstdMagic(bytes)) {
        throw new WireError("Expected a zstd frame.");
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const stream = new Decompress((chunk) => {
        total += chunk.byteLength;
        if (total > maxBytes) {
            throw new WireError(`Decompressed size exceeds ${maxBytes} bytes.`);
        }
        chunks.push(chunk);
    });

    try {
        stream.push(bytes, true);
    } catch (error) {
        if (error instanceof WireError) {
            throw error;
        }
        throw new WireError("Invalid zstd data.");
    }
    return concat(chunks, total);
}

function decodeMsgpack(bytes: Uint8Array): unknown {
    try {
        return msgpack.decode(bytes);
    } catch {
        throw new WireError("Invalid MessagePack data.");
    }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
    if (chunks.length === 1) {
        return chunks[0]!;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

function checkWireSize(bytes: Uint8Array) {
    if (bytes.byteLength > DECODE_LIMITS.maxWireBytes) {
        throw new WireError("Payload exceeds the wire size limit.");
    }
}

// wire format is [count:u32LE] followed by [length:u32LE][blob] for each market
function readBlobs(bytes: Uint8Array, headerBytes: number): Uint8Array[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < headerBytes) {
        throw new WireError("Truncated frame header.");
    }
    const count = view.getUint32(0, true);
    if (count > DECODE_LIMITS.maxBlobs) {
        throw new WireError(`Implausible blob count ${count}.`);
    }

    const blobs: Uint8Array[] = [];
    let offset = headerBytes;
    for (let index = 0; index < count; index++) {
        if (offset + 4 > bytes.byteLength) {
            throw new WireError("Truncated blob length.");
        }
        const length = view.getUint32(offset, true);
        offset += 4;
        if (length === 0 || offset + length > bytes.byteLength) {
            throw new WireError("Blob length exceeds the frame.");
        }
        blobs.push(bytes.subarray(offset, offset + length));
        offset += length;
    }
    if (offset !== bytes.byteLength) {
        throw new WireError("Unexpected trailing bytes after the last blob.");
    }
    return blobs;
}

export interface IDecodedPositionMarket {
    coin: string;
    snapshotId: string;
    positions: IPositionRecord[];
    totalRows: number;
    unavailableLiquidationPx: number;
    invalidRows: number;
    zeroSizeRows: number;
    duplicateRows: number;
}

export type TPositionMarketResult =
    { ok: true; market: IDecodedPositionMarket } | { ok: false; error: WireError };

// check the bytes as well as x-payload-format, fetch may have already decompressed zstd
export function decodePositionsResponse(
    bytes: Uint8Array,
    format: string | null,
    requestedCoins: readonly string[]
): Map<string, TPositionMarketResult> {
    checkWireSize(bytes);
    const results = new Map<string, TPositionMarketResult>();
    const isMulti =
        format === "multi-zstd" || (format === null && !hasZstdMagic(bytes) && !isMsgpackArray(bytes));

    const blobs = isMulti ? readBlobs(bytes, 4) : [bytes];
    if (!isMulti && requestedCoins.length !== 1) {
        throw new WireError("Single-market payload for a multi-market request.");
    }

    for (const blob of blobs) {
        const decoded = decodeMsgpack(hasZstdMagic(blob) ? decompressBounded(blob) : requireMsgpack(blob));
        const result = normalizePositionMarket(decoded, requestedCoins);
        const coin = result.ok ? result.market.coin : marketName(decoded);
        if (coin === null || !requestedCoins.includes(coin)) {
            throw new WireError("Snapshot contains an unrequested market.");
        }
        if (results.has(coin)) {
            throw new WireError(`Duplicate market ${coin} in snapshot.`);
        }
        results.set(coin, result);
    }
    return results;
}

function isMsgpackArray(bytes: Uint8Array): boolean {
    const first = bytes[0];
    return first === 0x94 || first === 0xdc || first === 0xdd;
}

function requireMsgpack(bytes: Uint8Array): Uint8Array {
    const first = bytes[0] ?? 0;
    const isArrayOrMap = isMsgpackArray(bytes) || (first & 0xf0) === 0x80 || first === 0xde;
    if (!isArrayOrMap) {
        throw new WireError("Payload is neither zstd nor a MessagePack value.");
    }
    return bytes;
}

function marketName(decoded: unknown): string | null {
    if (Array.isArray(decoded) && typeof decoded[1] === "string") {
        return decoded[1];
    }
    return null;
}

function normalizePositionMarket(decoded: unknown, requestedCoins: readonly string[]): TPositionMarketResult {
    if (!Array.isArray(decoded) || decoded.length !== 4) {
        return fail("Position market must be [snapshotId, coin, rows, addresses].");
    }
    const [rawId, coin, rows, addresses] = decoded as unknown[];
    const snapshotId =
        typeof rawId === "string"
            ? rawId
            : typeof rawId === "number" || typeof rawId === "bigint"
              ? String(rawId)
              : null;

    if (snapshotId === null || snapshotId.length === 0) {
        return fail("Missing snapshot ID.");
    }
    if (typeof coin !== "string" || !requestedCoins.includes(coin)) {
        return fail("Snapshot market does not match the request.");
    }
    if (!Array.isArray(rows) || !Array.isArray(addresses)) {
        return fail("Positions and addresses must be arrays.");
    }
    if (rows.length !== addresses.length) {
        return fail(`Positions (${rows.length}) and addresses ` + `(${addresses.length}) differ in length.`);
    }

    const market: IDecodedPositionMarket = {
        coin,
        snapshotId,
        positions: [],
        totalRows: rows.length,
        unavailableLiquidationPx: 0,
        invalidRows: 0,
        zeroSizeRows: 0,
        duplicateRows: 0
    };
    const seen = new Set<string>();

    for (let index = 0; index < rows.length; index++) {
        const row = normalizePositionRow(coin, rows[index], addresses[index]);
        if (!row.ok) {
            if (row.reason === "zero-size") {
                market.zeroSizeRows++;
            } else {
                market.invalidRows++;
            }
            continue;
        }
        if (seen.has(row.position.id)) {
            market.duplicateRows++;
            continue;
        }
        seen.add(row.position.id);
        if (row.position.liquidationPx === null) {
            market.unavailableLiquidationPx++;
        }
        market.positions.push(row.position);
    }

    return { ok: true, market };
}

function fail(message: string): TPositionMarketResult {
    return { ok: false, error: new WireError(message) };
}

// TP/SL header is [count:u32][height:u64][timestampMs:u64]
// each length-prefixed blob is zstd(msgpack([coin, orderTuples]))

export interface IDecodedTpslBook {
    height: number;
    timestampMs: number;
    markets: Map<string, ITriggerOrderRecord[]>;
    invalidOrders: number;
}

export function decodeTpslBookResponse(
    bytes: Uint8Array,
    requestedCoins: readonly string[]
): IDecodedTpslBook {
    checkWireSize(bytes);
    if (bytes.byteLength < TPSL_HEADER_BYTES) {
        throw new WireError("Truncated TP/SL header.");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const height = parseTimestampMs(view.getBigUint64(4, true));
    const timestampMs = parseTimestampMs(view.getBigUint64(12, true));
    if (height === null || timestampMs === null) {
        throw new WireError("TP/SL header values exceed safe integers.");
    }

    const book: IDecodedTpslBook = {
        height,
        timestampMs,
        markets: new Map(),
        invalidOrders: 0
    };

    for (const blob of readBlobs(bytes, TPSL_HEADER_BYTES)) {
        const decoded = decodeMsgpack(decompressBounded(blob));
        if (!Array.isArray(decoded) || decoded.length !== 2) {
            throw new WireError("TP/SL market must be [coin, orders].");
        }
        const [coin, tuples] = decoded as unknown[];
        if (typeof coin !== "string" || !requestedCoins.includes(coin)) {
            throw new WireError("TP/SL book contains an unrequested market.");
        }
        if (!Array.isArray(tuples)) {
            throw new WireError("TP/SL orders must be an array.");
        }
        if (book.markets.has(coin)) {
            throw new WireError(`Duplicate market ${coin} in TP/SL book.`);
        }

        const orders: ITriggerOrderRecord[] = [];
        for (const tuple of tuples) {
            const order = normalizeTriggerOrder(orderFieldsFromTuple(tuple));
            if (order === null || order.coin !== coin) {
                book.invalidOrders++;
                continue;
            }
            orders.push(order);
        }
        book.markets.set(coin, orders);
    }

    // the provider leaves out markets with no orders
    for (const coin of requestedCoins) {
        if (!book.markets.has(coin)) {
            book.markets.set(coin, []);
        }
    }
    return book;
}
