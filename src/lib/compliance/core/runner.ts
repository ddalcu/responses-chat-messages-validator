import { makeRequest } from "./http";
import type {
  SpecSuite,
  StreamParseResult,
  TestConfig,
  TestResult,
  TestTemplate,
  ValidatorContext,
} from "./types";
import { formatZodIssues } from "./validators";

function displayRequest<TReq>(requestBody: TReq, streaming: boolean): unknown {
  if (
    streaming &&
    requestBody &&
    typeof requestBody === "object" &&
    !Array.isArray(requestBody)
  ) {
    return { ...(requestBody as Record<string, unknown>), stream: true };
  }
  return requestBody;
}

async function readResponseBody<TRes, TStreamCtx>(
  suite: SpecSuite<unknown, TRes, TStreamCtx>,
  response: Response,
  streaming: boolean,
): Promise<{
  rawData: unknown;
  sseResult?: StreamParseResult<TRes, TStreamCtx>;
}> {
  if (streaming) {
    const sseResult = await suite.parseStream(response);
    return { rawData: sseResult.finalResponse, sseResult };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return { rawData: await response.json() };
  }

  return { rawData: await response.text() };
}

function validateResponseData<TReq, TRes, TStreamCtx>(
  suite: SpecSuite<TReq, TRes, TStreamCtx>,
  template: TestTemplate<TReq, TRes, TStreamCtx>,
  requestBody: TReq,
  rawData: unknown,
  duration: number,
  context: ValidatorContext<TRes, TStreamCtx>,
): TestResult {
  const request = displayRequest(requestBody, context.streaming);

  // Templates can opt out of schema validation entirely (e.g. error-status
  // tests) by passing `responseSchema: null`.
  if (template.responseSchema === null) {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: "passed",
      duration,
      request,
      response: rawData,
      streamEvents: context.sseResult?.events.length,
    };
  }

  // Default path: delegate to the suite's spec-specific validator. Suites can
  // also opt to use a per-template `responseSchema` override; in that case the
  // template-level zod schema wins (used by Responses for the `compactResource`
  // alternate response).
  let parsed: { ok: boolean; data?: TRes; errors: string[] };
  if (template.responseSchema) {
    const parseResult = template.responseSchema.safeParse(rawData);
    if (parseResult.success) {
      parsed = {
        ok: true,
        data: parseResult.data as TRes,
        errors: [],
      };
    } else {
      parsed = {
        ok: false,
        errors: formatZodIssues("", parseResult.error),
      };
    }
  } else {
    parsed = suite.validateResponse(rawData);
  }

  if (!parsed.ok || !parsed.data) {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: "failed",
      duration,
      request,
      response: rawData,
      errors: parsed.errors,
      streamEvents: context.sseResult?.events.length,
    };
  }

  const errors = (template.validators ?? []).flatMap((v) =>
    v(parsed.data as TRes, context),
  );

  const outputTokens = suite.getOutputTokens?.(parsed.data as TRes);
  const tokensPerSecond =
    outputTokens !== undefined && duration > 0
      ? Math.round((outputTokens / duration) * 1000)
      : undefined;

  return {
    id: template.id,
    name: template.name,
    description: template.description,
    status: errors.length === 0 ? "passed" : "failed",
    duration,
    request,
    response: parsed.data,
    errors,
    streamEvents: context.sseResult?.events.length,
    outputTokens,
    tokensPerSecond,
  };
}

async function runTest<TReq, TRes, TStreamCtx>(
  suite: SpecSuite<TReq, TRes, TStreamCtx>,
  template: TestTemplate<TReq, TRes, TStreamCtx>,
  config: TestConfig,
): Promise<TestResult> {
  const startTime = Date.now();
  const streaming = template.streaming ?? false;
  const transport = template.transport ?? "http";
  const endpoint = template.endpoint ?? suite.defaultEndpoint;

  const unsupportedReason = template.unsupportedReason?.(config);
  if (unsupportedReason) {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: "skipped",
      duration: 0,
      errors: [unsupportedReason],
    };
  }

  if (template.run) {
    return template.run(config, template);
  }

  const requestBody = template.getRequest(config);

  try {
    if (template.getMockResponse) {
      return validateResponseData(
        suite,
        template,
        requestBody,
        template.getMockResponse(config),
        Date.now() - startTime,
        { streaming, transport },
      );
    }

    if (transport === "websocket") {
      // WebSocket tests must supply their own `run` since WS framing is
      // spec-specific. Fail loudly rather than silently passing.
      throw new Error(
        `WebSocket template "${template.id}" must supply a \`run\` function — the generic runner cannot drive WebSocket transport.`,
      );
    }

    const expectedStatuses = template.expectedStatuses ?? [200];
    const extraHeaders = suite.extraHeaders?.(config) ?? {};
    const response = await makeRequest(config, endpoint, requestBody, {
      streaming,
      extraHeaders,
    });
    const duration = Date.now() - startTime;
    const { rawData, sseResult } = await readResponseBody(
      suite,
      response,
      streaming,
    );

    if (!expectedStatuses.includes(response.status)) {
      return {
        id: template.id,
        name: template.name,
        description: template.description,
        status: "failed",
        duration,
        request: displayRequest(requestBody, streaming),
        response: rawData,
        errors: [`HTTP ${response.status}: ${String(rawData)}`],
        streamEvents: sseResult?.events.length,
      };
    }

    return validateResponseData(
      suite,
      template,
      requestBody,
      rawData,
      duration,
      {
        streaming,
        sseResult,
        transport,
      },
    );
  } catch (error) {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: "failed",
      duration: Date.now() - startTime,
      request: requestBody,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export async function runAllTests<TReq, TRes, TStreamCtx>(
  suite: SpecSuite<TReq, TRes, TStreamCtx>,
  config: TestConfig,
  onProgress: (result: TestResult) => void,
  templates: TestTemplate<TReq, TRes, TStreamCtx>[] = suite.templates,
): Promise<TestResult[]> {
  const promises = templates.map(async (template) => {
    const unsupportedReason = template.unsupportedReason?.(config);
    if (unsupportedReason) {
      const result: TestResult = {
        id: template.id,
        name: template.name,
        description: template.description,
        status: "skipped",
        duration: 0,
        errors: [unsupportedReason],
      };
      onProgress(result);
      return result;
    }

    onProgress({
      id: template.id,
      name: template.name,
      description: template.description,
      status: "running",
    });

    const result = await runTest(suite, template, config);
    onProgress(result);
    return result;
  });

  return Promise.all(promises);
}
