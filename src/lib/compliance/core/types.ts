import type { z } from "zod";

export type TestStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped";

export type TestTransport = "http" | "websocket";

export type ResponseSchema = z.ZodTypeAny;

export interface TestConfig {
  baseUrl: string;
  apiKey: string;
  authHeaderName: string;
  useBearerPrefix: boolean;
  model: string;
  runtime?: "browser" | "server";
}

export interface TestResult {
  id: string;
  name: string;
  description: string;
  status: TestStatus;
  duration?: number;
  request?: unknown;
  response?: unknown;
  errors?: string[];
  streamEvents?: number;
}

/**
 * Result returned by a spec's `parseStream` callback. Generic over the
 * spec-specific event union (`TEvent`), final response shape (`TFinal`), and
 * an optional spec-specific extra context blob (`TStreamCtx`).
 *
 * `events` is exposed as `unknown[]` to keep the runner free of any spec
 * event-shape knowledge — only `errors`, `finalResponse`, and the events count
 * are inspected by the generic core.
 */
export interface StreamParseResult<TFinal = unknown, TStreamCtx = unknown> {
  events: unknown[];
  errors: string[];
  finalResponse: TFinal | null;
  context?: TStreamCtx;
}

export interface ValidatorContext<TFinal = unknown, TStreamCtx = unknown> {
  streaming: boolean;
  sseResult?: StreamParseResult<TFinal, TStreamCtx>;
  transport: TestTransport;
}

export type ResponseValidator<TRes = unknown, TStreamCtx = unknown> = (
  response: TRes,
  context: ValidatorContext<TRes, TStreamCtx>,
) => string[];

export interface TestTemplate<
  TReq = unknown,
  TRes = unknown,
  TStreamCtx = unknown,
> {
  id: string;
  name: string;
  description: string;
  transport?: TestTransport;
  endpoint?: string;
  expectedStatuses?: number[];
  responseSchema?: ResponseSchema | null;
  getRequest: (config: TestConfig) => TReq;
  getMockResponse?: (config: TestConfig) => unknown;
  streaming?: boolean;
  validators?: ResponseValidator<TRes, TStreamCtx>[];
  unsupportedReason?: (config: TestConfig) => string | null;
  run?: (
    config: TestConfig,
    template: TestTemplate<TReq, TRes, TStreamCtx>,
  ) => Promise<TestResult>;
}

export interface ValidateResponseOutcome<TRes = unknown> {
  ok: boolean;
  data?: TRes;
  errors: string[];
}

export interface SpecSuite<
  TReq = unknown,
  TRes = unknown,
  TStreamCtx = unknown,
> {
  id: "responses" | "chat-completions" | "anthropic-messages";
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
  defaultAuthHeaderName: string;
  defaultUseBearerPrefix: boolean;
  defaultEndpoint: string;
  extraHeaders?: (cfg: TestConfig) => Record<string, string>;
  templates: TestTemplate<TReq, TRes, TStreamCtx>[];
  parseStream: (res: Response) => Promise<StreamParseResult<TRes, TStreamCtx>>;
  validateResponse: (raw: unknown) => ValidateResponseOutcome<TRes>;
}
