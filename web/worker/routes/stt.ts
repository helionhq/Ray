/**
 * Speech-to-text proxies.
 *
 * Audio and transcripts pass through memory only. Nothing in this file logs a
 * request or response body, and only word counts are written to D1.
 *
 * `/v1/stt/sync-live` forwards the original streamed multipart body without
 * buffering it. `/v1/stt/batch` implements the v2 upload/create/poll fallback
 * server-side.
 */

import type { Context, Hono } from "hono";
import type { AppContext } from "../env";
import { requireDevice } from "../auth";
import { addWords } from "../db";
import { quotaGuard } from "../quota-guard";
import { base64UrlDecode } from "../lib/crypto";
import { countWords } from "../lib/words";
import { nowSeconds, weekBounds } from "../lib/weeks";
import {
  fetchWithTimeout,
  parseJsonObject,
  upstreamErrorMessage,
} from "../http";

const SYNC_LIVE_URL = "https://sync.assemblyai.com/v1/transcribe/live";
const SYNC_URL = "https://sync.assemblyai.com/v1/transcribe";
const V2_BASE = "https://api.assemblyai.com/v2";

const BATCH_POLL_INTERVAL_MS = 700;
const BATCH_TIMEOUT_MS = 45_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const CREATE_TIMEOUT_MS = 20_000;
const POLL_REQUEST_TIMEOUT_MS = 15_000;
const MAX_KEYTERMS = 1_000;
const DEFAULT_SPEECH_MODELS = ["universal-3-5-pro", "universal-2"];

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Counts `text` only when the upstream body is the expected transcript JSON. */
function wordsInTranscript(text: string): number {
  const parsed = parseJsonObject(text);
  const transcript = parsed?.["text"];
  return typeof transcript === "string" ? countWords(transcript) : 0;
}

async function recordUsage(
  c: Context<AppContext>,
  weekStart: number,
  words: number,
): Promise<void> {
  if (words <= 0) return;
  await addWords(c.env.DB, c.get("user").id, weekStart, words);
}

async function proxySync(
  c: Context<AppContext>,
  upstreamUrl: string,
): Promise<Response> {
  const weekStart = weekBounds(nowSeconds()).weekStart;

  const headers = new Headers();
  headers.set("authorization", c.env.ASSEMBLYAI_API_KEY);
  const contentType = c.req.header("content-type");
  if (contentType) headers.set("content-type", contentType);
  const model = c.req.header("x-aai-model");
  if (model) headers.set("X-AAI-Model", model);

  let upstream: Response;
  try {
    // Forward the incoming stream directly. Do not call text()/json() on the
    // request before this line: that would buffer the audio.
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: c.req.raw.body,
      redirect: "manual",
    });
  } catch {
    return c.json(
      {
        error: "upstream_unavailable",
        message: "Speech service is unavailable.",
      },
      502,
    );
  }

  const text = await upstream.text();
  await recordUsage(c, weekStart, wordsInTranscript(text));

  const responseHeaders = new Headers();
  const responseType = upstream.headers.get("content-type");
  if (responseType) responseHeaders.set("content-type", responseType);
  return new Response(text, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

interface KeytermsResult {
  ok: boolean;
  terms: string[];
}

function decodeKeyterms(header: string | undefined): KeytermsResult {
  if (!header) return { ok: true, terms: [] };
  const decoded = base64UrlDecode(header);
  if (!decoded) return { ok: false, terms: [] };
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decoded));
    if (
      !Array.isArray(parsed) ||
      !parsed.every((item): item is string => typeof item === "string")
    ) {
      return { ok: false, terms: [] };
    }
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const item of parsed) {
      const term = item.trim();
      if (term !== "" && !seen.has(term)) {
        seen.add(term);
        terms.push(term);
        if (terms.length >= MAX_KEYTERMS) break;
      }
    }
    return { ok: true, terms };
  } catch {
    return { ok: false, terms: [] };
  }
}

function parseSpeechModels(header: string | undefined): string[] {
  if (!header) return [...DEFAULT_SPEECH_MODELS];
  const models = header
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model !== "");
  return models.length > 0 ? models : [...DEFAULT_SPEECH_MODELS];
}

