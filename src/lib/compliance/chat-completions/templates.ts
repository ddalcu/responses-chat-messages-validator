import type { z } from "zod";
import type { createChatCompletionRequestSchema } from "../../../generated/kubb/chat-completions/zod/createChatCompletionRequestSchema";
import type { TestTemplate } from "../core/types";
import type {
  ChatCompletion,
  ChatCompletionsStreamContext,
} from "./sse-events";
import {
  assistantRole,
  contentParsesAsJson,
  finishReasonIs,
  hasFirstChoice,
  hasToolCallNamed,
  nonEmptyContent,
  streamingChunksValid,
  streamingDoneSeen,
  streamingHasContentDelta,
  streamingHasEvents,
  streamingToolArgumentsAreJson,
  toolCallArgumentsHaveField,
} from "./validators";

type CreateChatCompletionRequest = z.infer<
  typeof createChatCompletionRequestSchema
>;
export type ChatCompletionsRequestBody = Partial<CreateChatCompletionRequest> &
  Record<string, unknown>;

export type ChatCompletionsTestTemplate = TestTemplate<
  ChatCompletionsRequestBody,
  ChatCompletion,
  ChatCompletionsStreamContext
>;

const weatherTool = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get the current weather for a location.",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "The city and country, e.g. Paris, France",
        },
      },
      required: ["location"],
    },
  },
};

export const chatCompletionsTemplates: ChatCompletionsTestTemplate[] = [
  {
    id: "basic-completion",
    name: "Basic Completion",
    description:
      "Single user message; validates ChatCompletion schema, assistant role, non-empty content, and finish_reason=stop",
    getRequest: (config) => ({
      model: config.model,
      messages: [{ role: "user", content: "Say hello in 3 words" }],
    }),
    validators: [
      hasFirstChoice,
      assistantRole,
      nonEmptyContent,
      finishReasonIs("stop"),
    ],
  },

  {
    id: "system-prompt",
    name: "System Prompt",
    description:
      "System message + user message; validates response shape only (does not assert lowercase content as that is model behaviour)",
    getRequest: (config) => ({
      model: config.model,
      messages: [
        {
          role: "system",
          content: "You only answer in lowercase.",
        },
        { role: "user", content: "What is 2+2?" },
      ],
    }),
    validators: [hasFirstChoice, assistantRole, nonEmptyContent],
  },

  {
    id: "streaming-completion",
    name: "Streaming Completion",
    description:
      "stream:true; validates >=1 chunk has non-empty delta.content, terminal [DONE] is observed, and every chunk parses cleanly",
    streaming: true,
    getRequest: (config) => ({
      model: config.model,
      messages: [{ role: "user", content: "Count from 1 to 5." }],
    }),
    validators: [
      streamingHasEvents,
      streamingChunksValid,
      streamingHasContentDelta,
      streamingDoneSeen,
    ],
  },

  {
    id: "multi-turn",
    name: "Multi-turn Conversation",
    description:
      "Interleaved user/assistant history; validates assistant continuation",
    getRequest: (config) => ({
      model: config.model,
      messages: [
        { role: "user", content: "My name is Alice." },
        {
          role: "assistant",
          content: "Hello Alice! Nice to meet you. How can I help you today?",
        },
        { role: "user", content: "What is my name?" },
      ],
    }),
    validators: [hasFirstChoice, assistantRole, nonEmptyContent],
  },

  {
    id: "tool-calling",
    name: "Tool Calling",
    description:
      "Defines a get_weather function tool; expects the model to emit a tool_calls entry with finish_reason=tool_calls",
    getRequest: (config) => ({
      model: config.model,
      messages: [{ role: "user", content: "What's the weather in Paris?" }],
      tools: [weatherTool],
      tool_choice: "auto",
    }),
    validators: [
      hasFirstChoice,
      assistantRole,
      hasToolCallNamed("get_weather"),
      toolCallArgumentsHaveField("location"),
      finishReasonIs("tool_calls"),
    ],
  },

  {
    id: "tool-result-followup",
    name: "Tool Result Followup",
    description:
      "Submits a multi-turn conversation where the second turn carries role:tool with tool_call_id; expects a normal text completion with finish_reason=stop",
    getRequest: (config) => ({
      model: config.model,
      messages: [
        { role: "user", content: "What's the weather in Paris?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_compliance_test_1",
              type: "function" as const,
              function: {
                name: "get_weather",
                arguments: JSON.stringify({ location: "Paris, France" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_compliance_test_1",
          content: JSON.stringify({
            location: "Paris, France",
            temperature_c: 18,
            condition: "partly cloudy",
          }),
        },
      ],
      tools: [weatherTool],
    }),
    validators: [
      hasFirstChoice,
      assistantRole,
      nonEmptyContent,
      finishReasonIs("stop"),
    ],
  },

  {
    id: "json-mode",
    name: "JSON Mode",
    description:
      "response_format:{type:json_object}; validates that choices[0].message.content parses as JSON",
    getRequest: (config) => ({
      model: config.model,
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant that only outputs valid JSON. Always respond in JSON.",
        },
        {
          role: "user",
          content:
            'Respond with a JSON object describing the colour blue with keys "name" and "hex".',
        },
      ],
      response_format: { type: "json_object" },
    }),
    validators: [
      hasFirstChoice,
      assistantRole,
      contentParsesAsJson,
      finishReasonIs("stop"),
    ],
  },

  {
    id: "streaming-tool-calls",
    name: "Streaming Tool Calls",
    description:
      "Streaming + tools; validates that reassembled tool_calls[].function.arguments concatenated across deltas parses as valid JSON",
    streaming: true,
    getRequest: (config) => ({
      model: config.model,
      messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
      tools: [weatherTool],
      tool_choice: "auto",
    }),
    validators: [
      streamingHasEvents,
      streamingChunksValid,
      streamingDoneSeen,
      streamingToolArgumentsAreJson,
    ],
  },
];
