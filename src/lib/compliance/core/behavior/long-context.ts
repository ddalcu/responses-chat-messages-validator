import {
  assertContains,
  buildHaystackWithNeedle,
  makeFailure,
  makePass,
  type ScenarioMeta,
} from "../behavior-helpers";
import type { Scenario } from "./types";

const tags = ["behavioral", "long-context"];

const longCtxMeta: ScenarioMeta = {
  id: "long-context-needle",
  name: "Long context — needle in haystack",
  description:
    "A 16 KB filler block contains a planted code; engine retrieves it on request.",
  tags,
};

export const longContextNeedle: Scenario = {
  meta: longCtxMeta,
  async run(adapter, config) {
    const start = Date.now();
    const needle = "The launch code is `quasar-471`.";
    const haystack = buildHaystackWithNeedle({
      fillerBytes: 16384,
      needle,
      position: "middle",
    });
    const r = await adapter.send(config, {
      turns: [
        {
          type: "user",
          text: `${haystack}\n\nWhat is the launch code? Reply with just the code, no extra words.`,
        },
      ],
      temperature: 0,
      maxTokens: 32,
    });
    const text = adapter.extractFinalText(r.raw);
    const errors = assertContains(text, "quasar-471", "needle");
    return errors.length === 0
      ? makePass(longCtxMeta, { duration: Date.now() - start })
      : makeFailure(longCtxMeta, errors, {
          duration: Date.now() - start,
          response: r.raw,
        });
  },
};

export const longContextScenarios: Scenario[] = [longContextNeedle];
