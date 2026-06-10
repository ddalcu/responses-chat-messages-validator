import { makeFailure, makePass, type ScenarioMeta } from "../behavior-helpers";
import type { Scenario } from "./types";

const tags = ["behavioral", "usage"];

const reasoningLeakMeta: ScenarioMeta = {
  id: "usage-no-reasoning-leak",
  name: "Usage — reasoning content not leaked",
  description:
    "For specs with a reasoning channel, the assistant text must not include CoT-style markers (<think>, etc).",
  tags,
};

export const usageNoReasoningLeak: Scenario = {
  meta: reasoningLeakMeta,
  requires: { reasoningChannel: true },
  async run(adapter, config) {
    const start = Date.now();
    const r = await adapter.send(config, {
      turns: [
        {
          type: "user",
          text: "Solve briefly: what's 17 × 23? Reply with just the number, no explanation.",
        },
      ],
      temperature: 0,
      maxTokens: 32,
    });
    const text = adapter.extractFinalText(r.raw);
    const leaks = [
      /<think>/i,
      /<\/think>/i,
      /<reasoning>/i,
      /^let me think/im,
      /^step\s*1[:.]/im,
    ].filter((re) => re.test(text));
    if (leaks.length) {
      return makeFailure(
        reasoningLeakMeta,
        [
          `reasoning markers leaked into final text: ${leaks.map(String).join(", ")}\n  text: ${text.slice(0, 200)}`,
        ],
        { duration: Date.now() - start, response: r.raw },
      );
    }
    return makePass(reasoningLeakMeta, { duration: Date.now() - start });
  },
};

export const usageScenarios: Scenario[] = [usageNoReasoningLeak];
