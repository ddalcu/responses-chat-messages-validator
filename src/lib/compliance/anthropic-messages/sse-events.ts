import { z } from "zod";
import { contentBlockDeltaEventSchema } from "../../../generated/kubb/anthropic-messages/zod/contentBlockDeltaEventSchema";
import { contentBlockStartEventSchema } from "../../../generated/kubb/anthropic-messages/zod/contentBlockStartEventSchema";
import { contentBlockStopEventSchema } from "../../../generated/kubb/anthropic-messages/zod/contentBlockStopEventSchema";
import { errorEventSchema } from "../../../generated/kubb/anthropic-messages/zod/errorEventSchema";
import { messageDeltaEventSchema } from "../../../generated/kubb/anthropic-messages/zod/messageDeltaEventSchema";
import type { messageSchema } from "../../../generated/kubb/anthropic-messages/zod/messageSchema";
import { messageStartEventSchema } from "../../../generated/kubb/anthropic-messages/zod/messageStartEventSchema";
import { messageStopEventSchema } from "../../../generated/kubb/anthropic-messages/zod/messageStopEventSchema";
import { pingEventSchema } from "../../../generated/kubb/anthropic-messages/zod/pingEventSchema";
import { parseSSELines } from "../core/sse";
import type { StreamParseResult } from "../core/types";

/**
 * Discriminated union over `type` covering every Anthropic Messages streaming
 * event type. The Kubb-generated `streamEventSchema` is a `z.union` (not a
 * `discriminatedUnion`) because the upstream schema uses `oneOf` over object
 * shapes. For nicer error reporting and faster matching, we redefine the union
 * as a discriminated union here while keeping the generated event schemas.
 */
export const streamEventSchema = z.discriminatedUnion("type", [
  messageStartEventSchema,
  contentBlockStartEventSchema,
  contentBlockDeltaEventSchema,
  contentBlockStopEventSchema,
  messageDeltaEventSchema,
  messageStopEventSchema,
  pingEventSchema,
  errorEventSchema,
]);

export type StreamEvent = z.infer<typeof streamEventSchema>;
export type Message = z.infer<typeof messageSchema>;

export interface ParsedEvent {
  /**
   * Event name from the SSE `event:` line. Anthropic always sends one and it
   * is expected to match the JSON `data.type`. The match is asserted in
   * `parseSSEStream`.
   */
  event: string;
  data: unknown;
  validationResult: z.SafeParseReturnType<unknown, StreamEvent>;
}

/**
 * Streaming-mode context surfaced to template validators. We track the
 * reassembled `input_json_delta.partial_json` per `content_block` index so the
 * `streaming-tool-use` test can validate the merged JSON parses.
 */
export interface AnthropicStreamContext {
  /** Final `Message` reassembled from `message_start` + `message_delta`s. */
  finalMessage: Message | null;
  /** `partial_json` strings concatenated per `content_block` index. */
  toolInputJsonByIndex: Record<number, string>;
  /** Indices that received `content_block_start` whose block was `tool_use`. */
  toolUseIndices: Set<number>;
  /** Tool names by content_block index, captured at `content_block_start`. */
  toolNamesByIndex: Record<number, string>;
  /** Whether a `message_stop` event was seen — required to be terminal. */
  sawMessageStop: boolean;
  /** Counts of each event `type` seen, used by validators. */
  eventTypeCounts: Record<string, number>;
}

export interface AnthropicSSEParseResult extends StreamParseResult<
  Message,
  AnthropicStreamContext
> {
  events: ParsedEvent[];
  finalResponse: Message | null;
  context: AnthropicStreamContext;
}

const getEventType = (data: unknown): string => {
  if (data && typeof data === "object" && "type" in data) {
    const type = (data as { type?: unknown }).type;
    if (typeof type === "string") return type;
  }
  return "unknown";
};

const incrementCount = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

