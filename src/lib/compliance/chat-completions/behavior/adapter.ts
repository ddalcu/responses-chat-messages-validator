import type {
  BehaviorAdapter,
  RequestSpec,
  SendResult,
  SendStreamResult,
  ToolCall,
  Turn,
} from "../../core/behavior-helpers";
import { makeRequest } from "../../core/http";
import type { TestConfig } from "../../core/types";
import {
  parseSSEStream,
  type ChatCompletion,
  type ChatCompletionsStreamContext,
} from "../sse-events";

interface OutgoingMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function turnsToMessages(spec: RequestSpec): OutgoingMessage[] {
  const out: OutgoingMessage[] = [];
  if (spec.system) out.push({ role: "system", content: spec.system });
  for (const t of spec.turns) {
    out.push(turnToMessage(t));
  }
  return out;
}

function turnToMessage(turn: Turn): OutgoingMessage {
  switch (turn.type) {
    case "user":
      return { role: "user", content: turn.text };
    case "assistant-text":
      return { role: "assistant", content: turn.text };
    case "assistant-tool-call":
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: turn.call.id,
            type: "function",
            function: { name: turn.call.name, arguments: turn.call.argsJson },
          },
        ],
      };
    case "tool-result":
      return {
        role: "tool",
        tool_call_id: turn.toolCallId,
        content: turn.output,
      };
  }
}

function buildBody(spec: RequestSpec, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: turnsToMessages(spec),
  };
  if (spec.temperature !== undefined) body.temperature = spec.temperature;
  // Modern OpenAI / GPT-5 / o-series reject `max_tokens` and require
  // `max_completion_tokens` instead. The new field is also accepted by current
  // LM Studio / vLLM / Ollama OpenAI-compat shims, so we send only the new
  // name. If a legacy engine rejects this we'll add a fallback.
  if (spec.maxTokens !== undefined) body.max_completion_tokens = spec.maxTokens;
  if (spec.stop) body.stop = spec.stop;
  if (spec.tools?.length) {
    body.tools = spec.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
  if (spec.responseFormat) {
    if (spec.responseFormat.type === "json_object") {
      body.response_format = { type: "json_object" };
    } else {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: spec.responseFormat.name,
          schema: spec.responseFormat.schema,
          strict: true,
        },
      };
    }
  }
  return body;
}

async function readJson(response: Response): Promise<unknown> {
  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return response.json();
  return response.text();
}

export const chatCompletionsBehaviorAdapter: BehaviorAdapter<ChatCompletion> = {
  spec: "chat-completions",
  capabilities: {
    jsonMode: true,
    jsonSchema: true,
    previousResponseId: false,
    promptCacheKey: false,
    reasoningChannel: false,
  },

  async send(config: TestConfig, spec): Promise<SendResult<ChatCompletion>> {
    const body = buildBody(spec, config.model);
    const start = Date.now();
    const response = await makeRequest(config, "/chat/completions", body);
    const durationMs = Date.now() - start;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const raw = (await readJson(response)) as ChatCompletion;
    return { raw, status: response.status, durationMs };
  },

  async sendStreaming(
    config: TestConfig,
    spec,
  ): Promise<SendStreamResult<ChatCompletion>> {
    const body = buildBody(spec, config.model);
    // OpenAI only reports usage on streamed completions when the request
    // opts in; without this, parity-usage-present can never pass against a
    // spec-compliant engine.
    body.stream_options = { include_usage: true };
    const start = Date.now();
    const response = await makeRequest(config, "/chat/completions", body, {
      streaming: true,
    });
    const durationMs = Date.now() - start;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const parsed = await parseSSEStream(response);
    return { parsed, durationMs };
  },

  extractFinalText(res) {
    return res.choices?.[0]?.message?.content ?? "";
  },

  extractToolCalls(res) {
    const calls = res.choices?.[0]?.message?.tool_calls ?? [];
    return calls.map((c, idx) => ({
      id: c.id ?? `tc_${idx}`,
      name: c.function?.name ?? "",
      argsJson: c.function?.arguments ?? "",
    }));
  },

  extractFinishReason(res) {
    return res.choices?.[0]?.finish_reason ?? null;
  },

  extractCachedTokens(res) {
    const u = res.usage as
      | { prompt_tokens_details?: { cached_tokens?: number } }
      | undefined;
    return u?.prompt_tokens_details?.cached_tokens ?? null;
  },

  extractInputTokens(res) {
    return res.usage?.prompt_tokens ?? null;
  },

  extractOutputTokens(res) {
    return res.usage?.completion_tokens ?? null;
  },

  extractResponseId(res) {
    return res.id ?? null;
  },

  reassembleStreamText(parsed) {
    if (parsed.finalResponse) {
      const text = parsed.finalResponse.choices?.[0]?.message?.content;
      if (typeof text === "string" && text.length) return text;
    }
    const ctx = (parsed as { context?: ChatCompletionsStreamContext }).context;
    return ctx?.contentByChoice?.get(0) ?? "";
  },

  reassembleStreamToolCalls(parsed) {
    if (parsed.finalResponse) {
      const calls = parsed.finalResponse.choices?.[0]?.message?.tool_calls;
      if (calls?.length) {
        return calls.map((c, i) => ({
          id: c.id ?? `tc_${i}`,
          name: c.function?.name ?? "",
          argsJson: c.function?.arguments ?? "",
        }));
      }
    }
    const ctx = (parsed as { context?: ChatCompletionsStreamContext }).context;
    const out: ToolCall[] = [];
    if (ctx) {
      const tcMap = ctx.toolCallsByChoice.get(0);
      if (tcMap) {
        for (const [, tc] of tcMap) {
          out.push({
            id: tc.id ?? "",
            name: tc.name ?? "",
            argsJson: tc.arguments ?? "",
          });
        }
      }
    }
    return out;
  },
};
