export const MAX_EVENT_DEPTH = 5;
export const MAX_EVENTS_PER_CALL = 32;
export const MAX_EVENT_PAYLOAD_BYTES = 512_000;
export const MAX_EVENT_ATTEMPTS = 5;
export const MAX_PENDING_EVENTS = 500;
export const MAX_RECENT_EVENTS = 50;
export const MAX_CONCURRENT_EVENTS_PER_APP = 4;

const eventRetryBaseMs = 5_000;
const eventRetryCapMs = 15 * 60_000;

const topicPattern = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/;
const subscriptionPattern = /^(?:\*|[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*(?:\.\*)?)$/;

export interface EventMeta {
  id: string;
  topic: string;
  source: string;
  at: string;
  depth: number;
}

export interface EmittedEvent {
  topic: string;
  payload: unknown;
}

export interface EventDelivery {
  id: string;
  eventId: string;
  topic: string;
  source: string;
  payload: unknown;
  at: string;
  depth: number;
  targetAppId: string;
  targetAppName: string;
  handler: string;
  due: number;
  failures: number;
  error?: string;
}

export interface EventHistoryEntry {
  eventId: string;
  topic: string;
  source: string;
  targetApp: string;
  handler: string;
  status: "delivered" | "failed" | "dropped";
  at: string;
  finishedAt: string;
  attempts: number;
  error?: string;
}

export interface EventStore {
  pending: EventDelivery[];
  recent: EventHistoryEntry[];
}

export interface EmitResult {
  eventId: string;
  topic: string;
  source: string;
  at: string;
  matched: number;
  dropped?: boolean;
  targets: Array<{ app: string; handler: string }>;
}

export function validateEventTopic(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !topicPattern.test(value)) {
    throw new Error(
      "Event topics must be dot-separated names using letters, digits, hyphens, or underscores (at most 128 characters).",
    );
  }
  return value;
}

export function validateEventPattern(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !subscriptionPattern.test(value)) {
    throw new Error(
      "Event subscriptions must be an exact topic, '*', or a trailing 'prefix.*' wildcard (at most 128 characters).",
    );
  }
  return value;
}

export function matchesEventPattern(pattern: string, topic: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return topic.startsWith(pattern.slice(0, -1));
  return pattern === topic;
}

export function encodeEventPayload(payload: unknown): unknown {
  const encoded = JSON.stringify(payload ?? null);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
    throw new Error("Event payload must be UTF-8 JSON of at most 512 KB.");
  }
  return JSON.parse(encoded);
}

export function eventRetryDelay(failures: number): number {
  return Math.min(eventRetryBaseMs * 3 ** Math.max(0, failures - 1), eventRetryCapMs);
}
