import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  pkceChallenge,
  randomToken,
  sha256Hex,
  timingSafeEqualBytes,
  timingSafeEqualString,
} from "../worker/lib/crypto";
import {
  BASE64URL_32_BYTES_LENGTH,
  isBase64Url32,
  isDeviceToken,
  parseBearer,
} from "../worker/lib/validation";

describe("PKCE S256", () => {
  it("matches the RFC 7636 appendix B vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await pkceChallenge(verifier)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("produces a different challenge for a different verifier", async () => {
    expect(await pkceChallenge("a".repeat(43))).not.toBe(
      await pkceChallenge("b".repeat(43)),
    );
  });
});

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
  });

  it("rejects non-base64url characters", () => {
    expect(base64UrlDecode("abc+def")).toBeNull();
    expect(base64UrlDecode("abc/def")).toBeNull();
    expect(base64UrlDecode("abc=def")).toBeNull();
  });

  it("generates 32-byte tokens of the expected shape", () => {
    const token = randomToken();
    expect(token).toHaveLength(BASE64URL_32_BYTES_LENGTH);
    expect(isBase64Url32(token)).toBe(true);
    expect(isBase64Url32(randomToken(16))).toBe(false);
    expect(isBase64Url32("short")).toBe(false);
    expect(isBase64Url32(42)).toBe(false);
  });
});

describe("sha256", () => {
  it("hashes to the known SHA-256 of the empty string", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("constant-time comparisons", () => {
  it("compares byte arrays correctly", () => {
    expect(
      timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])),
    ).toBe(true);
    expect(
      timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])),
    ).toBe(false);
    expect(
      timingSafeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])),
    ).toBe(false);
  });

  it("compares strings correctly", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
    expect(timingSafeEqualString("abc", "abd")).toBe(false);
    expect(timingSafeEqualString("abc", "ab")).toBe(false);
    expect(timingSafeEqualString("", "")).toBe(true);
  });
});

describe("validation", () => {
  it("recognises device tokens", () => {
    expect(isDeviceToken(`ray_${randomToken()}`)).toBe(true);
    expect(isDeviceToken("ray_short")).toBe(false);
    expect(isDeviceToken(`dev_${randomToken()}`)).toBe(false);
    expect(isDeviceToken(undefined)).toBe(false);
  });

  it("parses bearer headers", () => {
    expect(parseBearer("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(parseBearer("bearer abc")).toBe("abc");
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("Bearer ")).toBeNull();
  });
});
