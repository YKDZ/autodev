import { createHmac } from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EventQueue } from "./event-queue.js";
import {
  GithubWebhookServer,
  type GithubWebhookServerOptions,
} from "./github-webhook-server.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const TEST_SECRET = "test-webhook-secret";
const TEST_PORT = 49200;
const TEST_PATH = "/webhooks/github";

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function sendRequest(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: opts.port,
        path: opts.path,
        method: opts.method ?? "POST",
        headers: {
          "Content-Type": "application/json",
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("GithubWebhookServer", () => {
  let server: GithubWebhookServer;
  let queue: EventQueue;
  let portOffset = 0;

  const startServer = async (
    overrides: Partial<GithubWebhookServerOptions> = {},
  ) => {
    queue = new EventQueue();
    server = new GithubWebhookServer({
      // oxlint-disable-next-line no-plusplus
      port: TEST_PORT + portOffset++,
      path: TEST_PATH,
      secret: TEST_SECRET,
      queue,
      ...overrides,
    });
    await server.start();
    const actualPort = TEST_PORT + portOffset - 1;
    return actualPort;
  };

  afterEach(async () => {
    await server?.stop();
  });

  it("returns 202 for a valid signed POST", async () => {
    const port = await startServer();
    const body = JSON.stringify({ action: "labeled", zen: "test" });
    const sig = sign(TEST_SECRET, body);

    const res = await sendRequest({
      port,
      path: TEST_PATH,
      headers: {
        "x-hub-signature-256": sig,
        "x-github-event": "issues",
        "x-github-delivery": "delivery-1",
      },
      body,
    });

    expect(res.statusCode).toBe(202);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const json = JSON.parse(res.body) as { accepted: boolean };
    expect(json.accepted).toBe(true);
  });

  it("returns 401 for missing signature", async () => {
    const port = await startServer();
    const body = JSON.stringify({ action: "labeled" });

    const res = await sendRequest({
      port,
      path: TEST_PATH,
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": "delivery-2",
      },
      body,
    });

    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for wrong signature", async () => {
    const port = await startServer();
    const body = JSON.stringify({ action: "labeled" });
    const badSig = sign("wrong-secret", body);

    const res = await sendRequest({
      port,
      path: TEST_PATH,
      headers: {
        "x-hub-signature-256": badSig,
        "x-github-event": "issues",
        "x-github-delivery": "delivery-3",
      },
      body,
    });

    expect(res.statusCode).toBe(401);
  });

  it("signature is based on raw body bytes (not re-serialised JSON)", async () => {
    const port = await startServer();
    // Intentionally ugly JSON formatting — signature must still match
    const rawBody = '{ "action" :  "labeled" ,  "extra" : 1 }';
    const sig = sign(TEST_SECRET, rawBody);

    const res = await sendRequest({
      port,
      path: TEST_PATH,
      headers: {
        "x-hub-signature-256": sig,
        "x-github-event": "issues",
        "x-github-delivery": "delivery-4",
      },
      body: rawBody,
    });

    expect(res.statusCode).toBe(202);
  });

  it("returns 200 for ping event", async () => {
    const port = await startServer();
    const body = JSON.stringify({ zen: "Practicality beats purity." });
    const sig = sign(TEST_SECRET, body);

    const res = await sendRequest({
      port,
      path: TEST_PATH,
      headers: {
        "x-hub-signature-256": sig,
        "x-github-event": "ping",
        "x-github-delivery": "delivery-ping",
      },
      body,
    });

    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for unknown path", async () => {
    const port = await startServer();
    const res = await sendRequest({
      port,
      path: "/unknown/path",
      headers: { "x-github-event": "issues" },
      body: "{}",
    });

    expect(res.statusCode).toBe(404);
  });

  it("insecure local mode skips signature check for loopback", async () => {
    const port = await startServer({ insecureLocal: true });
    const body = JSON.stringify({ action: "labeled" });

    // No signature header at all — loopback address bypasses signature check
    const res = await sendRequest({
      port,
      path: TEST_PATH,
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": "delivery-insecure",
      },
      body,
    });

    expect(res.statusCode).toBe(202);
  });

  it("returns 400 for invalid JSON body", async () => {
    const port = await startServer();
    const body = "not-json{{";
    const sig = sign(TEST_SECRET, body);

    const res = await sendRequest({
      port,
      path: TEST_PATH,
      headers: {
        "x-hub-signature-256": sig,
        "x-github-event": "issues",
        "x-github-delivery": "delivery-bad-json",
      },
      body,
    });

    expect(res.statusCode).toBe(400);
  });

  it("enqueued event has correct deliveryId and eventType", async () => {
    // Set the worker BEFORE sending so the drain can invoke it
    const worker = vi.fn().mockResolvedValue(undefined);
    const port = await startServer();
    queue.setWorker(worker);

    const body = JSON.stringify({ action: "labeled" });
    const sig = sign(TEST_SECRET, body);

    await sendRequest({
      port,
      path: TEST_PATH,
      headers: {
        "x-hub-signature-256": sig,
        "x-github-event": "issues",
        "x-github-delivery": "abc-123",
      },
      body,
    });

    // Drain is async — wait a tick for it to complete
    await new Promise((r) => setTimeout(r, 20));

    expect(worker).toHaveBeenCalledOnce();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const event = worker.mock.calls[0][0] as {
      deliveryId: string;
      eventType: string;
    };
    expect(event.deliveryId).toBe("abc-123");
    expect(event.eventType).toBe("issues");
  });

  it("throws on start() when secret is empty and not insecure-local", async () => {
    queue = new EventQueue();
    const badServer = new GithubWebhookServer({
      // oxlint-disable-next-line no-plusplus
      port: TEST_PORT + portOffset++,
      path: TEST_PATH,
      secret: "",
      queue,
    });
    await expect(badServer.start()).rejects.toThrow(/AUTO_DEV_WEBHOOK_SECRET/);
  });

  it("empty secret is allowed in insecure-local mode", async () => {
    const port = await startServer({ insecureLocal: true, secret: "" });
    const body = JSON.stringify({ action: "labeled" });

    // loopback — no signature required
    const res = await sendRequest({
      port,
      path: TEST_PATH,
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": "delivery-insecure-no-secret",
      },
      body,
    });

    expect(res.statusCode).toBe(202);
  });
});
