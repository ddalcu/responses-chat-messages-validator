import { afterEach, describe, expect, it } from "bun:test";
import type { TestConfig } from "../../core/types";
import { chatCompletionsBehaviorAdapter } from "./adapter";

const config: TestConfig = {
  baseUrl: "http://localhost:0/v1",
  apiKey: "",
  model: "test-model",
  authHeaderName: "Authorization",
  useBearerPrefix: true,
} as unknown as TestConfig;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("chatCompletionsBehaviorAdapter.sendStreaming", () => {
  it("opts into streaming usage via stream_options.include_usage", async () => {
    // OpenAI only reports usage on streamed completions when the request
    // sets stream_options.include_usage — without it, parity-usage-present
    // can never pass against a spec-compliant engine.
    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    await chatCompletionsBehaviorAdapter.sendStreaming(config, {
      turns: [{ type: "user", text: "hi" }],
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.stream).toBe(true);
    expect(capturedBody!.stream_options).toEqual({ include_usage: true });
  });
});
