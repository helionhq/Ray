/**
 * Speech-to-text proxies.
 *
 * Audio and transcripts pass through memory only. Nothing in this file logs a
 * request or response body, and only word counts and audio seconds (metered
 * from bytes and, for sync, the duration AssemblyAI reports) are written to
 * D1.
 *
 * `/v1/stt/sync-live` forwards the original streamed multipart body without
 * buffering it. `/v1/stt/batch` implements the v2 upload/create/poll fallback
 * server-side. Every STT route streams upstream under a hard 12 MB body cap.
 */

import type { Context, Hono } from "hono";
import type { AppContext } from "../env";
import { requireDevice } from "../auth";
import { addSttFailure, addUsage, grantCleanup } from "../db";
import { quotaGuard } from "../quota-guard";
import { sttGuard } from "../stt-guard";
import { rateLimitUser } from "../lib/rate-limit";
import { base64UrlDecode } from "../lib/crypto";
import {
  CLEANUP_CALLS_PER_TRANSCRIPTION,
  CLEANUP_GRANT_TTL_SECONDS,
  CLEANUP_MAX_CALLS,
} from "../lib/cleanup";
import { countTranscriptWords } from "../lib/words";
import { nowSeconds, weekBounds } from "../lib/weeks";
import {
  createLimitedBody,
  fetchWithTimeout,
  mapUpstreamFailure,
  parseJsonObject,
  upstreamErrorMessage,
  upstreamUnavailable,
  type LimitedRequestBody,
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
/**
 * Decision 6: /v1/stt/batch accepts at most 12 MB of audio. Sync and sync-live
 * use the same cap: the desktop's 5-minute batch WAV is 9.6 MB and a 118 s
 * live segment is ~3.8 MB, so no real request comes close.
 */
export const BATCH_MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_SPEECH_MODELS = ["universal-3-5-pro", "universal-2"];
/** PCM16 mono 16 kHz is 32,000 bytes per second. */
const AUDIO_BYTES_PER_SECOND = 32_000;
/** WAV files carry a 44-byte header before the PCM samples. */
const WAV_HEADER_BYTES = 44;
/** The desktop stops recording at 5 minutes; allow a small margin. */
const WAV_MAX_DATA_BYTES = 32_000 * (5 * 60 + 5);

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function audioSecondsFromBytes(bytes: number): number {
  return Math.ceil(
    Math.max(0, bytes - WAV_HEADER_BYTES) / AUDIO_BYTES_PER_SECOND,
  );
}

/**
 * Validates the canonical WAV the desktop sends (`wav_from_pcm16`): RIFF/WAVE,
 * PCM format 1, mono, 16 kHz, 16 bit, and at most the desktop's 5-minute
 * recording. Returns the declared data length in bytes, or null. This keeps
 * the byte-derived meter exact: AssemblyAI bills decoded audio time, so a
 * compressed or lower-rate file could otherwise cost far more than it meters.
 */
function parsePcmWav(bytes: Uint8Array): number | null {
  if (bytes.byteLength < WAV_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteAt = (offset: number) => bytes[offset] ?? 0;
  const tag = (offset: number) =>
    String.fromCharCode(
      byteAt(offset),
      byteAt(offset + 1),
      byteAt(offset + 2),
      byteAt(offset + 3),
    );
  if (
    tag(0) !== "RIFF" ||
    tag(8) !== "WAVE" ||
    tag(12) !== "fmt " ||
    tag(36) !== "data"
  ) {
    return null;
  }
  const dataBytes = view.getUint32(40, true);
  if (
    view.getUint32(16, true) !== 16 || // fmt chunk size
    view.getUint16(20, true) !== 1 || // PCM
    view.getUint16(22, true) !== 1 || // mono
    view.getUint32(24, true) !== 16_000 ||
    view.getUint32(28, true) !== AUDIO_BYTES_PER_SECOND || // byte rate
    view.getUint16(32, true) !== 2 || // block align
    view.getUint16(34, true) !== 16 || // bits per sample
    dataBytes === 0 ||
    dataBytes % 2 !== 0 ||
    dataBytes > WAV_MAX_DATA_BYTES
  ) {
    return null;
  }
  return dataBytes;
}

/** AssemblyAI's sync responses report the decoded duration in milliseconds. */
function reportedAudioSeconds(
  payload: Record<string, unknown> | null,
): number {
  const milliseconds = payload?.["audio_duration_ms"];
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) {
    return 0;
  }
  return Math.ceil(Math.max(0, milliseconds) / 1000);
}

/**
 * Counts a transcript's words. An empty transcript (silence, noise) still
 * costs an upstream transcription but consumes no quota, so it counts against
 * the weekly failure budget instead.
 */
async function recordWords(
  c: Context<AppContext>,
  weekStart: number,
  words: number,
): Promise<void> {
  if (words <= 0) {
    try {
      await addSttFailure(c.env.DB, c.get("user").id, weekStart);
    } catch {
      // Failure accounting is best effort; never break the response.
    }
    return;
  }
  try {
    await addUsage(c.env.DB, c.get("user").id, weekStart, words);
  } catch {
    // An occasional quota undercount is acceptable; the transcript that was
    // already produced must still reach the user.
    console.error("failed to record stt word usage");
  }
  try {
    // Every counted transcription earns cleanup capacity (decision 1).
    await grantCleanup(
      c.env.DB,
      c.get("user").id,
      words,
      nowSeconds(),
      CLEANUP_CALLS_PER_TRANSCRIPTION,
      CLEANUP_MAX_CALLS,
      CLEANUP_GRANT_TTL_SECONDS,
    );
  } catch {
    // Cleanup will fail closed (403) if the grant cannot be stored; a
    // transcript that was already produced must still reach the user.
    console.error("failed to update cleanup grant");
  }
}

/**
 * Meters the audio that actually reached upstream, in seconds. AssemblyAI
 * bills audio time, so this is charged for every request, including ones that
 * return an empty transcript or fail upstream. For sync responses the
 * upstream-reported duration is authoritative when it is longer than the
 * byte-derived estimate (compressed or lower-rate input). Best effort:
 * metering must never mask the response.
 */
async function recordAudioUsage(
  c: Context<AppContext>,
  weekStart: number,
  bytes: number,
  reportedSeconds = 0,
): Promise<void> {
  const seconds = Math.max(audioSecondsFromBytes(bytes), reportedSeconds);
  if (seconds <= 0) return;
  try {
    await addUsage(c.env.DB, c.get("user").id, weekStart, 0, seconds);
  } catch {
    console.error("failed to record stt audio usage");
  }
}

function passthroughHeaders(upstream: Response): Headers {
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  return headers;
}

async function proxySync(
  c: Context<AppContext>,
  upstreamUrl: string,
): Promise<Response> {
  const weekStart = weekBounds(nowSeconds()).weekStart;

  if (declaredLengthTooLarge(c.req.header("content-length"), BATCH_MAX_BYTES)) {
    return payloadTooLarge(c);
  }
  const body = c.req.raw.body;
  if (!body) return invalidAudio(c);
  // The same streamed cap as /v1/stt/batch: a lying or missing Content-Length
  // cannot push an unbounded body (and an unbounded upstream bill) through.
  const limited = createLimitedBody(body, BATCH_MAX_BYTES);
  let reportedSeconds = 0;

  try {
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
        body: limited.stream,
        redirect: "manual",
      });
    } catch {
      if (limited.tooLarge()) return payloadTooLarge(c);
      const failure = upstreamUnavailable();
      return c.json(
        { error: failure.error, message: failure.message },
        failure.status,
      );
    }
    if (limited.tooLarge()) return payloadTooLarge(c);

    const text = await upstream.text();
    if (upstream.ok) {
      const payload = parseJsonObject(text);
      reportedSeconds = reportedAudioSeconds(payload);
      await recordWords(c, weekStart, countTranscriptWords(payload));
    }

    // Decision 4: upstream auth/rate-limit/5xx never look like Ray errors.
    const failure = mapUpstreamFailure(upstream.status);
    if (failure) {
      return c.json(
        { error: failure.error, message: failure.message },
        failure.status,
      );
    }

    return new Response(text, {
      status: upstream.status,
      headers: passthroughHeaders(upstream),
    });
  } finally {
    // Charge the audio that reached upstream even when the transcript was
    // empty or the request failed.
    await recordAudioUsage(c, weekStart, limited.bytesRead(), reportedSeconds);
  }
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

