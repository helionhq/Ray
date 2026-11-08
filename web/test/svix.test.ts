import { describe, expect, it } from "vitest";
import {
  base64Decode,
  base64Encode,
  hmacSha256Bytes,
} from "../worker/lib/crypto";
import {
  SVIX_TOLERANCE_SECONDS,
  svixHeadersFrom,
  verifySvixSignature,
} from "../worker/lib/svix";

const SECRET = "whsec_plJ3nmyCDGBKInavdOK15jsl";

/** The official Svix manual-verification test vector. */
const VECTOR = {
  id: "msg_loFOjxBNrRLzqYUf",
  timestamp: "1731705121",
  body: '{"event_type":"ping","data":{"success":true}}',
  signature: "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=",
};

describe("verifySvixSignature", () => {
  it("matches the official Svix test vector", async () => {
    expect(
      await verifySvixSignature(
        VECTOR.body,
        {
          id: VECTOR.id,
          timestamp: VECTOR.timestamp,
          signature: VECTOR.signature,
        },
        SECRET,
        Number(VECTOR.timestamp),
      ),
    ).toBe(true);
  });

  it("accepts any matching v1 entry in a multi-signature header", async () => {
    expect(
      await verifySvixSignature(
        VECTOR.body,
        {
          id: VECTOR.id,
          timestamp: VECTOR.timestamp,
          signature: `v2,AAAA ${VECTOR.signature} v3,BBBB`,
        },
        SECRET,
        Number(VECTOR.timestamp),
      ),
    ).toBe(true);
  });

  it("accepts the white-labelled webhook-* headers", () => {
    const headers = new Headers({
      "webhook-id": VECTOR.id,
      "webhook-timestamp": VECTOR.timestamp,
      "webhook-signature": VECTOR.signature,
    });
    expect(svixHeadersFrom(headers)).toEqual({
      id: VECTOR.id,
      timestamp: VECTOR.timestamp,
      signature: VECTOR.signature,
    });
  });

  it("rejects an invalid signature, body or secret", async () => {
    const headers = {
      id: VECTOR.id,
      timestamp: VECTOR.timestamp,
      signature: VECTOR.signature,
    };
    expect(
      await verifySvixSignature(
        `${VECTOR.body} `,
        headers,
        SECRET,
        Number(VECTOR.timestamp),
      ),
    ).toBe(false);
    expect(
      await verifySvixSignature(
        VECTOR.body,
        { ...headers, signature: VECTOR.signature.replace("r", "R") },
        SECRET,
        Number(VECTOR.timestamp),
      ),
    ).toBe(false);
    expect(
      await verifySvixSignature(
        VECTOR.body,
        headers,
        `${SECRET}x`,
        Number(VECTOR.timestamp),
      ),
    ).toBe(false);
  });

  it("rejects missing headers and blank secrets", async () => {
    const headers = {
      id: VECTOR.id,
      timestamp: VECTOR.timestamp,
      signature: VECTOR.signature,
    };
    expect(
      await verifySvixSignature(VECTOR.body, { ...headers, id: null }, SECRET),
    ).toBe(false);
    expect(
      await verifySvixSignature(
        VECTOR.body,
        { ...headers, timestamp: null },
        SECRET,
      ),
    ).toBe(false);
    expect(
      await verifySvixSignature(
        VECTOR.body,
        { ...headers, signature: null },
        SECRET,
      ),
    ).toBe(false);
    expect(
      await verifySvixSignature(
        VECTOR.body,
        headers,
        "",
        Number(VECTOR.timestamp),
      ),
    ).toBe(false);
    expect(
      await verifySvixSignature(
        VECTOR.body,
        headers,
        undefined,
        Number(VECTOR.timestamp),
      ),
    ).toBe(false);
  });

  it("rejects timestamps outside the tolerance window", async () => {
    const timestamp = Number(VECTOR.timestamp);
    expect(
      await verifySvixSignature(
        VECTOR.body,
        {
          id: VECTOR.id,
          timestamp: VECTOR.timestamp,
          signature: VECTOR.signature,
        },
        SECRET,
        timestamp + SVIX_TOLERANCE_SECONDS + 1,
      ),
    ).toBe(false);
    expect(
      await verifySvixSignature(
        VECTOR.body,
        { id: VECTOR.id, timestamp: "not-a-number", signature: VECTOR.signature },
        SECRET,
        timestamp,
      ),
    ).toBe(false);
  });

  it("builds a signature with the whsec_ secret as base64 HMAC key", async () => {
    const key = base64Decode(SECRET.slice("whsec_".length));
    expect(key).not.toBeNull();
    const id = "msg_test";
    const timestamp = "1760000000";
    const body = '{"type":"user.deleted"}';
    const expected = base64Encode(
      await hmacSha256Bytes(key!, `${id}.${timestamp}.${body}`),
    );
    expect(
      await verifySvixSignature(
        body,
        { id, timestamp, signature: `v1,${expected}` },
        SECRET,
        Number(timestamp),
      ),
    ).toBe(true);
  });
});
