import {
  assertJsonObject,
  makeFailure,
  makePass,
  type ScenarioMeta,
} from "../behavior-helpers";
import type { Scenario } from "./types";

const tags = ["behavioral", "structured"];

const jsonModeMeta: ScenarioMeta = {
  id: "structured-json-mode-valid",
  name: "Structured — json_object mode produces valid JSON",
  description:
    "response_format: json_object → response parses as a JSON object containing the requested keys.",
  tags,
};

export const structuredJsonMode: Scenario = {
  meta: jsonModeMeta,
  requires: { jsonMode: true },
  async run(adapter, config) {
    const start = Date.now();
    const r = await adapter.send(config, {
      turns: [
        {
          type: "user",
          text: "Output a JSON object with exactly these keys: name (string), count (number), active (boolean). Use any sensible values.",
        },
      ],
      responseFormat: { type: "json_object" },
      temperature: 0,
      maxTokens: 64,
    });
    const text = adapter.extractFinalText(r.raw);
    const errors = assertJsonObject(
      text,
      ["name", "count", "active"],
      "response",
    );
    return errors.length === 0
      ? makePass(jsonModeMeta, { duration: Date.now() - start })
      : makeFailure(jsonModeMeta, errors, {
          duration: Date.now() - start,
          response: r.raw,
        });
  },
};

const jsonSchemaMeta: ScenarioMeta = {
  id: "structured-json-schema-strict",
  name: "Structured — strict json_schema mode honored",
  description:
    "response_format: json_schema strict — response matches schema (number type fidelity, required keys).",
  tags,
};

export const structuredJsonSchema: Scenario = {
  meta: jsonSchemaMeta,
  requires: { jsonSchema: true },
  async run(adapter, config) {
    const start = Date.now();
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "integer" },
        active: { type: "boolean" },
      },
      required: ["name", "count", "active"],
      additionalProperties: false,
    };
    const r = await adapter.send(config, {
      turns: [
        {
          type: "user",
          text: "Return any sensible profile. Set count to exactly 7 and active to true.",
        },
      ],
      responseFormat: {
        type: "json_schema",
        name: "profile",
        schema,
      },
      temperature: 0,
      maxTokens: 64,
    });
    const text = adapter.extractFinalText(r.raw);
    const errors = assertJsonObject(
      text,
      ["name", "count", "active"],
      "response",
    );
    if (errors.length === 0) {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.name !== "string") errors.push("name must be string");
      if (typeof parsed.count !== "number" || !Number.isInteger(parsed.count))
        errors.push(`count must be integer, got ${typeof parsed.count}`);
      if (typeof parsed.active !== "boolean")
        errors.push("active must be boolean");
    }
    return errors.length === 0
      ? makePass(jsonSchemaMeta, { duration: Date.now() - start })
      : makeFailure(jsonSchemaMeta, errors, {
          duration: Date.now() - start,
          response: r.raw,
        });
  },
};

export const structuredScenarios: Scenario[] = [
  structuredJsonMode,
  structuredJsonSchema,
];
