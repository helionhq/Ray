import { describe, expect, it } from "vitest";
import {
  DEFAULT_FAIR_USE_WEEKLY_AUDIO_SECONDS,
  DEFAULT_STARTER_WEEKLY_AUDIO_SECONDS,
  DEFAULT_STARTER_WEEKLY_WORDS,
  DEFAULT_TRIAL_WEEKLY_AUDIO_SECONDS,
  decideQuota,
  parseLimit,
  quotaLimits,
} from "../worker/lib/quota";

const LIMITS = {
  starterWeeklyWords: 1_000,
  starterWeeklyAudioSeconds: 3_600,
  fairUseWeeklyAudioSeconds: 25_200,
  trialWeeklyAudioSeconds: 10_800,
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
    const limits = quotaLimits({ STARTER_WEEKLY_WORDS: "" });
    expect(limits.starterWeeklyWords).toBe(DEFAULT_STARTER_WEEKLY_WORDS);
    expect(limits.starterWeeklyAudioSeconds).toBe(
      DEFAULT_STARTER_WEEKLY_AUDIO_SECONDS,
    );
    expect(limits.fairUseWeeklyAudioSeconds).toBe(
      DEFAULT_FAIR_USE_WEEKLY_AUDIO_SECONDS,
    );
    expect(limits.trialWeeklyAudioSeconds).toBe(
      DEFAULT_TRIAL_WEEKLY_AUDIO_SECONDS,
    );
    // The shipped values are 60 minutes / 7 hours / 3 hours.
    expect(limits.starterWeeklyAudioSeconds).toBe(3_600);
    expect(limits.fairUseWeeklyAudioSeconds).toBe(25_200);
    expect(limits.trialWeeklyAudioSeconds).toBe(10_800);
  });

  it("parses the audio overrides", () => {
    const limits = quotaLimits({
      STARTER_WEEKLY_WORDS: "1000",
      STARTER_WEEKLY_AUDIO_SECONDS: "120",
      FAIR_USE_WEEKLY_AUDIO_SECONDS: "600",
      TRIAL_WEEKLY_AUDIO_SECONDS: "300",
    });
    expect(limits.starterWeeklyAudioSeconds).toBe(120);
    expect(limits.fairUseWeeklyAudioSeconds).toBe(600);
    expect(limits.trialWeeklyAudioSeconds).toBe(300);
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

  it("blocks at the weekly audio cap even far below the word cap", () => {
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
});

describe("decideQuota — Pro (time-based fair use)", () => {
  it("has no weekly word cap", () => {
    expect(decideQuota("pro", 0, 0, LIMITS, RESETS_AT).allowed).toBe(true);
    expect(decideQuota("pro", 99_999, 0, LIMITS, RESETS_AT).allowed).toBe(true);
    expect(
      decideQuota("pro", 100_000, 0, LIMITS, RESETS_AT).allowed,
    ).toBe(true);
    expect(
      decideQuota("pro", 10_000_000, 0, LIMITS, RESETS_AT).allowed,
    ).toBe(true);
  });

  it("allows Pro just below the hidden audio fair-use cap", () => {
    expect(decideQuota("pro", 5_000, 25_199, LIMITS, RESETS_AT).allowed).toBe(
      true,
    );
  });

  it("blocks Pro at the hidden audio cap with a fair_use decision", () => {
    const decision = decideQuota("pro", 1, 25_200, LIMITS, RESETS_AT);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toBe("fair_use");
    expect(decision.resetsAt).toBe(RESETS_AT);
  });

  it("does not apply the Starter limit to Pro", () => {
    expect(decideQuota("pro", 5_000, 0, LIMITS, RESETS_AT).allowed).toBe(true);
    expect(decideQuota("pro", 5_000, 3_600, LIMITS, RESETS_AT).allowed).toBe(
      true,
    );
  });
});

describe("decideQuota — trial (time-based fair use)", () => {
  it("has no weekly word cap", () => {
    expect(decideQuota("trial", 50_000, 0, LIMITS, RESETS_AT).allowed).toBe(
      true,
    );
  });

  it("uses the smaller trial audio budget, not the Pro one", () => {
    expect(
      decideQuota("trial", 1, 10_799, LIMITS, RESETS_AT).allowed,
    ).toBe(true);
    const decision = decideQuota("trial", 1, 10_800, LIMITS, RESETS_AT);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toBe("fair_use");
    expect(decision.resetsAt).toBe(RESETS_AT);
  });
});
