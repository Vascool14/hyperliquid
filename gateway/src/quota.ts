// share one quota ledger per endpoint across all markets and clients

export type TBudgetConfig = {
    capacity: number;
    windowMs: number;
    minSpacingMs: number;
};

export type TAdmission = { admitted: true } | { admitted: false; retryAfterMs: number; reason: string };

export type TUpstreamQuota = {
    limit: number | null;
    remaining: number | null;
    resetMs: number | null;
};

export const HEAVY_BUDGETS = {
    perpSnapshots: { capacity: 5, windowMs: 600_000, minSpacingMs: 125_000 },
    tpslBook: { capacity: 10, windowMs: 300_000, minSpacingMs: 0 }
} satisfies Record<string, TBudgetConfig>;

export class AdmissionLedger {
    private readonly config: TBudgetConfig;
    private readonly now: () => number;
    private dispatched: number[] = [];
    private blockedUntil = 0;
    private upstreamRemaining: number | null = null;

    constructor(config: TBudgetConfig, now: () => number = Date.now) {
        this.config = config;
        this.now = now;
    }

    // first loads can skip spacing only with spare upstream capacity, the rolling limit still applies
    check(options: { firstLoad: boolean }): TAdmission {
        const now = this.now();
        this.prune(now);

        if (now < this.blockedUntil) {
            return {
                admitted: false,
                retryAfterMs: this.blockedUntil - now,
                reason: "upstream-retry-after"
            };
        }

        const capacity = this.effectiveCapacity();
        if (this.dispatched.length >= capacity) {
            const oldest = this.dispatched[0] ?? now;
            return {
                admitted: false,
                retryAfterMs: oldest + this.config.windowMs - now,
                reason: "window-exhausted"
            };
        }

        const last = this.dispatched[this.dispatched.length - 1];
        const spacingWaived =
            options.firstLoad && (this.upstreamRemaining === null || this.upstreamRemaining >= 2);
        if (last !== undefined && !spacingWaived) {
            const wait = last + this.config.minSpacingMs - now;
            if (wait > 0) {
                return {
                    admitted: false,
                    retryAfterMs: wait,
                    reason: "min-spacing"
                };
            }
        }

        return { admitted: true };
    }

    recordDispatch(): void {
        this.dispatched.push(this.now());
    }

    recordResponse(quota: TUpstreamQuota): void {
        if (quota.remaining !== null) {
            this.upstreamRemaining = quota.remaining;
        }
    }

    recordRetryAfter(retryAfterMs: number): void {
        this.blockedUntil = Math.max(this.blockedUntil, this.now() + retryAfterMs);
    }

    private effectiveCapacity(): number {
        // upstream may have less quota than our ledger knows about, like after a gateway restart
        if (this.upstreamRemaining === 0) {
            return this.dispatched.length;
        }
        return this.config.capacity;
    }

    private prune(now: number): void {
        const cutoff = now - this.config.windowMs;
        while (this.dispatched.length > 0 && this.dispatched[0]! <= cutoff) {
            this.dispatched.shift();
        }
        if (this.dispatched.length === 0 && this.upstreamRemaining === 0) {
            this.upstreamRemaining = null;
        }
    }
}

export function parseUpstreamQuota(headers: Headers): TUpstreamQuota {
    return {
        limit: parseHeaderNumber(headers.get("x-ratelimit-limit")),
        remaining: parseHeaderNumber(headers.get("x-ratelimit-remaining")),
        resetMs: secondsToMs(headers.get("x-ratelimit-reset"))
    };
}

export function parseRetryAfterMs(headers: Headers, bodyText: string | null): number | null {
    const header = secondsToMs(headers.get("retry-after"));
    if (header !== null) {
        return header;
    }
    if (!bodyText) {
        return null;
    }
    try {
        const body = JSON.parse(bodyText) as Record<string, unknown>;
        const secs = body.retryAfterSecs;
        return typeof secs === "number" && secs >= 0 ? secs * 1000 : null;
    } catch {
        return null;
    }
}

function parseHeaderNumber(value: string | null): number | null {
    if (value === null || !/^\d+$/.test(value.trim())) {
        return null;
    }
    return Number(value);
}

function secondsToMs(value: string | null): number | null {
    const seconds = parseHeaderNumber(value);
    return seconds === null ? null : seconds * 1000;
}
