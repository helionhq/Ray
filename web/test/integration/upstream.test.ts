import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import app from "../../worker/index";
import type { Env } from "../../worker/env";
import { randomToken, sha256Hex } from "../../worker/lib/crypto";
import {
  getSttFailures,
  getUsage,
  getUsageWords,
} from "../../worker/db";
import { BATCH_MAX_BYTES } from "../../worker/routes/stt";
import {
  nowSeconds,
  weekBounds,
} from "../../worker/lib/weeks";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function seedUser(id: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, creem_customer_id, created_at)
     VALUES (?, ?, NULL, NULL, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(id, `${id}@example.com`, nowSeconds())
    .run();
}

async function seedDevice(userId: string): Promise<string> {
  const token = `ray_${randomToken()}`;
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(
    `INSERT INTO devices (id, user_id, token_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  )
    .bind(`dev_${crypto.randomUUID()}`, userId, tokenHash, nowSeconds())
    .run();
  return token;
}

async function seedGrant(
  userId: string,
  words: number,
  calls: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cleanup_grants (user_id, words, calls_left, expires_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(userId, words, calls, nowSeconds() + 600)
    .run();
}

function workerEnv(): Env {
  return {
    DB: env.DB,
    SITE_URL: env.SITE_URL,
    CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY,
    CREEM_API_BASE: env.CREEM_API_BASE,
    CREEM_PRODUCT_PRO_MONTHLY: env.CREEM_PRODUCT_PRO_MONTHLY,
    CREEM_PRODUCT_PRO_ANNUAL: env.CREEM_PRODUCT_PRO_ANNUAL,
    STARTER_WEEKLY_WORDS: env.STARTER_WEEKLY_WORDS,
    FAIR_USE_WEEKLY_WORDS: env.FAIR_USE_WEEKLY_WORDS,
    STARTER_WEEKLY_AUDIO_SECONDS: env.STARTER_WEEKLY_AUDIO_SECONDS,
    FAIR_USE_WEEKLY_AUDIO_SECONDS: env.FAIR_USE_WEEKLY_AUDIO_SECONDS,
    CLEANUP_MODELS: env.CLEANUP_MODELS,
    CLERK_SECRET_KEY: env.CLERK_SECRET_KEY,
    ASSEMBLYAI_API_KEY: env.ASSEMBLYAI_API_KEY,
    CREEM_API_KEY: env.CREEM_API_KEY,
    CREEM_WEBHOOK_SECRET: env.CREEM_WEBHOOK_SECRET,
    CLERK_WEBHOOK_SECRET: env.CLERK_WEBHOOK_SECRET,
  };
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(
  handler: (
    url: string,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  });
  return calls;
}

/** Consumes a streamed request body like a real upstream would. */
async function drainBody(init: RequestInit | undefined): Promise<void> {
  const body = init?.body as ReadableStream<Uint8Array> | undefined;
  if (!body) return;
  const reader = body.getReader();
  while (!(await reader.read()).done) {
    // Drain until the limiter closes the stream.
  }
}

function syncRequest(token: string, body: BodyInit = "audio"): Request {
  return new Request("https://ray.test/v1/stt/sync", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "audio/wav",
    },
    body,
  });
}

/** The canonical desktop WAV: PCM16 mono at `sampleRate`, zero-filled data. */
function wavBytes(dataBytes: number, sampleRate = 16_000): Uint8Array {
  const wav = new Uint8Array(44 + dataBytes);
  const view = new DataView(wav.buffer);
  const tag = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      wav[offset + index] = text.charCodeAt(index);
    }
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, dataBytes, true);
  return wav;
}

describe("upstream error mapping (decision 4)", () => {
  it("maps an upstream 401 to 502 upstream_error, not Ray unauthorized", async () => {
    await seedUser("user_upstream_401");
    const token = await seedDevice("user_upstream_401");
    stubFetch(() => new Response("upstream says no", { status: 401 }));

    const response = await app.request(
      syncRequest(token),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(502);
    expect(await jsonOf(response)).toMatchObject({
      error: "upstream_error",
    });
  });

  it("maps an upstream 429 to 503 upstream_busy", async () => {
    await seedUser("user_upstream_429");
    const token = await seedDevice("user_upstream_429");
    stubFetch(() => new Response("slow down", { status: 429 }));

    const response = await app.request(
      syncRequest(token),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(503);
    expect(await jsonOf(response)).toMatchObject({
      error: "upstream_busy",
    });
  });

  it("maps upstream 5xx and network failures to 502 upstream_error", async () => {
    await seedUser("user_upstream_500");
    const token = await seedDevice("user_upstream_500");
    stubFetch(() => new Response("boom", { status: 500 }));

    const serverError = await app.request(
      syncRequest(token),
      undefined,
      workerEnv(),
    );
    expect(serverError.status).toBe(502);
    expect(await jsonOf(serverError)).toMatchObject({
      error: "upstream_error",
    });

    vi.unstubAllGlobals();
    stubFetch(() => {
      throw new Error("network down");
    });
    const networkError = await app.request(
      syncRequest(token),
      undefined,
      workerEnv(),
    );
    expect(networkError.status).toBe(502);
    expect(await jsonOf(networkError)).toMatchObject({
      error: "upstream_error",
    });
  });

  it("maps cleanup upstream 401 to 502 instead of passing it through", async () => {
    await seedUser("user_upstream_cleanup");
    const token = await seedDevice("user_upstream_cleanup");
    await seedGrant("user_upstream_cleanup", 100, 5);
    stubFetch(() => new Response("unauthorized", { status: 401 }));

    const response = await app.request(
      new Request("https://ray.test/v1/cleanup/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gemma-4-31b",
          messages: [
            { role: "user", content: "<transcript>hello</transcript>" },
          ],
        }),
      }),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(502);
    expect(await jsonOf(response)).toMatchObject({
      error: "upstream_error",
    });
  });

  it("maps a batch upload 429 to 503 upstream_busy", async () => {
    await seedUser("user_upstream_batch");
    const token = await seedDevice("user_upstream_batch");
    stubFetch(() => new Response("slow down", { status: 429 }));

    const response = await app.request(
      new Request("https://ray.test/v1/stt/batch", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "audio/wav",
        },
        body: wavBytes(32_000),
      }),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(503);
    expect(await jsonOf(response)).toMatchObject({
      error: "upstream_busy",
    });
  });

  it("counts a failed transcription toward the weekly failure budget", async () => {
    await seedUser("user_failure_recorded");
    const token = await seedDevice("user_failure_recorded");
    stubFetch(() => new Response("boom", { status: 500 }));

    const response = await app.request(
      syncRequest(token),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(502);

    const weekStart = weekBounds(nowSeconds()).weekStart;
    expect(
      await getSttFailures(env.DB, "user_failure_recorded", weekStart),
    ).toBe(1);
  });
});

describe("word counting and cleanup grants on STT responses", () => {
  it("prefers the words array, counts usage and earns cleanup calls", async () => {
    await seedUser("user_words_array");
    const token = await seedDevice("user_words_array");
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ text: "one two three", words: [{}, {}] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const response = await app.request(
      syncRequest(token),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      text: "one two three",
      words: [{}, {}],
    });

    const weekStart = weekBounds(nowSeconds()).weekStart;
    expect(await getUsageWords(env.DB, "user_words_array", weekStart)).toBe(2);
    const grant = await env.DB.prepare(
      "SELECT words, calls_left, expires_at FROM cleanup_grants WHERE user_id = ?",
    )
      .bind("user_words_array")
      .first<{ words: number; calls_left: number; expires_at: number }>();
    expect(grant?.words).toBe(2);
    expect(grant?.calls_left).toBe(6);
    expect(grant!.expires_at).toBeGreaterThan(nowSeconds());
  });

  it("counts CJK characters when there is no words array", async () => {
    await seedUser("user_words_cjk");
    const token = await seedDevice("user_words_cjk");
    stubFetch(
      () =>
        new Response(JSON.stringify({ text: "你好世界" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await app.request(syncRequest(token), undefined, workerEnv());
    const weekStart = weekBounds(nowSeconds()).weekStart;
    expect(await getUsageWords(env.DB, "user_words_cjk", weekStart)).toBe(4);
  });

  it("counts a zero-word transcription toward the weekly failure budget", async () => {
    await seedUser("user_zero_words");
    const token = await seedDevice("user_zero_words");
    stubFetch(
      () =>
        new Response(JSON.stringify({ text: "" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const response = await app.request(
      syncRequest(token),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(200);
    const weekStart = weekBounds(nowSeconds()).weekStart;
    expect(await getUsageWords(env.DB, "user_zero_words", weekStart)).toBe(0);
    // Silent audio still costs an upstream transcription, so it is budgeted.
    expect(
      await getSttFailures(env.DB, "user_zero_words", weekStart),
    ).toBe(1);
  });

  it("counts a completed batch transcript from the words array", async () => {
    await seedUser("user_batch_words");
    const token = await seedDevice("user_batch_words");
    stubFetch((url) => {
      if (url.endsWith("/upload")) {
        return new Response(JSON.stringify({ upload_url: "https://u.test/a" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          id: "tran_done",
          status: "completed",
          text: "hello world",
          words: [{}, {}],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const response = await app.request(
      new Request("https://ray.test/v1/stt/batch", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "audio/wav",
        },
        body: wavBytes(32_000),
      }),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "hello world" });
    expect(
      await getUsageWords(
        env.DB,
        "user_batch_words",
        weekBounds(nowSeconds()).weekStart,
      ),
    ).toBe(2);
  });
});

describe("audio metering (AssemblyAI bills audio time)", () => {
  it("counts streamed audio seconds even when words are counted", async () => {
    await seedUser("user_audio_meter");
    const token = await seedDevice("user_audio_meter");
    stubFetch(async (_url, init) => {
      await drainBody(init);
      return new Response(
        JSON.stringify({ text: "word", words: [{}] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    // 64,000 PCM16 bytes plus the 44-byte WAV header is exactly 2 seconds.
    const response = await app.request(
      syncRequest(token, new Uint8Array(64_044)),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(200);

    const weekStart = weekBounds(nowSeconds()).weekStart;
    expect(await getUsage(env.DB, "user_audio_meter", weekStart)).toEqual({
      words: 1,
      audioSeconds: 2,
    });
  });

  it("meters the duration AssemblyAI reports when it exceeds the byte estimate", async () => {
    await seedUser("user_audio_reported");
    const token = await seedDevice("user_audio_reported");
    stubFetch(async (_url, init) => {
      await drainBody(init);
      return new Response(
        JSON.stringify({
          text: "word",
          words: [{}],
          audio_duration_ms: 120_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    // One second of bytes, but the upstream decoded two minutes.
    const response = await app.request(
      syncRequest(token, new Uint8Array(32_044)),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(200);

    const weekStart = weekBounds(nowSeconds()).weekStart;
    expect(await getUsage(env.DB, "user_audio_reported", weekStart)).toEqual({
      words: 1,
      audioSeconds: 120,
    });
  });

  it("counts audio for a zero-word response", async () => {
    await seedUser("user_audio_zero_words");
    const token = await seedDevice("user_audio_zero_words");
    stubFetch(async (_url, init) => {
      await drainBody(init);
      return new Response(JSON.stringify({ text: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await app.request(
      syncRequest(token, new Uint8Array(32_044)),
      undefined,
      workerEnv(),
    );

    const weekStart = weekBounds(nowSeconds()).weekStart;
    expect(await getUsage(env.DB, "user_audio_zero_words", weekStart)).toEqual({
      words: 0,
      audioSeconds: 1,
    });
  });

  it("counts audio when the upstream request fails", async () => {
    await seedUser("user_audio_upstream_fail");
    const token = await seedDevice("user_audio_upstream_fail");
    stubFetch(async (_url, init) => {
      await drainBody(init);
      return new Response("boom", { status: 500 });
    });

    const response = await app.request(
      syncRequest(token, new Uint8Array(32_044)),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(502);

    const weekStart = weekBounds(nowSeconds()).weekStart;
    expect(
      await getUsage(env.DB, "user_audio_upstream_fail", weekStart),
    ).toEqual({ words: 0, audioSeconds: 1 });
    expect(
      await getSttFailures(env.DB, "user_audio_upstream_fail", weekStart),
    ).toBe(1);
  });

  it("counts batch audio seconds", async () => {
    await seedUser("user_audio_batch");
    const token = await seedDevice("user_audio_batch");
    stubFetch(async (url, init) => {
      if (url.endsWith("/upload")) {
        await drainBody(init);
        return new Response(JSON.stringify({ upload_url: "https://u.test/a" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          id: "tran_audio",
          status: "completed",
          text: "hello world",
          words: [{}, {}],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    // 96,000 PCM16 bytes plus the WAV header is 3 seconds.
    const response = await app.request(
      new Request("https://ray.test/v1/stt/batch", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "audio/wav",
        },
        body: wavBytes(96_000),
      }),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(200);

    const weekStart = weekBounds(nowSeconds()).weekStart;
    expect(await getUsage(env.DB, "user_audio_batch", weekStart)).toEqual({
      words: 2,
      audioSeconds: 3,
    });
  });
});

describe("batch streamed input cap (decision 6)", () => {
  it("rejects an empty streamed body without calling upstream", async () => {
    await seedUser("user_batch_empty");
    const token = await seedDevice("user_batch_empty");
    const calls = stubFetch(() => new Response("{}", { status: 200 }));

    const empty = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const response = await app.request(
      new Request("https://ray.test/v1/stt/batch", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "audio/wav",
        },
        body: empty,
      }),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(400);
    expect(await jsonOf(response)).toMatchObject({ error: "invalid_audio" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-WAV or non-16 kHz PCM16 body without calling upstream", async () => {
    await seedUser("user_batch_format");
    const token = await seedDevice("user_batch_format");
    const calls = stubFetch(() => new Response("{}", { status: 200 }));

    for (const body of [
      new Uint8Array(1_024), // could be compressed audio to the v2 API
      wavBytes(32_000, 8_000), // decodes to twice the metered duration
    ]) {
      const response = await app.request(
        new Request("https://ray.test/v1/stt/batch", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "audio/wav",
          },
          body,
        }),
        undefined,
        workerEnv(),
      );
      expect(response.status).toBe(400);
      expect(await jsonOf(response)).toMatchObject({ error: "invalid_audio" });
    }
    expect(calls).toHaveLength(0);
  });

  it("returns 413 when the streamed body overflows 12 MB", async () => {
    await seedUser("user_batch_stream");
    const token = await seedDevice("user_batch_stream");

    vi.stubGlobal(
      "fetch",
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        // Consume the streamed upload like a real upstream would; the cap
        // errors the stream once 12 MB is exceeded.
        const reader = (
          init?.body as ReadableStream<Uint8Array>
        ).getReader();
        while (!(await reader.read()).done) {
          // Drain until the limiter errors.
        }
        return new Response(JSON.stringify({ upload_url: "https://u.test" }), {
          status: 200,
        });
      },
    );

    const header = wavBytes(32_000);
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) {
          sent += header.byteLength;
          controller.enqueue(header);
          return;
        }
        if (sent > 13 * 1024 * 1024) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    const response = await app.request(
      new Request("https://ray.test/v1/stt/batch", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "audio/wav",
        },
        body,
      }),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(413);
    expect(await jsonOf(response)).toMatchObject({
      error: "payload_too_large",
    });
  });
});

describe("sync input cap", () => {
  it("rejects a declared sync body over 12 MB without calling upstream", async () => {
    await seedUser("user_sync_cap");
    const token = await seedDevice("user_sync_cap");
    const calls = stubFetch(
      () => new Response(JSON.stringify({ text: "hi" }), { status: 200 }),
    );

    const response = await app.request(
      new Request("https://ray.test/v1/stt/sync", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "audio/wav",
          "content-length": String(BATCH_MAX_BYTES + 1),
        },
        body: "audio",
      }),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(413);
    expect(await jsonOf(response)).toMatchObject({
      error: "payload_too_large",
    });
    expect(calls).toHaveLength(0);
  });

  it("returns 413 when a streamed sync body overflows 12 MB", async () => {
    await seedUser("user_sync_stream");
    const token = await seedDevice("user_sync_stream");

    vi.stubGlobal(
      "fetch",
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        // Consume the streamed proxy body like the real upstream would.
        const reader = (
          init?.body as ReadableStream<Uint8Array>
        ).getReader();
        while (!(await reader.read()).done) {
          // Drain until the limiter errors.
        }
        return new Response(JSON.stringify({ text: "hi" }), { status: 200 });
      },
    );

    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 13 * 1024 * 1024) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    const response = await app.request(
      new Request("https://ray.test/v1/stt/sync", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "audio/wav",
        },
        body,
      }),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(413);
    expect(await jsonOf(response)).toMatchObject({
      error: "payload_too_large",
    });
  });
});

describe("cleanup field whitelist on the wire (decision 2)", () => {
  it("forwards only model, messages, temperature, max_tokens and stream", async () => {
    await seedUser("user_cleanup_wire");
    const token = await seedDevice("user_cleanup_wire");
    await seedGrant("user_cleanup_wire", 100, 5);

    const calls = stubFetch(
      () =>
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const response = await app.request(
      new Request("https://ray.test/v1/cleanup/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gemma-4-31b",
          messages: [
            { role: "system", content: "Be terse.", name: "dropped" },
            {
              role: "user",
              content: "<transcript>hello world</transcript>",
            },
          ],
          temperature: 0.3,
          max_tokens: 9_999,
          n: 4,
          max_completion_tokens: 9_999,
          stream: true,
          tools: [{ type: "function" }],
        }),
      }),
      undefined,
      workerEnv(),
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const forwarded = JSON.parse(String(calls[0]!.init?.body));
    expect(forwarded).toEqual({
      model: "gemma-4-31b",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "<transcript>hello world</transcript>" },
      ],
      temperature: 0.3,
      max_tokens: 4_000,
      stream: false,
    });
    expect(forwarded).not.toHaveProperty("n");
    expect(forwarded).not.toHaveProperty("max_completion_tokens");
    expect(forwarded).not.toHaveProperty("tools");
  });

  it("returns no_cleanup_grant when the transcript exceeds the grant", async () => {
    await seedUser("user_cleanup_wire_long");
    const token = await seedDevice("user_cleanup_wire_long");
    await seedGrant("user_cleanup_wire_long", 2, 5);
    const calls = stubFetch(() => new Response("{}", { status: 200 }));

    const transcript = Array.from(
      { length: 28 },
      (_, index) => `word${index}`,
    ).join(" ");
    const response = await app.request(
      new Request("https://ray.test/v1/cleanup/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gemma-4-31b",
          messages: [
            { role: "user", content: `<transcript>${transcript}</transcript>` },
          ],
        }),
      }),
      undefined,
      workerEnv(),
    );
    expect(response.status).toBe(403);
    expect(await jsonOf(response)).toMatchObject({
      error: "no_cleanup_grant",
    });
    expect(calls).toHaveLength(0);
  });
});
