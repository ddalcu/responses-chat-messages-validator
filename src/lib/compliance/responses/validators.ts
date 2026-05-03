import { compactResourceSchema } from "../../../generated/kubb/responses/zod/compactResourceSchema";
import { responseResourceSchema } from "../../../generated/kubb/responses/zod/responseResourceSchema";
import { webSocketResponseCreateEventSchema } from "../../../generated/kubb/responses/zod/webSocketResponseCreateEventSchema";
import { formatZodIssues } from "../core/validators";
import type {
  ResponseValidator,
  TestConfig,
  ValidateResponseOutcome,
} from "../core/types";
import type { ResponseResource } from "./sse-events";
import type { z } from "zod";

export type CompactResource = z.infer<typeof compactResourceSchema>;
export type ParsedResponse = ResponseResource | CompactResource;

export const hasOutput: ResponseValidator<ParsedResponse> = (response) => {
  if (!response.output || response.output.length === 0) {
    return ["Response has no output items"];
  }
  return [];
};

export const hasOutputType =
  (type: string): ResponseValidator<ParsedResponse> =>
  (response) => {
    const hasType = response.output?.some((item) => item.type === type);
    if (!hasType) {
      return [`Expected output item of type "${type}" but none found`];
    }
    return [];
  };

export const hasAssistantMessagePhase =
  (phase: "commentary" | "final_answer"): ResponseValidator<ParsedResponse> =>
  (response) => {
    const hasPhase = response.output?.some(
      (item) =>
        item.type === "message" &&
        "role" in item &&
        item.role === "assistant" &&
        "phase" in item &&
        item.phase === phase,
    );

    if (!hasPhase) {
      return [
        `Expected assistant output message with phase "${phase}" but none found`,
      ];
    }

    return [];
  };

export const completedStatus: ResponseValidator<ParsedResponse> = (
  response,
) => {
  if (!("status" in response)) {
    return ['Expected a standard response object with a "status" field'];
  }
  if (response.status !== "completed") {
    return [`Expected status "completed" but got "${response.status}"`];
  }
  return [];
};

export const compactObject: ResponseValidator<ParsedResponse> = (response) => {
  if (response.object !== "response.compaction") {
    return [
      `Expected object "response.compaction" but got "${response.object}"`,
    ];
  }
  return [];
};

export const streamingEvents: ResponseValidator<ParsedResponse> = (
  _,
  context,
) => {
  if (!context.streaming) return [];
  if (!context.sseResult || context.sseResult.events.length === 0) {
    return ["No streaming events received"];
  }
  return [];
};

export const streamingSchema: ResponseValidator<ParsedResponse> = (
  _,
  context,
) => {
  if (!context.streaming || !context.sseResult) return [];
  return context.sseResult.errors;
};

export const webSocketBrowserUnsupported = (config: TestConfig) => {
  if (config.runtime === "browser") {
    return "WebSocket compliance tests require a server-side runtime because browsers cannot set the required authorization header.";
  }
  return null;
};

export const validateWebSocketCreateEvent = (body: unknown) => {
  const parseResult = webSocketResponseCreateEventSchema.safeParse(body);
  if (parseResult.success) return [];
  return formatZodIssues("WebSocket request ", parseResult.error);
};

/**
 * Top-level `validateResponse` for the Responses suite. Used by the generic
 * core to schema-check the response body before per-template validators run.
 */
export const validateResponseResource = (
  raw: unknown,
): ValidateResponseOutcome<ParsedResponse> => {
  const parseResult = responseResourceSchema.safeParse(raw);
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

export const getStreamingErrorCode = (data: unknown) => {
  if (!data || typeof data !== "object") return null;
  const error = (data as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
};

export const getResponseErrorCode = (response: unknown) => {
  if (!response || typeof response !== "object") return null;
  const error = (response as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
};

export const hasResponseId = (response: unknown) => {
  const parseResult = responseResourceSchema.safeParse(response);
  if (!parseResult.success) {
    return formatZodIssues("", parseResult.error);
  }
  return parseResult.data.id ? [] : ["Warmup response did not include an id"];
};

export const getCompactedOutput = (
  response: unknown,
): {
  output: unknown[];
  errors: string[];
} => {
  if (!response || typeof response !== "object") {
    return { output: [], errors: ["Compaction response was not an object"] };
  }

  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    return {
      output: [],
      errors: ["Compaction response did not include an output array"],
    };
  }

  return { output, errors: [] };
};
