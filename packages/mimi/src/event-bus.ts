import { randomUUID } from "node:crypto";
import type {
  DeadLetterEntry,
  EventBusPublishOptions,
  EventBusStats,
  EventHandler,
  MimiEvent,
  MimiTopic,
} from "./types.js";
import { MIMI_TOPICS } from "./types.js";
import { publishToPubSubTopic, resolvePubSubTarget } from "./google-pubsub-rest.js";

export interface EventBusOptions {
  /** Force a transport; defaults to auto-detection from env. */
  mode?: "in-memory" | "auto";
  handlerTimeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  /** Max retained events in the rolling snapshot buffer. */
  snapshotSize?: number;
  /** Sink receives every accepted envelope (e.g. Memory Bank agent_events). */
  sink?: (event: MimiEvent) => Promise<void> | void;
  now?: () => Date;
}

type DispatchState = {
  timer: ReturnType<typeof setTimeout> | null;
  queue: Promise<void>;
};

/**
 * MiMi's asynchronous event backbone.
 *
 * Semantics mirror Google Cloud Pub/Sub: at-least-once delivery to
 * subscribers, idempotency keys for exactly-once processing effects,
 * retries with exponential backoff and a dead-letter queue after the final
 * failed attempt. When PUBSUB_EMULATOR_HOST (or Application Credentials) are
 * configured, every envelope is ALSO mirrored to real Pub/Sub topics over
 * the REST API, so the same code runs unchanged on Cloud Run.
 */
export class MimiEventBus {
  readonly mode: EventBusStats["mode"];
  readonly projectId: string | null;

  private readonly handlers = new Map<MimiTopic, EventHandler[]>();
  private readonly seenIdempotencyKeys = new Map<string, string>();
  private readonly deadLetters = new Map<string, DeadLetterEntry>();
  private readonly snapshot: MimiEvent[] = [];
  private readonly dispatchQueues = new Map<string, DispatchState>();
  private readonly opts: Required<Pick<EventBusOptions, "handlerTimeoutMs" | "maxAttempts" | "retryBaseDelayMs" | "snapshotSize">>;
  private readonly sink: ((event: MimiEvent) => Promise<void> | void) | null;
  private readonly now: () => Date;
  private stats: Omit<EventBusStats, "mode" | "topics" | "projectId"> = {
    published: 0,
    delivered: 0,
    duplicatesSuppressed: 0,
    retries: 0,
    deadLetters: 0,
  };

  constructor(opts: EventBusOptions = {}) {
    const target = resolvePubSubTarget();
    this.projectId = target?.projectId ?? null;
    this.mode =
      opts.mode === "in-memory"
        ? "in-memory"
        : target
          ? target.emulator
            ? "google-pubsub-emulator"
            : "google-pubsub"
          : "in-memory";
    this.opts = {
      handlerTimeoutMs: opts.handlerTimeoutMs ?? 30_000,
      maxAttempts: opts.maxAttempts ?? 3,
      retryBaseDelayMs: opts.retryBaseDelayMs ?? 10,
      snapshotSize: opts.snapshotSize ?? 500,
    };
    this.sink = opts.sink ?? null;
    this.now = opts.now ?? (() => new Date());
  }

