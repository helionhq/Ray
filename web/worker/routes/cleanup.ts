/**
 * OpenAI-compatible cleanup proxy for the AssemblyAI LLM gateway.
 *
 * Abuse guards: model allowlist, max_tokens <= 4000, body <= 64 KiB,
 * stream forced false, and the normal quota gate. Cleanup words are not
 * counted because the transcript was already counted by the STT call.
 */

import type { Hono } from "hono";
import type { AppContext } from "../env";
import { requireDevice } from "../auth";
import { quotaGuard } from "../quota-guard";
import {
  fetchWithTimeout,
  parseJsonObject,
  readBodyLimited,
} from "../http";

const CLEANUP_URL =
  "https://llm-gateway.assemblyai.com/v1/chat/completions";
const CLEANUP_BODY_LIMIT_BYTES = 64 * 1024;
const CLEANUP_MAX_TOKENS = 4_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_MODELS = ["gemma-4-31b"];

function cleanupModels(raw: string | undefined): string[] {
  const models = (raw ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model !== "");
  return models.length > 0 ? models : [...DEFAULT_CLEANUP_MODELS];
}

export function registerCleanupRoutes(app: Hono<AppContext>): void {
  app.post(
    "/v1/cleanup/chat/completions",
    requireDevice,
    quotaGuard,
    async (c) => {
      const body = await readBodyLimited(
        c,
        CLEANUP_BODY_LIMIT_BYTES,
      );
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

      const maxTokens = payload["max_tokens"];
      if (typeof maxTokens === "number" && Number.isFinite(maxTokens)) {
        payload["max_tokens"] = Math.min(
          CLEANUP_MAX_TOKENS,
          Math.max(1, Math.floor(maxTokens)),
        );
      } else if ("max_tokens" in payload) {
        delete payload["max_tokens"];
      }

      // Streaming is not supported by this proxy.
      payload["stream"] = false;

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
            body: JSON.stringify(payload),
          },
          CLEANUP_TIMEOUT_MS,
        );
      } catch {
        return c.json(
          {
            error: "upstream_unavailable",
            message: "Cleanup service is unavailable.",
          },
          502,
        );
      }

      // Pass the upstream status and body through unchanged. No logging.
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
