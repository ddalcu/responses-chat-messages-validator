import {
  makeFailure,
  makePass,
  runConcurrent,
  type ScenarioMeta,
} from "../behavior-helpers";
import type { Scenario } from "./types";

const tags = ["behavioral", "concurrency"];

const isolationMeta: ScenarioMeta = {
  id: "concurrency-isolation",
  name: "Concurrency — request isolation",
  description:
    "Four concurrent requests with distinct conversation context. Each response must reflect its own context, not another in-flight request's.",
  tags,
};

export const concurrencyIsolation: Scenario = {
  meta: isolationMeta,
  async run(adapter, config) {
    const start = Date.now();
    const names = ["Alice", "Bob", "Carol", "Dave"];
    const results = await runConcurrent(
      names.length,
      names.length,
      async (i) => {
        const name = names[i];
        const r = await adapter.send(config, {
          turns: [
            { type: "user", text: `Hi! My name is ${name}.` },
            { type: "assistant-text", text: `Hello, ${name}!` },
            {
              type: "user",
              text: "What is my name? Reply with just the name.",
            },
          ],
          temperature: 0,
          maxTokens: 16,
        });
        return { name, text: adapter.extractFinalText(r.raw) };
      },
    );
    const errors: string[] = [];
    for (const r of results) {
      const own = new RegExp(`\\b${r.name}\\b`, "i");
      if (!own.test(r.text)) {
        errors.push(
          `request for ${r.name} did not return its own name: "${r.text.slice(0, 80)}"`,
        );
      }
      // Check no other concurrent name leaked through.
      const others = names.filter((n) => n !== r.name);
      for (const other of others) {
        const re = new RegExp(`\\b${other}\\b`, "i");
        if (re.test(r.text)) {
          errors.push(
            `request for ${r.name} leaked name ${other}: "${r.text.slice(0, 80)}"`,
          );
        }
      }
    }
    return errors.length === 0
      ? makePass(isolationMeta, { duration: Date.now() - start })
      : makeFailure(isolationMeta, errors, { duration: Date.now() - start });
  },
};

export const concurrencyScenarios: Scenario[] = [concurrencyIsolation];
