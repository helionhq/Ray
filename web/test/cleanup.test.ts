import { describe, expect, it } from "vitest";
import {
  buildCleanupForwardBody,
  CLEANUP_MAX_TOKENS,
  CLEANUP_SYSTEM_BYTES,
  CLEANUP_USER_BYTES,
  cleanupMaxTokens,
  cleanupModels,
  cleanupTemperature,
  transcriptWordsInMessages,
  validateCleanupMessages,
} from "../worker/lib/cleanup";

describe("validateCleanupMessages", () => {
  it("accepts one system and one user message and keeps only role/content", () => {
    const result = validateCleanupMessages([
      { role: "system", content: "Be nice.", name: "ignored" },
      { role: "user", content: "<transcript>hi</transcript>" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.messages).toEqual([
      { role: "system", content: "Be nice." },
      { role: "user", content: "<transcript>hi</transcript>" },
    ]);
  });

  it("rejects more than two messages, duplicate roles and bad shapes", () => {
    expect(
      validateCleanupMessages([
        { role: "system", content: "a" },
        { role: "user", content: "b" },
        { role: "user", content: "c" },
      ]).ok,
    ).toBe(false);
    expect(
      validateCleanupMessages([
        { role: "user", content: "a" },
        { role: "user", content: "b" },
      ]).ok,
    ).toBe(false);
    expect(validateCleanupMessages("nope").ok).toBe(false);
    expect(validateCleanupMessages([]).ok).toBe(false);
    expect(validateCleanupMessages([null]).ok).toBe(false);
    expect(
      validateCleanupMessages([{ role: "assistant", content: "a" }]).ok,
    ).toBe(false);
    expect(
      validateCleanupMessages([{ role: "user", content: 5 }]).ok,
    ).toBe(false);
  });

  it("enforces the system and user byte budgets", () => {
    const atSystemLimit = validateCleanupMessages([
      { role: "system", content: "a".repeat(CLEANUP_SYSTEM_BYTES) },
    ]);
    expect(atSystemLimit.ok).toBe(true);
    const overSystem = validateCleanupMessages([
      { role: "system", content: "a".repeat(CLEANUP_SYSTEM_BYTES + 1) },
    ]);
    expect(overSystem.ok).toBe(false);
    if (overSystem.ok) throw new Error("unreachable");
    expect(overSystem.error).toBe("message_too_large");

    const atUserLimit = validateCleanupMessages([
      { role: "user", content: "a".repeat(CLEANUP_USER_BYTES) },
    ]);
    expect(atUserLimit.ok).toBe(true);
    expect(
      validateCleanupMessages([
        { role: "user", content: "a".repeat(CLEANUP_USER_BYTES + 1) },
      ]).ok,
    ).toBe(false);
  });

  it("measures UTF-8 bytes, not UTF-16 code units", () => {
    // Each CJK character is three bytes in UTF-8.
    const characters = Math.floor(CLEANUP_USER_BYTES / 3) + 1;
    expect(
      validateCleanupMessages([
        { role: "user", content: "你".repeat(characters) },
      ]).ok,
    ).toBe(false);
  });
});

describe("transcriptWordsInMessages", () => {
  it("counts the transcript in the last user message only", () => {
    expect(
      transcriptWordsInMessages([
        { role: "user", content: "<transcript>first one</transcript>" },
        { role: "system", content: "<transcript>system ignored</transcript>" },
        { role: "user", content: "<transcript>one two three</transcript>" },
      ]),
    ).toBe(3);
  });

  it("sums multiple transcript tags so they cannot be split to evade", () => {
    expect(
      transcriptWordsInMessages([
        {
          role: "user",
          content:
            "<transcript>one two</transcript> noise <transcript>three</transcript>",
        },
      ]),
    ).toBe(3);
  });

  it("counts CJK transcript words and falls back to untagged content", () => {
    expect(
      transcriptWordsInMessages([
        { role: "user", content: "<transcript>你好世界</transcript>" },
      ]),
    ).toBe(4);
    // No tags: the whole user message is counted, so the endpoint cannot be
    // repurposed as a general LLM by omitting the tags.
    expect(
      transcriptWordsInMessages([
        { role: "user", content: "write me a poem" },
      ]),
    ).toBe(4);
    expect(transcriptWordsInMessages([])).toBe(0);
    expect(
      transcriptWordsInMessages([{ role: "system", content: "ignored" }]),
    ).toBe(0);
  });
});

describe("cleanup forwards a strict field whitelist", () => {
  const messages = [{ role: "user" as const, content: "hi" }];

  it("drops n, max_completion_tokens, tools and every other field", () => {
    const body = buildCleanupForwardBody(
      "gemma-4-31b",
      messages,
      undefined,
      undefined,
    );
    expect(Object.keys(body).sort()).toEqual(
      ["messages", "model", "stream"].sort(),
    );
    expect(body["stream"]).toBe(false);
  });

  it("includes only whitelisted optional fields", () => {
    const body = buildCleanupForwardBody(
      "gemma-4-31b",
      messages,
      0.2,
      123,
    );
    expect(body).toEqual({
      model: "gemma-4-31b",
      messages,
      stream: false,
      temperature: 0.2,
      max_tokens: 123,
    });
  });

  it("clamps max_tokens to 4000 and normalises invalid values", () => {
    expect(cleanupMaxTokens(999_999)).toBe(CLEANUP_MAX_TOKENS);
    expect(cleanupMaxTokens(0)).toBe(1);
    expect(cleanupMaxTokens(-50)).toBe(1);
    expect(cleanupMaxTokens(12.9)).toBe(12);
    expect(cleanupMaxTokens("100")).toBeUndefined();
    expect(cleanupMaxTokens(Number.NaN)).toBeUndefined();
    expect(cleanupTemperature(0.5)).toBe(0.5);
    expect(cleanupTemperature("0.5")).toBeUndefined();
    expect(cleanupTemperature(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("parses the model allowlist with a default", () => {
    expect(cleanupModels("a, b ,,c")).toEqual(["a", "b", "c"]);
    expect(cleanupModels("")).toEqual(["gemma-4-31b"]);
    expect(cleanupModels(undefined)).toEqual(["gemma-4-31b"]);
  });
});
