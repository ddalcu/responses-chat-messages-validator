import {
  assertContains,
  assertNotContains,
  makeFailure,
  makePass,
  type ScenarioMeta,
  type Turn,
} from "../behavior-helpers";
import type { TestResult } from "../types";
import type { Scenario } from "./types";

const WEATHER_TOOL = {
  name: "get_weather",
  description: "Get the current weather for a location.",
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City and country, e.g. 'Paris, France'",
      },
    },
    required: ["location"],
    additionalProperties: false,
  },
};

const COUNT_TOOL = {
  name: "set_count",
  description: "Record a count.",
  parameters: {
    type: "object",
    properties: {
      count: { type: "integer", description: "An integer count value." },
    },
    required: ["count"],
    additionalProperties: false,
  },
};

function tagsFor(category: string): string[] {
  return ["behavioral", category];
}

function tryParseArgs(call: { argsJson: string }): {
  ok: boolean;
  value: Record<string, unknown> | null;
  error?: string;
} {
  try {
    const v = JSON.parse(call.argsJson);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      return { ok: true, value: v as Record<string, unknown> };
    }
    return {
      ok: false,
      value: null,
      error: "tool args parsed but not an object",
    };
  } catch (err) {
    return {
      ok: false,
      value: null,
      error: `tool args not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const toolRoundtripSingleMeta: ScenarioMeta = {
  id: "tool-roundtrip-single",
  name: "Tool roundtrip — single call",
  description:
    "Full request → tool_call → synthetic tool_result → final answer; final text references the tool's output.",
  tags: tagsFor("tool"),
};

export const toolRoundtripSingle: Scenario = {
  meta: toolRoundtripSingleMeta,
  async run(adapter, config) {
    const start = Date.now();
    const errors: string[] = [];
    const subResults: TestResult[] = [];

    // Step 1: ask for weather; expect a tool_call.
    const step1 = await adapter.send(config, {
      turns: [{ type: "user", text: "What's the weather in Paris, France?" }],
      tools: [WEATHER_TOOL],
      temperature: 0,
    });
    const calls = adapter.extractToolCalls(step1.raw);
    subResults.push({
      id: `${toolRoundtripSingleMeta.id}/step-1-tool-call`,
      name: "Step 1 — initial request emits tool_call",
      description: "Engine emits at least one tool call to get_weather.",
      status: calls.length > 0 ? "passed" : "failed",
      duration: step1.durationMs,
      response: step1.raw,
      errors: calls.length === 0 ? ["no tool call emitted"] : undefined,
    });
    if (calls.length === 0) {
      errors.push("step 1: no tool call emitted");
      return makeFailure(toolRoundtripSingleMeta, errors, {
        duration: Date.now() - start,
        subResults,
      });
    }
    const call = calls[0];
    if (call.name !== WEATHER_TOOL.name) {
      errors.push(`step 1: tool name "${call.name}" != "${WEATHER_TOOL.name}"`);
    }
    const parsed = tryParseArgs(call);
    if (!parsed.ok) errors.push(`step 1: ${parsed.error}`);

    // Step 2: feed back a synthetic result and expect a coherent final answer.
    const turns: Turn[] = [
      { type: "user", text: "What's the weather in Paris, France?" },
      { type: "assistant-tool-call", call },
      {
        type: "tool-result",
        toolCallId: call.id,
        output:
          '{"location":"Paris, France","temperature_celsius":17,"summary":"partly cloudy"}',
      },
    ];
    const step2 = await adapter.send(config, {
      turns,
      tools: [WEATHER_TOOL],
      temperature: 0,
    });
    const finalText = adapter.extractFinalText(step2.raw);
    const containsErr = assertContains(
      finalText,
      /17|seventeen|partly cloud/i,
      "step 2 final text",
    );
    subResults.push({
      id: `${toolRoundtripSingleMeta.id}/step-2-final-answer`,
      name: "Step 2 — final answer references tool output",
      description:
        "Engine's follow-up after the tool result mentions 17° or partly cloudy.",
      status: containsErr.length === 0 ? "passed" : "failed",
      duration: step2.durationMs,
      response: step2.raw,
      errors: containsErr.length ? containsErr : undefined,
    });
    errors.push(...containsErr);

    return errors.length === 0
      ? makePass(toolRoundtripSingleMeta, {
          duration: Date.now() - start,
          subResults,
        })
      : makeFailure(toolRoundtripSingleMeta, errors, {
          duration: Date.now() - start,
          subResults,
        });
  },
};

const toolArgsValidJsonMeta: ScenarioMeta = {
  id: "tool-roundtrip-args-valid-json",
  name: "Tool roundtrip — args parse as JSON",
  description:
    "tool_call.arguments parses as a JSON object containing the declared required keys.",
  tags: tagsFor("tool"),
};

export const toolArgsValidJson: Scenario = {
  meta: toolArgsValidJsonMeta,
  async run(adapter, config) {
    const start = Date.now();
    const r = await adapter.send(config, {
      turns: [
        {
          type: "user",
          text: "Use the tool to get the weather in Paris, France.",
        },
      ],
      tools: [WEATHER_TOOL],
      temperature: 0,
    });
    const calls = adapter.extractToolCalls(r.raw);
    if (calls.length === 0) {
      return makeFailure(toolArgsValidJsonMeta, ["no tool call emitted"], {
        duration: Date.now() - start,
        response: r.raw,
      });
    }
    const parsed = tryParseArgs(calls[0]);
    if (!parsed.ok) {
      return makeFailure(
        toolArgsValidJsonMeta,
        [parsed.error ?? "args invalid"],
        {
          duration: Date.now() - start,
          response: r.raw,
        },
      );
    }
    const errors: string[] = [];
    if (typeof parsed.value?.location !== "string") {
      errors.push(`required key "location" missing or not a string`);
    }
    return errors.length === 0
      ? makePass(toolArgsValidJsonMeta, { duration: Date.now() - start })
      : makeFailure(toolArgsValidJsonMeta, errors, {
          duration: Date.now() - start,
          response: r.raw,
        });
  },
};

const toolArgsTypedMeta: ScenarioMeta = {
  id: "tool-roundtrip-args-typed",
  name: "Tool roundtrip — typed args",
  description:
    "Schema requires count: integer; assert reassembled args has number, not stringified.",
  tags: tagsFor("tool"),
};

export const toolArgsTyped: Scenario = {
  meta: toolArgsTypedMeta,
  async run(adapter, config) {
    const start = Date.now();
    const r = await adapter.send(config, {
      turns: [
        {
          type: "user",
          text: "Call set_count with the count value 42.",
        },
      ],
      tools: [COUNT_TOOL],
      temperature: 0,
    });
    const calls = adapter.extractToolCalls(r.raw);
    if (calls.length === 0) {
      return makeFailure(toolArgsTypedMeta, ["no tool call emitted"], {
        duration: Date.now() - start,
        response: r.raw,
      });
    }
    const parsed = tryParseArgs(calls[0]);
    if (!parsed.ok) {
      return makeFailure(toolArgsTypedMeta, [parsed.error ?? "args invalid"], {
        duration: Date.now() - start,
      });
    }
    const errors: string[] = [];
    const v = parsed.value?.count;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      errors.push(
        `count expected integer (number), got ${typeof v} (${JSON.stringify(v)})`,
      );
    } else if (v !== 42) {
      errors.push(`count expected 42, got ${v}`);
    }
    return errors.length === 0
      ? makePass(toolArgsTypedMeta, { duration: Date.now() - start })
      : makeFailure(toolArgsTypedMeta, errors, {
          duration: Date.now() - start,
          response: r.raw,
        });
  },
};

const toolNoHallucinatedNameMeta: ScenarioMeta = {
  id: "tool-roundtrip-no-hallucinated-name",
  name: "Tool roundtrip — exact tool name",
  description: "Engine emits tool calls with the exact declared name.",
  tags: tagsFor("tool"),
};

export const toolNoHallucinatedName: Scenario = {
  meta: toolNoHallucinatedNameMeta,
  async run(adapter, config) {
    const start = Date.now();
    const r = await adapter.send(config, {
      turns: [{ type: "user", text: "What's the weather in Paris, France?" }],
      tools: [WEATHER_TOOL],
      temperature: 0,
    });
    const calls = adapter.extractToolCalls(r.raw);
    if (calls.length === 0) {
      return makeFailure(toolNoHallucinatedNameMeta, ["no tool call emitted"], {
        duration: Date.now() - start,
        response: r.raw,
      });
    }
    const wrong = calls.filter((c) => c.name !== WEATHER_TOOL.name);
    if (wrong.length) {
      return makeFailure(
        toolNoHallucinatedNameMeta,
        wrong.map(
          (c) => `tool call name "${c.name}" != "${WEATHER_TOOL.name}"`,
        ),
        { duration: Date.now() - start, response: r.raw },
      );
    }
    return makePass(toolNoHallucinatedNameMeta, {
      duration: Date.now() - start,
    });
  },
};

const toolNoToolWhenNotNeededMeta: ScenarioMeta = {
  id: "tool-roundtrip-no-tool-when-not-needed",
  name: "Tool roundtrip — no tool when not needed",
  description:
    "A tool is defined but the prompt doesn't need it; engine answers directly.",
  tags: tagsFor("tool"),
};

export const toolNoToolWhenNotNeeded: Scenario = {
  meta: toolNoToolWhenNotNeededMeta,
  async run(adapter, config) {
    const start = Date.now();
    const r = await adapter.send(config, {
      turns: [
        { type: "user", text: "What is 2 + 2? Reply with just the number." },
      ],
      tools: [WEATHER_TOOL],
      temperature: 0,
    });
    const calls = adapter.extractToolCalls(r.raw);
    const errors: string[] = [];
    if (calls.length > 0) {
      errors.push(
        `engine emitted ${calls.length} tool call(s) when none were needed`,
      );
    }
    const text = adapter.extractFinalText(r.raw);
    errors.push(...assertContains(text, /4|four/i, "final answer"));
    return errors.length === 0
      ? makePass(toolNoToolWhenNotNeededMeta, { duration: Date.now() - start })
      : makeFailure(toolNoToolWhenNotNeededMeta, errors, {
          duration: Date.now() - start,
          response: r.raw,
        });
  },
};

const toolParallelMeta: ScenarioMeta = {
  id: "tool-parallel",
  name: "Tool roundtrip — parallel tool calls",
  description:
    "Prompt induces ≥2 parallel tool calls; engine emits multiple tool calls in one response.",
  tags: tagsFor("tool"),
};

export const toolParallel: Scenario = {
  meta: toolParallelMeta,
  async run(adapter, config) {
    const start = Date.now();
    const r = await adapter.send(config, {
      turns: [
        {
          type: "user",
          text: "Call get_weather in parallel for both Paris, France and Tokyo, Japan.",
        },
      ],
      tools: [WEATHER_TOOL],
      temperature: 0,
    });
    const calls = adapter.extractToolCalls(r.raw);
    if (calls.length < 2) {
      return makeFailure(
        toolParallelMeta,
        [`expected ≥2 tool calls, got ${calls.length}`],
        { duration: Date.now() - start, response: r.raw },
      );
    }
    const errors: string[] = [];
    for (const [i, c] of calls.entries()) {
      const p = tryParseArgs(c);
      if (!p.ok) errors.push(`call ${i}: ${p.error}`);
      else if (typeof p.value?.location !== "string")
        errors.push(`call ${i}: location not a string`);
    }
    return errors.length === 0
      ? makePass(toolParallelMeta, { duration: Date.now() - start })
      : makeFailure(toolParallelMeta, errors, {
          duration: Date.now() - start,
          response: r.raw,
        });
  },
};

const toolSequentialMeta: ScenarioMeta = {
  id: "tool-sequential",
  name: "Tool roundtrip — sequential tool calls",
  description:
    "Round 1 tool call → tool result → round 2 follow-up induces a second tool call.",
  tags: tagsFor("tool"),
};

export const toolSequential: Scenario = {
  meta: toolSequentialMeta,
  async run(adapter, config) {
    const start = Date.now();
    const errors: string[] = [];

    const step1 = await adapter.send(config, {
      turns: [
        {
          type: "user",
          text: "What's the weather in Paris, France? Use the tool.",
        },
      ],
      tools: [WEATHER_TOOL],
      temperature: 0,
    });
    const calls1 = adapter.extractToolCalls(step1.raw);
    if (calls1.length === 0) {
      errors.push("round 1: no tool call");
      return makeFailure(toolSequentialMeta, errors, {
        duration: Date.now() - start,
        response: step1.raw,
      });
    }

    const step2 = await adapter.send(config, {
      turns: [
        {
          type: "user",
          text: "What's the weather in Paris, France? Use the tool.",
        },
        { type: "assistant-tool-call", call: calls1[0] },
        {
          type: "tool-result",
          toolCallId: calls1[0].id,
          output: '{"location":"Paris, France","temperature_celsius":17}',
        },
        {
          type: "user",
          text: "Now check Tokyo, Japan as well — use the tool again.",
        },
      ],
      tools: [WEATHER_TOOL],
      temperature: 0,
    });
    const calls2 = adapter.extractToolCalls(step2.raw);
    if (calls2.length === 0) {
      errors.push("round 2: no second tool call");
    }
    return errors.length === 0
      ? makePass(toolSequentialMeta, { duration: Date.now() - start })
      : makeFailure(toolSequentialMeta, errors, {
          duration: Date.now() - start,
          response: step2.raw,
        });
  },
};

const toolStreamingArgsMeta: ScenarioMeta = {
  id: "tool-streaming-args-reassembly",
  name: "Tool roundtrip — streaming args reassemble",
  description:
    "Streaming mode reassembles tool args into valid JSON matching the schema.",
  tags: tagsFor("tool"),
};

export const toolStreamingArgs: Scenario = {
  meta: toolStreamingArgsMeta,
  async run(adapter, config) {
    const start = Date.now();
    const r = await adapter.sendStreaming(config, {
      turns: [
        {
          type: "user",
          text: "What's the weather in Paris, France? Use the tool.",
        },
      ],
      tools: [WEATHER_TOOL],
      temperature: 0,
    });
    const calls = adapter.reassembleStreamToolCalls(r.parsed);
    if (calls.length === 0) {
      return makeFailure(
        toolStreamingArgsMeta,
        ["stream produced no tool calls"],
        { duration: Date.now() - start },
      );
    }
    const p = tryParseArgs(calls[0]);
    if (!p.ok) {
      return makeFailure(toolStreamingArgsMeta, [p.error ?? "args invalid"], {
        duration: Date.now() - start,
      });
    }
    const errors = assertNotContains(
      calls[0].argsJson,
      /^\s*$/,
      "reassembled args",
    );
    if (typeof p.value?.location !== "string") {
      errors.push("location not a string after reassembly");
    }
    return errors.length === 0
      ? makePass(toolStreamingArgsMeta, { duration: Date.now() - start })
      : makeFailure(toolStreamingArgsMeta, errors, {
          duration: Date.now() - start,
        });
  },
};

export const toolScenarios: Scenario[] = [
  toolRoundtripSingle,
  toolArgsValidJson,
  toolArgsTyped,
  toolNoHallucinatedName,
  toolNoToolWhenNotNeeded,
  toolParallel,
  toolSequential,
  toolStreamingArgs,
];
