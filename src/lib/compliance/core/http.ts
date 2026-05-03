import type { TestConfig } from "./types";

/**
 * Generic HTTP request helper for compliance tests. Adds the auth header
 * (with or without Bearer prefix) and any spec-supplied extra headers, and
 * injects `stream: true` into the body for streaming requests.
 */
export async function makeRequest(
  config: TestConfig,
  endpoint: string,
  body: unknown,
  options: {
    streaming?: boolean;
    extraHeaders?: Record<string, string>;
  } = {},
): Promise<Response> {
  const { streaming = false, extraHeaders = {} } = options;

  const authValue = config.useBearerPrefix
    ? `Bearer ${config.apiKey}`
    : config.apiKey;

  const finalBody =
    streaming && body && typeof body === "object" && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>), stream: true }
      : body;

  return fetch(`${config.baseUrl.replace(/\/$/, "")}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [config.authHeaderName]: authValue,
      ...extraHeaders,
    },
    body: JSON.stringify(finalBody),
  });
}
