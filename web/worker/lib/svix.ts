/**
 * Svix webhook signature verification (Clerk sends its webhooks through
 * Svix).
 *
 * Algorithm (verified against https://docs.svix.com/receiving/verifying-payloads/how-manual):
 *   signed content = `${svix-id}.${svix-timestamp}.${rawBody}`
 *   key            = base64-decode(secret without the `whsec_` prefix)
 *   expected       = base64(HMAC-SHA256(key, signed content))
 * The signature header is a space-separated list of `v1,<base64>` entries;
 * any matching entry verifies the payload. Timestamps outside the tolerance
 * are rejected (replay protection).
 */

import {
  base64Decode,
  base64Encode,
  hmacSha256Bytes,
  timingSafeEqualString,
} from "./crypto";

export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export function svixHeadersFrom(
  headers: Headers,
): SvixHeaders {
  return {
    id: headers.get("svix-id") ?? headers.get("webhook-id"),
    timestamp:
      headers.get("svix-timestamp") ?? headers.get("webhook-timestamp"),
    signature:
      headers.get("svix-signature") ?? headers.get("webhook-signature"),
  };
}

export async function verifySvixSignature(
  rawBody: string,
  headers: SvixHeaders,
  secret: string | null | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !secret) return false;
  if (secret.trim() === "") return false;

  const timestampSeconds = Number(timestamp);
  if (
    !Number.isInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > SVIX_TOLERANCE_SECONDS
  ) {
    return false;
  }

  const encodedKey = secret.startsWith("whsec_")
    ? secret.slice("whsec_".length)
    : secret;
  const key = base64Decode(encodedKey);
  if (!key) return false;

  const expected = base64Encode(
    await hmacSha256Bytes(key, `${id}.${timestamp}.${rawBody}`),
  );

  for (const entry of signature.split(" ")) {
    const separator = entry.indexOf(",");
    if (separator <= 0) continue;
    const version = entry.slice(0, separator);
    const candidate = entry.slice(separator + 1);
    if (version !== "v1" || candidate === "") continue;
    if (timingSafeEqualString(candidate, expected)) return true;
  }
  return false;
}
