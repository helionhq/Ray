import { describe, expect, it } from "vitest";
import {
  createLimitedBody,
  mapUpstreamFailure,
} from "../worker/http";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function drain(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe("mapUpstreamFailure (decision 4)", () => {
  it("maps upstream 429 to 503 upstream_busy", () => {
    expect(mapUpstreamFailure(429)).toEqual({
      status: 503,
      error: "upstream_busy",
      message: expect.any(String),
    });
  });

  it("maps upstream 401/402/403 and 5xx to 502 upstream_error", () => {
    for (const status of [401, 402, 403, 500, 502, 503, 504]) {
      expect(mapUpstreamFailure(status)).toMatchObject({
        status: 502,
        error: "upstream_error",
      });
    }
  });

  it("passes other statuses through", () => {
    for (const status of [200, 201, 400, 404, 422]) {
      expect(mapUpstreamFailure(status)).toBeNull();
    }
  });
});

describe("createLimitedBody (decision 6)", () => {
  it("streams bodies under the cap unchanged", async () => {
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5]);
    const limited = createLimitedBody(streamOf([first, second]), 10);
    expect(await drain(limited.stream)).toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
    expect(limited.tooLarge()).toBe(false);
    expect(limited.bytesRead()).toBe(5);
  });

  it("accepts a body exactly at the cap", async () => {
    const limited = createLimitedBody(
      streamOf([new Uint8Array(8), new Uint8Array(4)]),
      12,
    );
    expect((await drain(limited.stream)).byteLength).toBe(12);
    expect(limited.tooLarge()).toBe(false);
  });

  it("errors and flags a streamed body that overflows the cap", async () => {
    const limited = createLimitedBody(
      streamOf([new Uint8Array(8), new Uint8Array(8)]),
      12,
    );
    await expect(drain(limited.stream)).rejects.toThrow();
    expect(limited.tooLarge()).toBe(true);
  });

  it("does not buffer the whole body before enforcing the cap", async () => {
    let produced = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        controller.enqueue(new Uint8Array(4));
      },
    });
    const limited = createLimitedBody(source, 12);
    await expect(drain(limited.stream)).rejects.toThrow();
    expect(limited.tooLarge()).toBe(true);
    // The consumer fails on the first chunk past the cap, not after an
    // unbounded amount of input.
    expect(produced).toBeLessThanOrEqual(5);
  });
});
