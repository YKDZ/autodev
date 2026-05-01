import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { parseArgs } from "node:util";

import type { DecisionRequest } from "../shared/types.js";

import { logger } from "../shared/logger.js";

export const runRequestDecision = async (args: string[]): Promise<void> => {
  const { values } = parseArgs({
    args,
    options: {
      id: { type: "string" },
      "workflow-run-id": { type: "string" },
      title: { type: "string" },
      options: { type: "string" },
      recommendation: { type: "string" },
      context: { type: "string" },
    },
    strict: true,
  });

  const socketPath = process.env.AUTO_DEV_SOCKET ?? "/var/run/auto-dev.sock";

  // Parse options: accept either string[] or {key,label,description}[] format.
  const rawOptions: unknown = JSON.parse(values.options ?? "[]");
  const normalizedOptions = Array.isArray(rawOptions)
    ? rawOptions.map((o: unknown) => {
        if (typeof o === "string") {
          return { key: o, label: o, description: o };
        }
        return o;
      })
    : [];

  const request: DecisionRequest = {
    id: values.id ?? randomUUID(),
    workflowRunId: values["workflow-run-id"] ?? "",
    title: values.title ?? "",
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    options: normalizedOptions as DecisionRequest["options"],
    recommendation: values.recommendation ?? "",
    context: values.context ?? null,
  };

  const socket = createConnection(socketPath);

  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });

    socket.on("data", (data: Buffer) => {
      const response = data.toString("utf-8").trim();
      try {
        const parsed: Record<string, unknown> = JSON.parse(response);
        if (parsed.error) {
          logger.error(JSON.stringify(parsed));
          socket.end();
          resolve();
          return;
        }
        // Output simplified format that agents can easily parse.
        // Include both `choice` and full response for compatibility.
        const output = {
          choice: parsed.resolution ?? parsed.choice,
          ...parsed,
        };
        process.stdout.write(JSON.stringify(output) + "\n");
        socket.end();
        resolve();
      } catch {
        logger.error(`Invalid response from coordinator: ${response}`);
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
