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
import { parseSSEStream, type ResponseResource } from "../sse-events";

/**
 * Open Responses input items. We narrowly type the shapes we emit; the remote
 * side may accept additional fields we don't use here.
 */
type InputItem =
  | { type: "message"; role: "system" | "user" | "assistant"; content: string }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }
  | { type: "function_call_output"; call_id: string; output: string };

function turnsToInput(spec: RequestSpec): InputItem[] {
  const out: InputItem[] = [];
  if (spec.system) {
    out.push({ type: "message", role: "system", content: spec.system });
  }
  for (const t of spec.turns) {
    out.push(...turnToItems(t));
  }
  return out;
}

function turnToItems(turn: Turn): InputItem[] {
  switch (turn.type) {
    case "user":
      return [{ type: "message", role: "user", content: turn.text }];
    case "assistant-text":
      return [{ type: "message", role: "assistant", content: turn.text }];
    case "assistant-tool-call":
      return [
        {
          type: "function_call",
          call_id: turn.call.id,
          name: turn.call.name,
          arguments: turn.call.argsJson,
        },
      ];
    case "tool-result":
      return [
        {
          type: "function_call_output",
          call_id: turn.toolCallId,
          output: turn.output,
        },
      ];
  }
}

function buildBody(spec: RequestSpec, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    input: turnsToInput(spec),
  };
  if (spec.temperature !== undefined) body.temperature = spec.temperature;
  if (spec.maxTokens !== undefined) body.max_output_tokens = spec.maxTokens;
  if (spec.stop) body.stop = spec.stop;
  if (spec.previousResponseId)
    body.previous_response_id = spec.previousResponseId;
  if (spec.promptCacheKey) body.prompt_cache_key = spec.promptCacheKey;
  if (spec.tools?.length) {
    body.tools = spec.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
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

interface ResponseLike {
  id?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  output?: Array<{
    type?: string;
    role?: string;
    content?: string | Array<{ type?: string; text?: string }> | undefined;
    name?: string;
    arguments?: string;
    call_id?: string;
  }>;
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

function asResponseLike(res: ResponseResource): ResponseLike {
  return res as unknown as ResponseLike;
}

export const responsesBehaviorAdapter: BehaviorAdapter<ResponseResource> = {
  spec: "responses",
  capabilities: {
    jsonMode: true,
    jsonSchema: true,
    previousResponseId: true,
    promptCacheKey: true,
    reasoningChannel: true,
  },

  async send(config: TestConfig, spec): Promise<SendResult<ResponseResource>> {
    const body = buildBody(spec, config.model);
    const start = Date.now();
    const response = await makeRequest(config, "/responses", body);
    const durationMs = Date.now() - start;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const raw = (await readJson(response)) as ResponseResource;
    return { raw, status: response.status, durationMs };
  },

  async sendStreaming(
    config: TestConfig,
    spec,
  ): Promise<SendStreamResult<ResponseResource>> {
    const body = buildBody(spec, config.model);
    const start = Date.now();
    const response = await makeRequest(config, "/responses", body, {
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
    const r = asResponseLike(res);
    if (typeof r.output_text === "string" && r.output_text.length) {
      return r.output_text;
    }
    const parts: string[] = [];
    for (const item of r.output ?? []) {
      if (item.type !== "message") continue;
      if (typeof item.content === "string") {
        parts.push(item.content);
      } else if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c.text === "string") parts.push(c.text);
        }
      }
    }
    return parts.join("");
  },

  extractToolCalls(res) {
    const r = asResponseLike(res);
    const calls: ToolCall[] = [];
    for (const item of r.output ?? []) {
      if (item.type === "function_call") {
        calls.push({
          id: item.call_id ?? "",
          name: item.name ?? "",
          argsJson: item.arguments ?? "",
        });
      }
    }
    return calls;
  },

  extractFinishReason(res) {
    const r = asResponseLike(res);
    // Truncation reports as status="incomplete" + incomplete_details.reason
    // ("max_output_tokens" / "content_filter"). The bare status string has
    // no length signal, so surface the detail reason when present.
    if (r.status === "incomplete" && r.incomplete_details?.reason) {
      return r.incomplete_details.reason;
    }
    return r.status ?? null;
  },

  extractCachedTokens(res) {
    return (
      asResponseLike(res).usage?.input_tokens_details?.cached_tokens ?? null
    );
  },

  extractInputTokens(res) {
    return asResponseLike(res).usage?.input_tokens ?? null;
  },

  extractOutputTokens(res) {
    return asResponseLike(res).usage?.output_tokens ?? null;
  },

  extractResponseId(res) {
    return asResponseLike(res).id ?? null;
  },

  reassembleStreamText(parsed) {
    if (parsed.finalResponse)
      return this.extractFinalText(parsed.finalResponse);
    return "";
  },

  reassembleStreamToolCalls(parsed) {
    if (parsed.finalResponse)
      return this.extractToolCalls(parsed.finalResponse);
    return [];
  },
};
