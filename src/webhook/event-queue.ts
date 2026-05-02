import type { WebhookEvent } from "./github-webhook-types.js";

import { logger } from "@/shared/logger.js";

export type EventWorker = (event: WebhookEvent) => Promise<void>;

/**
 * Simple in-memory FIFO event queue with a single sequential worker.
 * Events are processed one at a time to avoid race conditions.
 * The HTTP handler enqueues events and returns immediately (202).
 */
export class EventQueue {
    private readonly queue: WebhookEvent[] = [];
    private running = false;
    private worker: EventWorker | null = null;

    setWorker(worker: EventWorker): void {
        this.worker = worker;
    }

    enqueue(event: WebhookEvent): void {
        this.queue.push(event);
        if (!this.running) {
            void this.drain();
        }
    }

    private async drain(): Promise<void> {
        if (this.running) return;
        this.running = true;
        while (this.queue.length > 0) {
            const event = this.queue.shift();
            if (!event) break;
            if (!this.worker) {
                logger.warn("[webhook] EventQueue: no worker set, dropping event");
                continue;
            }
            try {
                // oxlint-disable-next-line no-await-in-loop
                await this.worker(event);
            } catch (err) {
                logger.error(
                    `[webhook] EventQueue worker error for delivery ${event.deliveryId}: ${String(err)}`,
                );
            }
        }
        this.running = false;
    }

    get size(): number {
        return this.queue.length;
    }
}
