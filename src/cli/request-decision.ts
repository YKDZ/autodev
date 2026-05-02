import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { parseArgs } from "node:util";
import z from "zod";

import { logger } from "@/shared/logger.js";

const DecisionOptionInputSchema = z.union([
    z.string(),
    z.object({
        key: z.string(),
        label: z.string().optional(),
        description: z.string().optional(),
    }),
]);

const DecisionInputSchema = z.object({
    id: z.string().optional(),
    workflowRunId: z.string().optional(),
    title: z.string().optional(),
    options: z.array(DecisionOptionInputSchema).optional(),
    recommendation: z.string().optional(),
    context: z.string().nullable().optional(),
});

const normalizeOptions = (
    input: z.infer<typeof DecisionOptionInputSchema>[],
): Array<{ key: string; label: string; description: string }> =>
    input.map((option) => {
        if (typeof option === "string") {
            return {
                key: option,
                label: option,
                description: option,
            };
        }

        const label = option.label?.trim() ? option.label : option.key;
        return {
            key: option.key,
            label,
            description: option.description ?? label,
        };
    });

const parseJsonArg = (raw: string): unknown => {
    try {
        return JSON.parse(raw);
    } catch {
        throw new Error("Invalid JSON payload");
    }
};

export const runRequestDecision = async (args: string[]): Promise<void> => {
    const { values } = parseArgs({
        args,
        options: {
            "workflow-run-id": { type: "string" },
            title: { type: "string" },
            options: { type: "string" },
            recommendation: { type: "string" },
            context: { type: "string" },
            json: { type: "string" },
        },
        strict: true,
    });

    const host = process.env.AUTO_DEV_DECISION_HOST ?? "127.0.0.1";
    const parsedPort = parseInt(process.env.AUTO_DEV_DECISION_PORT ?? "3000", 10);
    const port = Number.isNaN(parsedPort) ? 3000 : parsedPort;
    const token = process.env.AUTO_DEV_DECISION_TOKEN ?? "";

    let parsedInput: z.infer<typeof DecisionInputSchema>;

    if (values.json) {
        parsedInput = DecisionInputSchema.parse(parseJsonArg(values.json));
    } else {
        const optionsRaw = values.options ? parseJsonArg(values.options) : [];
        parsedInput = DecisionInputSchema.parse({
            workflowRunId: values["workflow-run-id"],
            title: values.title,
            options: optionsRaw,
            recommendation: values.recommendation,
            context: values.context ?? null,
        });
    }

    const workflowRunId =
        parsedInput.workflowRunId ??
        values["workflow-run-id"] ??
        process.env.AUTO_DEV_RUN_ID ??
        "";

    if (!workflowRunId) {
        logger.error(
            "Missing workflow run id. Use --workflow-run-id or set AUTO_DEV_RUN_ID.",
        );
        process.exit(1);
    }

    const normalizedOptions = normalizeOptions(parsedInput.options ?? []);
    if (normalizedOptions.length === 0) {
        logger.error("Missing decision options. Use --options '[...]'.");
        process.exit(1);
    }

    const recommendation =
        parsedInput.recommendation ?? normalizedOptions[0]?.key ?? "";

    const request = {
        id: parsedInput.id ?? randomUUID(),
        workflowRunId,
        title: parsedInput.title?.trim() || "Decision required",
        options: normalizedOptions,
        recommendation,
        context: parsedInput.context ?? null,
        ...(token ? { token } : {}),
    };

    const socket = createConnection(port, host);

    await new Promise<void>((resolve, reject) => {
        let buffer = "";
        let done = false;

        const finish = (ok: boolean): void => {
            if (done) return;
            done = true;
            socket.end();
            if (!ok) {
                process.exitCode = 1;
            }
            resolve();
        };

        socket.on("connect", () => {
            socket.write(JSON.stringify(request) + "\n");
        });

        socket.on("data", (data: Buffer) => {
            buffer += data.toString("utf-8");
            const newlineIdx = buffer.indexOf("\n");
            if (newlineIdx === -1) return;

            const line = buffer.slice(0, newlineIdx).trim();
            if (!line) {
                finish(false);
                return;
            }

            try {
                const parsed = JSON.parse(line) as Record<string, unknown>;
                if (typeof parsed.error === "string") {
                    logger.error(JSON.stringify(parsed));
                    finish(false);
                    return;
                }

                const output = {
                    decisionId: String(parsed.decisionId ?? request.id),
                    resolution: String(parsed.resolution ?? ""),
                    resolvedBy: String(parsed.resolvedBy ?? ""),
                    remainingDecisions: Number(parsed.remainingDecisions ?? 0),
                };
                process.stdout.write(JSON.stringify(output) + "\n");
                finish(true);
            } catch {
                logger.error(`Invalid response from decision server: ${line}`);
                finish(false);
            }
        });

        socket.on("error", (err: Error) => {
            logger.error(JSON.stringify({ error: err.message }));
            reject(err);
        });

        socket.setTimeout(0);
    });
};
