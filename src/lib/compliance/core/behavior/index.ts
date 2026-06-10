import type { BehaviorAdapter } from "../behavior-helpers";
import { runScenarioSafe } from "../behavior-helpers";
import type { TestTemplate } from "../types";
import { cacheScenarios } from "./cache";
import { concurrencyScenarios } from "./concurrency";
import { limitsScenarios } from "./limits";
import { longContextScenarios } from "./long-context";
import { multiturnScenarios } from "./multiturn";
import { parityScenarios } from "./parity";
import { structuredScenarios } from "./structured";
import { toolScenarios } from "./tool";
import type { Scenario } from "./types";
import { usageScenarios } from "./usage";

/** Stable order matching the plan's category list. */
export const allBehaviorScenarios: Scenario[] = [
  ...toolScenarios,
  ...parityScenarios,
  ...cacheScenarios,
  ...multiturnScenarios,
  ...structuredScenarios,
  ...limitsScenarios,
  ...longContextScenarios,
  ...concurrencyScenarios,
  ...usageScenarios,
];

/**
 * Derive per-spec `TestTemplate`s from the shared scenario list, using the
 * spec's BehaviorAdapter for request/response shape. Capability-gated
 * scenarios (e.g. previous_response_id) are converted to skip-on-unsupported
 * templates so the JSON output reports them clearly.
 */
export function deriveBehaviorTemplates<TReq, TRes, TStreamCtx>(
  adapter: BehaviorAdapter<TRes>,
): TestTemplate<TReq, TRes, TStreamCtx>[] {
  return allBehaviorScenarios.map((scenario) => {
    const requires = scenario.requires;
    let unsupportedReason: ((cfg: unknown) => string | null) | undefined;
    if (requires) {
      const missing = Object.entries(requires)
        .filter(([cap, need]) => {
          if (!need) return false;
          return !adapter.capabilities[
            cap as keyof typeof adapter.capabilities
          ];
        })
        .map(([cap]) => cap);
      if (missing.length > 0) {
        unsupportedReason = () =>
          `${adapter.spec} does not support: ${missing.join(", ")}`;
      }
    }
    return {
      id: scenario.meta.id,
      name: scenario.meta.name,
      description: scenario.meta.description,
      tags: scenario.meta.tags,
      // Behavioural scenarios run their own multi-request flow; the runner's
      // schema-validation path is bypassed.
      responseSchema: null,
      // Keep `getRequest` defined for type compatibility with the runner; it's
      // never called because `run` short-circuits.
      getRequest: () => ({}) as TReq,
      unsupportedReason: unsupportedReason ?? undefined,
      run: async (config) =>
        runScenarioSafe(scenario.meta, () => scenario.run(adapter, config)),
    };
  });
}
