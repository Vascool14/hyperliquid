import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { validateClientSocketMessage } from "./validate.ts";

export type TRelayOptions = {
    apiKey: string;
    upstreamUrl?: string;
    log?: (message: string) => void;
};

// stop reconnecting on 4401 or 4403, retrying cannot fix credentials
export const CLOSE_UPSTREAM_UNAVAILABLE = 4502;
export const CLOSE_UPSTREAM_AUTH = 4401;
export const CLOSE_UPSTREAM_FORBIDDEN = 4403;
export const CLOSE_BACKPRESSURE = 4508;

const MAX_PENDING_CLIENT_MESSAGES = 64;
const MAX_CLIENT_FRAME_BYTES = 16 * 1024;
const MAX_UPSTREAM_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_DOWNSTREAM_BUFFERED_BYTES = 8 * 1024 * 1024;

// charts on one page share a socket, each downstream socket gets one upstream connection
export function createSocketRelay(options: TRelayOptions) {
    const upstreamUrl = options.upstreamUrl ?? "wss://api.hydromancer.xyz/ws";
    const log = options.log ?? (() => {});
    const server = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_CLIENT_FRAME_BYTES
    });

    server.on("connection", (client: WebSocket) => {
        relay(client);
    });

    function relay(client: WebSocket) {
        const pending: string[] = [];
        const url = `${upstreamUrl}?token=${encodeURIComponent(options.apiKey)}`;
        const upstream = new WebSocket(url, {
            maxPayload: MAX_UPSTREAM_FRAME_BYTES,
            handshakeTimeout: 15_000
        });

        upstream.on("open", () => {
            for (const message of pending.splice(0)) {
                upstream.send(message);
            }
        });

        upstream.on("unexpected-response", (_request, response) => {
            const status = response.statusCode ?? 0;
            log(`upstream ws rejected handshake: ${status}`);
            const code =
                status === 401
                    ? CLOSE_UPSTREAM_AUTH
                    : status === 403
                      ? CLOSE_UPSTREAM_FORBIDDEN
                      : CLOSE_UPSTREAM_UNAVAILABLE;
            closeQuietly(client, code, "upstream rejected connection");
            upstream.terminate();
        });

        upstream.on("message", (data: RawData, isBinary: boolean) => {
            if (client.readyState !== WebSocket.OPEN) {
                return;
            }
            if (client.bufferedAmount > MAX_DOWNSTREAM_BUFFERED_BYTES) {
                log("closing slow downstream client");
                closeQuietly(client, CLOSE_BACKPRESSURE, "client too slow");
                upstream.close();
                return;
            }
            client.send(data, { binary: isBinary });
        });

        upstream.on("close", (code: number) => {
            log(`upstream ws closed: ${code}`);
            closeQuietly(client, CLOSE_UPSTREAM_UNAVAILABLE, "upstream closed");
        });

        // ws errors may include the token in the URL, never log the full error
        upstream.on("error", (error: Error) => {
            log(`upstream ws error: ${error.name}`);
        });

        client.on("message", (data: RawData, isBinary: boolean) => {
            if (isBinary) {
                sendError(client, "Binary client frames are not supported.");
                return;
            }
            const result = validateClientSocketMessage(rawToString(data));
            if (!result.ok) {
                sendError(client, result.error);
                return;
            }
            if (upstream.readyState === WebSocket.OPEN) {
                upstream.send(result.message);
                return;
            }
            if (pending.length >= MAX_PENDING_CLIENT_MESSAGES) {
                closeQuietly(client, CLOSE_BACKPRESSURE, "too many queued");
                upstream.terminate();
                return;
            }
            pending.push(result.message);
        });

        client.on("close", () => {
            if (upstream.readyState === WebSocket.CONNECTING) {
                upstream.terminate();
                return;
            }
            upstream.close();
        });

        client.on("error", (error: Error) => {
            log(`downstream ws error: ${error.name}`);
        });
    }

    return {
        handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
            server.handleUpgrade(request, socket, head, (client) => {
                server.emit("connection", client, request);
            });
        },
        close() {
            for (const client of server.clients) {
                client.terminate();
            }
            server.close();
        }
    };
}

function sendError(client: WebSocket, error: string) {
    if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "gatewayError", error }));
    }
}

function closeQuietly(client: WebSocket, code: number, reason: string) {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(code, reason);
    }
}

function rawToString(data: RawData): string {
    if (Array.isArray(data)) {
        return Buffer.concat(data).toString("utf8");
    }
    if (data instanceof ArrayBuffer) {
        return Buffer.from(data).toString("utf8");
    }
    return data.toString("utf8");
}