async function batchTranscribe(
  c: Context<AppContext>,
  audio: ArrayBuffer,
  keyterms: string[],
  speechModels: string[],
): Promise<Response> {
  const authorization = c.env.ASSEMBLYAI_API_KEY;

  let uploadResponse: Response;
  try {
    uploadResponse = await fetchWithTimeout(
      `${V2_BASE}/upload`,
      {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/octet-stream",
        },
        body: audio,
      },
      UPLOAD_TIMEOUT_MS,
    );
  } catch {
    return c.json(
      {
        error: "upstream_unavailable",
        message: "Speech service is unavailable.",
      },
      502,
    );
  }

  const uploadText = await uploadResponse.text();
  const uploadJson = uploadResponse.ok
    ? parseJsonObject(uploadText)
    : null;
  const uploadUrl = uploadJson?.["upload_url"];
  if (typeof uploadUrl !== "string" || uploadUrl === "") {
    return c.json(
      {
        error: "upstream_error",
        message: upstreamErrorMessage(
          uploadText,
          "Audio upload failed.",
        ),
      },
      502,
    );
  }

  const createPayload: Record<string, unknown> = {
    audio_url: uploadUrl,
    speech_models: speechModels,
    punctuate: true,
    format_text: true,
  };
  if (keyterms.length > 0) {
    createPayload["keyterms_prompt"] = keyterms;
  }

  let createResponse: Response;
  try {
    createResponse = await fetchWithTimeout(
      `${V2_BASE}/transcript`,
      {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify(createPayload),
      },
      CREATE_TIMEOUT_MS,
    );
  } catch {
    return c.json(
      {
        error: "upstream_unavailable",
        message: "Speech service is unavailable.",
      },
      502,
    );
  }

  const createText = await createResponse.text();
  const created = createResponse.ok ? parseJsonObject(createText) : null;
  const transcriptId = created?.["id"];
  if (typeof transcriptId !== "string" || transcriptId === "") {
    return c.json(
      {
        error: "upstream_error",
        message: upstreamErrorMessage(
          createText,
          "Could not create the transcript.",
        ),
      },
      502,
    );
  }

  const deadline = Date.now() + BATCH_TIMEOUT_MS;
  let status =
    typeof created?.["status"] === "string"
      ? (created["status"] as string)
      : "queued";
  let text =
    typeof created?.["text"] === "string"
      ? (created["text"] as string)
      : "";
  let error =
    typeof created?.["error"] === "string"
      ? (created["error"] as string)
      : "";

  while (true) {
    if (status === "completed") {
      await recordUsage(
        c,
        weekBounds(nowSeconds()).weekStart,
        countWords(text),
      );
      return c.json({ text });
    }
    if (status === "error") {
      return c.json(
        {
          error: "transcription_failed",
          message:
            error !== ""
              ? error
              : "AssemblyAI could not transcribe the audio.",
        },
        502,
      );
    }
    if (Date.now() >= deadline) {
      return c.json(
        {
          error: "transcription_timeout",
          message: "Transcription timed out.",
        },
        504,
      );
    }

    await sleep(BATCH_POLL_INTERVAL_MS);

    let pollResponse: Response;
    try {
      pollResponse = await fetchWithTimeout(
        `${V2_BASE}/transcript/${encodeURIComponent(transcriptId)}`,
        { headers: { authorization } },
        POLL_REQUEST_TIMEOUT_MS,
      );
    } catch {
      return c.json(
        {
          error: "upstream_unavailable",
          message: "Speech service is unavailable.",
        },
        502,
      );
    }

    const pollText = await pollResponse.text();
    const polled = pollResponse.ok ? parseJsonObject(pollText) : null;
    if (!polled) {
      return c.json(
        {
          error: "upstream_error",
          message: upstreamErrorMessage(
            pollText,
            "Could not read the transcript.",
          ),
        },
        502,
      );
    }
    status =
      typeof polled["status"] === "string"
        ? (polled["status"] as string)
        : status;
    text =
      typeof polled["text"] === "string"
        ? (polled["text"] as string)
        : text;
    error =
      typeof polled["error"] === "string"
        ? (polled["error"] as string)
        : error;
  }
}

export function registerSttRoutes(app: Hono<AppContext>): void {
  app.post(
    "/v1/stt/sync-live",
    requireDevice,
    quotaGuard,
    async (c) => proxySync(c, SYNC_LIVE_URL),
  );

  app.post(
    "/v1/stt/sync",
    requireDevice,
    quotaGuard,
    async (c) => proxySync(c, SYNC_URL),
  );

  app.post("/v1/stt/batch", requireDevice, quotaGuard, async (c) => {
    const keyterms = decodeKeyterms(c.req.header("x-ray-keyterms"));
    if (!keyterms.ok) {
      return c.json(
        {
          error: "invalid_keyterms",
          message: "X-Ray-Keyterms must be base64url-encoded JSON strings.",
        },
        400,
      );
    }
    const speechModels = parseSpeechModels(
      c.req.header("x-ray-speech-models"),
    );

    const audio = await c.req.arrayBuffer();
    if (audio.byteLength === 0) {
      return c.json(
        { error: "invalid_audio", message: "The audio body is empty." },
        400,
      );
    }
    return batchTranscribe(c, audio, keyterms.terms, speechModels);
  });
}
