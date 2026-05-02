import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createConnection, createServer as netCreateServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import z from "zod";

import type { DecisionRequest, DecisionResponse } from "@/shared/types.js";

import { DEFAULT_CONFIG } from "@/config/types.js";

import { DecisionSocketServer } from "./socket-server.js";

let tmpDir: string;
let testPort: number;
let server: DecisionSocketServer;

const noopAccept = vi
  .fn()
  .mockResolvedValue({ accepted: true, remainingDecisions: 19 });
const noopGetResolution = vi.fn().mockResolvedValue(null);

/** Allocate a free TCP port by letting the OS assign one. */
const getFreePort = async (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const srv = netCreateServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected address type"));
        return;
      }
      srv.close(() => {
        resolvePort(addr.port);
      });
    });
    srv.on("error", reject);
  });

beforeEach(async () => {
  tmpDir = mkdtempSync(resolve(tmpdir(), "socket-test-"));
  testPort = await getFreePort();
  server = new DecisionSocketServer({
    port: testPort,
    config: DEFAULT_CONFIG,
    workspaceRoot: tmpDir,
    onDecisionRequest: noopAccept,
    onGetResolution: noopGetResolution,
  });
});

afterEach(async () => {
  await server.stop();
  await rm(tmpDir, { recursive: true, force: true });
});

const makeRequest = (): DecisionRequest => ({
  id: randomUUID(),
  workflowRunId: "test-run-id",
  title: "Test decision",
  options: [{ key: "a", label: "Option A", description: "First option" }],
  recommendation: "a",
  context: null,
});

