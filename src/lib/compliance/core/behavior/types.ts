import type { BehaviorAdapter, ScenarioMeta } from "../behavior-helpers";
import type { TestConfig, TestResult } from "../types";

/**
 * A scenario is a spec-agnostic engine-correctness test. Each scenario takes
 * an adapter for the spec under test and a TestConfig and returns a
 * TestResult. Per-spec template files derive `TestTemplate` arrays from a
 * shared list of scenarios — see `<spec>/behavior/index.ts`.
 */
export interface Scenario {
  meta: ScenarioMeta;
  /**
   * Capabilities the scenario requires; templates derived for a spec missing
   * any of these will be marked unsupported (skipped at run time).
   */
  requires?: Partial<{
    jsonMode: boolean;
    jsonSchema: boolean;
    previousResponseId: boolean;
    promptCacheKey: boolean;
    reasoningChannel: boolean;
  }>;
  run: (adapter: BehaviorAdapter, config: TestConfig) => Promise<TestResult>;
}
