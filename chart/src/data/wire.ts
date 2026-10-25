// validate provider JSON and MessagePack before turning them into app records

import type { TOrderSide, IPositionRecord, TTriggerKind, ITriggerOrderRecord } from "../types";

export class WireError extends Error {
    readonly code = "malformed-payload";

    constructor(message: string) {
        super(message);
        this.name = "WireError";
    }
}

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const UINT_PATTERN = /^\d+$/;

// reject empty strings, partial numbers, NaN and Infinity
export function parseDecimal(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function finiteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// wire IDs are uint64, reject JSON numbers that have already lost precision
export function parseUintId(value: unknown): string | null {
    if (typeof value === "bigint") {
        return value >= 0n ? value.toString() : null;
    }
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    }
    if (typeof value === "string" && UINT_PATTERN.test(value)) {
        return value;
    }
    return null;
}

export function parseTimestampMs(value: unknown): number | null {
    if (typeof value === "bigint") {
        return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
    }
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
        return value;
    }
    return null;
}

export function parseAddress(value: unknown): string | null {
    return typeof value === "string" && ADDRESS_PATTERN.test(value) ? value.toLowerCase() : null;
}

function rawString(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "bigint") {
        return String(value);
    }
    return "";
}

// position tuple is [size, notional, fundingPnl, entryPx, leverageTypeFlag, leverage, liquidationPx, accountValue]

export type TPositionRowResult =
    { ok: true; position: IPositionRecord } | { ok: false; reason: "invalid" | "zero-size" };

export function normalizePositionRow(
    coin: string,
    tuple: unknown,
    addressValue: unknown
): TPositionRowResult {
    if (!Array.isArray(tuple) || tuple.length !== 8) {
        return { ok: false, reason: "invalid" };
    }

    const address = parseAddress(addressValue);
    const size = finiteNumber(tuple[0]);
    const notional = finiteNumber(tuple[1]);
    const fundingPnl = finiteNumber(tuple[2]);
    const entryPx = finiteNumber(tuple[3]);
    const leverageFlag = tuple[4];
    const leverage = finiteNumber(tuple[5]);
    const liquidationPx = finiteNumber(tuple[6]);
    const accountValue = finiteNumber(tuple[7]);

    if (
        address === null ||
        size === null ||
        notional === null ||
        notional < 0 ||
        fundingPnl === null ||
        entryPx === null ||
        entryPx <= 0 ||
        (leverageFlag !== 0 && leverageFlag !== 1) ||
        leverage === null ||
        leverage <= 0
    ) {
        return { ok: false, reason: "invalid" };
    }
    if (size === 0) {
        return { ok: false, reason: "zero-size" };
    }

    return {
        ok: true,
        position: {
            id: `${coin}:${address}`,
            coin,
            address,
            side: size > 0 ? "long" : "short",
            size,
            notional,
            entryPx,
            leverageType: leverageFlag === 0 ? "cross" : "isolated",
            leverage,
            liquidationPx: liquidationPx !== null && liquidationPx > 0 ? liquidationPx : null,
            fundingPnl,
            accountValue
        }
    };
}

// orders arrive as snapshot tuples or live add diffs

export interface ITriggerOrderFields {
    oid: unknown;
    coin: unknown;
    user: unknown;
    side: unknown;
    triggerPx: unknown;
    limitPx: unknown;
    sz: unknown;
    triggerCondition: unknown;
    orderType: unknown;
    isPositionTpsl: unknown;
    reduceOnly: unknown;
    timestamp: unknown;
}

export function orderFieldsFromTuple(tuple: unknown): ITriggerOrderFields {
    if (!Array.isArray(tuple) || tuple.length !== 12) {
        throw new WireError("TP/SL order tuple must have 12 fields.");
    }
    return {
        oid: tuple[0],
        coin: tuple[1],
        user: tuple[2],
        side: tuple[3],
        triggerPx: tuple[4],
        limitPx: tuple[5],
        sz: tuple[6],
        triggerCondition: tuple[7],
        orderType: tuple[8],
        isPositionTpsl: tuple[9],
        reduceOnly: tuple[10],
        timestamp: tuple[11]
    };
}

export function classifyOrderType(orderType: string): TTriggerKind {
    if (orderType.includes("Take Profit")) {
        return "tp";
    }
    if (orderType.includes("Stop")) {
        return "sl";
    }
    return "unknown";
}

export function normalizeTriggerOrder(fields: ITriggerOrderFields): ITriggerOrderRecord | null {
    const id = parseUintId(fields.oid);
    const user = parseAddress(fields.user);
    const triggerPx = parseDecimal(fields.triggerPx);
    const limitPx = parseDecimal(fields.limitPx);
    const size = parseDecimal(fields.sz);
    const side: TOrderSide | null = fields.side === "A" ? "sell" : fields.side === "B" ? "buy" : null;

    if (
        id === null ||
        typeof fields.coin !== "string" ||
        user === null ||
        side === null ||
        triggerPx === null ||
        triggerPx < 0 ||
        size === null ||
        size < 0 ||
        typeof fields.orderType !== "string" ||
        typeof fields.isPositionTpsl !== "boolean" ||
        typeof fields.reduceOnly !== "boolean"
    ) {
        return null;
    }

    return {
        id,
        coin: fields.coin,
        user,
        side,
        kind: classifyOrderType(fields.orderType),
        orderType: fields.orderType,
        isTrailing: fields.orderType.includes("Trailing"),
        triggerPx: triggerPx > 0 ? triggerPx : null,
        triggerPxRaw: rawString(fields.triggerPx),
        limitPx,
        limitPxRaw: rawString(fields.limitPx),
        size,
        sizeRaw: rawString(fields.sz),
        sizeKnown: size > 0,
        triggerCondition: typeof fields.triggerCondition === "string" ? fields.triggerCondition : "",
        isPositionTpsl: fields.isPositionTpsl,
        reduceOnly: fields.reduceOnly,
        createdMs: parseTimestampMs(fields.timestamp)
    };
}

export interface IWireCandle {
    timeMs: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export function normalizeCandle(value: unknown, coin: string, interval: string): IWireCandle | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const candle = value as Record<string, unknown>;
    if (candle.s !== coin || candle.i !== interval) {
        return null;
    }

    const timeMs = parseTimestampMs(candle.t);
    const open = parseDecimal(candle.o);
    const high = parseDecimal(candle.h);
    const low = parseDecimal(candle.l);
    const close = parseDecimal(candle.c);
    const volume = parseDecimal(candle.v);

    if (
        timeMs === null ||
        open === null ||
        high === null ||
        low === null ||
        close === null ||
        volume === null
    ) {
        return null;
    }
    if (high < Math.max(open, close, low) || low > Math.min(open, close)) {
        return null;
    }
    return { timeMs, open, high, low, close, volume };
}