describe("DecisionSocketServer", () => {
  it("starts and listens on TCP port", async () => {
    await server.start();
    // Verify we can connect to the port
    await new Promise<void>((resolvePromise, reject) => {
      const conn = createConnection(testPort, "127.0.0.1", () => {
        conn.destroy();
        resolvePromise();
      });
      conn.on("error", reject);
    });
  });

  it("client connects and sends decision request", async () => {
    await server.start();
    const request = makeRequest();

    const result = await new Promise<string>((resolvePromise, reject) => {
      const socket = createConnection(testPort, "127.0.0.1", () => {
        socket.write(JSON.stringify(request) + "\n");
      });

      socket.on("data", (data: Buffer) => {
        resolvePromise(data.toString("utf-8"));
        socket.end();
      });

      socket.on("error", reject);

      setTimeout(() => {
        resolvePromise("connected");
        socket.end();
      }, 500);
    });

    expect(result).toBe("connected");
  });

  it("keeps connection open after receiving request", async () => {
    await server.start();
    const request = makeRequest();

    await new Promise<void>((resolvePromise, reject) => {
      const socket = createConnection(testPort, "127.0.0.1", () => {
        socket.write(JSON.stringify(request) + "\n");
      });

      setTimeout(() => {
        expect(socket.readyState).toBe("open");
        socket.end();
        resolvePromise();
      }, 100);

      socket.on("error", reject);
    });
  });

  it("responds to client after resolveDecision", async () => {
    await server.start();
    const request = makeRequest();

    const responsePromise = new Promise<string>((resolvePromise, reject) => {
      const socket = createConnection(testPort, "127.0.0.1", () => {
        socket.write(JSON.stringify(request) + "\n");
      });

      socket.on("data", (data: Buffer) => {
        resolvePromise(data.toString("utf-8").trim());
        socket.end();
      });

      socket.on("error", reject);
    });

    await new Promise((r) => setTimeout(r, 200));

    const response: DecisionResponse = {
      decisionId: request.id,
      title: request.title,
      resolution: "a",
      resolvedBy: "human",
      resolvedAt: new Date().toISOString(),
      remainingDecisions: 18,
    };

    server.resolveDecision(request.id, response);

    const result = await responsePromise;
    const parsed = z
      .object({
        decisionId: z.string(),
        resolution: z.string(),
      })
      .parse(JSON.parse(result));
    expect(parsed.decisionId).toBe(request.id);
    expect(parsed.resolution).toBe("a");
  }, 10000);

  it("rejects when onDecisionRequest returns false", async () => {
    const rejectPort = await getFreePort();
    const rejectServer = new DecisionSocketServer({
      port: rejectPort,
      config: DEFAULT_CONFIG,
      workspaceRoot: tmpDir,
      onDecisionRequest: vi
        .fn()
        .mockResolvedValue({ accepted: false, remainingDecisions: 0 }),
      onGetResolution: noopGetResolution,
    });

    await rejectServer.start();
    const request = makeRequest();

    const result = await new Promise<string>((resolvePromise, reject) => {
      const socket = createConnection(rejectPort, "127.0.0.1", () => {
        socket.write(JSON.stringify(request) + "\n");
      });

      socket.on("data", (data: Buffer) => {
        resolvePromise(data.toString("utf-8").trim());
        socket.end();
      });

      socket.on("error", reject);
    });

    const parsed = z
      .object({
        error: z.string(),
        remainingDecisions: z.number(),
      })
      .parse(JSON.parse(result));
    expect(parsed.error).toBe("Decision limit reached");
    expect(parsed.remainingDecisions).toBe(0);

    await rejectServer.stop();
  });

  it("handles invalid JSON", async () => {
    await server.start();

    const result = await new Promise<string>((resolvePromise, reject) => {
      const socket = createConnection(testPort, "127.0.0.1", () => {
        socket.write("not valid json\n");
      });

      socket.on("data", (data: Buffer) => {
        resolvePromise(data.toString("utf-8").trim());
        socket.end();
      });

      socket.on("error", reject);
    });

    const parsed = z
      .object({
        error: z.string(),
      })
      .parse(JSON.parse(result));
    expect(parsed.error).toBe("Invalid JSON in decision request");
  });

  it("closes cleanly on stop", async () => {
    await server.start();
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it("supports getResolution polling command", async () => {
    const requestId = randomUUID();
    const pollPort = await getFreePort();
    const pollServer = new DecisionSocketServer({
      port: pollPort,
      config: DEFAULT_CONFIG,
      workspaceRoot: tmpDir,
      onDecisionRequest: noopAccept,
      onGetResolution: vi.fn().mockResolvedValue({
        decisionId: requestId,
        title: "T",
        resolution: "a",
        resolvedBy: "human",
        resolvedAt: new Date().toISOString(),
        remainingDecisions: 5,
      }),
    });

    await pollServer.start();

    const result = await new Promise<string>((resolvePromise, reject) => {
      const socket = createConnection(pollPort, "127.0.0.1", () => {
        socket.write(JSON.stringify({ getResolution: requestId }) + "\n");
      });

      socket.on("data", (data: Buffer) => {
        resolvePromise(data.toString("utf-8").trim());
        socket.end();
      });

      socket.on("error", reject);
    });

    const parsed = z
      .object({
        resolved: z.boolean(),
        response: z.object({
          decisionId: z.string(),
          resolution: z.string(),
        }),
      })
      .parse(JSON.parse(result));
    expect(parsed.resolved).toBe(true);
    expect(parsed.response.decisionId).toBe(requestId);
    expect(parsed.response.resolution).toBe("a");

    await pollServer.stop();
  });

  it("rejects requests with missing token when decisionToken is configured", async () => {
    const authPort = await getFreePort();
    const authServer = new DecisionSocketServer({
      port: authPort,
      config: DEFAULT_CONFIG,
      workspaceRoot: tmpDir,
      decisionToken: "secret-token",
      onDecisionRequest: noopAccept,
      onGetResolution: noopGetResolution,
    });
    await authServer.start();

    const request = makeRequest();
    const result = await new Promise<string>((resolvePromise, reject) => {
      const socket = createConnection(authPort, "127.0.0.1", () => {
        socket.write(JSON.stringify(request) + "\n");
      });
      socket.on("data", (data: Buffer) => {
        resolvePromise(data.toString("utf-8").trim());
        socket.end();
      });
      socket.on("error", reject);
    });

    const parsed = z.object({ error: z.string() }).parse(JSON.parse(result));
    expect(parsed.error).toBe("Unauthorized decision request");

    await authServer.stop();
  });
});
