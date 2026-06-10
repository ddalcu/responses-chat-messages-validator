import {
  assertContains,
  assertNotContains,
  isLengthStyleFinish,
  makeFailure,
  makePass,
  type ScenarioMeta,
} from "../behavior-helpers";
import type { Scenario } from "./types";

const tags = ["behavioral", "limits"];

const stopSeqMeta: ScenarioMeta = {
  id: "limits-stop-sequence",
  name: "Limits — stop sequence honored",
  description:
    "Set stop=['STOPHERE']; prompt induces 'STOPHERE' early; response does not include 'STOPHERE' or anything after.",
  tags,
};

export const limitsStopSequence: Scenario = {
  meta: stopSeqMeta,
  async run(adapter, config) {
    const start = Date.now();
    const r = await adapter.send(config, {
      turns: [
        {
          type: "user",
          text: "Reply with the literal text: alpha STOPHERE beta. Output exactly that, nothing else.",
        },
      ],
      stop: ["STOPHERE"],
      temperature: 0,
      maxTokens: 32,
    });
    const text = adapter.extractFinalText(r.raw);
    const errors: string[] = [];
    errors.push(...assertNotContains(text, "STOPHERE", "response"));
    errors.push(...assertNotContains(text, "beta", "response"));
    return errors.length === 0
      ? makePass(stopSeqMeta, { duration: Date.now() - start })
      : makeFailure(stopSeqMeta, errors, {
          duration: Date.now() - start,
          response: r.raw,
        });
  },
};

const maxTokensMeta: ScenarioMeta = {
  id: "limits-max-tokens",
  name: "Limits — max tokens honored",
  description:
    "max_tokens=8 produces output with usage.output_tokens ≤ 12 (small slack) AND a length-style finish reason.",
  tags,
};

export const limitsMaxTokens: Scenario = {
  meta: maxTokensMeta,
  async run(adapter, config) {
    const start = Date.now();
    const r = await adapter.send(config, {
      turns: [
        {
          type: "user",
          text: "Count from 1 to 30, separating each number with a space.",
        },
      ],
      temperature: 0,
      maxTokens: 8,
    });
    const out = adapter.extractOutputTokens(r.raw);
    const fr = adapter.extractFinishReason(r.raw);
    const errors: string[] = [];
    if (out === null) {
      errors.push("output_tokens not reported");
    } else if (out > 12) {
      errors.push(`output_tokens=${out} exceeds limit (8 + slack)`);
    }
    if (fr && !isLengthStyleFinish(fr)) {
      errors.push(`finish reason ${fr} not length-style`);
    }
    return errors.length === 0
      ? makePass(maxTokensMeta, { duration: Date.now() - start })
      : makeFailure(maxTokensMeta, errors, {
          duration: Date.now() - start,
          response: r.raw,
        });
  },
};

const unicodeMeta: ScenarioMeta = {
  id: "limits-unicode-roundtrip",
  name: "Limits — unicode round-trip",
  description:
    "Engine round-trips multi-byte unicode (Latin diacritic, CJK, emoji) through the response without corruption.",
  tags,
};

export const limitsUnicodeRoundtrip: Scenario = {
  meta: unicodeMeta,
  async run(adapter, config) {
    const start = Date.now();
    const probe = "héllo 你好 🦊";
    const r = await adapter.send(config, {
      turns: [
        {
          type: "user",
          text: `Reply with the exact string: ${probe} — nothing else.`,
        },
      ],
      temperature: 0,
      maxTokens: 32,
    });
    const text = adapter.extractFinalText(r.raw);
    const errors: string[] = [];
    errors.push(...assertContains(text, "héllo", "diacritic"));
    errors.push(...assertContains(text, "你好", "CJK"));
    errors.push(...assertContains(text, "🦊", "emoji"));
    return errors.length === 0
      ? makePass(unicodeMeta, { duration: Date.now() - start })
      : makeFailure(unicodeMeta, errors, {
          duration: Date.now() - start,
          response: r.raw,
        });
  },
};

const TOOL = {
  name: "set_count",
  description: "Record a count.",
  parameters: {
    type: "object",
    properties: { count: { type: "integer" } },
    required: ["count"],
    additionalProperties: false,
  },
};

const argTypeMeta: ScenarioMeta = {
  id: "limits-tool-arg-type-fidelity",
  name: "Limits — tool arg type fidelity",
  description:
    "Schema demands count: integer; reassembled args has integer (number, not string).",
  tags,
};

export const limitsToolArgTypeFidelity: Scenario = {
  meta: argTypeMeta,
  async run(adapter, config) {
    const start = Date.now();
    const r = await adapter.send(config, {
      turns: [
        { type: "user", text: "Call set_count with the count value 99." },
      ],
      tools: [TOOL],
      temperature: 0,
    });
    const calls = adapter.extractToolCalls(r.raw);
    if (calls.length === 0) {
      return makeFailure(argTypeMeta, ["no tool call emitted"], {
        duration: Date.now() - start,
        response: r.raw,
      });
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(calls[0].argsJson) as Record<string, unknown>;
    } catch (err) {
      return makeFailure(
        argTypeMeta,
        [`args not JSON: ${err instanceof Error ? err.message : String(err)}`],
        { duration: Date.now() - start },
      );
    }
    const errors: string[] = [];
    const v = parsed.count;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      errors.push(
        `count expected integer, got ${typeof v} (${JSON.stringify(v)})`,
      );
    } else if (v !== 99) {
      errors.push(`count expected 99, got ${v}`);
    }
    return errors.length === 0
      ? makePass(argTypeMeta, { duration: Date.now() - start })
      : makeFailure(argTypeMeta, errors, {
          duration: Date.now() - start,
          response: r.raw,
        });
  },
};

const emptyContentMeta: ScenarioMeta = {
  id: "limits-empty-content-coherent",
  name: "Limits — empty tool result handled",
  description:
    "Empty tool-result content followed by a follow-up; engine produces a coherent reply (does not crash).",
  tags,
};

const SHORT_TOOL = {
  name: "noop",
  description: "Returns nothing.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

export const limitsEmptyContentCoherent: Scenario = {
  meta: emptyContentMeta,
  async run(adapter, config) {
    const start = Date.now();
    const callId = "call_compliance_test_empty";
    const r = await adapter.send(config, {
      turns: [
        { type: "user", text: "Call noop, then say 'done'." },
        {
          type: "assistant-tool-call",
          call: { id: callId, name: SHORT_TOOL.name, argsJson: "{}" },
        },
        { type: "tool-result", toolCallId: callId, output: "" },
        { type: "user", text: "Now say 'done'." },
      ],
      tools: [SHORT_TOOL],
      temperature: 0,
      maxTokens: 16,
    });
    const text = adapter.extractFinalText(r.raw);
    const errors = assertContains(text, /done/i, "follow-up answer");
    return errors.length === 0
      ? makePass(emptyContentMeta, { duration: Date.now() - start })
      : makeFailure(emptyContentMeta, errors, {
          duration: Date.now() - start,
          response: r.raw,
        });
  },
};

export const limitsScenarios: Scenario[] = [
  limitsStopSequence,
  limitsMaxTokens,
  limitsUnicodeRoundtrip,
  limitsToolArgTypeFidelity,
  limitsEmptyContentCoherent,
];