export function parseStreamingEventData(
  data: unknown,
  eventName?: string,
): ParsedEvent {
  const validationResult = streamEventSchema.safeParse(data);
  return {
    event: eventName || getEventType(data),
    data,
    validationResult,
  };
}

/**
 * Apply a single (validated) event to a running `AnthropicStreamContext`.
 * Mutates `ctx` in place and returns the (possibly updated) `finalMessage`.
 */
function applyEvent(ctx: AnthropicStreamContext, event: StreamEvent): void {
  incrementCount(ctx.eventTypeCounts, event.type);

  switch (event.type) {
    case "message_start": {
      ctx.finalMessage = event.message as Message;
      break;
    }
    case "content_block_start": {
      const block = event.content_block;
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        (block as { type?: unknown }).type === "tool_use"
      ) {
        ctx.toolUseIndices.add(event.index);
        ctx.toolInputJsonByIndex[event.index] = "";
        const name = (block as { name?: unknown }).name;
        if (typeof name === "string") {
          ctx.toolNamesByIndex[event.index] = name;
        }
      }
      break;
    }
    case "content_block_delta": {
      if (event.delta.type === "input_json_delta") {
        const prev = ctx.toolInputJsonByIndex[event.index] ?? "";
        ctx.toolInputJsonByIndex[event.index] = prev + event.delta.partial_json;
      }
      break;
    }
    case "message_delta": {
      // Merge `delta.stop_reason` / `delta.stop_sequence` and `usage` into the
      // running final message so callers get a fully-populated `Message`.
      if (ctx.finalMessage) {
        const merged: Record<string, unknown> = {
          ...(ctx.finalMessage as unknown as Record<string, unknown>),
        };
        if ("stop_reason" in event.delta) {
          merged.stop_reason = event.delta.stop_reason;
        }
        if ("stop_sequence" in event.delta) {
          merged.stop_sequence = event.delta.stop_sequence;
        }
        const existingUsage =
          (merged.usage as Record<string, unknown> | undefined) ?? {};
        merged.usage = {
          ...existingUsage,
          ...(event.usage as Record<string, unknown>),
        };
        ctx.finalMessage = merged as unknown as Message;
      }
      break;
    }
    case "message_stop": {
      ctx.sawMessageStop = true;
      break;
    }
    // ping, error, content_block_stop: no state to update
    default:
      break;
  }
}

export async function parseSSEStream(
  response: Response,
): Promise<AnthropicSSEParseResult> {
  const events: ParsedEvent[] = [];
  const errors: string[] = [];
  const context: AnthropicStreamContext = {
    finalMessage: null,
    toolInputJsonByIndex: {},
    toolUseIndices: new Set<number>(),
    toolNamesByIndex: {},
    sawMessageStop: false,
    eventTypeCounts: {},
  };

  if (!response.body) {
    return {
      events,
      errors: ["No response body"],
      finalResponse: null,
      context,
    };
  }

  for await (const { event: eventName, data } of parseSSELines(response)) {
    if (data === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      errors.push(`Failed to parse event data: ${data}`);
      continue;
    }

    const parsedEvent = parseStreamingEventData(parsed, eventName);
    events.push(parsedEvent);

    if (!parsedEvent.validationResult.success) {
      errors.push(
        `Event validation failed for ${parsedEvent.event}: ${JSON.stringify(parsedEvent.validationResult.error.issues)}`,
      );
      continue;
    }

    // Anthropic always sends an `event:` line; assert it matches the JSON
    // `type`. A mismatch is a wire-format violation.
    const dataType = (parsedEvent.validationResult.data as { type: string })
      .type;
    if (eventName && eventName !== dataType) {
      errors.push(
        `SSE event line "${eventName}" does not match JSON type "${dataType}"`,
      );
    }

    applyEvent(context, parsedEvent.validationResult.data);
  }

  return {
    events,
    errors,
    finalResponse: context.finalMessage,
    context,
  };
}
