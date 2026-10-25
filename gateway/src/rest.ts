import {
    AdmissionLedger,
    HEAVY_BUDGETS,
    parseRetryAfterMs,
    parseUpstreamQuota,
    type TBudgetConfig
} from "./quota.ts";
import type { THeavyKind, TValidatedRequest } from "./validate.ts";

export type TProxyResponse = {
    status: number;
    headers: Record<string, string>;
    body: Uint8Array;
};

export type TInfoProxyOptions = {
    apiKey: string;
    upstreamUrl?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
    maxResponseBytes?: number;
    heavyCacheFreshMs?: Partial<Record<THeavyKind, number>>;
    budgets?: Record<THeavyKind, TBudgetConfig>;
    log?: (message: string) => void;
};

type TCacheEntry = {
    response: TProxyResponse;
    storedAt: number;
};

const FORWARDED_HEADERS = [
    "content-type",
    "x-payload-format",
    "x-compression",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-cost",
    "retry-after"
];

const MAX_CACHE_ENTRIES_PER_KIND = 8;

export class InfoProxy {
    private readonly apiKey: string;
    private readonly upstreamUrl: string;
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;
    private readonly timeoutMs: number;
    private readonly maxResponseBytes: number;
    private readonly heavyCacheFreshMs: Record<THeavyKind, number>;
    private readonly log: (message: string) => void;
    private readonly ledgers: Record<THeavyKind, AdmissionLedger>;
    private readonly inFlight = new Map<string, Promise<TProxyResponse>>();
    private readonly cache = new Map<string, TCacheEntry>();

    constructor(options: TInfoProxyOptions) {
        const budgets = options.budgets ?? HEAVY_BUDGETS;

        this.apiKey = options.apiKey;
        this.upstreamUrl = options.upstreamUrl ?? "https://api.hydromancer.xyz/info";
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.now = options.now ?? Date.now;
        this.timeoutMs = options.timeoutMs ?? 45_000;
        this.maxResponseBytes = options.maxResponseBytes ?? 64 * 1024 * 1024;
        this.heavyCacheFreshMs = {
            perpSnapshots: 60_000,
            tpslBook: 0,
            ...options.heavyCacheFreshMs
        };
        this.log = options.log ?? (() => {});
        this.ledgers = {
            perpSnapshots: new AdmissionLedger(budgets.perpSnapshots, this.now),
            tpslBook: new AdmissionLedger(budgets.tpslBook, this.now)
        };
    }

    // aborting one waiter must not cancel the upstream request for everyone else
    handle(request: TValidatedRequest, signal?: AbortSignal): Promise<TProxyResponse> {
        const work = request.heavy
            ? this.handleHeavy(request, request.heavy)
            : this.coalesce(JSON.stringify(request.body), () => this.fetchUpstream(request.body));
        return withAbort(work, signal);
    }

    private handleHeavy(request: TValidatedRequest, kind: THeavyKind): Promise<TProxyResponse> {
        const key = request.cacheKey ?? JSON.stringify(request.body);
        const pending = this.inFlight.get(key);
        if (pending) {
            return pending;
        }

        const cached = this.cache.get(key);
        const now = this.now();
        if (cached && now - cached.storedAt < this.heavyCacheFreshMs[kind]) {
            return Promise.resolve(withCacheHeaders(cached, "hit", now));
        }

        const ledger = this.ledgers[kind];
        const admission = ledger.check({ firstLoad: !cached });
        if (!admission.admitted) {
            if (cached) {
                return Promise.resolve(withCacheHeaders(cached, "stale", now, admission.retryAfterMs));
            }
            this.log(
                `${kind} deferred (${admission.reason}), retry in ${Math.ceil(admission.retryAfterMs / 1000)}s`
            );

            return Promise.resolve(quotaResponse(admission.retryAfterMs, admission.reason));
        }

        ledger.recordDispatch();
        return this.coalesce(key, async () => {
            const response = await this.fetchUpstream(request.body, ledger);
            // cached TP/SL snapshots can be too old for a new client, only share requests still in flight
            if (response.status === 200 && kind === "perpSnapshots") {
                this.store(kind, key, response);
            }
            return response;
        });
    }

