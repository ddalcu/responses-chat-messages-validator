import type { z } from "zod";
import type { createMessageBodySchema } from "../../../generated/kubb/anthropic-messages/zod/createMessageBodySchema";
import type { TestTemplate } from "../core/types";
import type { AnthropicStreamContext } from "./sse-events";
import type { ParsedResponse } from "./validators";
import {
  firstContentTypeIs,
  hasContent,
  hasContentType,
  isAssistantMessage,
  reassembledToolInputIsValidJson,
  requiredStreamSequence,
  stopReasonIs,
  streamingEvents,
  streamingSchema,
  toolUseHasName,
} from "./validators";

type CreateMessageBody = z.infer<typeof createMessageBodySchema>;
export type AnthropicMessagesRequestBody = Partial<CreateMessageBody> &
  Record<string, unknown>;

export type AnthropicMessagesTestTemplate = TestTemplate<
  AnthropicMessagesRequestBody,
  ParsedResponse,
  AnthropicStreamContext
>;

/**
 * 1×1 transparent PNG, base64-encoded. Used by the `image-input` template so
 * the test does not require any external network fetch.
 */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const WEATHER_TOOL = {
  name: "get_weather",
  description: "Get the current weather for a given location.",
  input_schema: {
    type: "object" as const,
    properties: {
      location: {
        type: "string",
        description: "The city and state, e.g. San Francisco, CA",
      },
    },
    required: ["location"],
  },
};

/**
 * Validates the JSON object that streaming reassembled `partial_json` should
 * produce for the `streaming-tool-use` test: must be an object with a
 * `location` string property.
 */
const validateWeatherToolInput = (parsed: unknown): string[] => {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ["Reassembled tool input is not a JSON object"];
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.location !== "string" || obj.location.length === 0) {
    return [
      'Reassembled tool input does not match `get_weather` input_schema (missing or empty "location" string)',
    ];
  }
  return [];
};

export const anthropicMessagesTemplates: AnthropicMessagesTestTemplate[] = [
  {
    id: "basic-message",
    name: "Basic Message",
    description: "Simple user message, validates Message schema",
    getRequest: (config) => ({
      model: config.model,
      max_tokens: 64,
      messages: [{ role: "user", content: "Say hello in 3 words." }],
    }),
    validators: [
      isAssistantMessage,
      hasContent,
      firstContentTypeIs("text"),
      stopReasonIs("end_turn"),
    ],
  },

  {
    id: "system-prompt",
    name: "System Prompt",
    description: "Top-level `system` field, validates valid Message response",
    getRequest: (config) => ({
      model: config.model,
      max_tokens: 64,
      system: "You only answer in lowercase.",
      messages: [{ role: "user", content: "Say HELLO." }],
    }),
    validators: [isAssistantMessage, hasContent, stopReasonIs("end_turn")],
  },

  {
    id: "streaming-message",
    name: "Streaming Message",
    description:
      "Validates SSE streaming event sequence and per-event schema parse",
    streaming: true,
    getRequest: (config) => ({
      model: config.model,
      max_tokens: 64,
      messages: [{ role: "user", content: "Count from 1 to 5." }],
    }),
    validators: [
      streamingEvents,
      streamingSchema,
      requiredStreamSequence,
      isAssistantMessage,
    ],
  },

  {
    id: "multi-turn",
    name: "Multi-turn Conversation",
    description: "Alternating user/assistant history",
    getRequest: (config) => ({
      model: config.model,
      max_tokens: 128,
      messages: [
        { role: "user", content: "My name is Alice." },
        {
          role: "assistant",
          content: "Hello Alice! Nice to meet you. How can I help you today?",
        },
        { role: "user", content: "What is my name?" },
      ],
    }),
    validators: [isAssistantMessage, hasContent, stopReasonIs("end_turn")],
  },

  {
    id: "tool-use",
    name: "Tool Use",
    description:
      "Define a function tool and verify a tool_use content block is returned",
    getRequest: (config) => ({
      model: config.model,
      max_tokens: 256,
      tools: [WEATHER_TOOL],
      messages: [
        {
          role: "user",
          content: "What is the weather in San Francisco, CA right now?",
        },
      ],
    }),
    validators: [
      isAssistantMessage,
      hasContent,
      hasContentType("tool_use"),
      toolUseHasName("get_weather"),
      stopReasonIs("tool_use"),
    ],
  },

  {
    id: "tool-result-followup",
    name: "Tool Result Follow-up",
    description:
      "Send a synthetic tool_use turn followed by a tool_result message and assert text continuation",
    getRequest: (config) => ({
      model: config.model,
      max_tokens: 256,
      tools: [WEATHER_TOOL],
      messages: [
        {
          role: "user",
          content: "What is the weather in San Francisco, CA right now?",
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_compliance_1",
              name: "get_weather",
              input: { location: "San Francisco, CA" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_compliance_1",
              content: "sunny, 22C",
            },
          ],
        },
      ],
    }),
    validators: [
      isAssistantMessage,
      hasContent,
      hasContentType("text"),
      stopReasonIs("end_turn"),
    ],
  },

  {
    id: "image-input",
    name: "Image Input",
    description: "Send a base64 image content block + a text prompt",
    getRequest: (config) => ({
      model: config.model,
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: TINY_PNG_BASE64,
              },
            },
            { type: "text", text: "What is in this image?" },
          ],
        },
      ],
    }),
    validators: [isAssistantMessage, hasContent],
  },

  {
    id: "streaming-tool-use",
    name: "Streaming Tool Use",
    description:
      "Streaming + tools: reassembled `input_json_delta.partial_json` must parse as JSON matching the tool input schema",
    streaming: true,
    getRequest: (config) => ({
      model: config.model,
      max_tokens: 256,
      tools: [WEATHER_TOOL],
      messages: [
        {
          role: "user",
          content: "What is the weather in San Francisco, CA right now?",
        },
      ],
    }),
    validators: [
      streamingEvents,
      streamingSchema,
      reassembledToolInputIsValidJson(validateWeatherToolInput),
    ],
  },
];
