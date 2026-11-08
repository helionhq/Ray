/**
 * OpenAI-compatible cleanup proxy for the AssemblyAI LLM gateway.
 *
 * This endpoint is not a general LLM (review decisions 1 and 2):
 * - it requires an unexpired cleanup grant earned by a counted transcription;
 * - the transcript in the last user message cannot exceed the words that were
 *   actually counted (plus a small constant);
 * - only `model`, `messages`, `temperature`, `max_tokens` (clamped) and
 *   `stream: false` are forwarded, so `n`, `max_completion_tokens`, tools and
 *   anything else are dropped;
 * - at most one system + one user message, with byte budgets.
 *
 * Cleanup words are not counted because STT already counted them.
 */

import type { Context, Hono } from "hono";
import type { AppContext } from "../env";
import { requireDevice } from "../auth";
import { consumeCleanupGrant } from "../db";
import {
  buildCleanupForwardBody,
  CLEANUP_BODY_LIMIT_BYTES,
  CLEANUP_TRANSCRIPT_SLACK_WORDS,
  cleanupMaxTokens,
  cleanupModels,
  cleanupTemperature,
  transcriptWordsInMessages,
  validateCleanupMessages,
} from "../lib/cleanup";
import { nowSeconds } from "../lib/weeks";
import {
  fetchWithTimeout,
  mapUpstreamFailure,
  parseJsonObject,
  readBodyLimited,
  upstreamUnavailable,
} from "../http";

const CLEANUP_URL =
  "https://llm-gateway.assemblyai.com/v1/chat/completions";
const CLEANUP_TIMEOUT_MS = 30_000;

function noCleanupGrant(c: Context<AppContext>): Response {
  return c.json(
    {
      error: "no_cleanup_grant",
      message: "Cleanup is only available right after a dictation.",
    },
    403,
  );
}

export function registerCleanupRoutes(app: Hono<AppContext>): void {
  app.post(
    "/v1/cleanup/chat/completions",
    requireDevice,
    async (c) => {
      const body = await readBodyLimited(c, CLEANUP_BODY_LIMIT_BYTES);
      if (!body.ok) {
        return c.json(
          {
            error: "payload_too_large",
            message: "The cleanup request is too large.",
          },
          413,
        );
      }

      const payload = parseJsonObject(body.text);
      if (!payload) {
        return c.json(
          {
            error: "invalid_request",
            message: "Expected a JSON object.",
          },
          400,
        );
      }

      const model = payload["model"];
      if (
        typeof model !== "string" ||
        !cleanupModels(c.env.CLEANUP_MODELS).includes(model)
      ) {
        return c.json(
          {
            error: "model_not_allowed",
            message: "That model is not available.",
          },
          400,
        );
      }

      const messages = validateCleanupMessages(payload["messages"]);
      if (!messages.ok) {
        return c.json(
          { error: messages.error, message: messages.message },
          messages.error === "message_too_large" ? 413 : 400,
        );
      }

      // Consume the grant before checking the transcript so failed probes
      // still use one of the bounded calls.
      const grant = await consumeCleanupGrant(
        c.env.DB,
        c.get("user").id,
        nowSeconds(),
      );
      if (!grant) return noCleanupGrant(c);

      const transcriptWords = transcriptWordsInMessages(messages.messages);
      if (
        transcriptWords >
        grant.words + CLEANUP_TRANSCRIPT_SLACK_WORDS
      ) {
        return noCleanupGrant(c);
      }

      const forwardBody = buildCleanupForwardBody(
        model,
        messages.messages,
        cleanupTemperature(payload["temperature"]),
        cleanupMaxTokens(payload["max_tokens"]),
      );

      let upstream: Response;
      try {
        upstream = await fetchWithTimeout(
          CLEANUP_URL,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${c.env.ASSEMBLYAI_API_KEY}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(forwardBody),
          },
          CLEANUP_TIMEOUT_MS,
        );
      } catch {
        const failure = upstreamUnavailable();
        return c.json(
          { error: failure.error, message: failure.message },
          failure.status,
        );
      }

      // Decision 4: never pass upstream 401/403/429/5xx through unchanged.
      const failure = mapUpstreamFailure(upstream.status);
      if (failure) {
        return c.json(
          { error: failure.error, message: failure.message },
          failure.status,
        );
      }

      // Pass other upstream statuses and bodies through unchanged. No logging.
      const text = await upstream.text();
      const responseHeaders = new Headers();
      const responseType = upstream.headers.get("content-type");
      if (responseType) {
        responseHeaders.set("content-type", responseType);
      }
      return new Response(text, {
        status: upstream.status,
        headers: responseHeaders,
      });
    },
  );
}
