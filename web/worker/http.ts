/** Small HTTP utilities: security headers, CORS, bounded body reads. */

import type { Context, MiddlewareHandler } from "hono";
import type { AppContext } from "./env";

export function applySecurityHeaders(
  headers: Headers,
  siteUrl: string,
): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  if (siteUrl.startsWith("https://")) {
    headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
}

export const securityHeaders: MiddlewareHandler<AppContext> = async (
  c,
  next,
) => {
  await next();
  applySecurityHeaders(c.res.headers, c.env.SITE_URL);
};

/**
 * The site is same-origin in production, so only SITE_URL is allowed. When
 * SITE_URL is itself a localhost origin, any localhost/127.0.0.1 origin on
 * the same protocol is allowed for the Vite dev server.
 */
export function isAllowedOrigin(
  origin: string,
  siteUrl: string,
): boolean {
  let candidate: URL;
  let site: URL;
  try {
    candidate = new URL(origin);
    site = new URL(siteUrl);
  } catch {
    return false;
  }
  if (candidate.origin === site.origin) return true;
  const isLocal = (hostname: string) =>
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]";
  return (
    isLocal(site.hostname) &&
    isLocal(candidate.hostname) &&
    candidate.protocol === site.protocol
  );
}

export const corsHeaders: MiddlewareHandler<AppContext> = async (
  c,
  next,
) => {
  const origin = c.req.header("origin");
  if (origin && isAllowedOrigin(origin, c.env.SITE_URL)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    c.header(
      "Access-Control-Allow-Headers",
      "authorization, content-type, x-aai-model, x-ray-keyterms, x-ray-speech-models",
    );
    c.header("Access-Control-Max-Age", "86400");
  }
  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }
  await next();
};

export type BodyReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" };

/** Parses JSON that must be an object (not an array or scalar). */
export function parseJsonObject(
  text: string,
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Reads a request body with an upper bound. Bodies on these endpoints are
 * small JSON documents; audio and transcript traffic never goes through this
 * helper, so nothing here is stored. The cap is enforced on the stream as
 * well as `Content-Length` so a lying or absent header cannot force the
 * isolate to buffer an unbounded body.
 */
export async function readBodyLimited(
  c: Context<AppContext>,
  maxBytes: number,
): Promise<BodyReadResult> {
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: "too_large" };
  }

  const body = c.req.raw.body;
  if (!body) return { ok: true, text: "" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The body is already gone; nothing else to clean up.
        }
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

/** Extracts a short human-readable message from an upstream error body. */
export function upstreamErrorMessage(
  text: string,
  fallback: string,
): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const direct = record["message"];
      if (typeof direct === "string" && direct !== "") return direct;
      const errorValue = record["error"];
      if (typeof errorValue === "string" && errorValue !== "") {
        return errorValue;
      }
      if (typeof errorValue === "object" && errorValue !== null) {
        const nested = (errorValue as Record<string, unknown>)["message"];
        if (typeof nested === "string" && nested !== "") return nested;
      }
    }
  } catch {
    // Not JSON; fall through to a bounded text excerpt.
  }
  const trimmed = text.trim();
  return trimmed === "" ? fallback : trimmed.slice(0, 300);
}

export async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
