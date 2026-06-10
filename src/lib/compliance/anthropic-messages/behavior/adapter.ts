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
import { parseSSEStream, type Message } from "../sse-events";

interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result" | string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[] | string;
}

function turnsToMessages(spec: RequestSpec): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const t of spec.turns) {
    const msg = turnToMessage(t);
    if (msg) out.push(msg);
  }
  // Anthropic disallows consecutive assistant messages; merge tool_use into
  // the same assistant turn if needed.
  return mergeConsecutiveAssistant(out);
}

function turnToMessage(turn: Turn): AnthropicMessage | null {
  switch (turn.type) {
    case "user":
      return { role: "user", content: [{ type: "text", text: turn.text }] };
    case "assistant-text":
      return {
        role: "assistant",
        content: [{ type: "text", text: turn.text }],
      };
    case "assistant-tool-call": {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(turn.call.argsJson || "{}");
      } catch {
        input = {};
      }
      return {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: turn.call.id || `toolu_${Math.random().toString(36).slice(2)}`,
            name: turn.call.name,
            input,
          },
        ],
      };
    }
    case "tool-result":
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: turn.toolCallId,
            content: turn.output,
          },
        ],
      };
  }
}

function mergeConsecutiveAssistant(
  msgs: AnthropicMessage[],
): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role && last.role === "assistant") {
      const lastContent = Array.isArray(last.content) ? last.content : [];
      const mContent = Array.isArray(m.content) ? m.content : [];
      out[out.length - 1] = {
        role: "assistant",
        content: [...lastContent, ...mContent],
      };
    } else {
      out.push(m);
    }
  }
  return out;
}

function buildBody(spec: RequestSpec, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: turnsToMessages(spec),
    // Anthropic requires max_tokens; pick a sane default if caller didn't set one.
    max_tokens: spec.maxTokens ?? 1024,
  };
  if (spec.system) body.system = spec.system;
  if (spec.temperature !== undefined) body.temperature = spec.temperature;
  if (spec.stop) body.stop_sequences = spec.stop;
  if (spec.tools?.length) {
    body.tools = spec.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  return body;
}

async function readJson(response: Response): Promise<unknown> {
  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return response.json();
  return response.text();
}

interface MessageLike {
  id?: string;
  stop_reason?: string;
  content?: AnthropicContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function asMessageLike(m: Message): MessageLike {
  return m as unknown as MessageLike;
}

export const anthropicMessagesBehaviorAdapter: BehaviorAdapter<Message> = {
  spec: "anthropic-messages",
  capabilities: {
    jsonMode: false,
    jsonSchema: false,
    previousResponseId: false,
    promptCacheKey: false,
    reasoningChannel: true,
  },

  async send(config: TestConfig, spec): Promise<SendResult<Message>> {
    const body = buildBody(spec, config.model);
    const start = Date.now();
    const response = await makeRequest(config, "/v1/messages", body, {
      extraHeaders: { "anthropic-version": "2023-06-01" },
    });
    const durationMs = Date.now() - start;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const raw = (await readJson(response)) as Message;
    return { raw, status: response.status, durationMs };
  },

  async sendStreaming(
    config: TestConfig,
    spec,
  ): Promise<SendStreamResult<Message>> {
    const body = buildBody(spec, config.model);
    const start = Date.now();
    const response = await makeRequest(config, "/v1/messages", body, {
      streaming: true,
      extraHeaders: { "anthropic-version": "2023-06-01" },
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
    const m = asMessageLike(res);
    const parts: string[] = [];
    for (const block of m.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("");
  },

  extractToolCalls(res) {
    const m = asMessageLike(res);
    const calls: ToolCall[] = [];
    for (const block of m.content ?? []) {
      if (block.type === "tool_use") {
        calls.push({
          id: block.id ?? "",
          name: block.name ?? "",
          argsJson: JSON.stringify(block.input ?? {}),
        });
      }
    }
    return calls;
  },

  extractFinishReason(res) {
    return asMessageLike(res).stop_reason ?? null;
  },

  extractCachedTokens(res) {
    return asMessageLike(res).usage?.cache_read_input_tokens ?? null;
  },

  extractInputTokens(res) {
    return asMessageLike(res).usage?.input_tokens ?? null;
  },

  extractOutputTokens(res) {
    return asMessageLike(res).usage?.output_tokens ?? null;
  },

  extractResponseId(res) {
    return asMessageLike(res).id ?? null;
  },

  reassembleStreamText(parsed) {
    // Spec-compliant streaming never carries text on `message_start.message`
    // (content is `[]` there) — text only exists as accumulated
    // `text_delta`s, which `parseSSEStream` collects per block index.
    const byIndex = parsed.context?.textByIndex ?? {};
    const text = Object.keys(byIndex)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => byIndex[i])
      .join("");
    if (text) return text;
    if (parsed.finalResponse)
      return this.extractFinalText(parsed.finalResponse);
    return "";
  },

  reassembleStreamToolCalls(parsed) {
    // Same story as text: tool calls stream as `content_block_start`
    // (id/name) + `input_json_delta`s; the final message never carries them.
    const ctx = parsed.context;
    if (ctx && ctx.toolUseIndices.size > 0) {
      return Array.from(ctx.toolUseIndices)
        .sort((a, b) => a - b)
        .map((i) => ({
          id: ctx.toolIdsByIndex[i] ?? "",
          name: ctx.toolNamesByIndex[i] ?? "",
          argsJson: ctx.toolInputJsonByIndex[i] || "{}",
        }));
    }
    if (parsed.finalResponse)
      return this.extractToolCalls(parsed.finalResponse);
    return [];
  },
};
