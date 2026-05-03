import type { SpecSuite } from "../core/types";
import type { AnthropicStreamContext } from "./sse-events";
import { parseSSEStream } from "./sse-events";
import {
  anthropicMessagesTemplates,
  type AnthropicMessagesRequestBody,
} from "./templates";
import type { ParsedResponse } from "./validators";
import { validateMessageResource } from "./validators";

export const anthropicMessagesSuite: SpecSuite<
  AnthropicMessagesRequestBody,
  ParsedResponse,
  AnthropicStreamContext
> = {
  id: "anthropic-messages",
  label: "Anthropic Messages",
  defaultBaseUrl: "https://api.anthropic.com",
  defaultModel: "claude-sonnet-4-5",
  defaultAuthHeaderName: "x-api-key",
  defaultUseBearerPrefix: false,
  defaultEndpoint: "/v1/messages",
  extraHeaders: () => ({ "anthropic-version": "2023-06-01" }),
  templates: anthropicMessagesTemplates,
  parseStream: parseSSEStream,
  validateResponse: validateMessageResource,
};
