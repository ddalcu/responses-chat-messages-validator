import { describe, expect, it } from "bun:test";
import type { ResponseResource } from "../sse-events";
import { responsesBehaviorAdapter } from "./adapter";

const asResource = (r: unknown): ResponseResource => r as ResponseResource;

describe("responsesBehaviorAdapter.extractFinishReason", () => {
  it("surfaces incomplete_details.reason for truncated responses", () => {
    // The OpenAI Responses API reports max-token truncation as
    // status="incomplete" + incomplete_details.reason="max_output_tokens".
    // The bare status string carries no length signal, so the adapter must
    // surface the detail reason for limits-max-tokens to be checkable.
    expect(
      responsesBehaviorAdapter.extractFinishReason(
        asResource({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      ),
    ).toBe("max_output_tokens");
  });

  it("returns status for completed responses", () => {
    expect(
      responsesBehaviorAdapter.extractFinishReason(
        asResource({ status: "completed" }),
      ),
    ).toBe("completed");
  });

  it("falls back to status when incomplete_details is missing", () => {
    expect(
      responsesBehaviorAdapter.extractFinishReason(
        asResource({ status: "incomplete" }),
      ),
    ).toBe("incomplete");
  });
});
