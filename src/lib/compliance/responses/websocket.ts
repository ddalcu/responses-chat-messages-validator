import type {
  StreamParseResult,
  TestConfig,
  TestResult,
  TestTemplate,
} from "../core/types";
import { buildAuthHeader } from "../core/http";
import { formatZodIssues } from "../core/validators";
import {
  getTerminalResponse,
  parseStreamingEventData,
  type ParsedEvent,
  type ResponseResource,
} from "./sse-events";
import {
  getResponseErrorCode,
  getStreamingErrorCode,
  hasResponseId,
  validateWebSocketCreateEvent,
} from "./validators";
import { responseResourceSchema } from "../../../generated/kubb/responses/zod/responseResourceSchema";

type ResponsesRequestBody = Record<string, unknown>;

export interface WebSocketTurnResult extends StreamParseResult<ResponseResource> {
  events: ParsedEvent[];
  finalResponse: ResponseResource | null;
  errorCode?: string | null;
  errorEvent?: unknown;
  rawMessages: unknown[];
  request?: ResponsesRequestBody;
}

type WebSocketRequestStep =
  | ResponsesRequestBody
  | ((previousTurns: WebSocketTurnResult[]) => ResponsesRequestBody);

interface WebSocketSessionOptions {
  validateRequests?: boolean;
}

export function toWebSocketUrl(baseUrl: string) {
  const responseUrl = new URL(`${baseUrl.replace(/\/$/, "")}/responses`);

  if (responseUrl.protocol === "https:") {
    responseUrl.protocol = "wss:";
  } else if (responseUrl.protocol === "http:") {
    responseUrl.protocol = "ws:";
  } else if (
    responseUrl.protocol !== "ws:" &&
    responseUrl.protocol !== "wss:"
  ) {
    throw new Error(
      `Unsupported base URL protocol for WebSocket: ${responseUrl.protocol}`,
    );
  }

  return responseUrl.toString();
}

function createEmptyWebSocketTurn(): WebSocketTurnResult {
  return {
    events: [],
    errors: [],
    finalResponse: null,
    rawMessages: [],
    errorCode: null,
  };
}

export function getTurnErrorCode(turn: WebSocketTurnResult | undefined) {
  return turn?.errorCode ?? getResponseErrorCode(turn?.finalResponse);
}

export function isFailedTurn(turn: WebSocketTurnResult | undefined) {
  return (
    Boolean(turn?.errorEvent) ||
    Boolean(getTurnErrorCode(turn)) ||
    turn?.finalResponse?.status === "failed"
  );
}

