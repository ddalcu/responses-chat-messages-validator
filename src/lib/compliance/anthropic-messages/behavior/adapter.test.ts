import { describe, expect, it } from "bun:test";
import { parseSSEStream } from "../sse-events";
import { anthropicMessagesBehaviorAdapter } from "./adapter";

/**
 * Build a `text/event-stream` Response from (event, data) pairs, mirroring
 * the wire format the Anthropic Messages API produces.
 */
const sseResponse = (events: Array<[string, unknown]>): Response =>
  new Response(
    events
      .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const messageStart: [string, unknown] = [
  "message_start",
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      // Spec-compliant streaming: content is ALWAYS empty at message_start;
      // text arrives only via content_block_delta events.
      content: [],
      model: "claude-sonnet-4-5",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 32, output_tokens: 1 },
    },
  },
];

describe("anthropicMessagesBehaviorAdapter.reassembleStreamText", () => {
  it("reassembles text from content_block_delta events (not message_start.content)", async () => {
    const parsed = await parseSSEStream(
      sseResponse([
        messageStart,
        [
          "content_block_start",
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Mercury," },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Venus," },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Earth" },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 5 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ]),
    );
    expect(parsed.errors).toEqual([]);
    expect(anthropicMessagesBehaviorAdapter.reassembleStreamText(parsed)).toBe(
      "Mercury,Venus,Earth",
    );
  });
});

describe("anthropicMessagesBehaviorAdapter.reassembleStreamToolCalls", () => {
  it("reassembles tool calls from content_block_start + input_json_delta events", async () => {
    const parsed = await parseSSEStream(
      sseResponse([
        messageStart,
        [
          "content_block_start",
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "toolu_1",
              name: "set_value",
              input: {},
            },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"val' },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: 'ue":7}' },
          },
        ],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        [
          "message_delta",
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 12 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ]),
    );
    expect(parsed.errors).toEqual([]);
    const calls =
      anthropicMessagesBehaviorAdapter.reassembleStreamToolCalls(parsed);
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("set_value");
    expect(calls[0].id).toBe("toolu_1");
    expect(JSON.parse(calls[0].argsJson)).toEqual({ value: 7 });
  });
});
