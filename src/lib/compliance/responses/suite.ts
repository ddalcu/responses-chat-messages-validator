import type { SpecSuite } from "../core/types";
import { parseSSEStream } from "./sse-events";
import { responsesTemplates, type ResponsesRequestBody } from "./templates";
import type { ParsedResponse } from "./validators";
import { validateResponseResource } from "./validators";

export const responsesSuite: SpecSuite<
  ResponsesRequestBody,
  ParsedResponse,
  unknown
> = {
  id: "responses",
  label: "OpenAI Responses",
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-4o-mini",
  defaultAuthHeaderName: "Authorization",
  defaultUseBearerPrefix: true,
  defaultEndpoint: "/responses",
  templates: responsesTemplates,
  parseStream: parseSSEStream,
  validateResponse: validateResponseResource,
};
