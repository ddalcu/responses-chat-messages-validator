import {
  assertContains,
  makeFailure,
  makePass,
  type ScenarioMeta,
} from "../behavior-helpers";
import type { Scenario } from "./types";

const tags = ["behavioral", "multi-turn"];

const nameRecallMeta: ScenarioMeta = {
  id: "multiturn-name-recall",
  name: "Multi-turn — name recall",
  description:
    "After multiple turns the assistant correctly recalls the user's name from turn 1.",
  tags,
};

export const multiturnNameRecall: Scenario = {
  meta: nameRecallMeta,
  async run(adapter, config) {
    const start = Date.now();
    const r = await adapter.send(config, {
      turns: [
        { type: "user", text: "Hi! My name is Alice." },
        { type: "assistant-text", text: "Nice to meet you, Alice!" },
        { type: "user", text: "What is my name? Reply with just the name." },
      ],
      temperature: 0,
      maxTokens: 16,
    });
    const text = adapter.extractFinalText(r.raw);
    const errors = assertContains(text, /\balice\b/i, "final answer");
    return errors.length === 0
      ? makePass(nameRecallMeta, { duration: Date.now() - start })
      : makeFailure(nameRecallMeta, errors, {
          duration: Date.now() - start,
          response: r.raw,
        });
  },
};

const toolResultHonoredMeta: ScenarioMeta = {
  id: "multiturn-tool-result-honored",
  name: "Multi-turn — tool result honored",
  description:
    "Pre-baked assistant tool_call + tool_result; subsequent answer references the tool's output.",
  tags,
};

const TOOL = {
  name: "get_weather",
  description: "Get the current weather for a location.",
  parameters: {
    type: "object",
    properties: { location: { type: "string" } },
    required: ["location"],
    additionalProperties: false,
  },
};

export const multiturnToolResultHonored: Scenario = {
  meta: toolResultHonoredMeta,
  async run(adapter, config) {
    const start = Date.now();
    const callId = "call_compliance_test_22";
    const r = await adapter.send(config, {
      turns: [
        { type: "user", text: "What's the weather in Tokyo, Japan?" },
        {
          type: "assistant-tool-call",
          call: {
            id: callId,
            name: TOOL.name,
            argsJson: '{"location":"Tokyo, Japan"}',
          },
        },
        {
          type: "tool-result",
          toolCallId: callId,
          output:
            '{"location":"Tokyo, Japan","temperature_celsius":22,"summary":"sunny"}',
        },
        { type: "user", text: "What's the temperature there in Celsius?" },
      ],
      tools: [TOOL],
      temperature: 0,
      maxTokens: 32,
    });
    const text = adapter.extractFinalText(r.raw);
    const errors = assertContains(text, /22/, "tool-aware response");
    return errors.length === 0
      ? makePass(toolResultHonoredMeta, { duration: Date.now() - start })
      : makeFailure(toolResultHonoredMeta, errors, {
          duration: Date.now() - start,
          response: r.raw,
        });
  },
};

const systemPersistMeta: ScenarioMeta = {
  id: "multiturn-system-prompt-persists",
  name: "Multi-turn — system prompt persists",
  description:
    "System prompt 'reply only in lowercase' still applies several turns later.",
  tags,
};

export const multiturnSystemPersists: Scenario = {
  meta: systemPersistMeta,
  async run(adapter, config) {
    const start = Date.now();
    const r = await adapter.send(config, {
      system:
        "Reply using only lowercase letters. Never use any capital letters.",
      turns: [
        { type: "user", text: "Say hello." },
        { type: "assistant-text", text: "hello there!" },
        { type: "user", text: "Say goodbye." },
        { type: "assistant-text", text: "goodbye." },
        { type: "user", text: "Now name a country in europe." },
      ],
      temperature: 0,
      maxTokens: 32,
    });
    const text = adapter.extractFinalText(r.raw);
    if (!text.trim()) {
      return makeFailure(systemPersistMeta, ["empty response"], {
        duration: Date.now() - start,
      });
    }
    if (/[A-Z]/.test(text)) {
      return makeFailure(
        systemPersistMeta,
        [
          `system prompt violated — uppercase in response: ${text.slice(0, 200)}`,
        ],
        { duration: Date.now() - start, response: r.raw },
      );
    }
    return makePass(systemPersistMeta, { duration: Date.now() - start });
  },
};

export const multiturnScenarios: Scenario[] = [
  multiturnNameRecall,
  multiturnToolResultHonored,
  multiturnSystemPersists,
];