    private coalesce(key: string, start: () => Promise<TProxyResponse>): Promise<TProxyResponse> {
        const pending = this.inFlight.get(key);
        if (pending) {
            return pending;
        }
        const promise = start().finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, promise);
        return promise;
    }

    private store(kind: THeavyKind, key: string, response: TProxyResponse) {
        this.cache.set(key, { response, storedAt: this.now() });

        const keys = [...this.cache.keys()].filter((k) => k.startsWith(kind));
        for (const old of keys.slice(0, -MAX_CACHE_ENTRIES_PER_KIND)) {
            this.cache.delete(old);
        }
    }

    private async fetchUpstream(
        body: Record<string, unknown>,
        ledger?: AdmissionLedger
    ): Promise<TProxyResponse> {
        let upstream: Response;
        try {
            upstream = await this.fetchImpl(this.upstreamUrl, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${this.apiKey}`
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(this.timeoutMs)
            });
        } catch (error) {
            const timedOut = error instanceof Error && error.name === "TimeoutError";
            this.log(`upstream ${String(body.type)} failed: ${errorName(error)}`);
            return jsonResponse(timedOut ? 504 : 502, {
                error: timedOut ? "upstream-timeout" : "upstream-unreachable"
            });
        }

        ledger?.recordResponse(parseUpstreamQuota(upstream.headers));

        let bytes: Uint8Array;
        try {
            bytes = await readBounded(upstream, this.maxResponseBytes);
        } catch (error) {
            this.log(`upstream ${String(body.type)} body: ${errorName(error)}`);
            return jsonResponse(502, { error: "upstream-body-rejected" });
        }

        if (upstream.status === 200) {
            return {
                status: 200,
                headers: pickHeaders(upstream.headers),
                body: bytes
            };
        }

        const text = this.redact(new TextDecoder().decode(bytes.slice(0, 600)));
        this.log(`upstream ${String(body.type)} -> ${upstream.status}`);

        if (upstream.status === 429) {
            const retryAfterMs = parseRetryAfterMs(upstream.headers, text) ?? 60_000;
            ledger?.recordRetryAfter(retryAfterMs);
            return quotaResponse(retryAfterMs, "upstream-429");
        }
        if (upstream.status === 401 || upstream.status === 403) {
            return jsonResponse(upstream.status, {
                error: "upstream-permission",
                detail: text
            });
        }
        if (upstream.status >= 500) {
            return jsonResponse(502, {
                error: "upstream-unavailable",
                upstreamStatus: upstream.status,
                detail: text
            });
        }
        return jsonResponse(upstream.status, {
            error: "upstream-rejected",
            detail: text
        });
    }

    private redact(text: string): string {
        return this.apiKey ? text.split(this.apiKey).join("[redacted]") : text;
    }
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
        return promise;
    }
    if (signal.aborted) {
        return Promise.reject(signal.reason);
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            }
        );
    });
}

// fetch may have already decompressed the response, drop stale Content-Encoding and Content-Length
// let the client inspect the actual bytes
function pickHeaders(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
        const value = headers.get(name);
        if (value !== null) {
            out[name] = value;
        }
    }
    return out;
}

function withCacheHeaders(
    entry: TCacheEntry,
    state: "hit" | "stale",
    now: number,
    retryAfterMs?: number
): TProxyResponse {
    const headers: Record<string, string> = {
        ...entry.response.headers,
        "x-gateway-cache": state,
        "x-gateway-age-ms": String(now - entry.storedAt)
    };
    if (retryAfterMs !== undefined) {
        headers["x-gateway-next-fetch-ms"] = String(Math.ceil(retryAfterMs));
    }
    return { ...entry.response, headers };
}

function quotaResponse(retryAfterMs: number, reason: string): TProxyResponse {
    const retryAfterSecs = Math.max(1, Math.ceil(retryAfterMs / 1000));
    const response = jsonResponse(429, {
        error: "quota",
        reason,
        retryAfterSecs
    });
    response.headers["retry-after"] = String(retryAfterSecs);
    return response;
}

export function jsonResponse(status: number, body: Record<string, unknown>): TProxyResponse {
    return {
        status,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify(body))
    };
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
    if (!response.body) {
        return new Uint8Array(0);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw new Error(`Upstream body exceeded ${maxBytes} bytes`);
        }
        chunks.push(value);
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : "UnknownError";
}