function payloadTooLarge(c: Context<AppContext>): Response {
  return c.json(
    {
      error: "payload_too_large",
      message: "The audio body is larger than 12 MB.",
    },
    413,
  );
}

/** Declared Content-Length check (the streamed cap still applies). */
function declaredLengthTooLarge(
  header: string | undefined,
  maxBytes: number,
): boolean {
  if (header === undefined) return false;
  const declared = Number(header);
  return Number.isFinite(declared) && declared > maxBytes;
}

function invalidAudio(c: Context<AppContext>): Response {
  return c.json(
    {
      error: "invalid_audio",
      message:
        "The audio body must be a 16 kHz mono PCM16 WAV of at most about 5 minutes.",
    },
    400,
  );
}

/**
 * Re-attaches the chunks already read for header validation to the rest of a
 * reader so the batch route can validate the WAV before calling upstream while
 * still streaming everything else under the cap.
 */
function prependChunks(
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const first = chunks.shift();
      if (first !== undefined) {
        controller.enqueue(first);
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {
        // Best effort; the consumer cancelled the upload.
      });
    },
  });
}

async function batchTranscribe(
  c: Context<AppContext>,
  weekStart: number,
  limited: LimitedRequestBody,
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
        // Streamed upload: the cap is enforced chunk by chunk, so no
        // unbounded arrayBuffer() is ever allocated.
        body: limited.stream,
      },
      UPLOAD_TIMEOUT_MS,
    );
  } catch {
    if (limited.tooLarge()) return payloadTooLarge(c);
    const failure = upstreamUnavailable();
    return c.json(
      { error: failure.error, message: failure.message },
      failure.status,
    );
  }
  if (limited.tooLarge()) return payloadTooLarge(c);

  const uploadText = await uploadResponse.text();
  if (!uploadResponse.ok) {
    const failure = mapUpstreamFailure(uploadResponse.status);
    if (failure) {
      return c.json(
        { error: failure.error, message: failure.message },
        failure.status,
      );
    }
    return c.json(
      {
        error: "upstream_error",
        message: upstreamErrorMessage(uploadText, "Audio upload failed."),
      },
      502,
    );
  }

  const uploadJson = parseJsonObject(uploadText);
  const uploadUrl = uploadJson?.["upload_url"];
  if (typeof uploadUrl !== "string" || uploadUrl === "") {
    return c.json(
      {
        error: "upstream_error",
        message: "Audio upload failed.",
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
    const failure = upstreamUnavailable();
    return c.json(
      { error: failure.error, message: failure.message },
      failure.status,
    );
  }

  const createText = await createResponse.text();
  if (!createResponse.ok) {
    const failure = mapUpstreamFailure(createResponse.status);
    if (failure) {
      return c.json(
        { error: failure.error, message: failure.message },
        failure.status,
      );
    }
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

  const created = parseJsonObject(createText);
  const transcriptId = created?.["id"];
  if (typeof transcriptId !== "string" || transcriptId === "") {
    return c.json(
      {
        error: "upstream_error",
        message: "Could not create the transcript.",
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
  let finalPayload: Record<string, unknown> | null = created;

  while (true) {
    if (status === "completed") {
      await recordWords(
        c,
        weekStart,
        countTranscriptWords(finalPayload),
      );
      return c.json({ text });
    }
    if (status === "error") {
      // Decision 4: an upstream processing failure is an upstream error, not
      // a Ray-specific code.
      return c.json(
        {
          error: "upstream_error",
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
          error: "upstream_error",
          message: "Transcription timed out.",
        },
        502,
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
      const failure = upstreamUnavailable();
      return c.json(
        { error: failure.error, message: failure.message },
        failure.status,
      );
    }

    const pollText = await pollResponse.text();
    if (!pollResponse.ok) {
      const failure = mapUpstreamFailure(pollResponse.status);
      if (failure) {
        return c.json(
          { error: failure.error, message: failure.message },
          failure.status,
        );
      }
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

    const polled = parseJsonObject(pollText);
    if (!polled) {
      return c.json(
        {
          error: "upstream_error",
          message: "Could not read the transcript.",
        },
        502,
      );
    }
    finalPayload = polled;
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
    rateLimitUser("RATE_LIMIT_STT"),
    quotaGuard,
    sttGuard,
    async (c) => proxySync(c, SYNC_LIVE_URL),
  );

  app.post(
    "/v1/stt/sync",
    requireDevice,
    rateLimitUser("RATE_LIMIT_STT"),
    quotaGuard,
    sttGuard,
    async (c) => proxySync(c, SYNC_URL),
  );

  app.post(
    "/v1/stt/batch",
    requireDevice,
    rateLimitUser("RATE_LIMIT_STT"),
    quotaGuard,
    sttGuard,
    async (c) => {
      const contentLength = c.req.header("content-length");
      if (declaredLengthTooLarge(contentLength, BATCH_MAX_BYTES)) {
        return payloadTooLarge(c);
      }
      if (contentLength !== undefined && Number(contentLength) === 0) {
        return invalidAudio(c);
      }

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

      const body = c.req.raw.body;
      if (!body) return invalidAudio(c);

      // Peek the WAV header so non-PCM/compressed or over-long audio is
      // rejected before any upstream work; the rest is still streamed under
      // the cap.
      const reader = body.getReader();
      const head: Uint8Array[] = [];
      let headBytes = 0;
      while (headBytes < WAV_HEADER_BYTES) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value.byteLength === 0) continue;
        head.push(next.value);
        headBytes += next.value.byteLength;
      }
      const header = new Uint8Array(headBytes);
      let offset = 0;
      for (const chunk of head) {
        header.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (parsePcmWav(header) === null) {
        try {
          await reader.cancel();
        } catch {
          // The body is already gone; nothing else to clean up.
        }
        reader.releaseLock();
        return invalidAudio(c);
      }

      const limited = createLimitedBody(
        prependChunks(head, reader),
        BATCH_MAX_BYTES,
      );
      const weekStart = weekBounds(nowSeconds()).weekStart;
      try {
        return await batchTranscribe(
          c,
          weekStart,
          limited,
          keyterms.terms,
          speechModels,
        );
      } finally {
        // Charge the audio that reached upstream even when transcription
        // failed or produced no text.
        await recordAudioUsage(c, weekStart, limited.bytesRead());
      }
    },
  );
}
