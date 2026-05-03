/**
 * Generic SSE framing helper. Returns an async iterable of `{event?, data}`
 * pairs from a `Response` body, with no knowledge of any spec-specific
 * event-data schema. `data: [DONE]` lines are surfaced as a final pair with
 * `data === "[DONE]"` so callers can choose to terminate.
 */
export interface SSELine {
  event?: string;
  data: string;
}

export async function* parseSSELines(
  response: Response,
): AsyncIterable<SSELine> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  let currentEvent = "";
  let currentData = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          currentData = line.slice(5).trim();
        } else if (line === "" && currentData) {
          yield { event: currentEvent || undefined, data: currentData };
          currentEvent = "";
          currentData = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
