import type { Socket, Server } from "node:net";

import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

import type { DecisionRequest, DecisionResponse } from "@/shared/types.js";

import { logger } from "@/shared/logger.js";
import { DecisionRequestSchema } from "@/shared/schemas.js";

import type { AutoDevConfig } from "../config/types.js";

interface PendingConnection {
  socket: Socket;
  request: DecisionRequest;
}

export interface SocketServerOptions {
  /** TCP port to listen on. */
  port: number;
  config: AutoDevConfig;
  workspaceRoot: string;
  decisionToken?: string;
  onDecisionRequest: (request: DecisionRequest) => Promise<{
    accepted: boolean;
    remainingDecisions: number;
  }>;
  onGetResolution: (decisionId: string) => Promise<DecisionResponse | null>;
  onBatchDecisionRequest?: (
    requests: DecisionRequest[],
    batchId: string,
  ) => Promise<
    Array<{ accepted: boolean; id: string; alias: string; reason?: string }>
  >;
}

export class DecisionSocketServer {
  private server: Server | null = null;
  private pending: Map<string, PendingConnection> = new Map();
  private readonly options: SocketServerOptions;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly POLL_INTERVAL_MS = 2000;

  constructor(options: SocketServerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket: Socket) => {
        this.handleConnection(socket);
      });

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        logger.error(`[auto-dev] Decision TCP server error: ${err.message}`);
        reject(err);
      });

      this.server.listen(this.options.port, "0.0.0.0", () => {
        logger.info(
          `[auto-dev] Decision server listening on TCP 0.0.0.0:${this.options.port}`,
        );
        this.startResolutionPoller();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }

      for (const [, pending] of this.pending) {
        pending.socket.destroy();
      }
      this.pending.clear();

      if (this.server) {
        this.server.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Polls pending decisions against the state store so that when a human
   * resolves a decision via `auto-dev resolve-decision` (which only writes to
   * the file system), the blocked `request-decision` connection is
   * automatically woken up and the agent resumes.
   */
  private startResolutionPoller(): void {
    const poll = async () => {
      await Promise.all(
        [...this.pending.keys()].map(async (decisionId) => {
          try {
            const response = await this.options.onGetResolution(decisionId);
            if (response) {
              this.resolveDecision(decisionId, response);
            }
          } catch (err) {
            logger.error(
              `[auto-dev] Resolution poller error for decision ${decisionId}: ${String(err)}`,
            );
          }
        }),
      );
      this.pollTimer = setTimeout(
        () => void poll(),
        DecisionSocketServer.POLL_INTERVAL_MS,
      );
    };
    this.pollTimer = setTimeout(
      () => void poll(),
      DecisionSocketServer.POLL_INTERVAL_MS,
    );
  }

  resolveDecision(decisionId: string, response: DecisionResponse): void {
    const pending = this.pending.get(decisionId);
    if (!pending) {
      logger.warn(
        `[auto-dev] No pending connection for decision ${decisionId}`,
      );
      return;
    }

    const payload = JSON.stringify(response) + "\n";
    pending.socket.write(payload, () => {
      pending.socket.end();
      this.pending.delete(decisionId);
    });
  }

  private cleanupConnection(decisionId: string): void {
    this.pending.delete(decisionId);
  }

  private handleConnection(socket: Socket): void {
    let buffer = "";
    let decisionId: string | null = null;

    // Close idle connections that never send a request within 10 seconds.
    const idleTimeout = setTimeout(() => {
      if (!decisionId) {
        socket.destroy();
      }
    }, 10_000);

    socket.on("data", (data: Buffer) => {
      clearTimeout(idleTimeout);
      socket.pause();
      void this.handleData(socket, data, buffer, decisionId)
        .then((updated) => {
          buffer = updated.buffer;
          decisionId = updated.decisionId;
          socket.resume();
        })
        .catch((err: unknown) => {
          logger.error(`[auto-dev] Connection handler error: ${String(err)}`);
          socket.destroy();
        });
    });

    socket.on("close", () => {
      if (decisionId) {
        this.cleanupConnection(decisionId);
      }
    });

    socket.on("error", (err: Error) => {
      logger.error(`[auto-dev] TCP connection error: ${err.message}`);
      if (decisionId) {
        this.cleanupConnection(decisionId);
      }
    });
  }

  private async handleData(
    socket: Socket,
    data: Buffer,
    currentBuffer: string,
    currentDecisionId: string | null,
  ): Promise<{ buffer: string; decisionId: string | null }> {
    let buffer = currentBuffer + data.toString("utf-8");
    let decisionId = currentDecisionId;

    const newlineIdx = buffer.indexOf("\n");
    if (newlineIdx === -1) return { buffer, decisionId };

    const message = buffer.slice(0, newlineIdx);
    buffer = buffer.slice(newlineIdx + 1);

    // Detect batch mode: { batch: [...] }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      const errorResp =
        JSON.stringify({ error: "Invalid JSON in decision request" }) + "\n";
      socket.write(errorResp);
      socket.end();
      return { buffer, decisionId };
    }

    const expectedToken = this.options.decisionToken ?? "";
    if (expectedToken) {
      const receivedToken =
        parsed !== null &&
          typeof parsed === "object" &&
          "token" in parsed &&
          typeof (parsed as Record<string, unknown>).token === "string"
          ? ((parsed as Record<string, unknown>).token as string)
          : "";
      if (receivedToken !== expectedToken) {
        socket.write(JSON.stringify({ error: "Unauthorized decision request" }) + "\n");
        socket.end();
        return { buffer, decisionId };
      }
    }

    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "getResolution" in parsed &&
      typeof (parsed as Record<string, unknown>)["getResolution"] === "string"
    ) {
      const requestId = (parsed as Record<string, string>).getResolution;
      const response = await this.options.onGetResolution(requestId);
      if (response) {
        socket.write(JSON.stringify({ resolved: true, response }) + "\n");
      } else {
        socket.write(JSON.stringify({ resolved: false }) + "\n");
      }
      socket.end();
      return { buffer, decisionId };
    }

    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "batch" in parsed &&
      Array.isArray((parsed as Record<string, unknown>)["batch"]) &&
      this.options.onBatchDecisionRequest
    ) {
      const record = parsed as Record<string, unknown>;
      // Array.isArray was already checked in the guard condition above
      const batch: readonly unknown[] = Array.isArray(record["batch"])
        ? record["batch"]
        : [];
      try {
        const batchId = randomUUID();
        const batchRequests = batch.map((d: unknown) =>
          DecisionRequestSchema.parse(d),
        );
        const results = await this.options.onBatchDecisionRequest(
          batchRequests,
          batchId,
        );
        socket.write(JSON.stringify({ results }) + "\n");
        socket.end();
        // Batch mode is fire-and-forget: the agent does not wait for resolution
        // on this socket, so we must NOT add batch requests to pending.
        return { buffer, decisionId: null };
      } catch (err) {
        socket.write(JSON.stringify({ error: String(err) }) + "\n");
        socket.end();
        return { buffer, decisionId };
      }
    }

    let request: DecisionRequest;
    try {
      request = DecisionRequestSchema.parse(parsed);
    } catch (err) {
      const errorResp =
        JSON.stringify({
          error: "Invalid decision request payload",
          details: String(err),
        }) + "\n";
      socket.write(errorResp);
      socket.end();
      return { buffer, decisionId };
    }

    decisionId = request.id;

    const result = await this.options.onDecisionRequest(request);

    if (!result.accepted) {
      const errorResp =
        JSON.stringify({
          error: "Decision limit reached",
          remainingDecisions: 0,
        }) + "\n";
      socket.write(errorResp);
      socket.end();
      return { buffer, decisionId };
    }

    this.pending.set(request.id, {
      socket,
      request,
    });

    return { buffer, decisionId };
  }
}
