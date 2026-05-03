import { compactResourceSchema } from "../../../generated/kubb/responses/zod/compactResourceSchema";
import type { createResponseBodySchema } from "../../../generated/kubb/responses/zod/createResponseBodySchema";
import type { z } from "zod";
import type { TestTemplate } from "../core/types";
import type { ParsedResponse } from "./validators";
import {
  compactObject,
  completedStatus,
  hasAssistantMessagePhase,
  hasOutput,
  hasOutputType,
  streamingEvents,
  streamingSchema,
  webSocketBrowserUnsupported,
} from "./validators";
import {
  runWebSocketBasicTest,
  runWebSocketCompactNewChainTest,
  runWebSocketContinuationTest,
  runWebSocketFailedContinuationEvictsCacheTest,
  runWebSocketPreviousResponseNotFoundTest,
  runWebSocketReconnectStoreFalseRecoveryTest,
  runWebSocketSequentialResponsesTest,
} from "./websocket";

type CreateResponseBody = z.infer<typeof createResponseBodySchema>;
export type ResponsesRequestBody = Partial<CreateResponseBody> &
  Record<string, unknown>;

export type ResponsesTestTemplate = TestTemplate<
  ResponsesRequestBody,
  ParsedResponse,
  unknown
>;

export const responsesTemplates: ResponsesTestTemplate[] = [
  {
    id: "basic-response",
    name: "Basic Text Response",
    description: "Simple user message, validates ResponseResource schema",
    getRequest: (config) => ({
      model: config.model,
      input: [
        {
          type: "message",
          role: "user",
          content: "Say hello in exactly 3 words.",
        },
      ],
    }),
    validators: [hasOutput, completedStatus],
  },

  {
    id: "assistant-phase",
    name: "Assistant Message Phase",
    description:
      "Sends assistant history with phase labels and validates contract acceptance",
    getRequest: (config) => ({
      model: config.model,
      input: [
        {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: "I should answer with the saved number.",
        },
        {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: "The number is four.",
        },
        {
          type: "message",
          role: "user",
          content: "Repeat only the number.",
        },
      ],
    }),
    validators: [hasOutput, completedStatus],
  },

  {
    id: "response-output-phase-schema",
    name: "Response Output Phase Schema",
    description:
      "Validates ResponseResource schema support for assistant output phase labels",
    getRequest: (config) => ({
      model: config.model,
      note: "Local schema fixture; no HTTP request is sent.",
    }),
    getMockResponse: (config) => ({
      id: "resp_phase_schema",
      object: "response",
      created_at: 1764967971,
      completed_at: 1764967972,
      status: "completed",
      incomplete_details: null,
      model: config.model,
      previous_response_id: null,
      instructions: null,
      output: [
        {
          id: "msg_phase_commentary",
          type: "message",
          status: "completed",
          role: "assistant",
          phase: "commentary",
          content: [
            {
              type: "output_text",
              text: "I am checking the answer.",
              annotations: [],
            },
          ],
        },
        {
          id: "msg_phase_final",
          type: "message",
          status: "completed",
          role: "assistant",
          phase: "final_answer",
          content: [
            {
              type: "output_text",
              text: "The answer is four.",
              annotations: [],
            },
          ],
        },
      ],
      error: null,
      tools: [],
      tool_choice: "auto",
      truncation: "disabled",
      parallel_tool_calls: true,
      text: {
        format: {
          type: "text",
        },
      },
      top_p: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_logprobs: 0,
      temperature: 1,
      reasoning: {
        effort: null,
        summary: null,
      },
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        total_tokens: 3,
        input_tokens_details: {
          cached_tokens: 0,
        },
        output_tokens_details: {
          reasoning_tokens: 0,
        },
      },
      max_output_tokens: null,
      max_tool_calls: null,
      store: true,
      background: false,
      service_tier: "default",
      metadata: {},
      safety_identifier: null,
      prompt_cache_key: null,
    }),
    validators: [
      hasOutput,
      completedStatus,
      hasAssistantMessagePhase("commentary"),
      hasAssistantMessagePhase("final_answer"),
    ],
  },

  {
    id: "streaming-response",
    name: "Streaming Response",
    description: "Validates SSE streaming events and final response",
    streaming: true,
    getRequest: (config) => ({
      model: config.model,
      input: [{ type: "message", role: "user", content: "Count from 1 to 5." }],
    }),
    validators: [streamingEvents, streamingSchema, completedStatus],
  },

  {
    id: "websocket-response",
    name: "WebSocket Response",
    description:
      "Creates a response over WebSocket and validates returned streaming events",
    transport: "websocket",
    streaming: true,
    unsupportedReason: webSocketBrowserUnsupported,
    getRequest: (config) => ({
      type: "response.create",
      model: config.model,
      input: [{ type: "message", role: "user", content: "Count from 1 to 3." }],
    }),
    validators: [streamingEvents, streamingSchema, completedStatus],
    run: runWebSocketBasicTest,
  },

  {
    id: "websocket-sequential-responses",
    name: "WebSocket Sequential Responses",
    description:
      "Sends multiple response.create messages on one WebSocket connection and validates sequential terminal responses",
    transport: "websocket",
    streaming: true,
    unsupportedReason: webSocketBrowserUnsupported,
    getRequest: (config) => ({
      type: "response.create",
      model: config.model,
      store: false,
      input: "Reply with exactly: first",
    }),
    validators: [streamingEvents, streamingSchema, completedStatus],
    run: runWebSocketSequentialResponsesTest,
  },

  {
    id: "websocket-continuation",
    name: "WebSocket Continuation",
    description:
      "Continues a store:false response on the active WebSocket using previous_response_id and only new input",
    transport: "websocket",
    streaming: true,
    unsupportedReason: webSocketBrowserUnsupported,
    getRequest: (config) => ({
      type: "response.create",
      model: config.model,
      store: false,
      input: "Remember the code word: cobalt. Reply with OK.",
    }),
    validators: [streamingEvents, streamingSchema, completedStatus],
    run: runWebSocketContinuationTest,
  },

  {
    id: "websocket-reconnect-store-false-recovery",
    name: "WebSocket Store False Reconnect Recovery",
    description:
      "Creates a store:false response, reconnects on a new WebSocket, validates previous_response_not_found, then starts a clean recovery response",
    transport: "websocket",
    streaming: true,
    unsupportedReason: webSocketBrowserUnsupported,
    getRequest: (config) => ({
      type: "response.create",
      model: config.model,
      store: false,
      input: "Remember the code word: copper. Reply with OK.",
    }),
    validators: [],
    run: runWebSocketReconnectStoreFalseRecoveryTest,
  },

  {
    id: "websocket-previous-response-not-found",
    name: "WebSocket Missing Previous Response",
    description:
      "Verifies store:false continuation with an uncached previous_response_id returns previous_response_not_found",
    transport: "websocket",
    streaming: true,
    unsupportedReason: webSocketBrowserUnsupported,
    getRequest: (config) => ({
      type: "response.create",
      model: config.model,
      store: false,
      previous_response_id: `resp_openresponses_missing_${Date.now()}`,
      input: "This should fail because the previous response is missing.",
    }),
    validators: [],
    run: runWebSocketPreviousResponseNotFoundTest,
  },

  {
    id: "websocket-failed-continuation-evicts-cache",
    name: "WebSocket Failed Continuation Evicts Cache",
    description:
      "Fails a store:false continuation and verifies the referenced previous_response_id is evicted from connection-local state",
    transport: "websocket",
    streaming: true,
    unsupportedReason: webSocketBrowserUnsupported,
    getRequest: (config) => ({
      type: "response.create",
      model: config.model,
      store: false,
      input: "Remember the code word: ember. Reply with OK.",
    }),
    validators: [],
    run: runWebSocketFailedContinuationEvictsCacheTest,
  },

  {
    id: "websocket-compact-new-chain",
    name: "WebSocket Compact New Chain",
    description:
      "Uses /responses/compact output as the base input for a new WebSocket response without previous_response_id",
    transport: "websocket",
    streaming: true,
    unsupportedReason: webSocketBrowserUnsupported,
    getRequest: (config) => ({
      type: "response.create",
      model: config.model,
      store: false,
      input: "This seed request only validates the WebSocket schema.",
    }),
    validators: [streamingEvents, streamingSchema, completedStatus],
    run: runWebSocketCompactNewChainTest,
  },

  {
    id: "system-prompt",
    name: "System Prompt",
    description: "Include system role message in input",
    getRequest: (config) => ({
      model: config.model,
      input: [
        {
          type: "message",
          role: "system",
          content: "You are a pirate. Always respond in pirate speak.",
        },
        { type: "message", role: "user", content: "Say hello." },
      ],
    }),
    validators: [hasOutput, completedStatus],
  },

  {
    id: "tool-calling",
    name: "Tool Calling",
    description: "Define a function tool and verify function_call output",
    getRequest: (config) => ({
      model: config.model,
      input: [
        {
          type: "message",
          role: "user",
          content: "What's the weather like in San Francisco?",
        },
      ],
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get the current weather for a location",
          parameters: {
            type: "object",
            properties: {
              location: {
                type: "string",
                description: "The city and state, e.g. San Francisco, CA",
              },
            },
            required: ["location"],
          },
        },
      ],
    }),
    validators: [hasOutput, hasOutputType("function_call")],
  },

  {
    id: "image-input",
    name: "Image Input",
    description: "Send image URL in user content",
    getRequest: (config) => ({
      model: config.model,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "What do you see in this image? Answer in one sentence.",
            },
            {
              type: "input_image",
              image_url:
                // a red heart icon on a white background
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAABmklEQVR42tyWAaTyUBzFew/eG4AHz+MBSAHKBiJRGFKwIgQQJKLUIioBIhCAiCAAEizAQIAECaASqFFJq84nudjnaqvuPnxzgP9xfrq5938csPn7PwHTKSoViCIEAYEAMhmoKsU2mUCWEQqB5xEMIp/HaGQG2G6RSuH9HQ7H34rFrtPbdz4jl6PbwmEsl3QA1mt4vcRKk8dz9eg6IpF7tt9fzGY0gCgafFRFo5Blc5vLhf3eCOj1yNhM5GRMVK0aATxPZoz09YXjkQDmczJgquGQAPp9WwCNBgG027YACgUC6HRsAZRKBDAY2AJoNv/ZnwzA6WScznG3p4UAymXGAEkyXrTFAh8fLAGqagQAyGaZpYsi7bHTNPz8MEj//LxuFPo+UBS8vb0KaLXubrRa7aX0RMLCykwmn0z3+XA4WACcTpCkh9MFAZpmuVXo+mO/w+/HZvNgbblcUCxaSo/Hyck80Yu6XXDcvfVZr79cvMZjuN2U9O9vKAqjZrfbIZ0mV4TUi9Xqz6jddNy//7+e3n8Fhf/Llo2kxi8AQyGRoDkmAhAAAAAASUVORK5CYII=",
            },
          ],
        },
      ],
    }),
    validators: [hasOutput, completedStatus],
  },

  {
    id: "multi-turn",
    name: "Multi-turn Conversation",
    description: "Send assistant + user messages as conversation history",
    getRequest: (config) => ({
      model: config.model,
      input: [
        { type: "message", role: "user", content: "My name is Alice." },
        {
          type: "message",
          role: "assistant",
          content: "Hello Alice! Nice to meet you. How can I help you today?",
        },
        { type: "message", role: "user", content: "What is my name?" },
      ],
    }),
    validators: [hasOutput, completedStatus],
  },

  {
    id: "compact-response",
    name: "Compaction Endpoint",
    description:
      "Compacts a short conversation with prompt_cache_key and validates the compacted response schema",
    endpoint: "/responses/compact",
    responseSchema: compactResourceSchema,
    getRequest: (config) => ({
      model: config.model,
      prompt_cache_key: "openresponses-compact-test",
      input: [
        {
          type: "message",
          role: "user",
          content: "We agreed to launch on Tuesday and notify support first.",
        },
        {
          type: "message",
          role: "assistant",
          content:
            "Understood. The launch is Tuesday, with support notified beforehand.",
        },
      ],
    }),
    validators: [hasOutput, compactObject, hasOutputType("compaction")],
  },

  {
    id: "compact-missing-model",
    name: "Compaction Missing Required Model",
    description:
      "Rejects a compact request that omits the required model field",
    endpoint: "/responses/compact",
    expectedStatuses: [400, 422],
    responseSchema: null,
    getRequest: () => ({
      input: [
        {
          type: "message",
          role: "user",
          content: "Compact this conversation.",
        },
      ],
    }),
  },
];
