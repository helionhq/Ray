/** Input validation shared by the unauthenticated and auth endpoints. */

/** 32 random bytes encoded as unpadded base64url. */
export const BASE64URL_32_BYTES_LENGTH = 43;

export function isBase64Url32(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === BASE64URL_32_BYTES_LENGTH &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

/** `ray_` + 32 random bytes base64url. */
export const DEVICE_TOKEN_PATTERN = /^ray_[A-Za-z0-9_-]{43}$/u;

export function isDeviceToken(value: unknown): value is string {
  return typeof value === "string" && DEVICE_TOKEN_PATTERN.test(value);
}

/** Extracts a bearer token from an Authorization header. */
export function parseBearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/iu.exec(header);
  return match?.[1] ?? null;
}
