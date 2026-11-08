import { describe, expect, it } from "vitest";
import {
  CREEM_SIGNATURE_HEADER,
  creemApiBase,
  verifyCreemSignature,
} from "../worker/lib/creem";

const encoder = new TextEncoder();

/** Independent HMAC implementation used only to build test vectors. */
async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(body)),
  );
  return [...signature]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("verifyCreemSignature", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({
    id: "evt_123",
    eventType: "subscription.paid",
  });

  it("uses the creem-signature header name from the docs", () => {
    expect(CREEM_SIGNATURE_HEADER).toBe("creem-signature");
  });

  it("accepts a valid signature", async () => {
    const signature = await hmacHex(secret, body);
    expect(await verifyCreemSignature(body, signature, secret)).toBe(true);
  });

  it("rejects a signature over a different body", async () => {
    const signature = await hmacHex(secret, body);
    expect(
      await verifyCreemSignature(`${body} `, signature, secret),
    ).toBe(false);
  });

  it("rejects a signature made with a different secret", async () => {
    const signature = await hmacHex("whsec_other", body);
    expect(await verifyCreemSignature(body, signature, secret)).toBe(false);
  });

  it("rejects missing, malformed and empty-secret signatures", async () => {
    const signature = await hmacHex(secret, body);
    expect(await verifyCreemSignature(body, null, secret)).toBe(false);
    expect(await verifyCreemSignature(body, "", secret)).toBe(false);
    expect(await verifyCreemSignature(body, "not-hex", secret)).toBe(false);
    expect(await verifyCreemSignature(body, signature.slice(2), secret)).toBe(
      false,
    );
    expect(await verifyCreemSignature(body, signature, "")).toBe(false);
  });

  it("normalises an uppercase hex signature", async () => {
    const signature = await hmacHex(secret, body);
    expect(
      await verifyCreemSignature(body, signature.toUpperCase(), secret),
    ).toBe(true);
  });
});

describe("creemApiBase", () => {
  it("appends /v1 when missing and preserves it when present", () => {
    expect(creemApiBase("https://api.creem.io")).toBe(
      "https://api.creem.io/v1",
    );
    expect(creemApiBase("https://api.creem.io/")).toBe(
      "https://api.creem.io/v1",
    );
    expect(creemApiBase("https://test-api.creem.io/v1")).toBe(
      "https://test-api.creem.io/v1",
    );
  });

  it("falls back to the production base", () => {
    expect(creemApiBase("")).toBe("https://api.creem.io/v1");
    expect(creemApiBase(undefined)).toBe("https://api.creem.io/v1");
  });
});
