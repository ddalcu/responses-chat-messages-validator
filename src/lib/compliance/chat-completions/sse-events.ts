import { z } from "zod";
import { chatCompletionChunkSchema } from "../../../generated/kubb/chat-completions/zod/chatCompletionChunkSchema";
import type { chatCompletionSchema } from "../../../generated/kubb/chat-completions/zod/chatCompletionSchema";
import { parseSSELines } from "../core/sse";
import type { StreamParseResult } from "../core/types";

export type ChatCompletionChunk = z.infer<typeof chatCompletionChunkSchema>;
export type ChatCompletion = z.infer<typeof chatCompletionSchema>;

export interface ParsedChunkEvent {
  data: unknown;
  validationResult: z.SafeParseReturnType<unknown, ChatCompletionChunk>;
}

/**
 * Streaming context for chat-completions. The runner stays generic, but
 * per-template validators reach into `streamCtx` for accumulated data such as
 * the reassembled tool-call arguments and per-choice content text.
 */
export interface ChatCompletionsStreamContext {
  /** Saw the literal `data: [DONE]` terminator. */
  doneSeen: boolean;
  /** Concatenated text content per `choices[].index`. */
  contentByChoice: Map<number, string>;
  /**
   * Reassembled tool call data per `choices[].index` -> `tool_calls[].index`.
   * Each delta increments the `arguments` string and may overwrite `name`.
   */
  toolCallsByChoice: Map<
    number,
    Map<
      number,
      {
        id?: string;
        name?: string;
        arguments: string;
      }
    >
  >;
  /** Collected `finish_reason` values across all chunks. */
  finishReasons: Array<string | null | undefined>;
}

export interface ChatCompletionsSSEParseResult extends StreamParseResult<
  ChatCompletion,
  ChatCompletionsStreamContext
> {
  events: ParsedChunkEvent[];
  finalResponse: ChatCompletion | null;
  context: ChatCompletionsStreamContext;
}

const emptyContext = (): ChatCompletionsStreamContext => ({
  doneSeen: false,
  contentByChoice: new Map(),
  toolCallsByChoice: new Map(),
  finishReasons: [],
});

const accumulateChunk = (
  ctx: ChatCompletionsStreamContext,
  chunk: ChatCompletionChunk,
): void => {
  for (const choice of chunk.choices) {
    const idx = choice.index;
    const delta = choice.delta;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      ctx.contentByChoice.set(
        idx,
        (ctx.contentByChoice.get(idx) ?? "") + delta.content,
      );
    }

    if (delta.tool_calls && delta.tool_calls.length > 0) {
      let perChoice = ctx.toolCallsByChoice.get(idx);
      if (!perChoice) {
        perChoice = new Map();
        ctx.toolCallsByChoice.set(idx, perChoice);
      }
      for (const tc of delta.tool_calls) {
        const existing = perChoice.get(tc.index) ?? { arguments: "" };
        if (typeof tc.id === "string") existing.id = tc.id;
        if (tc.function?.name !== undefined) existing.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") {
          existing.arguments += tc.function.arguments;
        }
        perChoice.set(tc.index, existing);
      }
    }

    if (choice.finish_reason !== undefined) {
      ctx.finishReasons.push(choice.finish_reason);
    }
  }
};

/**
 * Synthesizes a `ChatCompletion`-shaped object from the accumulated streaming
 * chunks. The wire never sends a terminal completion payload during streaming
 * (only chunks + `[DONE]`), but the generic runner expects `finalResponse` to
 * carry a schema-checkable response so the suite's `validateResponse` and
 * per-template validators execute. We reconstruct a non-streaming
 * `ChatCompletion` from the last seen chunk metadata + accumulated content
 * and tool calls.
 */
const synthesizeFinalResponse = (
  lastChunk: ChatCompletionChunk | null,
  ctx: ChatCompletionsStreamContext,
): ChatCompletion | null => {
  if (!lastChunk) return null;

  const choices: ChatCompletion["choices"] = lastChunk.choices.map((c) => {
    const idx = c.index;
    const content = ctx.contentByChoice.get(idx) ?? null;
    const toolMap = ctx.toolCallsByChoice.get(idx);
    const toolCalls = toolMap
      ? Array.from(toolMap.entries())
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => ({
            id: tc.id ?? "",
            type: "function" as const,
            function: {
              name: tc.name ?? "",
              arguments: tc.arguments,
            },
          }))
      : undefined;

    return {
      index: idx,
      message: {
        role: "assistant" as const,
        content,
        tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      },
      finish_reason: c.finish_reason ?? null,
    };
  });

  return {
    id: lastChunk.id,
    object: "chat.completion",
    created: lastChunk.created,
    model: lastChunk.model,
    system_fingerprint: lastChunk.system_fingerprint,
    service_tier: lastChunk.service_tier,
    choices,
    usage: lastChunk.usage ?? undefined,
  };
};

/**
 * Parses a `text/event-stream` body of `chat.completion.chunk` payloads. The
 * literal `data: [DONE]` line is terminal; any other unparseable JSON or
 * Zod-failing chunk is recorded as an error but does not stop parsing.
 */
export async function parseSSEStream(
  response: Response,
): Promise<ChatCompletionsSSEParseResult> {
  const events: ParsedChunkEvent[] = [];
  const errors: string[] = [];
  const context = emptyContext();
  let lastValidChunk: ChatCompletionChunk | null = null;

  if (!response.body) {
    return {
      events,
      errors: ["No response body"],
      finalResponse: null,
      context,
    };
  }

  for await (const { data } of parseSSELines(response)) {
    if (data === "[DONE]") {
      context.doneSeen = true;
      // [DONE] is terminal — stop draining further frames.
      break;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      errors.push(`Failed to parse chunk JSON: ${data}`);
      continue;
    }

    const validationResult = chatCompletionChunkSchema.safeParse(parsed);
    events.push({ data: parsed, validationResult });

    if (!validationResult.success) {
      errors.push(
        `Chunk validation failed: ${JSON.stringify(validationResult.error.issues)}`,
      );
      continue;
    }

    accumulateChunk(context, validationResult.data);
    lastValidChunk = validationResult.data;
  }

  return {
    events,
    errors,
    finalResponse: synthesizeFinalResponse(lastValidChunk, context),
    context,
  };
}