export async function makeWebSocketSession(
  config: TestConfig,
  steps: WebSocketRequestStep[],
  options: WebSocketSessionOptions = {},
): Promise<WebSocketTurnResult[]> {
  const authHeader = buildAuthHeader(config);

  return new Promise((resolve, reject) => {
    const turns = steps.map(() => createEmptyWebSocketTurn());
    let turnIndex = 0;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;
    let settled = false;

    const clearPendingTimeout = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearPendingTimeout();
      try {
        ws?.close();
      } catch {
        // Ignore close errors after a terminal event.
      }
      resolve(turns);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearPendingTimeout();
      try {
        ws?.close();
      } catch {
        // Ignore close errors while rejecting the request.
      }
      reject(error);
    };

    const currentTurn = () => turns[turnIndex];

    const armTimeout = () => {
      clearPendingTimeout();
      timeout = setTimeout(() => {
        currentTurn()?.errors.push(
          "Timed out waiting for terminal WebSocket response event",
        );
        finish();
      }, 30000);
    };

    const sendCurrentRequest = () => {
      if (!ws || turnIndex >= steps.length) {
        finish();
        return;
      }
      const turn = currentTurn();
      if (!turn) {
        finish();
        return;
      }
      let body: ResponsesRequestBody;
      try {
        const step = steps[turnIndex];
        body =
          typeof step === "function" ? step(turns.slice(0, turnIndex)) : step;
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (options.validateRequests !== false) {
        const requestValidationErrors = validateWebSocketCreateEvent(body);
        if (requestValidationErrors.length > 0) {
          fail(
            new Error(
              requestValidationErrors
                .map((error) => `Request ${turnIndex + 1}: ${error}`)
                .join("\n"),
            ),
          );
          return;
        }
      }
      turn.request = body;
      armTimeout();
      ws.send(JSON.stringify(body));
    };

    const completeCurrentTurn = () => {
      clearPendingTimeout();
      turnIndex += 1;
      if (turnIndex >= steps.length) {
        finish();
      } else {
        sendCurrentRequest();
      }
    };

    const messageDataToString = (data: MessageEvent["data"]) => {
      if (typeof data === "string") return data;
      if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
      if (ArrayBuffer.isView(data)) {
        return new TextDecoder().decode(data);
      }
      return String(data);
    };

    try {
      type WebSocketConstructorWithHeaders = new (
        url: string | URL,
        options?: { headers?: Record<string, string> },
      ) => WebSocket;
      // Bun supports headers for client WebSockets; browser runs skip this path.
      const WebSocketWithHeaders =
        WebSocket as unknown as WebSocketConstructorWithHeaders;

      ws = new WebSocketWithHeaders(toWebSocketUrl(config.baseUrl), {
        headers: {
          "Content-Type": "application/json",
          ...authHeader,
        },
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    // Connection-phase timeout. If the server's HTTP port accepts TCP but
    // never completes the WebSocket upgrade (e.g. LM Studio, OpenAI itself —
    // anything that isn't a WS endpoint), neither `open` nor `error` fires
    // and we'd hang forever. The first armTimeout() inside sendCurrentRequest
    // clears this and replaces it with the per-turn timer.
    timeout = setTimeout(() => {
      fail(new Error("WebSocket connection timed out (no upgrade within 10s)"));
    }, 10000);

    ws.addEventListener("open", () => {
      sendCurrentRequest();
    });

    ws.addEventListener("message", (message) => {
      const turn = currentTurn();
      if (!turn) return;

      const data = messageDataToString(message.data);
      if (data === "[DONE]") {
        if (!turn.finalResponse && !turn.errorCode) {
          turn.errors.push("Received [DONE] before a terminal WebSocket event");
        }
        completeCurrentTurn();
        return;
      }

      try {
        const parsed = JSON.parse(data);
        const parsedEvent = parseStreamingEventData(parsed, undefined, {
          transport: "websocket",
        });
        turn.rawMessages.push(parsed);
        turn.events.push(parsedEvent);

        if (!parsedEvent.validationResult.success) {
          turn.errors.push(
            `Event validation failed for ${parsedEvent.event}: ${JSON.stringify(parsedEvent.validationResult.error.issues)}`,
          );
        }

        const terminalResponse = getTerminalResponse(parsed);
        if (terminalResponse) {
          turn.finalResponse = terminalResponse;
          completeCurrentTurn();
          return;
        }

        const errorCode = getStreamingErrorCode(parsed);
        if (parsedEvent.event === "error" || errorCode) {
          turn.errorCode = errorCode;
          turn.errorEvent = parsed;
          if (!errorCode) {
            turn.errors.push(
              `WebSocket error event: ${JSON.stringify(parsed)}`,
            );
          }
          completeCurrentTurn();
        }
      } catch {
        turn.errors.push(`Failed to parse WebSocket event data: ${data}`);
      }
    });

    ws.addEventListener("error", () => {
      fail(new Error("WebSocket connection failed"));
    });

    ws.addEventListener("close", () => {
      const turn = currentTurn();
      if (!settled && turn && !turn.finalResponse && !turn.errorCode) {
        turn.errors.push("WebSocket closed before a terminal response event");
      }
      finish();
    });
  });
}

async function makeCompactRequest(
  config: TestConfig,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${config.baseUrl.replace(/\/$/, "")}/responses/compact`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildAuthHeader(config),
    },
    body: JSON.stringify(body),
  });
}

function createResponseResultFromTurn(
  template: TestTemplate<ResponsesRequestBody, ResponseResource, unknown>,
  requestBody: unknown,
  rawData: unknown,
  turn: WebSocketTurnResult,
  startTime: number,
): TestResult {
  const duration = Date.now() - startTime;
  const parseResult = responseResourceSchema.safeParse(rawData);
  if (!parseResult.success) {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: "failed",
      duration,
      request: requestBody,
      response: rawData,
      errors: [...turn.errors, ...formatZodIssues("", parseResult.error)],
      streamEvents: turn.events.length,
    };
  }

  const errors = (template.validators ?? []).flatMap((v) =>
    v(parseResult.data, {
      streaming: true,
      sseResult: turn,
      transport: "websocket",
    }),
  );

  return {
    id: template.id,
    name: template.name,
    description: template.description,
    status: errors.length === 0 ? "passed" : "failed",
    duration,
    request: requestBody,
    response: parseResult.data,
    errors,
    streamEvents: turn.events.length,
  };
}

/**
 * Default WebSocket single-turn runner used by the `websocket-response`
 * template. The generic core does not drive WebSocket transport; suites must
 * supply a `run` for each WebSocket template.
 */
export async function runWebSocketBasicTest(
  config: TestConfig,
  template: TestTemplate<ResponsesRequestBody, ResponseResource, unknown>,
): Promise<TestResult> {
  const startTime = Date.now();
  const requestBody = template.getRequest(config);

  try {
    const [turn] = await makeWebSocketSession(config, [requestBody]);
    return createResponseResultFromTurn(
      template,
      requestBody,
      turn.finalResponse,
      turn,
      startTime,
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

export async function runWebSocketSequentialResponsesTest(
  config: TestConfig,
  template: TestTemplate<ResponsesRequestBody, ResponseResource, unknown>,
): Promise<TestResult> {
  const startTime = Date.now();
  const requests: ResponsesRequestBody[] = [
    {
      type: "response.create",
      model: config.model,
      store: false,
      input: "Reply with exactly: first",
    },
    {
      type: "response.create",
      model: config.model,
      store: false,
      input: "Reply with exactly: second",
    },
  ];

  try {
    const turns = await makeWebSocketSession(config, requests);
    const errors: string[] = [];
    for (const [index, turn] of turns.entries()) {
      const result = createResponseResultFromTurn(
        template,
        requests[index],
        turn.finalResponse,
        turn,
        startTime,
      );
      if (result.errors?.length) {
        errors.push(
          ...result.errors.map((error) => `Turn ${index + 1}: ${error}`),
        );
      }
    }

    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: errors.length === 0 ? "passed" : "failed",
      duration: Date.now() - startTime,
      request: requests,
      response: turns.map((turn) => turn.finalResponse),
      errors,
      streamEvents: turns.reduce((sum, turn) => sum + turn.events.length, 0),
    };
  } catch (error) {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: "failed",
      duration: Date.now() - startTime,
      request: requests,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export async function runWebSocketContinuationTest(
  config: TestConfig,
  template: TestTemplate<ResponsesRequestBody, ResponseResource, unknown>,
): Promise<TestResult> {
  const startTime = Date.now();
  const firstRequest = template.getRequest(config);

  try {
    const [firstTurn, secondTurn] = await makeWebSocketSession(config, [
      firstRequest,
      (turns) => {
        const previousResponseId = turns[0]?.finalResponse?.id;
        if (!previousResponseId) {
          throw new Error("First WebSocket turn did not return a response id");
        }
        return {
          type: "response.create",
          model: config.model,
          store: false,
          previous_response_id: previousResponseId,
          input: "What is the code word? Reply with only the code word.",
        };
      },
    ]);
    const firstErrors = [
      ...firstTurn.errors,
      ...hasResponseId(firstTurn.finalResponse),
    ];

    if (firstErrors.length > 0 || !firstTurn.finalResponse?.id || !secondTurn) {
      return {
        id: template.id,
        name: template.name,
        description: template.description,
        status: "failed",
        duration: Date.now() - startTime,
        request: firstRequest,
        response: firstTurn.finalResponse,
        errors:
          firstErrors.length > 0
            ? firstErrors
            : ["Second WebSocket continuation turn did not run"],
        streamEvents: firstTurn.events.length,
      };
    }

    const secondResult = createResponseResultFromTurn(
      template,
      [firstTurn.request, secondTurn.request],
      secondTurn.finalResponse,
      secondTurn,
      startTime,
    );

    return {
      ...secondResult,
      request: [firstTurn.request, secondTurn.request],
      response: [firstTurn.finalResponse, secondTurn.finalResponse],
      streamEvents: firstTurn.events.length + secondTurn.events.length,
    };
  } catch (error) {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: "failed",
      duration: Date.now() - startTime,
      request: firstRequest,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export async function runWebSocketReconnectStoreFalseRecoveryTest(
  config: TestConfig,
  template: TestTemplate<ResponsesRequestBody, ResponseResource, unknown>,
): Promise<TestResult> {
  const startTime = Date.now();
  const firstRequest = template.getRequest(config);

  try {
    const [firstTurn] = await makeWebSocketSession(config, [firstRequest]);
    const firstErrors = [
      ...firstTurn.errors,
      ...hasResponseId(firstTurn.finalResponse),
    ];
    const previousResponseId = firstTurn.finalResponse?.id;

    if (firstErrors.length > 0 || !previousResponseId) {
      return {
        id: template.id,
        name: template.name,
        description: template.description,
        status: "failed",
        duration: Date.now() - startTime,
        request: firstRequest,
        response: firstTurn.finalResponse,
        errors: firstErrors,
        streamEvents: firstTurn.events.length,
      };
    }

    const reconnectRequest: ResponsesRequestBody = {
      type: "response.create",
      model: config.model,
      store: false,
      previous_response_id: previousResponseId,
      input: "Try to continue after reconnect. Reply with exactly: reconnected",
    };
    const recoveryRequest: ResponsesRequestBody = {
      type: "response.create",
      model: config.model,
      store: false,
      input: [
        {
          type: "message",
          role: "user",
          content:
            "The previous store:false chain could not continue after reconnect. Start a new response and reply with exactly: recovered",
        },
      ],
    };
    const [reconnectTurn, recoveryTurn] = await makeWebSocketSession(config, [
      reconnectRequest,
      recoveryRequest,
    ]);
    const reconnectErrorCode = getTurnErrorCode(reconnectTurn);
    const errors = [...reconnectTurn.errors];

    if (reconnectErrorCode !== "previous_response_not_found") {
      errors.push(
        `Expected previous_response_not_found after reconnecting a store:false chain but got ${reconnectErrorCode ?? "no error code"}`,
      );
    }
    if (!recoveryTurn) {
      errors.push("Recovery WebSocket turn did not run after reconnect miss");
    } else {
      const recoveryResult = createResponseResultFromTurn(
        template,
        recoveryRequest,
        recoveryTurn.finalResponse,
        recoveryTurn,
        startTime,
      );
      errors.push(...(recoveryResult.errors ?? []));
      if ("previous_response_id" in recoveryRequest) {
        errors.push(
          "Reconnect recovery must start a new response without previous_response_id",
        );
      }
    }

    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: errors.length === 0 ? "passed" : "failed",
      duration: Date.now() - startTime,
      request: [
        firstTurn.request,
        reconnectTurn.request,
        recoveryTurn?.request,
      ],
      response: [
        firstTurn.finalResponse,
        reconnectTurn.errorEvent ?? reconnectTurn.finalResponse,
        recoveryTurn?.finalResponse,
      ],
      errors,
      streamEvents:
        firstTurn.events.length +
        reconnectTurn.events.length +
        (recoveryTurn?.events.length ?? 0),
    };
  } catch (error) {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: "failed",
      duration: Date.now() - startTime,
      request: firstRequest,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export async function runWebSocketPreviousResponseNotFoundTest(
  config: TestConfig,
  template: TestTemplate<ResponsesRequestBody, ResponseResource, unknown>,
): Promise<TestResult> {
  const startTime = Date.now();
  const request = template.getRequest(config);

  try {
    const [turn] = await makeWebSocketSession(config, [request]);
    const errorCode =
      turn.errorCode ?? getResponseErrorCode(turn.finalResponse);
    const errors = [...turn.errors];
    if (errorCode !== "previous_response_not_found") {
      errors.unshift(
        `Expected previous_response_not_found but got ${errorCode ?? "no error code"}`,
      );
    }

    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: errors.length === 0 ? "passed" : "failed",
      duration: Date.now() - startTime,
      request,
      response: turn.errorEvent ?? turn.finalResponse,
      errors,
      streamEvents: turn.events.length,
    };
  } catch (error) {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: "failed",
      duration: Date.now() - startTime,
      request,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export async function runWebSocketFailedContinuationEvictsCacheTest(
  config: TestConfig,
  template: TestTemplate<ResponsesRequestBody, ResponseResource, unknown>,
): Promise<TestResult> {
  const startTime = Date.now();
  const firstRequest = template.getRequest(config);

  try {
    const [firstTurn, failedTurn, retryTurn] = await makeWebSocketSession(
      config,
      [
        firstRequest,
        (turns) => {
          const previousResponseId = turns[0]?.finalResponse?.id;
          if (!previousResponseId) {
            throw new Error(
              "First WebSocket turn did not return a response id",
            );
          }
          return {
            type: "response.create",
            model: config.model,
            store: false,
            previous_response_id: previousResponseId,
            input: [
              {
                type: "function_call_output",
                call_id: "call_openresponses_missing",
                output:
                  "No matching tool call exists in the previous response.",
              },
            ],
          };
        },
        (turns) => {
          const previousResponseId = turns[0]?.finalResponse?.id;
          if (!previousResponseId) {
            throw new Error(
              "First WebSocket turn did not return a response id",
            );
          }
          return {
            type: "response.create",
            model: config.model,
            store: false,
            previous_response_id: previousResponseId,
            input:
              "Try to continue after the failed turn. Reply with exactly: stale",
          };
        },
      ],
    );
    const errors = [
      ...firstTurn.errors,
      ...hasResponseId(firstTurn.finalResponse),
    ];

    if (!failedTurn) {
      errors.push("Failed WebSocket continuation turn did not run");
    } else if (!isFailedTurn(failedTurn)) {
      errors.push(...failedTurn.errors);
      errors.push(
        `Expected second WebSocket continuation turn to fail but got status ${failedTurn.finalResponse?.status ?? "no terminal response"}`,
      );
    }

    const retryErrorCode = getTurnErrorCode(retryTurn);
    if (!retryTurn) {
      errors.push("Retry WebSocket continuation turn did not run");
    } else {
      errors.push(...retryTurn.errors);
      if (retryErrorCode !== "previous_response_not_found") {
        errors.push(
          `Expected previous_response_not_found after failed continuation eviction but got ${retryErrorCode ?? "no error code"}`,
        );
      }
    }

    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: errors.length === 0 ? "passed" : "failed",
      duration: Date.now() - startTime,
      request: [firstTurn.request, failedTurn?.request, retryTurn?.request],
      response: [
        firstTurn.finalResponse,
        failedTurn?.errorEvent ?? failedTurn?.finalResponse,
        retryTurn?.errorEvent ?? retryTurn?.finalResponse,
      ],
      errors,
      streamEvents: [firstTurn, failedTurn, retryTurn].reduce(
        (sum, turn) => sum + (turn?.events.length ?? 0),
        0,
      ),
    };
  } catch (error) {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: "failed",
      duration: Date.now() - startTime,
      request: firstRequest,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function readCompactBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

export async function runWebSocketCompactNewChainTest(
  config: TestConfig,
  template: TestTemplate<ResponsesRequestBody, ResponseResource, unknown>,
): Promise<TestResult> {
  const startTime = Date.now();
  const compactRequest = {
    model: config.model,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Remember the compaction code word: slate.",
          },
        ],
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "OK.",
          },
        ],
      },
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Compress this conversation for later continuation.",
          },
        ],
      },
    ],
  };

  try {
    const compactResponse = await makeCompactRequest(config, compactRequest);
    const compactBody = await readCompactBody(compactResponse);
    if (!compactResponse.ok) {
      return {
        id: template.id,
        name: template.name,
        description: template.description,
        status: "failed",
        duration: Date.now() - startTime,
        request: compactRequest,
        response: compactBody,
        errors: [
          `HTTP ${compactResponse.status} from /responses/compact: ${JSON.stringify(compactBody)}`,
        ],
      };
    }

    // Inline import to avoid a top-level cycle with validators.ts
    const { getCompactedOutput } = await import("./validators");
    const { output, errors: compactErrors } = getCompactedOutput(compactBody);
    if (compactErrors.length > 0) {
      return {
        id: template.id,
        name: template.name,
        description: template.description,
        status: "failed",
        duration: Date.now() - startTime,
        request: compactRequest,
        response: compactBody,
        errors: compactErrors,
      };
    }

    const websocketRequest: ResponsesRequestBody = {
      type: "response.create",
      model: config.model,
      store: false,
      input: [
        ...output,
        {
          type: "message",
          role: "user",
          content: "Continue from here. Reply with exactly: compacted",
        },
      ],
      tools: [],
    };

    const [turn] = await makeWebSocketSession(
      config,
      [websocketRequest],
      // The compacted window is provider-generated and the guide requires
      // passing it back as-is, so preflight validation cannot assume a static
      // input schema for those returned items.
      { validateRequests: false },
    );
    const websocketResult = createResponseResultFromTurn(
      template,
      websocketRequest,
      turn.finalResponse,
      turn,
      startTime,
    );
    const errors = [...(websocketResult.errors ?? [])];

    if ("previous_response_id" in websocketRequest) {
      errors.push(
        "Standalone compact recovery must start a new chain without previous_response_id",
      );
    }

    return {
      ...websocketResult,
      status: errors.length === 0 ? "passed" : "failed",
      request: {
        compact: compactRequest,
        websocket: turn.request,
      },
      response: {
        compact: compactBody,
        websocket: turn.finalResponse,
      },
      errors,
      streamEvents: turn.events.length,
    };
  } catch (error) {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      status: "failed",
      duration: Date.now() - startTime,
      request: compactRequest,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}
