// rebuild requests from validated fields so unknown keys never reach upstream

export type THeavyKind = "perpSnapshots" | "tpslBook";

export type TValidatedRequest = {
    body: Record<string, unknown>;
    heavy: THeavyKind | null;
    cacheKey: string | null;
};

export type TValidationResult = { ok: true; request: TValidatedRequest } | { ok: false; error: string };

export const MAX_COINS = 4;

const COIN_PATTERN = /^[A-Za-z0-9]{1,20}(:[A-Za-z0-9]{1,20})?$/;

const INTERVAL_MS: Record<string, number> = {
    "15s": 15_000,
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000
};

const MAX_CANDLES_PER_REQUEST = 5000;
const EARLIEST_TIME_MS = Date.UTC(2020, 0, 1);
const MAX_LIQUIDATION_SPAN_MS = 7 * 24 * 3_600_000;

export function isValidCoin(value: unknown): value is string {
    return typeof value === "string" && COIN_PATTERN.test(value);
}

export function canonicalCoins(value: unknown): string[] | null {
    if (!Array.isArray(value) || value.length === 0) {
        return null;
    }
    if (value.length > MAX_COINS || !value.every(isValidCoin)) {
        return null;
    }
    return [...new Set(value as string[])].sort();
}

function isTimeMs(value: unknown, nowMs: number): value is number {
    return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= EARLIEST_TIME_MS &&
        value <= nowMs + 86_400_000
    );
}

function ok(
    body: Record<string, unknown>,
    heavy: THeavyKind | null = null,
    cacheKey: string | null = null
): TValidationResult {
    return { ok: true, request: { body, heavy, cacheKey } };
}

function fail(error: string): TValidationResult {
    return { ok: false, error };
}

export function validateInfoRequest(input: unknown, nowMs: number = Date.now()): TValidationResult {
    if (typeof input !== "object" || input === null) {
        return fail("Request body must be a JSON object.");
    }
    const request = input as Record<string, unknown>;

    switch (request.type) {
        case "perpSnapshotTimestamp":
        case "metaAndAssetCtxs":
            return ok({ type: request.type });

        case "perpSnapshots": {
            const coins = canonicalCoins(request.market_names);
            if (!coins) {
                return fail(`market_names must list 1-${MAX_COINS} coins.`);
            }
            return ok(
                { type: "perpSnapshots", market_names: coins },
                "perpSnapshots",
                `perpSnapshots:${coins.join(",")}`
            );
        }

        case "tpslBook": {
            const coins = canonicalCoins(request.coins);
            if (!coins) {
                return fail(`coins must list 1-${MAX_COINS} coins.`);
            }
            return ok({ type: "tpslBook", coins }, "tpslBook", `tpslBook:${coins.join(",")}`);
        }

        case "candleSnapshot":
            return validateCandleRequest(request.req, nowMs);

        case "liquidationHistoryByTime":
            return validateLiquidationHistory(request, nowMs);

        default:
            return fail("Unsupported request type.");
    }
}

function validateCandleRequest(input: unknown, nowMs: number): TValidationResult {
    if (typeof input !== "object" || input === null) {
        return fail("candleSnapshot requires req.");
    }
    const req = input as Record<string, unknown>;
    const intervalMs = typeof req.interval === "string" ? INTERVAL_MS[req.interval] : undefined;

    if (!isValidCoin(req.coin)) {
        return fail("Invalid coin.");
    }
    if (intervalMs === undefined) {
        return fail("Unsupported interval.");
    }
    if (!isTimeMs(req.startTime, nowMs) || !isTimeMs(req.endTime, nowMs)) {
        return fail("startTime and endTime must be millisecond timestamps.");
    }
    if (req.endTime <= req.startTime) {
        return fail("endTime must be after startTime.");
    }
    if (req.endTime - req.startTime > intervalMs * MAX_CANDLES_PER_REQUEST) {
        return fail("Requested range exceeds 5000 candles.");
    }

    return ok({
        type: "candleSnapshot",
        req: {
            coin: req.coin,
            interval: req.interval,
            startTime: req.startTime,
            endTime: req.endTime
        }
    });
}

function validateLiquidationHistory(request: Record<string, unknown>, nowMs: number): TValidationResult {
    const limit = request.limit ?? 500;

    if (!isValidCoin(request.coin)) {
        return fail("Invalid coin.");
    }
    if (!isTimeMs(request.startTime, nowMs) || !isTimeMs(request.endTime, nowMs)) {
        return fail("startTime and endTime must be millisecond timestamps.");
    }
    if (request.endTime < request.startTime) {
        return fail("endTime must not precede startTime.");
    }
    if (request.endTime - request.startTime > MAX_LIQUIDATION_SPAN_MS) {
        return fail("Requested range exceeds seven days.");
    }
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
        return fail("limit must be an integer from 1 to 1000.");
    }

    return ok({
        type: "liquidationHistoryByTime",
        coin: request.coin,
        startTime: request.startTime,
        endTime: request.endTime,
        limit
    });
}

const REQUEST_ID_PATTERN = /^[\x20-\x7e]{1,128}$/;

export type TSocketValidationResult = { ok: true; message: string } | { ok: false; error: string };

// only forward the market subscriptions we use, reject account, firehose and cursor subscriptions
export function validateClientSocketMessage(text: string): TSocketValidationResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { ok: false, error: "Message must be JSON." };
    }
    if (typeof parsed !== "object" || parsed === null) {
        return { ok: false, error: "Message must be a JSON object." };
    }
    const message = parsed as Record<string, unknown>;

    if (message.type === "pong") {
        return { ok: true, message: JSON.stringify({ type: "pong" }) };
    }
    if (message.method !== "subscribe" && message.method !== "unsubscribe") {
        return { ok: false, error: "Unsupported message." };
    }

    const subscription = validateSubscription(message.subscription);
    if (!subscription) {
        return { ok: false, error: "Unsupported subscription." };
    }

    const out: Record<string, unknown> = {
        method: message.method,
        subscription
    };
    if (message.requestId !== undefined) {
        if (typeof message.requestId !== "string" || !REQUEST_ID_PATTERN.test(message.requestId)) {
            return { ok: false, error: "Invalid requestId." };
        }
        out.requestId = message.requestId;
    }
    return { ok: true, message: JSON.stringify(out) };
}

function validateSubscription(input: unknown): Record<string, unknown> | null {
    if (typeof input !== "object" || input === null) {
        return null;
    }
    const subscription = input as Record<string, unknown>;

    switch (subscription.type) {
        case "candle":
            if (
                !isValidCoin(subscription.coin) ||
                typeof subscription.interval !== "string" ||
                !(subscription.interval in INTERVAL_MS)
            ) {
                return null;
            }
            return {
                type: "candle",
                coin: subscription.coin,
                interval: subscription.interval
            };

        case "tpslUpdates": {
            const coins = canonicalCoins(subscription.coins);
            return coins ? { type: "tpslUpdates", coins } : null;
        }

        case "activeAssetCtx":
            return isValidCoin(subscription.coin)
                ? { type: "activeAssetCtx", coin: subscription.coin }
                : null;

        case "liquidationFills":
            return { type: "liquidationFills" };

        default:
            return null;
    }
}
