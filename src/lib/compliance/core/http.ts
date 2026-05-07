import type { TestConfig } from "./types";

/**
 * Build the auth header for a config, or `{}` if no API key is set
 * (e.g. local servers like Ollama / LM Studio that don't require auth).
 */
export function buildAuthHeader(config: TestConfig): Record<string, string> {
  if (!config.apiKey) return {};
  const value = config.useBearerPrefix
    ? `Bearer ${config.apiKey}`
    : config.apiKey;
  return { [config.authHeaderName]: value };
}

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

  const finalBody =
    streaming && body && typeof body === "object" && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>), stream: true }
      : body;

  return fetch(`${config.baseUrl.replace(/\/$/, "")}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildAuthHeader(config),
      ...extraHeaders,
    },
    body: JSON.stringify(finalBody),
    signal: AbortSignal.timeout(config.timeoutMs ?? 60_000),
  });
}
