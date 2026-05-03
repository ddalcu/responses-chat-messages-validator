import { chatCompletionSchema } from "../../../generated/kubb/chat-completions/zod/chatCompletionSchema";
import { formatZodIssues } from "../core/validators";
import type { ResponseValidator, ValidateResponseOutcome } from "../core/types";
import type {
  ChatCompletion,
  ChatCompletionsStreamContext,
} from "./sse-events";

/**
 * Top-level `validateResponse` for the Chat Completions suite. Used by the
 * generic core to schema-check the response body before per-template
 * validators run.
 */
export const validateChatCompletion = (
  raw: unknown,
): ValidateResponseOutcome<ChatCompletion> => {
  const parseResult = chatCompletionSchema.safeParse(raw);
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

const firstChoice = (response: ChatCompletion) => response.choices[0];

export const hasFirstChoice: ResponseValidator<
  ChatCompletion,
  ChatCompletionsStreamContext
> = (response) => {
  if (!response.choices || response.choices.length === 0) {
    return ["Response has no choices"];
  }
  return [];
};

export const assistantRole: ResponseValidator<
  ChatCompletion,
  ChatCompletionsStreamContext
> = (response) => {
  const choice = firstChoice(response);
  if (!choice) return ["Response has no choices"];
  if (choice.message.role !== "assistant") {
    return [
      `Expected choices[0].message.role to be "assistant" but got "${choice.message.role}"`,
    ];
  }
  return [];
};

export const nonEmptyContent: ResponseValidator<
  ChatCompletion,
  ChatCompletionsStreamContext
> = (response) => {
  const choice = firstChoice(response);
  if (!choice) return ["Response has no choices"];
  const content = choice.message.content;
  if (typeof content !== "string" || content.length === 0) {
    return [
      "Expected choices[0].message.content to be a non-empty string but it was empty or absent",
    ];
  }
  return [];
};

export const finishReasonIs =
  (
    expected: NonNullable<
      NonNullable<ChatCompletion["choices"][number]["finish_reason"]>
    >,
  ): ResponseValidator<ChatCompletion, ChatCompletionsStreamContext> =>
  (response) => {
    const choice = firstChoice(response);
    if (!choice) return ["Response has no choices"];
    if (choice.finish_reason !== expected) {
      return [
        `Expected choices[0].finish_reason to be "${expected}" but got ${
          choice.finish_reason === null ? "null" : `"${choice.finish_reason}"`
        }`,
      ];
    }
    return [];
  };

export const hasToolCallNamed =
  (
    name: string,
  ): ResponseValidator<ChatCompletion, ChatCompletionsStreamContext> =>
  (response) => {
    const choice = firstChoice(response);
    if (!choice) return ["Response has no choices"];
    const toolCalls = choice.message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return ["Expected choices[0].message.tool_calls to be non-empty"];
    }
    const first = toolCalls[0];
    if (!first || first.function.name !== name) {
      return [
        `Expected choices[0].message.tool_calls[0].function.name to be "${name}" but got "${
          first?.function.name ?? "<missing>"
        }"`,
      ];
    }
    return [];
  };

export const toolCallArgumentsHaveField =
  (
    field: string,
  ): ResponseValidator<ChatCompletion, ChatCompletionsStreamContext> =>
  (response) => {
    const choice = firstChoice(response);
    if (!choice) return ["Response has no choices"];
    const first = choice.message.tool_calls?.[0];
    if (!first) {
      return ["Expected choices[0].message.tool_calls[0] to be present"];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(first.function.arguments);
    } catch (err) {
      return [
        `choices[0].message.tool_calls[0].function.arguments is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ];
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [
        "choices[0].message.tool_calls[0].function.arguments did not parse to a JSON object",
      ];
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, field)) {
      return [
        `choices[0].message.tool_calls[0].function.arguments JSON object missing required field "${field}"`,
      ];
    }
    return [];
  };

export const contentParsesAsJson: ResponseValidator<
  ChatCompletion,
  ChatCompletionsStreamContext
> = (response) => {
  const choice = firstChoice(response);
  if (!choice) return ["Response has no choices"];
  const content = choice.message.content;
  if (typeof content !== "string" || content.length === 0) {
    return [
      "Expected choices[0].message.content to be a non-empty JSON string",
    ];
  }
  try {
    JSON.parse(content);
  } catch (err) {
    return [
      `choices[0].message.content is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    ];
  }
  return [];
};

/* ----- Streaming-only validators ----- */

export const streamingHasContentDelta: ResponseValidator<
  ChatCompletion,
  ChatCompletionsStreamContext
> = (_response, context) => {
  if (!context.streaming || !context.sseResult) return [];
  const ctx = context.sseResult.context;
  if (!ctx) return ["Streaming context missing"];
  const anyContent = Array.from(ctx.contentByChoice.values()).some(
    (s) => s.length > 0,
  );
  if (!anyContent) {
    return [
      "Expected at least one streaming chunk with non-empty choices[0].delta.content but none were observed",
    ];
  }
  return [];
};

export const streamingDoneSeen: ResponseValidator<
  ChatCompletion,
  ChatCompletionsStreamContext
> = (_response, context) => {
  if (!context.streaming || !context.sseResult) return [];
  const ctx = context.sseResult.context;
  if (!ctx?.doneSeen) {
    return ["Expected terminal `data: [DONE]` line but it was not observed"];
  }
  return [];
};

export const streamingChunksValid: ResponseValidator<
  ChatCompletion,
  ChatCompletionsStreamContext
> = (_response, context) => {
  if (!context.streaming || !context.sseResult) return [];
  return context.sseResult.errors;
};

export const streamingHasEvents: ResponseValidator<
  ChatCompletion,
  ChatCompletionsStreamContext
> = (_response, context) => {
  if (!context.streaming || !context.sseResult) return [];
  if (context.sseResult.events.length === 0) {
    return ["No streaming events received"];
  }
  return [];
};

export const streamingToolArgumentsAreJson: ResponseValidator<
  ChatCompletion,
  ChatCompletionsStreamContext
> = (_response, context) => {
  if (!context.streaming || !context.sseResult) return [];
  const ctx = context.sseResult.context;
  if (!ctx) return ["Streaming context missing"];

  if (ctx.toolCallsByChoice.size === 0) {
    return ["Expected streaming tool_calls deltas but none were observed"];
  }

  const errors: string[] = [];
  for (const [choiceIdx, perChoice] of ctx.toolCallsByChoice) {
    if (perChoice.size === 0) {
      errors.push(
        `choice ${choiceIdx} reassembled tool_calls map is empty after streaming`,
      );
      continue;
    }
    for (const [tcIdx, tc] of perChoice) {
      if (tc.arguments.length === 0) {
        errors.push(
          `choice ${choiceIdx} tool_call ${tcIdx} reassembled arguments string is empty`,
        );
        continue;
      }
      try {
        JSON.parse(tc.arguments);
      } catch (err) {
        errors.push(
          `choice ${choiceIdx} tool_call ${tcIdx} reassembled arguments are not valid JSON: ${
            err instanceof Error ? err.message : String(err)
          } — got: ${tc.arguments}`,
        );
      }
    }
  }

  return errors;
};
