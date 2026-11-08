/**
 * Cleanup proxy policy (review decisions 1 and 2).
 *
 * Cleanup is only available for a short window after a counted transcription,
 * with a bounded number of calls whose transcript content cannot exceed what
 * was actually transcribed (plus a small constant). The forwarded body is a
 * strict whitelist so the endpoint cannot be used as a general LLM.
 */

import { countWords } from "./words";

export const CLEANUP_BODY_LIMIT_BYTES = 64 * 1024;
export const CLEANUP_MAX_TOKENS = 4_000;
export const CLEANUP_MAX_MESSAGES = 2;
export const CLEANUP_SYSTEM_BYTES = 24 * 1024;
export const CLEANUP_USER_BYTES = 40 * 1024;

/** Grant accrual (decision 1). */
export const CLEANUP_GRANT_TTL_SECONDS = 15 * 60;
export const CLEANUP_CALLS_PER_TRANSCRIPTION = 6;
export const CLEANUP_MAX_CALLS = 30;
/** The transcript may exceed the counted words by this much. */
export const CLEANUP_TRANSCRIPT_SLACK_WORDS = 25;

const DEFAULT_CLEANUP_MODELS = ["gemma-4-31b"];
const TRANSCRIPT_TAG = /<transcript>([\s\S]*?)<\/transcript>/giu;
const encoder = new TextEncoder();

export interface CleanupMessage {
  role: "system" | "user";
  content: string;
}

export type CleanupMessagesResult =
  | { ok: true; messages: CleanupMessage[] }
  | {
      ok: false;
      error: "invalid_messages" | "message_too_large";
      message: string;
    };

export function cleanupModels(raw: string | undefined): string[] {
  const models = (raw ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model !== "");
  return models.length > 0 ? models : [...DEFAULT_CLEANUP_MODELS];
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/**
 * Validates and sanitises `messages`: at most two (one system and one user),
 * only `role` and `content` survive, and each role has a byte budget.
 */
export function validateCleanupMessages(value: unknown): CleanupMessagesResult {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      error: "invalid_messages",
      message: "messages must be a non-empty array.",
    };
  }
  if (value.length > CLEANUP_MAX_MESSAGES) {
    return {
      ok: false,
      error: "invalid_messages",
      message: `At most ${CLEANUP_MAX_MESSAGES} messages are allowed.`,
    };
  }

  const messages: CleanupMessage[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return {
        ok: false,
        error: "invalid_messages",
        message: "Each message must be an object.",
      };
    }
    const record = item as Record<string, unknown>;
    const role = record["role"];
    const content = record["content"];
    if (role !== "system" && role !== "user") {
      return {
        ok: false,
        error: "invalid_messages",
        message: "Only system and user messages are allowed.",
      };
    }
    if (typeof content !== "string") {
      return {
        ok: false,
        error: "invalid_messages",
        message: "Message content must be a string.",
      };
    }
    if (seen.has(role)) {
      return {
        ok: false,
        error: "invalid_messages",
        message: "At most one system and one user message are allowed.",
      };
    }
    seen.add(role);

    const limit =
      role === "system" ? CLEANUP_SYSTEM_BYTES : CLEANUP_USER_BYTES;
    if (byteLength(content) > limit) {
      return {
        ok: false,
        error: "message_too_large",
        message: `The ${role} message is too large.`,
      };
    }
    messages.push({ role, content });
  }
  return { ok: true, messages };
}

/**
 * Counts the words inside every `<transcript>…</transcript>` tag in the last
 * user message. Multiple tags are summed so a caller cannot split a transcript
 * to evade the length check.
 *
 * If the message has no transcript tags at all, the whole last user message is
 * counted instead. Otherwise a caller could omit the tags and use the grant as
 * a small general-purpose LLM (up to 30 calls per grant window).
 */
export function transcriptWordsInMessages(
  messages: readonly CleanupMessage[],
): number {
  let lastUserContent: string | null = null;
  for (const message of messages) {
    if (message.role === "user") lastUserContent = message.content;
  }
  if (lastUserContent === null) return 0;

  let total = 0;
  let sawTranscript = false;
  for (const match of lastUserContent.matchAll(TRANSCRIPT_TAG)) {
    sawTranscript = true;
    total += countWords(match[1] ?? "");
  }
  return sawTranscript ? total : countWords(lastUserContent);
}

/** Clamps `max_tokens` to 1..4000; anything non-numeric is dropped. */
export function cleanupMaxTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(CLEANUP_MAX_TOKENS, Math.max(1, Math.floor(value)));
}

/** Forwards only a finite numeric temperature; anything else is dropped. */
export function cleanupTemperature(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** The exact upstream body allowed by decision 2. */
export function buildCleanupForwardBody(
  model: string,
  messages: readonly CleanupMessage[],
  temperature: number | undefined,
  maxTokens: number | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    stream: false,
  };
  if (temperature !== undefined) body["temperature"] = temperature;
  if (maxTokens !== undefined) body["max_tokens"] = maxTokens;
  return body;
}
