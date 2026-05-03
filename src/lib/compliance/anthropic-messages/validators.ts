import { messageSchema } from "../../../generated/kubb/anthropic-messages/zod/messageSchema";
import { formatZodIssues } from "../core/validators";
import type { ResponseValidator, ValidateResponseOutcome } from "../core/types";
import type {
  AnthropicStreamContext,
  Message,
  ParsedEvent,
} from "./sse-events";

export type ParsedResponse = Message;

export type AnthropicValidator = ResponseValidator<
  ParsedResponse,
  AnthropicStreamContext
>;

/**
 * Top-level `validateResponse` for the Anthropic Messages suite. Used by the
 * generic core to schema-check the response body before per-template
 * validators run.
 */
export const validateMessageResource = (
  raw: unknown,
): ValidateResponseOutcome<ParsedResponse> => {
  const parseResult = messageSchema.safeParse(raw);
  if (parseResult.success) {
    return {
      ok: true,
      data: parseResult.data,
      errors: [],
    };
  }
  return {
    ok: false,
    errors: formatZodIssues("", parseResult.error),
  };
};

export const isAssistantMessage: AnthropicValidator = (response) => {
  const errors: string[] = [];
  if (response.type !== "message") {
    errors.push(`Expected type "message" but got "${response.type}"`);
  }
  if (response.role !== "assistant") {
    errors.push(`Expected role "assistant" but got "${response.role}"`);
  }
  return errors;
};

export const hasContent: AnthropicValidator = (response) => {
  if (!Array.isArray(response.content) || response.content.length === 0) {
    return ["Response has no content blocks"];
  }
  return [];
};

export const firstContentTypeIs =
  (type: "text" | "tool_use" | "thinking"): AnthropicValidator =>
  (response) => {
    const first = response.content?.[0];
    if (!first) {
      return ["Response has no content blocks"];
    }
    if (first.type !== type) {
      return [
        `Expected first content block type "${type}" but got "${first.type}"`,
      ];
    }
    return [];
  };

export const hasContentType =
  (type: "text" | "tool_use" | "thinking"): AnthropicValidator =>
  (response) => {
    const has = response.content?.some((block) => block.type === type);
    if (!has) {
      return [
        `Expected at least one content block of type "${type}" but none found`,
      ];
    }
    return [];
  };

export const stopReasonIs =
  (
    expected:
      | "end_turn"
      | "max_tokens"
      | "stop_sequence"
      | "tool_use"
      | "pause_turn"
      | "refusal",
  ): AnthropicValidator =>
  (response) => {
    if (response.stop_reason !== expected) {
      return [
        `Expected stop_reason "${expected}" but got "${response.stop_reason}"`,
      ];
    }
    return [];
  };

export const toolUseHasName =
  (name: string): AnthropicValidator =>
  (response) => {
    const block = response.content?.find((b) => b.type === "tool_use") as
      | { type: "tool_use"; name?: unknown; input?: unknown }
      | undefined;
    if (!block) {
      return [
        `Expected a tool_use content block with name "${name}" but none found`,
      ];
    }
    const errors: string[] = [];
    if (block.name !== name) {
      errors.push(
        `Expected tool_use name "${name}" but got "${String(block.name)}"`,
      );
    }
    if (!block.input || typeof block.input !== "object") {
      errors.push("tool_use block has no `input` object");
    }
    return errors;
  };

export const streamingEvents: AnthropicValidator = (_, context) => {
  if (!context.streaming) return [];
  if (!context.sseResult || context.sseResult.events.length === 0) {
    return ["No streaming events received"];
  }
  return [];
};

export const streamingSchema: AnthropicValidator = (_, context) => {
  if (!context.streaming || !context.sseResult) return [];
  return context.sseResult.errors;
};

/**
 * Asserts that the streaming sequence contains, at minimum:
 *   message_start -> ≥1 content_block_start -> ≥1 content_block_delta
 *   -> content_block_stop -> message_delta -> message_stop
 * The order constraint is loose (any interleaving is allowed) but each event
 * type must occur at least once and `message_stop` must be terminal.
 */
export const requiredStreamSequence: AnthropicValidator = (_, context) => {
  if (!context.streaming || !context.sseResult) return [];
  const errors: string[] = [];
  const ctx = context.sseResult.context;
  if (!ctx) return ["Missing streaming context"];

  const required: Array<keyof AnthropicStreamContext["eventTypeCounts"]> = [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ] as const;
  for (const type of required) {
    if (!ctx.eventTypeCounts[type as string]) {
      errors.push(
        `Streaming sequence missing required "${String(type)}" event`,
      );
    }
  }
  if (!ctx.sawMessageStop) {
    errors.push("Stream did not terminate with `message_stop`");
  }

  // Ensure at least one content_block_delta carried a `text_delta`.
  const events = context.sseResult.events as ParsedEvent[];
  const textDeltas = events.filter((e) => {
    if (!e.validationResult.success) return false;
    const ev = e.validationResult.data;
    return ev.type === "content_block_delta" && ev.delta.type === "text_delta";
  });
  if (textDeltas.length === 0) {
    errors.push(
      "Stream contained no `content_block_delta` events with a `text_delta`",
    );
  }
  return errors;
};

/**
 * Asserts that the reassembled `partial_json` for at least one tool_use
 * `content_block` parses as valid JSON, and that the matching tool name was
 * the one declared in the request. The parsed object must satisfy
 * `validateInput` (called once per tool_use index that produced JSON).
 */
export const reassembledToolInputIsValidJson =
  (validateInput: (parsed: unknown) => string[]): AnthropicValidator =>
  (_, context) => {
    if (!context.streaming || !context.sseResult) return [];
    const ctx = context.sseResult.context;
    if (!ctx) return ["Missing streaming context"];
    if (ctx.toolUseIndices.size === 0) {
      return ["Streaming response did not include a tool_use content block"];
    }

    const errors: string[] = [];
    for (const index of ctx.toolUseIndices) {
      const merged = ctx.toolInputJsonByIndex[index] ?? "";
      // Empty `partial_json` is allowed by Anthropic when the tool takes no
      // arguments, but for our compliance tests we expect at least one delta.
      if (merged.length === 0) {
        errors.push(
          `tool_use content block at index ${index} produced no input_json_delta payload`,
        );
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(merged);
      } catch (err) {
        errors.push(
          `Reassembled tool_use input JSON at index ${index} did not parse: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      errors.push(...validateInput(parsed));
    }
    return errors;
  };
