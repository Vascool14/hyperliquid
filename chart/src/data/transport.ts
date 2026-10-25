// connection handling and message routing, financial logic lives in the feeds

export interface IClock {
    now(): number;
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

export const systemClock: IClock = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export type TInfoErrorCode =
    | "rate-limited"
    | "permission-denied"
    | "upstream-unavailable"
    | "network-error"
    | "bad-request"
    | "aborted";

export class InfoError extends Error {
    readonly code: TInfoErrorCode;
    readonly retryAfterMs: number | null;
    readonly status: number | null;

    constructor(
        code: TInfoErrorCode,
        message: string,
        options: { retryAfterMs?: number | null; status?: number | null } = {}
    ) {
        super(message);
        this.name = "InfoError";
        this.code = code;
        this.retryAfterMs = options.retryAfterMs ?? null;
        this.status = options.status ?? null;
    }
}

export interface IInfoResponse {
    bytes: Uint8Array;
    headers: Headers;
}

export async function postInfo(
    url: string,
    body: Record<string, unknown>,
    signal: AbortSignal
): Promise<IInfoResponse> {
    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal
        });
    } catch (error) {
        if (signal.aborted) {
            throw new InfoError("aborted", "Request aborted.");
        }
        throw new InfoError("network-error", describe(error));
    }

    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
        if (signal.aborted) {
            throw new InfoError("aborted", "Request aborted.");
        }
        throw new InfoError("network-error", describe(error));
    }

    if (response.ok) {
        return { bytes, headers: response.headers };
    }
    throw errorFromResponse(response, bytes);
}

export async function postInfoJson(
    url: string,
    body: Record<string, unknown>,
    signal: AbortSignal
): Promise<unknown> {
    const { bytes } = await postInfo(url, body, signal);
    try {
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
        throw new InfoError("upstream-unavailable", "Response was not JSON.");
    }
}

