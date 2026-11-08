import { describe, expect, it } from "vitest";
import {
  DEFAULT_FAIR_USE_WEEKLY_AUDIO_SECONDS,
  DEFAULT_FAIR_USE_WEEKLY_WORDS,
  DEFAULT_STARTER_WEEKLY_AUDIO_SECONDS,
  DEFAULT_STARTER_WEEKLY_WORDS,
  decideQuota,
  parseLimit,
  quotaLimits,
} from "../worker/lib/quota";

const LIMITS = {
  starterWeeklyWords: 1_000,
  fairUseWeeklyWords: 100_000,
  starterWeeklyAudioSeconds: 3_600,
  fairUseWeeklyAudioSeconds: 54_000,
};
const RESETS_AT = Math.floor(Date.parse("2026-11-09T00:00:00Z") / 1000);

describe("parseLimit", () => {
  it("parses whole numbers", () => {
    expect(parseLimit("1000", 5)).toBe(1_000);
    expect(parseLimit("12.9", 5)).toBe(12);
    expect(parseLimit("0", 5)).toBe(0);
  });

  it("falls back for missing, invalid and negative values", () => {
    expect(parseLimit(undefined, 5)).toBe(5);
    expect(parseLimit(null, 5)).toBe(5);
    expect(parseLimit("", 5)).toBe(5);
    expect(parseLimit("abc", 5)).toBe(5);
    expect(parseLimit("-1", 5)).toBe(5);
    expect(parseLimit("Infinity", 5)).toBe(5);
  });

  it("uses the contract defaults", () => {
    const limits = quotaLimits({
      STARTER_WEEKLY_WORDS: "",
      FAIR_USE_WEEKLY_WORDS: "",
    });
    expect(limits.starterWeeklyWords).toBe(DEFAULT_STARTER_WEEKLY_WORDS);
    expect(limits.fairUseWeeklyWords).toBe(DEFAULT_FAIR_USE_WEEKLY_WORDS);
    expect(limits.starterWeeklyAudioSeconds).toBe(
      DEFAULT_STARTER_WEEKLY_AUDIO_SECONDS,
    );
    expect(limits.fairUseWeeklyAudioSeconds).toBe(
      DEFAULT_FAIR_USE_WEEKLY_AUDIO_SECONDS,
    );
  });

  it("parses the audio overrides", () => {
    const limits = quotaLimits({
      STARTER_WEEKLY_WORDS: "1000",
      FAIR_USE_WEEKLY_WORDS: "100000",
      STARTER_WEEKLY_AUDIO_SECONDS: "120",
      FAIR_USE_WEEKLY_AUDIO_SECONDS: "600",
    });
    expect(limits.starterWeeklyAudioSeconds).toBe(120);
    expect(limits.fairUseWeeklyAudioSeconds).toBe(600);
  });
});

describe("decideQuota — Starter", () => {
  it("allows dictation below the weekly limit", () => {
    expect(decideQuota("starter", 0, 0, LIMITS, RESETS_AT).allowed).toBe(true);
    expect(decideQuota("starter", 999, 0, LIMITS, RESETS_AT).allowed).toBe(true);
  });

  it("blocks at exactly the limit", () => {
    const decision = decideQuota("starter", 1_000, 0, LIMITS, RESETS_AT);
    expect(decision.allowed).toBe(false);
    if (decision.allowed || decision.reason !== "starter_limit") {
      throw new Error("unreachable");
    }
    expect(decision.wordsUsed).toBe(1_000);
    expect(decision.wordsLimit).toBe(1_000);
    expect(decision.resetsAt).toBe(RESETS_AT);
  });

  it("blocks over the limit", () => {
    const decision = decideQuota("starter", 1_001, 0, LIMITS, RESETS_AT);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toBe("starter_limit");
  });
});

describe("decideQuota — audio budget", () => {
  it("blocks Starter at the weekly audio cap even far below the word cap", () => {
    const decision = decideQuota("starter", 1, 3_600, LIMITS, RESETS_AT);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toBe("starter_limit");
  });

  it("allows Starter just below the audio cap", () => {
    expect(decideQuota("starter", 1, 3_599, LIMITS, RESETS_AT).allowed).toBe(
      true,
    );
  });

  it("blocks Pro at the hidden audio fair-use cap with a fair_use decision", () => {
    const decision = decideQuota("pro", 1, 54_000, LIMITS, RESETS_AT);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toBe("fair_use");
  });
});

describe("decideQuota — Pro fair use", () => {
  it("allows Pro dictation below the hidden cap", () => {
    expect(decideQuota("pro", 0, 0, LIMITS, RESETS_AT).allowed).toBe(true);
    expect(decideQuota("pro", 99_999, 0, LIMITS, RESETS_AT).allowed).toBe(true);
  });

  it("blocks Pro at the hidden cap with a fair_use decision", () => {
    const decision = decideQuota("pro", 100_000, 0, LIMITS, RESETS_AT);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toBe("fair_use");
    expect(decision.resetsAt).toBe(RESETS_AT);
  });

  it("blocks Pro over the hidden cap", () => {
    expect(decideQuota("pro", 100_001, 0, LIMITS, RESETS_AT).allowed).toBe(false);
  });

  it("does not apply the Starter limit to Pro", () => {
    expect(decideQuota("pro", 5_000, 0, LIMITS, RESETS_AT).allowed).toBe(true);
  });
});
