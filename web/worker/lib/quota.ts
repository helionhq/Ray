/** Quota decisions. Pure so every boundary can be unit tested. */

import type { PlanName } from "./plan";

export const DEFAULT_STARTER_WEEKLY_WORDS = 1_000;
export const DEFAULT_FAIR_USE_WEEKLY_WORDS = 100_000;

export interface QuotaLimits {
  starterWeeklyWords: number;
  fairUseWeeklyWords: number;
}

export function parseLimit(
  raw: string | undefined | null,
  fallback: number,
): number {
  if (raw === undefined || raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

export function quotaLimits(env: {
  STARTER_WEEKLY_WORDS: string;
  FAIR_USE_WEEKLY_WORDS: string;
}): QuotaLimits {
  return {
    starterWeeklyWords: parseLimit(
      env.STARTER_WEEKLY_WORDS,
      DEFAULT_STARTER_WEEKLY_WORDS,
    ),
    fairUseWeeklyWords: parseLimit(
      env.FAIR_USE_WEEKLY_WORDS,
      DEFAULT_FAIR_USE_WEEKLY_WORDS,
    ),
  };
}

export type QuotaDecision =
  | { allowed: true; plan: PlanName }
  | {
      allowed: false;
      plan: "starter";
      reason: "starter_limit";
      wordsUsed: number;
      wordsLimit: number;
      resetsAt: number;
    }
  | {
      allowed: false;
      plan: "pro";
      reason: "fair_use";
      resetsAt: number;
    };

/**
 * Called before the upstream request. At or over the limit blocks; the
 * dictation that crosses the line is already in flight and still counted.
 */
export function decideQuota(
  plan: PlanName,
  wordsUsed: number,
  limits: QuotaLimits,
  resetsAt: number,
): QuotaDecision {
  if (plan === "pro") {
    if (wordsUsed >= limits.fairUseWeeklyWords) {
      return {
        allowed: false,
        plan: "pro",
        reason: "fair_use",
        resetsAt,
      };
    }
    return { allowed: true, plan: "pro" };
  }

  if (wordsUsed >= limits.starterWeeklyWords) {
    return {
      allowed: false,
      plan: "starter",
      reason: "starter_limit",
      wordsUsed,
      wordsLimit: limits.starterWeeklyWords,
      resetsAt,
    };
  }
  return { allowed: true, plan: "starter" };
}
