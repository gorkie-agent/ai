// Regression test for #124: the 5s upstream header timeout in
// /chat/completions aborts every image-modality request (text-to-image
// generation and image editing), since image models routinely take 8-30s to
// begin returning headers.
//
// We mock the heavy dependencies (env, auth, limits, shared helpers) and
// point the REAL handleProxy/fetchWithHeaderTimeout code at a mock upstream
// that delays 8s — longer than the 5s guard — then assert:
//   - text requests still hit the 5s guard (504)
//   - image-modality requests bypass the guard and succeed (200)

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { Server } from "bun";
import type { Context } from "hono";

// Minimal subset of the Hono context used by the mocked middleware.
type MockCtx = Pick<Context, "set">;

const TEXT_MODEL = "openai/gpt-4o";
const IMAGE_MODEL = "google/gemini-3.1-flash-image-preview";
const SLOW_MS = 8_000;
let upstream: Server;
let upstreamUrl = "";

mock.module("./src/env", () => ({
  env: { OPENAI_API_URL: upstreamUrl },
  allowedImageModels: [IMAGE_MODEL],
  allowedLanguageModels: [TEXT_MODEL],
  allowedEmbeddingModels: [],
}));

mock.module("./src/middleware/auth", () => ({
  requireApiKey: async (c: MockCtx, next: () => Promise<void>) => {
    c.set("apiKey", { id: 1 });
    c.set("user", { id: 1 });
    c.set("openrouterKey", "sk-test");
    await next();
  },
}));

mock.module("./src/middleware/limits", () => ({
  checkSpendingLimit: async (_c: MockCtx, next: () => Promise<void>) => next(),
  reserveCharge: async () => {},
  releasePendingCharge: async () => {},
}));

mock.module("./src/routes/proxy/shared", () => ({
  MODEL_POOL: [TEXT_MODEL, IMAGE_MODEL],
  SIZE_RATIOS: { "1024x1024": "1:1" },
  standardLimiter: async (_c: MockCtx, next: () => Promise<void>) => next(),
  apiHeaders: () => ({ "Content-Type": "application/json" }),
  resolveModel: (model: string) => model,
  resolveUsage: () => ({ prompt: 0, completion: 0, total: 0, cost: 0 }),
  estimateUpstreamCost: async () => 0.05,
  logRequest: async () => {},
}));

let general: typeof import("./src/routes/proxy/v1/general").default;

beforeAll(async () => {
  // Mock upstream that behaves like a real OpenRouter: headers arrive only
  // after SLOW_MS, which is beyond the 5s header timeout.
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      const isImage =
        body.model === IMAGE_MODEL ||
        (Array.isArray(body.modalities) && body.modalities.includes("image"));
      await Bun.sleep(SLOW_MS);
      if (isImage) {
        return Response.json({
          choices: [
            {
              message: {
                images: [{ image_url: { url: "data:image/png;base64,AAAA" } }],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      return Response.json({
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  upstreamUrl = `http://127.0.0.1:${upstream.port}`;

  const { default: mod } = await import("./src/routes/proxy/v1/general");
  general = mod;
});

afterAll(() => {
  upstream.stop(true);
});

async function postChat(body: unknown) {
  return general.request("/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test",
    },
    body: JSON.stringify(body),
  });
}

describe("upstream header timeout (#124)", () => {
  test("image editing via /chat/completions (modalities: image) is not killed by the 5s guard", async () => {
    const res = await postChat({
      model: TEXT_MODEL,
      modalities: ["image", "text"],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "edit this" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAA" },
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.choices[0].message.images[0].image_url.url).toBe(
      "data:image/png;base64,AAAA",
    );
  }, 30_000);

  test("text-to-image via /chat/completions targeting an image model bypasses the guard", async () => {
    const res = await postChat({
      model: IMAGE_MODEL,
      modalities: ["image", "text"],
      messages: [{ role: "user", content: "draw a cat" }],
    });
    expect(res.status).toBe(200);
  }, 30_000);

  test("plain text requests still hit the 5s header timeout (504)", async () => {
    const res = await postChat({
      model: TEXT_MODEL,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(504);
  }, 30_000);

  test("streaming image-modality request bypasses the guard", async () => {
    const res = await postChat({
      model: TEXT_MODEL,
      stream: true,
      modalities: ["image", "text"],
      messages: [{ role: "user", content: "draw a cat" }],
    });
    expect(res.status).toBe(200);
  }, 30_000);
});
