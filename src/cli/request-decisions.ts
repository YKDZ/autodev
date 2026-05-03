import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { parseArgs } from "node:util";
import { z } from "zod";

import { logger } from "@/shared/logger.js";

const DecisionInputItemSchema = z.object({
  id: z.string().optional(),
  workflowRunId: z.string().optional(),
  title: z.string().default(""),
  options: z.array(z.unknown()).default([]),
  recommendation: z.string().default(""),
  context: z.string().nullable().default(null),
});

const normalizeOptions = (
  options: unknown[],
): Array<{ key: string; label: string; description: string }> =>
  options
    .map((option) => {
      if (typeof option === "string") {
        return {
          key: option,
          label: option,
          description: option,
        };
      }
      if (typeof option !== "object" || option === null) return null;

      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const record = option as Record<string, unknown>;
      const key = typeof record.key === "string" ? record.key : "";
      if (!key) return null;

      const label =
        typeof record.label === "string" && record.label.trim()
          ? record.label
          : key;
      return {
        key,
        label,
        description:
          typeof record.description === "string" && record.description.trim()
            ? record.description
            : label,
      };
    })
    .filter(
      (option): option is { key: string; label: string; description: string } =>
        option !== null,
    );

const queryResolution = async (
  host: string,
  port: number,
  decisionId: string,
  token: string,
): Promise<
  | {
      resolved: false;
    }
  | {
      resolved: true;
      response: Record<string, unknown>;
    }
> => {
  const socket = createConnection(port, host);

  return new Promise((resolve, reject) => {
    let buffer = "";
    socket.on("connect", () => {
      const payload = {
        getResolution: decisionId,
        ...(token ? { token } : {}),
      };
      socket.write(JSON.stringify(payload) + "\n");
    });
    socket.on("data", (data: Buffer) => {
      buffer += data.toString("utf-8");
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;

      const line = buffer.slice(0, idx).trim();
      socket.end();
      try {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.resolved === true && parsed.response) {
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          const response = parsed.response as Record<string, unknown>;
          resolve({
            resolved: true,
            response,
          });
          return;
        }
        resolve({ resolved: false });
      } catch {
        resolve({ resolved: false });
      }
    });
    socket.on("error", reject);
  });
};

export const runRequestDecisions = async (args: string[]): Promise<void> => {
  const { values } = parseArgs({
    args,
    options: {
      "workflow-run-id": { type: "string" },
      decisions: { type: "string" },
      wait: { type: "boolean", default: false },
      timeout: { type: "string" },
      interval: { type: "string" },
    },
    strict: true,
  });

  const host = process.env.AUTO_DEV_DECISION_HOST ?? "127.0.0.1";
  const port = parseInt(process.env.AUTO_DEV_DECISION_PORT ?? "3000", 10);
  const token = process.env.AUTO_DEV_DECISION_TOKEN ?? "";
  const workflowRunId = values["workflow-run-id"] ?? "";
  const shouldWait = values.wait ?? false;
  const timeoutParsed = values.timeout ? parseInt(values.timeout, 10) : 300;
  const timeoutSec = Number.isNaN(timeoutParsed) ? 300 : timeoutParsed;
  const intervalParsed = values.interval ? parseInt(values.interval, 10) : 2;
  const intervalMs = (Number.isNaN(intervalParsed) ? 2 : intervalParsed) * 1000;
  const rawDecisions = JSON.parse(values.decisions ?? "[]");

  const decisions = (Array.isArray(rawDecisions) ? rawDecisions : []).map(
    (d: unknown) => {
      const item = DecisionInputItemSchema.parse(d);
      return {
        id: item.id ?? randomUUID(),
        workflowRunId: item.workflowRunId ?? workflowRunId,
        title: item.title,
        options: normalizeOptions(item.options),
        recommendation: item.recommendation,
        context: item.context,
      };
    },
  );

  if (decisions.length === 0) {
    logger.error("No decisions provided. Use --decisions '[{...}]'.");
    process.exit(1);
  }

  const socket = createConnection(port, host);
  const payload =
    JSON.stringify({ batch: decisions, ...(token ? { token } : {}) }) + "\n";

  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => {
      socket.write(payload);
    });
    socket.on("data", (data: Buffer) => {
      const rawResponse = data.toString("utf-8").trim();
      try {
        const parsed: unknown = JSON.parse(rawResponse);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "error" in parsed
        ) {
          logger.error(JSON.stringify(parsed));
          process.exitCode = 1;
          socket.end();
          resolve();
          return;
        }
        const response =
          parsed !== null && typeof parsed === "object"
            ? (parsed as {
                results?: Array<{
                  accepted: boolean;
                  id: string;
                  alias: string;
                  reason?: string;
                }>;
              })
            : { results: [] };

        if (!shouldWait) {
          process.stdout.write(JSON.stringify(parsed) + "\n");
          socket.end();
          resolve();
          return;
        }

        socket.end();

        const acceptedDecisionIds = (response.results ?? [])
          .filter((item) => item.accepted)
          .map((item) => item.id);

        const pending = new Set(acceptedDecisionIds);
        const resolved: Array<{
          decisionId: string;
          resolution: string;
          resolvedBy: string;
          remainingDecisions: number;
        }> = [];
        const deadline = Date.now() + timeoutSec * 1000;

        const waitLoop = async (): Promise<void> => {
          while (pending.size > 0 && Date.now() < deadline) {
            const ids = [...pending.values()];
            for (const decisionId of ids) {
              // oxlint-disable-next-line no-await-in-loop
              const status = await queryResolution(
                host,
                port,
                decisionId,
                token,
              );
              if (status.resolved) {
                resolved.push({
                  decisionId:
                    typeof status.response.decisionId === "string"
                      ? status.response.decisionId
                      : decisionId,
                  resolution:
                    typeof status.response.resolution === "string"
                      ? status.response.resolution
                      : "",
                  resolvedBy:
                    typeof status.response.resolvedBy === "string"
                      ? status.response.resolvedBy
                      : "",
                  remainingDecisions: Number(
                    status.response.remainingDecisions ?? 0,
                  ),
                });
                pending.delete(decisionId);
              }
            }

            if (pending.size > 0) {
              // oxlint-disable-next-line no-await-in-loop
              await new Promise((r) => setTimeout(r, intervalMs));
            }
          }

          const output = {
            mode: "wait",
            accepted: acceptedDecisionIds.length,
            rejected: (response.results ?? []).filter((item) => !item.accepted)
              .length,
            results: response.results ?? [],
            resolved,
            pendingDecisionIds: [...pending.values()],
            timedOut: pending.size > 0,
          };

          process.stdout.write(JSON.stringify(output) + "\n");
          if (pending.size > 0) {
            process.exitCode = 1;
          }
        };

        void waitLoop().then(resolve).catch(reject);
      } catch {
        logger.error(`Invalid response: ${rawResponse}`);
        socket.end();
        resolve();
      }
    });
    socket.on("error", (err: Error) => {
      logger.error(JSON.stringify({ error: err.message }));
      reject(err);
    });
    socket.setTimeout(0);
  });
};
