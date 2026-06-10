import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chatCompletionsBehaviorAdapter } from "../../chat-completions/behavior/adapter";
import type { TestConfig } from "../types";
import { multiturnNameRecall, multiturnSystemPersists } from "./multiturn";
import { cacheDeterminism } from "./cache";
import { limitsUnicodeRoundtrip, limitsStopSequence } from "./limits";
import { toolNoToolWhenNotNeeded } from "./tool";

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";

interface ChatCompletionsRequest {
  messages: Array<{ role: string; content: string | null }>;
  stop?: string[];
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as ChatCompletionsRequest;
      const lastUser = [...body.messages]
        .reverse()
        .find((m) => m.role === "user");
      const userText = (lastUser?.content as string | null) ?? "";

      // Simple keyword routing.
      let reply = "ok";
      if (/what is my name/i.test(userText)) reply = "Alice";
      else if (/2\s*\+\s*2/.test(userText)) reply = "4";
      else if (/exact string:/.test(userText)) {
        const match = userText.match(/exact string:\s*(.+?)\s*—/);
        reply = match?.[1] ?? "héllo 你好 🦊";
      } else if (/europe/i.test(userText)) {
        reply = "france";
      } else if (/banana/i.test(userText)) {
        reply = "banana";
      } else if (/literal text:/i.test(userText)) {
        // Stop-sequence test: server returns text up to the stop sequence and
        // the engine would normally truncate. We simulate the engine doing
        // the right thing — returning text *without* "STOPHERE" or anything
        // after it.
        reply = "alpha ";
      }

      return new Response(
        JSON.stringify({
          id: "stub-1",
          choices: [
            {
              message: { role: "assistant", content: reply },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

function cfg(): TestConfig {
  return {
    baseUrl,
    apiKey: "",
    authHeaderName: "Authorization",
    useBearerPrefix: false,
    model: "stub",
  };
}

describe("behavioral scenarios against a stub", () => {
  it("multiturn-name-recall passes when stub returns Alice", async () => {
    const r = await multiturnNameRecall.run(
      chatCompletionsBehaviorAdapter,
      cfg(),
    );
    expect(r.status).toBe("passed");
  });

  it("multiturn-system-prompt-persists passes on lowercase reply", async () => {
    const r = await multiturnSystemPersists.run(
      chatCompletionsBehaviorAdapter,
      cfg(),
    );
    expect(r.status).toBe("passed");
  });

  it("limits-unicode-roundtrip passes when stub echoes unicode", async () => {
    const r = await limitsUnicodeRoundtrip.run(
      chatCompletionsBehaviorAdapter,
      cfg(),
    );
    expect(r.status).toBe("passed");
  });

  it("limits-stop-sequence passes when reply lacks STOPHERE", async () => {
    const r = await limitsStopSequence.run(
      chatCompletionsBehaviorAdapter,
      cfg(),
    );
    expect(r.status).toBe("passed");
  });

  it("tool-roundtrip-no-tool-when-not-needed passes when stub answers '4'", async () => {
    const r = await toolNoToolWhenNotNeeded.run(
      chatCompletionsBehaviorAdapter,
      cfg(),
    );
    expect(r.status).toBe("passed");
  });

  it("cache-determinism passes when stub is deterministic", async () => {
    const r = await cacheDeterminism.run(chatCompletionsBehaviorAdapter, cfg());
    expect(r.status).toBe("passed");
  });
});
