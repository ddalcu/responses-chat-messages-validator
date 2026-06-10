import {
  approxTextSimilarity,
  makeFailure,
  makePass,
  type ScenarioMeta,
} from "../behavior-helpers";
import type { Scenario } from "./types";

const tags = ["behavioral", "parity"];

const PARITY_PROMPT =
  "List the first three planets from the Sun in order. Reply with just the names separated by commas, nothing else.";

const TOOL = {
  name: "set_value",
  description: "Record a value.",
  parameters: {
    type: "object",
    properties: { value: { type: "integer" } },
    required: ["value"],
    additionalProperties: false,
  },
};

const parityTextMeta: ScenarioMeta = {
  id: "parity-text-similarity",
  name: "Streaming parity — text similarity",
  description:
    "At temp=0, reassembled streamed text and non-streamed text are highly similar (Jaccard ≥ 0.7).",
  tags,
};

export const parityText: Scenario = {
  meta: parityTextMeta,
  async run(adapter, config) {
    const start = Date.now();
    const [nonStream, stream] = await Promise.all([
      adapter.send(config, {
        turns: [{ type: "user", text: PARITY_PROMPT }],
        temperature: 0,
        maxTokens: 64,
      }),
      adapter.sendStreaming(config, {
        turns: [{ type: "user", text: PARITY_PROMPT }],
        temperature: 0,
        maxTokens: 64,
      }),
    ]);
    const a = adapter.extractFinalText(nonStream.raw);
    const b = adapter.reassembleStreamText(stream.parsed);
    if (!a || !b) {
      return makeFailure(
        parityTextMeta,
        [
          `empty response (non-stream=${a.length} chars, stream=${b.length} chars)`,
        ],
        { duration: Date.now() - start },
      );
    }
    const sim = approxTextSimilarity(a, b);
    if (sim < 0.7) {
      return makeFailure(
        parityTextMeta,
        [
          `streaming/non-streaming similarity ${sim.toFixed(3)} < 0.7\n  non-stream: ${a}\n      stream: ${b}`,
        ],
        { duration: Date.now() - start },
      );
    }
    return makePass(parityTextMeta, { duration: Date.now() - start });
  },
};

const parityFinishMeta: ScenarioMeta = {
  id: "parity-finish-reason",
  name: "Streaming parity — finish reason",
  description:
    "Streaming and non-streaming runs report the same finish reason.",
  tags,
};

export const parityFinish: Scenario = {
  meta: parityFinishMeta,
  async run(adapter, config) {
    const start = Date.now();
    const [a, b] = await Promise.all([
      adapter.send(config, {
        turns: [{ type: "user", text: PARITY_PROMPT }],
        temperature: 0,
        maxTokens: 64,
      }),
      adapter.sendStreaming(config, {
        turns: [{ type: "user", text: PARITY_PROMPT }],
        temperature: 0,
        maxTokens: 64,
      }),
    ]);
    const fa = adapter.extractFinishReason(a.raw);
    const fb = b.parsed.finalResponse
      ? adapter.extractFinishReason(b.parsed.finalResponse)
      : null;
    if (fa === null || fb === null) {
      return makeFailure(
        parityFinishMeta,
        [`finish reason missing (non-stream=${fa}, stream=${fb})`],
        { duration: Date.now() - start },
      );
    }
    if (fa !== fb) {
      return makeFailure(
        parityFinishMeta,
        [`finish reason mismatch (non-stream=${fa}, stream=${fb})`],
        { duration: Date.now() - start },
      );
    }
    return makePass(parityFinishMeta, { duration: Date.now() - start });
  },
};

const parityUsageMeta: ScenarioMeta = {
  id: "parity-usage-present",
  name: "Streaming parity — usage present",
  description:
    "Both streaming and non-streaming reports populate input/output token counts.",
  tags,
};

export const parityUsage: Scenario = {
  meta: parityUsageMeta,
  async run(adapter, config) {
    const start = Date.now();
    const [a, b] = await Promise.all([
      adapter.send(config, {
        turns: [{ type: "user", text: PARITY_PROMPT }],
        temperature: 0,
        maxTokens: 64,
      }),
      adapter.sendStreaming(config, {
        turns: [{ type: "user", text: PARITY_PROMPT }],
        temperature: 0,
        maxTokens: 64,
      }),
    ]);
    const errors: string[] = [];
    const aIn = adapter.extractInputTokens(a.raw);
    const aOut = adapter.extractOutputTokens(a.raw);
    if (!aIn || !aOut)
      errors.push(`non-streaming usage missing (input=${aIn}, output=${aOut})`);
    if (b.parsed.finalResponse) {
      const bIn = adapter.extractInputTokens(b.parsed.finalResponse);
      const bOut = adapter.extractOutputTokens(b.parsed.finalResponse);
      if (!bIn || !bOut)
        errors.push(`streaming usage missing (input=${bIn}, output=${bOut})`);
    } else {
      errors.push("streaming did not produce a final response");
    }
    return errors.length === 0
      ? makePass(parityUsageMeta, { duration: Date.now() - start })
      : makeFailure(parityUsageMeta, errors, { duration: Date.now() - start });
  },
};

const parityToolArgsMeta: ScenarioMeta = {
  id: "parity-tool-args",
  name: "Streaming parity — tool args",
  description:
    "Same tool prompt streaming + non-streaming; reassembled args deep-equal.",
  tags,
};

export const parityToolArgs: Scenario = {
  meta: parityToolArgsMeta,
  async run(adapter, config) {
    const start = Date.now();
    const [a, b] = await Promise.all([
      adapter.send(config, {
        turns: [{ type: "user", text: "Call set_value with the value 7." }],
        tools: [TOOL],
        temperature: 0,
      }),
      adapter.sendStreaming(config, {
        turns: [{ type: "user", text: "Call set_value with the value 7." }],
        tools: [TOOL],
        temperature: 0,
      }),
    ]);
    const callsA = adapter.extractToolCalls(a.raw);
    const callsB = adapter.reassembleStreamToolCalls(b.parsed);
    if (callsA.length === 0 || callsB.length === 0) {
      return makeFailure(
        parityToolArgsMeta,
        [
          `tool calls missing (non-stream=${callsA.length}, stream=${callsB.length})`,
        ],
        { duration: Date.now() - start },
      );
    }
    let parsedA: unknown;
    let parsedB: unknown;
    try {
      parsedA = JSON.parse(callsA[0].argsJson);
      parsedB = JSON.parse(callsB[0].argsJson);
    } catch (err) {
      return makeFailure(
        parityToolArgsMeta,
        [
          `args not JSON (non-stream=${callsA[0].argsJson}, stream=${callsB[0].argsJson}): ${err instanceof Error ? err.message : String(err)}`,
        ],
        { duration: Date.now() - start },
      );
    }
    const eq = JSON.stringify(parsedA) === JSON.stringify(parsedB);
    return eq
      ? makePass(parityToolArgsMeta, { duration: Date.now() - start })
      : makeFailure(
          parityToolArgsMeta,
          [
            `tool args differ\n  non-stream: ${JSON.stringify(parsedA)}\n      stream: ${JSON.stringify(parsedB)}`,
          ],
          { duration: Date.now() - start },
        );
  },
};

export const parityScenarios: Scenario[] = [
  parityText,
  parityFinish,
  parityUsage,
  parityToolArgs,
];
