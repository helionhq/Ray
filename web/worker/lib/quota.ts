/** Quota decisions. Pure so every boundary can be unit tested. */

import type { PlanName } from "./plan";

export const DEFAULT_STARTER_WEEKLY_WORDS = 1_000;
/**
 * Audio budgets bound the real AssemblyAI cost: 1,000 words is roughly
 * 8-10 minutes of speech, so the Starter cap only catches silent or
 * near-empty audio abuse. Pro is unmetered by words and has one hidden
 * audio-time fair-use cap; the trial has a smaller hidden audio budget.
 */
export const DEFAULT_STARTER_WEEKLY_AUDIO_SECONDS = 60 * 60;
export const DEFAULT_FAIR_USE_WEEKLY_AUDIO_SECONDS = 7 * 60 * 60;
export const DEFAULT_TRIAL_WEEKLY_AUDIO_SECONDS = 3 * 60 * 60;

/**
 * Starter keeps its visible word limit. Pro and trial are time-based: their
 * only hidden cap is audio seconds.
 */
export type QuotaTier = "starter" | "pro" | "trial";

export interface QuotaLimits {
  starterWeeklyWords: number;
  starterWeeklyAudioSeconds: number;
  fairUseWeeklyAudioSeconds: number;
  trialWeeklyAudioSeconds: number;
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
  STARTER_WEEKLY_AUDIO_SECONDS?: string;
  FAIR_USE_WEEKLY_AUDIO_SECONDS?: string;
  TRIAL_WEEKLY_AUDIO_SECONDS?: string;
}): QuotaLimits {
  return {
    starterWeeklyWords: parseLimit(
      env.STARTER_WEEKLY_WORDS,
      DEFAULT_STARTER_WEEKLY_WORDS,
    ),
    starterWeeklyAudioSeconds: parseLimit(
      env.STARTER_WEEKLY_AUDIO_SECONDS,
      DEFAULT_STARTER_WEEKLY_AUDIO_SECONDS,
    ),
    fairUseWeeklyAudioSeconds: parseLimit(
      env.FAIR_USE_WEEKLY_AUDIO_SECONDS,
      DEFAULT_FAIR_USE_WEEKLY_AUDIO_SECONDS,
    ),
    trialWeeklyAudioSeconds: parseLimit(
      env.TRIAL_WEEKLY_AUDIO_SECONDS,
      DEFAULT_TRIAL_WEEKLY_AUDIO_SECONDS,
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
 * Starter's words and audio seconds are independent budgets; either blocks.
 * Pro and trial have no word cap at all, only the hidden audio-time cap.
 */
export function decideQuota(
  tier: QuotaTier,
  wordsUsed: number,
  audioSecondsUsed: number,
  limits: QuotaLimits,
  resetsAt: number,
): QuotaDecision {
  if (tier === "pro" || tier === "trial") {
    const audioLimit =
      tier === "pro"
        ? limits.fairUseWeeklyAudioSeconds
        : limits.trialWeeklyAudioSeconds;
    if (audioSecondsUsed >= audioLimit) {
      return {
        allowed: false,
        plan: "pro",
        reason: "fair_use",
        resetsAt,
      };
    }
    return { allowed: true, plan: "pro" };
  }

  if (
    wordsUsed >= limits.starterWeeklyWords ||
    audioSecondsUsed >= limits.starterWeeklyAudioSeconds
  ) {
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
