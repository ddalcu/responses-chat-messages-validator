import type { SpecSuite } from "../core/types";
import type {
  ChatCompletion,
  ChatCompletionsStreamContext,
} from "./sse-events";
import { parseSSEStream } from "./sse-events";
import {
  chatCompletionsTemplates,
  type ChatCompletionsRequestBody,
} from "./templates";
import { validateChatCompletion } from "./validators";

export const chatCompletionsSuite: SpecSuite<
  ChatCompletionsRequestBody,
  ChatCompletion,
  ChatCompletionsStreamContext
> = {
  id: "chat-completions",
  label: "OpenAI Chat Completions",
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-4o-mini",
  defaultAuthHeaderName: "Authorization",
  defaultUseBearerPrefix: true,
  defaultEndpoint: "/chat/completions",
  templates: chatCompletionsTemplates,
  parseStream: parseSSEStream,
  validateResponse: validateChatCompletion,
  getOutputTokens: (response) => response.usage?.completion_tokens,
};
