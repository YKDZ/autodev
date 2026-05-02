import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";

import type { EventQueue } from "./event-queue.js";
import type { WebhookEvent } from "./github-webhook-types.js";

import { logger } from "@/shared/logger.js";

const MAX_BODY_BYTES = 26 * 1024 * 1024; // 26 MB (GitHub max is 25 MB)

export interface GithubWebhookServerOptions {
    port: number;
    path: string;
    secret: string;
    /** Allow requests without a valid signature (loopback-only dev mode). */
    insecureLocal?: boolean;
    queue: EventQueue;
}

const readRawBody = async (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;

        req.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                req.destroy();
                reject(new Error("Payload too large"));
                return;
            }
            chunks.push(chunk);
        });

        req.on("end", () => {
            resolve(Buffer.concat(chunks));
        });

        req.on("error", reject);
    });

const verifySignature = (
    secret: string,
    rawBody: Buffer,
    sigHeader: string,
): boolean => {
    if (!sigHeader.startsWith("sha256=")) return false;
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    try {
        return timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
    } catch {
        return false;
    }
};

export class GithubWebhookServer {
    private server: Server | null = null;
    private readonly opts: GithubWebhookServerOptions;

    constructor(opts: GithubWebhookServerOptions) {
        this.opts = opts;
    }

    async start(): Promise<void> {
        if (!this.opts.insecureLocal && !this.opts.secret) {
            throw new Error(
                "[webhook] AUTO_DEV_WEBHOOK_SECRET must be set (non-empty) when not running in insecure-local mode. " +
                "Set AUTO_DEV_WEBHOOK_FORWARD_INSECURE_LOCAL=1 only for loopback development.",
            );
        }

        return new Promise((resolve, reject) => {
            this.server = createServer((req, res) => {
                void this.handleRequest(req, res);
            });

            this.server.on("error", reject);

            this.server.listen(this.opts.port, "0.0.0.0", () => {
                logger.info(
                    `[webhook] GitHub Webhook server listening on port ${this.opts.port} (path: ${this.opts.path})`,
                );
                if (this.opts.insecureLocal) {
                    logger.warn(
                        "[webhook] INSECURE LOCAL MODE: signature verification disabled. Do not use in production.",
                    );
                }
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.server) {
                resolve();
                return;
            }
            this.server.close(() => { resolve(); });
        });
    }

    private async handleRequest(
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> {
        const url = req.url ?? "/";
        const method = req.method ?? "GET";

        // Health check
        if (method === "GET" && url === "/health") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("ok");
            return;
        }

        if (method !== "POST" || url !== this.opts.path) {
            res.writeHead(404);
            res.end("Not Found");
            return;
        }

        // Read raw body
        let rawBody: Buffer;
        try {
            rawBody = await readRawBody(req);
        } catch (err) {
            logger.warn(`[webhook] Failed to read body: ${String(err)}`);
            res.writeHead(413);
            res.end("Payload Too Large");
            return;
        }

        // Verify signature
        const rawSigHeader = req.headers["x-hub-signature-256"];
        const sigHeader = Array.isArray(rawSigHeader)
            ? (rawSigHeader[0] ?? "")
            : (rawSigHeader ?? "");
        const isInsecureLocal =
            this.opts.insecureLocal &&
            (req.socket.remoteAddress === "127.0.0.1" ||
                req.socket.remoteAddress === "::1" ||
                req.socket.remoteAddress === "::ffff:127.0.0.1");

        if (!isInsecureLocal) {
            if (!sigHeader) {
                logger.warn("[webhook] Missing X-Hub-Signature-256 header");
                res.writeHead(401);
                res.end("Unauthorized");
                return;
            }
            if (!verifySignature(this.opts.secret, rawBody, sigHeader)) {
                logger.warn("[webhook] Invalid signature");
                res.writeHead(401);
                res.end("Unauthorized");
                return;
            }
        }

        const rawEventType = req.headers["x-github-event"];
        const eventType = Array.isArray(rawEventType)
            ? (rawEventType[0] ?? "")
            : (rawEventType ?? "");
        const rawDeliveryId = req.headers["x-github-delivery"];
        const deliveryId = Array.isArray(rawDeliveryId)
            ? (rawDeliveryId[0] ?? `local-${Date.now()}`)
            : (rawDeliveryId ?? `local-${Date.now()}`);

        // Handle ping immediately
        if (eventType === "ping") {
            logger.info(`[webhook] Received ping (delivery: ${deliveryId})`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        // Parse JSON
        let payload: unknown;
        try {
            payload = JSON.parse(rawBody.toString("utf-8")) as unknown;
        } catch {
            res.writeHead(400);
            res.end("Bad Request: invalid JSON");
            return;
        }

        const event: WebhookEvent = {
            deliveryId,
            eventType,
            payload,
            receivedAt: new Date().toISOString(),
        };

        this.opts.queue.enqueue(event);

        logger.info(
            `[webhook] Accepted ${eventType} delivery ${deliveryId} (queue size: ${this.opts.queue.size})`,
        );

        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true, deliveryId }));
    }
}

/** Resolve the webhook port from environment, default 3001. */
export const resolveWebhookPort = (): number => {
    const raw = process.env.AUTO_DEV_WEBHOOK_PORT;
    if (raw) {
        const parsed = parseInt(raw, 10);
        if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }
    return 3001;
};

/** Resolve the webhook HTTP path, default /webhooks/github. */
export const resolveWebhookPath = (): string =>
    process.env.AUTO_DEV_WEBHOOK_PATH ?? "/webhooks/github";

/** Resolve the webhook secret from environment. */
export const resolveWebhookSecret = (): string =>
    process.env.AUTO_DEV_WEBHOOK_SECRET ?? "";

/** Whether loopback insecure forwarding mode is enabled (dev only). */
export const resolveInsecureLocal = (): boolean =>
    process.env.AUTO_DEV_WEBHOOK_FORWARD_INSECURE_LOCAL === "1";
