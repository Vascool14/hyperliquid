import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { InfoProxy, jsonResponse, type TProxyResponse } from "./rest.ts";
import { validateInfoRequest } from "./validate.ts";
import { createSocketRelay } from "./ws-relay.ts";

export const INFO_PATH = "/api/hydromancer/info";
export const WS_PATH = "/api/hydromancer/ws";

const MAX_REQUEST_BYTES = 8 * 1024;

export type TGatewayOptions = {
    apiKey: string;
    allowedOrigins: string[];
    proxy?: InfoProxy;
    upstreamWsUrl?: string;
    log?: (message: string) => void;
};

export function createGateway(options: TGatewayOptions): Server {
    const log = options.log ?? (() => {});
    const allowed = new Set(options.allowedOrigins);
    const proxy = options.proxy ?? new InfoProxy({ apiKey: options.apiKey, log });
    const relayOptions = {
        apiKey: options.apiKey,
        log,
        ...(options.upstreamWsUrl ? { upstreamUrl: options.upstreamWsUrl } : {})
    };
    const relay = createSocketRelay(relayOptions);

    // allow non-browser requests without Origin, checking Origin alone is not authentication
    const originAllowed = (request: IncomingMessage) => {
        const origin = request.headers.origin;
        return origin === undefined || allowed.has(origin);
    };

    const server = createServer((request, response) => {
        void handleHttp(request, response);
    });

    async function handleHttp(request: IncomingMessage, response: ServerResponse) {
        const path = new URL(request.url ?? "/", "http://gateway").pathname;

        if (path === "/healthz" && request.method === "GET") {
            send(response, jsonResponse(200, { ok: true }));
            return;
        }
        if (path !== INFO_PATH) {
            send(response, jsonResponse(404, { error: "not-found" }));
            return;
        }
        if (!originAllowed(request)) {
            send(response, jsonResponse(403, { error: "origin-not-allowed" }));
            return;
        }
        if (request.method !== "POST") {
            send(response, jsonResponse(405, { error: "method-not-allowed" }));
            return;
        }

        let body: unknown;
        try {
            body = JSON.parse(await readBody(request, MAX_REQUEST_BYTES));
        } catch {
            send(response, jsonResponse(400, { error: "invalid-json" }));
            return;
        }

        const validation = validateInfoRequest(body);
        if (!validation.ok) {
            send(
                response,
                jsonResponse(400, {
                    error: "invalid-request",
                    detail: validation.error
                })
            );
            return;
        }

        const controller = new AbortController();
        response.on("close", () => controller.abort());

        try {
            send(response, await proxy.handle(validation.request, controller.signal));
        } catch (error) {
            if (controller.signal.aborted) {
                return;
            }
            log(`proxy error: ${error instanceof Error ? error.name : "?"}`);
            send(response, jsonResponse(502, { error: "gateway-error" }));
        }
    }

    server.on("upgrade", (request, socket, head) => {
        const path = new URL(request.url ?? "/", "http://gateway").pathname;
        if (path !== WS_PATH || !originAllowed(request)) {
            socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
        }
        relay.handleUpgrade(request, socket, head);
    });

    server.on("close", () => relay.close());
    return server;
}

function send(response: ServerResponse, result: TProxyResponse) {
    if (response.headersSent || response.destroyed) {
        return;
    }
    response.writeHead(result.status, {
        ...result.headers,
        "cache-control": "no-store",
        "content-length": String(result.body.byteLength)
    });
    response.end(result.body);
}

function readBody(request: IncomingMessage, maxBytes: number) {
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        request.on("data", (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > maxBytes) {
                reject(new Error("Request body too large"));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.on("error", reject);
    });
}

function main() {
    const apiKey = process.env.HYDROMANCER_API_KEY;
    if (!apiKey) {
        console.error("HYDROMANCER_API_KEY is not set. Copy .env.example to .env.");
        process.exit(1);
    }

    const host = process.env.GATEWAY_HOST;
    const port = Number(process.env.GATEWAY_PORT);
    const allowedOrigins = (process.env.GATEWAY_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);

    const log = (message: string) => console.log(`[gateway] ${new Date().toISOString()} ${message}`);
    const server = createGateway({ apiKey, allowedOrigins, log });

    server.listen(port, host, () => {
        log(`listening on http://${host}:${port}`);
    });
}

if (import.meta.main) {
    main();
}