  subscribe(topic: MimiTopic, handler: EventHandler): () => void {
    const list = this.handlers.get(topic) ?? [];
    list.push(handler);
    this.handlers.set(topic, list);
    return () => {
      const current = this.handlers.get(topic) ?? [];
      const idx = current.indexOf(handler);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  /**
   * Publish an envelope. Duplicate idempotency keys are suppressed (recorded,
   * not re-delivered). Delivery to subscribers is asynchronous and serialized
   * per idempotency key so retries never race the original attempt.
   */
  async publish(
    input: {
      topic: MimiTopic;
      type: string;
      sourceAgent: MimiEvent["sourceAgent"];
      payload: Record<string, unknown>;
    } & EventBusPublishOptions,
  ): Promise<{ event: MimiEvent | null; duplicate: boolean }> {
    const key = input.idempotencyKey ?? randomUUID();
    if (this.seenIdempotencyKeys.has(key)) {
      this.stats.duplicatesSuppressed += 1;
      return { event: null, duplicate: true };
    }
    const event: MimiEvent = {
      eventId: randomUUID(),
      topic: input.topic,
      type: input.type,
      workflowId: input.workflowId ?? null,
      correlationId: input.correlationId ?? randomUUID(),
      idempotencyKey: key,
      occurredAt: this.now().toISOString(),
      sourceAgent: input.sourceAgent,
      targetAgent: input.targetAgent ?? null,
      payload: input.payload,
      attempt: 1,
    };
    this.remember(event);
    this.stats.published += 1;
    this.snapshot.unshift(event);
    if (this.snapshot.length > this.opts.snapshotSize) this.snapshot.pop();
    if (this.sink) {
      try {
        await this.sink(event);
      } catch {
        // Sink persistence failures must not block the backbone.
      }
    }
    if (this.mode !== "in-memory") {
      // Mirror to real Pub/Sub (emulator or prod). Local delivery continues
      // regardless of mirror outcome; mirror errors are logged by the client.
      void publishToPubSubTopic({
        projectId: this.projectId!,
        topic: event.topic,
        message: event,
      }).catch(() => undefined);
    }
    this.dispatch(event);
    return { event, duplicate: false };
  }

  /** Synchronously visible rolling buffer of recent envelopes. */
  recentEvents(limit = 100): MimiEvent[] {
    return this.snapshot.slice(0, limit);
  }

  listDeadLetters(): DeadLetterEntry[] {
    return [...this.deadLetters.values()].sort((a, b) => b.failedAt.localeCompare(a.failedAt));
  }

  /** Re-drive a dead-lettered event once. */
  async replayDeadLetter(id: string): Promise<boolean> {
    const entry = this.deadLetters.get(id);
    if (!entry) return false;
    this.deadLetters.delete(id);
    this.stats.deadLetters -= 1;
    this.dispatch({ ...entry.event, eventId: randomUUID(), attempt: 1 });
    return true;
  }

  getStats(): EventBusStats {
    return { ...this.stats, mode: this.mode, topics: [...MIMI_TOPICS], projectId: this.projectId };
  }

  /** Test/diagnostic hook: wait until all queued deliveries settle. */
  async idle(): Promise<void> {
    await Promise.all([...this.dispatchQueues.values()].map((s) => s.queue));
  }

  private remember(event: MimiEvent) {
    this.seenIdempotencyKeys.set(event.idempotencyKey, event.eventId);
    if (this.seenIdempotencyKeys.size > 5000) {
      const first = this.seenIdempotencyKeys.keys().next().value;
      if (first !== undefined) this.seenIdempotencyKeys.delete(first);
    }
  }

  private dispatch(event: MimiEvent) {
    const stateKey = `${event.topic}:${event.idempotencyKey}`;
    let state = this.dispatchQueues.get(stateKey);
    if (!state) {
      state = { timer: null, queue: Promise.resolve() };
      this.dispatchQueues.set(stateKey, state);
    }
    state.queue = state.queue.then(() => this.deliverWithRetries(event)).finally(() => {
      if (!state.timer) this.dispatchQueues.delete(stateKey);
    });
  }

  private async deliverWithRetries(event: MimiEvent): Promise<void> {
    const handlers = this.handlers.get(event.topic) ?? [];
    if (handlers.length === 0) return;
    for (let attempt = event.attempt; attempt <= this.opts.maxAttempts; attempt += 1) {
      event.attempt = attempt;
      if (attempt > 1) this.stats.retries += 1;
      const results = await Promise.allSettled(
        handlers.map((h) => this.withTimeout(Promise.resolve().then(() => h(event)), event)),
      );
      const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (!failure) {
        this.stats.delivered += 1;
        return;
      }
      if (attempt === this.opts.maxAttempts) {
        this.deadLetter(event, String(failure.reason instanceof Error ? failure.reason.message : failure.reason));
        return;
      }
      await delay(this.opts.retryBaseDelayMs * 2 ** (attempt - 1));
    }
  }

  private withTimeout(p: Promise<unknown>, event: MimiEvent): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`handler timeout after ${this.opts.handlerTimeoutMs}ms (${event.type})`)),
        this.opts.handlerTimeoutMs,
      );
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  private deadLetter(event: MimiEvent, reason: string) {
    const entry: DeadLetterEntry = {
      id: randomUUID(),
      event: { ...event },
      reason,
      failedAt: this.now().toISOString(),
      attempts: event.attempt,
    };
    this.deadLetters.set(entry.id, entry);
    this.stats.deadLetters += 1;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
