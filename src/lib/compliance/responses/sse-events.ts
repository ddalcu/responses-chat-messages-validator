import { z } from "zod";
import { errorStreamingEventSchema } from "../../../generated/kubb/responses/zod/errorStreamingEventSchema";
import { responseCompletedStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseCompletedStreamingEventSchema";
import { responseContentPartAddedStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseContentPartAddedStreamingEventSchema";
import { responseContentPartDoneStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseContentPartDoneStreamingEventSchema";
import { responseCreatedStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseCreatedStreamingEventSchema";
import { responseFailedStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseFailedStreamingEventSchema";
import { responseFunctionCallArgumentsDeltaStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseFunctionCallArgumentsDeltaStreamingEventSchema";
import { responseFunctionCallArgumentsDoneStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseFunctionCallArgumentsDoneStreamingEventSchema";
import { responseIncompleteStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseIncompleteStreamingEventSchema";
import { responseInProgressStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseInProgressStreamingEventSchema";
import { responseOutputItemAddedStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseOutputItemAddedStreamingEventSchema";
import { responseOutputItemDoneStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseOutputItemDoneStreamingEventSchema";
import { responseOutputTextAnnotationAddedStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseOutputTextAnnotationAddedStreamingEventSchema";
import { responseOutputTextDeltaStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseOutputTextDeltaStreamingEventSchema";
import { responseOutputTextDoneStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseOutputTextDoneStreamingEventSchema";
import { responseQueuedStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseQueuedStreamingEventSchema";
import { responseReasoningDeltaStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseReasoningDeltaStreamingEventSchema";
import { responseReasoningDoneStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseReasoningDoneStreamingEventSchema";
import { responseReasoningSummaryDeltaStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseReasoningSummaryDeltaStreamingEventSchema";
import { responseReasoningSummaryDoneStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseReasoningSummaryDoneStreamingEventSchema";
import { responseReasoningSummaryPartAddedStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseReasoningSummaryPartAddedStreamingEventSchema";
import { responseReasoningSummaryPartDoneStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseReasoningSummaryPartDoneStreamingEventSchema";
import { responseRefusalDeltaStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseRefusalDeltaStreamingEventSchema";
import { responseRefusalDoneStreamingEventSchema } from "../../../generated/kubb/responses/zod/responseRefusalDoneStreamingEventSchema";
import type { responseResourceSchema } from "../../../generated/kubb/responses/zod/responseResourceSchema";
import { webSocketErrorEventSchema } from "../../../generated/kubb/responses/zod/webSocketErrorEventSchema";
import { parseSSELines } from "../core/sse";
import type { StreamParseResult } from "../core/types";

export const streamingEventSchema = z.union([
  responseCreatedStreamingEventSchema,
  responseQueuedStreamingEventSchema,
  responseInProgressStreamingEventSchema,
  responseCompletedStreamingEventSchema,
  responseFailedStreamingEventSchema,
  responseIncompleteStreamingEventSchema,
  responseOutputItemAddedStreamingEventSchema,
  responseOutputItemDoneStreamingEventSchema,
  responseContentPartAddedStreamingEventSchema,
  responseContentPartDoneStreamingEventSchema,
  responseOutputTextDeltaStreamingEventSchema,
  responseOutputTextDoneStreamingEventSchema,
  responseRefusalDeltaStreamingEventSchema,
  responseRefusalDoneStreamingEventSchema,
  responseFunctionCallArgumentsDeltaStreamingEventSchema,
  responseFunctionCallArgumentsDoneStreamingEventSchema,
  responseReasoningSummaryPartAddedStreamingEventSchema,
  responseReasoningSummaryPartDoneStreamingEventSchema,
  responseReasoningDeltaStreamingEventSchema,
  responseReasoningDoneStreamingEventSchema,
  responseReasoningSummaryDeltaStreamingEventSchema,
  responseReasoningSummaryDoneStreamingEventSchema,
  responseOutputTextAnnotationAddedStreamingEventSchema,
  errorStreamingEventSchema,
]);
export const webSocketStreamingEventSchema = z.union([
  streamingEventSchema,
  webSocketErrorEventSchema,
]);

export type StreamingEvent = z.infer<typeof streamingEventSchema>;
export type WebSocketStreamingEvent = z.infer<
  typeof webSocketStreamingEventSchema
>;

export type ResponseResource = z.infer<typeof responseResourceSchema>;

interface ParseStreamingEventOptions {
  transport?: "http" | "websocket";
}

export interface ParsedEvent {
  event: string;
  data: unknown;
  validationResult: z.SafeParseReturnType<
    unknown,
    StreamingEvent | WebSocketStreamingEvent
  >;
}

export interface SSEParseResult extends StreamParseResult<ResponseResource> {
  events: ParsedEvent[];
  finalResponse: ResponseResource | null;
}

const getEventType = (data: unknown) => {
  if (data && typeof data === "object" && "type" in data) {
    const type = (data as { type?: unknown }).type;
    if (typeof type === "string") return type;
  }
  return "unknown";
};

export function parseStreamingEventData(
  data: unknown,
  eventName?: string,
  options: ParseStreamingEventOptions = {},
): ParsedEvent {
  const validationSchema =
    options.transport === "websocket"
      ? webSocketStreamingEventSchema
      : streamingEventSchema;
  const validationResult = validationSchema.safeParse(data);
  return {
    event: eventName || getEventType(data),
    data,
    validationResult,
  };
}

export function getTerminalResponse(data: unknown): ResponseResource | null {
  if (!data || typeof data !== "object") return null;

  const event = data as {
    type?: unknown;
    response?: ResponseResource;
  };
  if (
    event.type === "response.completed" ||
    event.type === "response.failed" ||
    event.type === "response.incomplete"
  ) {
    return event.response ?? null;
  }

  return null;
}

export async function parseSSEStream(
  response: Response,
): Promise<SSEParseResult> {
  const events: ParsedEvent[] = [];
  const errors: string[] = [];
  let finalResponse: ResponseResource | null = null;

  if (!response.body) {
    return { events, errors: ["No response body"], finalResponse };
  }

  for await (const { event: eventName, data } of parseSSELines(response)) {
    if (data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      const parsedEvent = parseStreamingEventData(parsed, eventName);
      events.push(parsedEvent);

      if (!parsedEvent.validationResult.success) {
        errors.push(
          `Event validation failed for ${parsedEvent.event}: ${JSON.stringify(parsedEvent.validationResult.error.issues)}`,
        );
      }

      finalResponse = getTerminalResponse(parsed) ?? finalResponse;
    } catch {
      errors.push(`Failed to parse event data: ${data}`);
    }
  }

  return { events, errors, finalResponse };
}