function errorFromResponse(response: Response, bytes: Uint8Array): InfoError {
    const status = response.status;
    const text = new TextDecoder().decode(bytes.slice(0, 400));
    const retryAfterSecs = Number(response.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(retryAfterSecs) && retryAfterSecs > 0 ? retryAfterSecs * 1000 : null;

    if (status === 429) {
        return new InfoError("rate-limited", "Quota exhausted.", {
            retryAfterMs: retryAfterMs ?? 60_000,
            status
        });
    }
    if (status === 401 || status === 403) {
        return new InfoError("permission-denied", text, { status });
    }
    if (status === 400) {
        return new InfoError("bad-request", text, { status });
    }
    return new InfoError("upstream-unavailable", text, { status });
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export interface ISocketLike {
    readonly readyState: number;
    onopen: ((event: unknown) => void) | null;
    onclose: ((event: { code: number; reason: string }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}

const OPEN = 1;

export type TTransportState = "connecting" | "open" | "closed";

export interface ITransportStatus {
    state: TTransportState;
    // bump on each successful connection so feeds know to resync
    generation: number;
    retryAtMs: number | null;
    // stop retrying when reconnecting cannot help, like an auth failure
    fatal: boolean;
    detail: string | null;
}

export interface IDeliveryInfo {
    // this channel missed a seq number on the current connection
    seqGap: boolean;
}

export type TMessageHandler = (
    data: unknown,
    message: Record<string, unknown>,
    delivery: IDeliveryInfo
) => void;

export type TSubscription = Record<string, unknown> & { type: string };

interface IRoute {
    subscription: TSubscription;
    handler: TMessageHandler;
    onRejected: (detail: string) => void;
    requestId: string;
}

export interface ITransportOptions {
    url: string;
    createSocket?: (url: string) => ISocketLike;
    clock?: IClock;
    onStatus: (status: ITransportStatus) => void;
    // pings arrive every 60 seconds, assume the connection died after this much silence
    idleTimeoutMs?: number;
}

const FATAL_CLOSE_CODES = new Set([4401, 4403]);
const MAX_BACKOFF_MS = 30_000;
const LINGER_MS = 1500;

export function routeKeyForSubscription(subscription: TSubscription): string {
    switch (subscription.type) {
        case "candle":
            return `candle:${String(subscription.coin)}:${String(subscription.interval)}`;
        case "activeAssetCtx":
            return `activeAssetCtx:${String(subscription.coin)}`;
        default:
            return subscription.type;
    }
}

export function routeKeyForMessage(message: Record<string, unknown>): string | null {
    const channel = message.channel ?? message.type;
    const data = message.data as Record<string, unknown> | undefined;

    switch (channel) {
        case "candle":
            return data ? `candle:${String(data.s)}:${String(data.i)}` : null;
        case "activeAssetCtx":
            return data ? `activeAssetCtx:${String(data.coin)}` : null;
        case "tpslUpdates":
        case "liquidationFills":
            return channel;
        default:
            return null;
    }
}

export class SocketTransport {
    private readonly options: ITransportOptions;
    private readonly clock: IClock;
    private readonly routes = new Map<string, IRoute>();
    private readonly lastSeq = new Map<string, number>();
    private socket: ISocketLike | null = null;
    private status: ITransportStatus = {
        state: "closed",
        generation: 0,
        retryAtMs: null,
        fatal: false,
        detail: null
    };
    private attempt = 0;
    private nextRequestId = 1;
    private reconnectTimer: unknown = null;
    private idleTimer: unknown = null;
    private lingerTimer: unknown = null;
    private destroyed = false;

    constructor(options: ITransportOptions) {
        this.options = options;
        this.clock = options.clock ?? systemClock;
    }

    getStatus(): ITransportStatus {
        return this.status;
    }

    subscribe(
        subscription: TSubscription,
        handler: TMessageHandler,
        onRejected: (detail: string) => void = () => {}
    ): () => void {
        const key = routeKeyForSubscription(subscription);
        const route: IRoute = {
            subscription,
            handler,
            onRejected,
            requestId: `r${this.nextRequestId++}`
        };
        this.routes.set(key, route);
        this.lastSeq.delete(String(subscription.type));
        this.cancelLinger();

        if (this.socket?.readyState === OPEN) {
            this.sendSubscription("subscribe", route);
        } else {
            this.ensureConnected();
        }

        return () => {
            if (this.routes.get(key) !== route) {
                return;
            }
            this.routes.delete(key);
            if (this.socket?.readyState === OPEN) {
                this.sendSubscription("unsubscribe", route);
            }
            if (this.routes.size === 0) {
                this.scheduleLinger();
            }
        };
    }

    // simulate a dropped connection and let the normal reconnect path handle it
    drop(): void {
        this.socket?.close(4000, "simulated drop");
    }

    destroy(): void {
        this.destroyed = true;
        this.routes.clear();
        this.clearTimers();
        this.closeSocket();
        this.setStatus({ state: "closed", retryAtMs: null, detail: null });
    }

    private ensureConnected(): void {
        if (this.destroyed || this.socket || this.reconnectTimer !== null) {
            return;
        }
        if (this.status.fatal) {
            return;
        }
        this.connect();
    }

    private connect(): void {
        const create =
            this.options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as ISocketLike);
        const socket = create(this.options.url);
        this.socket = socket;
        this.setStatus({ state: "connecting", retryAtMs: null });

        socket.onopen = () => {
            if (this.socket !== socket) {
                return;
            }
            this.lastSeq.clear();
            this.setStatus({
                state: "open",
                generation: this.status.generation + 1,
                detail: null
            });
            for (const route of this.routes.values()) {
                this.sendSubscription("subscribe", route);
            }
            this.armIdleTimer();
        };

        socket.onmessage = (event) => {
            if (this.socket !== socket) {
                return;
            }
            this.attempt = 0;
            this.armIdleTimer();
            this.handleMessage(event.data);
        };

        socket.onclose = (event) => {
            if (this.socket !== socket) {
                return;
            }
            this.socket = null;
            this.handleClose(event.code, event.reason);
        };

        socket.onerror = () => {
            // the close event handles reconnecting
        };
    }

    private handleClose(code: number, reason: string): void {
        this.clock.clearTimeout(this.idleTimer);
        this.idleTimer = null;
        if (this.destroyed) {
            return;
        }
        if (FATAL_CLOSE_CODES.has(code)) {
            this.setStatus({
                state: "closed",
                fatal: true,
                retryAtMs: null,
                detail: reason || "The gateway rejected the credentials."
            });
            return;
        }
        if (this.routes.size === 0) {
            this.setStatus({ state: "closed", retryAtMs: null });
            return;
        }

        // jitter can delay a retry but must never make it early
        const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt);
        const delay = base + Math.random() * 500;
        this.attempt++;
        this.setStatus({
            state: "closed",
            retryAtMs: this.clock.now() + delay,
            detail: reason || `Connection closed (${code}).`
        });
        this.reconnectTimer = this.clock.setTimeout(() => {
            this.reconnectTimer = null;
            this.ensureConnected();
        }, delay);
    }

    private handleMessage(raw: unknown): void {
        if (typeof raw !== "string") {
            return;
        }
        let message: Record<string, unknown>;
        try {
            const parsed = JSON.parse(raw) as unknown;
            if (typeof parsed !== "object" || parsed === null) {
                return;
            }
            message = parsed as Record<string, unknown>;
        } catch {
            return;
        }

        if (message.type === "ping") {
            this.socket?.send('{"type":"pong"}');
            return;
        }
        if (
            message.type === "subscriptionUpdate" ||
            message.channel === "subscriptionResponse" ||
            message.type === "error" ||
            message.type === "gatewayError"
        ) {
            this.handleControl(message);
            return;
        }

        const key = routeKeyForMessage(message);
        const route = key === null ? undefined : this.routes.get(key);
        if (!route) {
            return;
        }

        route.handler(message.data ?? message, message, {
            seqGap: this.checkSequence(message)
        });
    }

    // seq is per channel and resets on reconnect, even two candle subscriptions share the counter
    private checkSequence(message: Record<string, unknown>): boolean {
        const channel = String(message.channel ?? message.type);
        const seq = message.seq;
        if (typeof seq !== "number") {
            return false;
        }
        const last = this.lastSeq.get(channel);
        this.lastSeq.set(channel, seq);
        return last !== undefined && seq !== last + 1;
    }

    private handleControl(message: Record<string, unknown>): void {
        const failed = message.failed;
        const rejected =
            message.type === "error" ||
            message.type === "gatewayError" ||
            (Array.isArray(failed) && failed.length > 0);
        if (!rejected) {
            return;
        }
        const detail = JSON.stringify(message).slice(0, 300);
        const requestId = message.requestId;
        for (const route of this.routes.values()) {
            if (requestId === undefined || route.requestId === requestId) {
                route.onRejected(detail);
            }
        }
    }

    private sendSubscription(method: "subscribe" | "unsubscribe", route: IRoute): void {
        this.socket?.send(
            JSON.stringify({
                method,
                requestId: route.requestId,
                subscription: route.subscription
            })
        );
    }

    private armIdleTimer(): void {
        this.clock.clearTimeout(this.idleTimer);
        this.idleTimer = this.clock.setTimeout(() => {
            this.idleTimer = null;
            this.socket?.close(4001, "idle timeout");
        }, this.options.idleTimeoutMs ?? 75_000);
    }

    // keep the socket briefly so Strict Mode remounts and quick market switches can reuse it
    private scheduleLinger(): void {
        this.cancelLinger();
        this.lingerTimer = this.clock.setTimeout(() => {
            this.lingerTimer = null;
            if (this.routes.size === 0) {
                this.closeSocket();
                this.clock.clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
                this.setStatus({ state: "closed", retryAtMs: null });
            }
        }, LINGER_MS);
    }

    private cancelLinger(): void {
        this.clock.clearTimeout(this.lingerTimer);
        this.lingerTimer = null;
    }

    private closeSocket(): void {
        const socket = this.socket;
        this.socket = null;
        this.clock.clearTimeout(this.idleTimer);
        this.idleTimer = null;
        if (socket) {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onclose = null;
            socket.onerror = null;
            socket.close(1000, "closed by client");
        }
    }

    private clearTimers(): void {
        for (const timer of [this.reconnectTimer, this.idleTimer, this.lingerTimer]) {
            this.clock.clearTimeout(timer);
        }
        this.reconnectTimer = null;
        this.idleTimer = null;
        this.lingerTimer = null;
    }

    private setStatus(patch: Partial<ITransportStatus>): void {
        this.status = { ...this.status, ...patch };
        this.options.onStatus(this.status);
    }
}
