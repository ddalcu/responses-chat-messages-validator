import type { TestConfig, TestResult } from "./types";

// ────────────────────────────────────────────────────────────────────────────
// Spec-agnostic value types passed across the BehaviorAdapter boundary.
// The point of these types is to let scenario functions (multi-request flows
// like tool round-trip, parity, cache) be written ONCE in this module and
// reused across all three specs. The per-spec adapter translates to/from the
// spec's wire shape.
// ────────────────────────────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  /**
   * Stable id supplied by the engine. Required when emitting a follow-up
   * tool-result turn. Some chat-completions implementations omit it; adapter
   * may synthesise one. Empty string is allowed for engines that drop the id
   * but still produce a valid tool call.
   */
  id: string;
  name: string;
  /** Raw `arguments` payload as a string — adapter does NOT parse. */
  argsJson: string;
}

export interface AssistantTextTurn {
  type: "assistant-text";
  text: string;
}

export interface AssistantToolCallTurn {
  type: "assistant-tool-call";
  call: ToolCall;
}

export interface ToolResultTurn {
  type: "tool-result";
  toolCallId: string;
  output: string;
}

export interface UserTurn {
  type: "user";
  text: string;
}

export type Turn =
  | UserTurn
  | AssistantTextTurn
  | AssistantToolCallTurn
  | ToolResultTurn;

export interface RequestSpec {
  turns: Turn[];
  system?: string;
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  /** Spec-agnostic structured-output toggles. Adapter maps to wire format. */
  responseFormat?:
    | { type: "json_object" }
    | { type: "json_schema"; name: string; schema: Record<string, unknown> };
  previousResponseId?: string;
  promptCacheKey?: string;
}

export interface ParsedStreamForBehavior {
  events: unknown[];
  /** Spec-specific reassembled response object, when available. */
  finalResponse: unknown;
}

export interface SpecCapabilities {
  jsonMode: boolean;
  jsonSchema: boolean;
  previousResponseId: boolean;
  promptCacheKey: boolean;
  /** True when responses carry a separate reasoning/thinking channel. */
  reasoningChannel: boolean;
}

export interface SendResult<TRes> {
  raw: TRes;
  status: number;
  durationMs: number;
}

export interface SendStreamResult<TRes> {
  parsed: { events: unknown[]; finalResponse: TRes | null };
  durationMs: number;
}

export interface BehaviorAdapter<TRes = unknown> {
  /** Diagnostic only — used in error messages. */
  spec: "responses" | "chat-completions" | "anthropic-messages";
  capabilities: SpecCapabilities;
  /** Issue a non-streaming request and return the typed response. */
  send(config: TestConfig, request: RequestSpec): Promise<SendResult<TRes>>;
  /** Issue a streaming request and return the reassembled events + final. */
  sendStreaming(
    config: TestConfig,
    request: RequestSpec,
  ): Promise<SendStreamResult<TRes>>;
  // Response extraction
  extractFinalText(res: TRes): string;
  extractToolCalls(res: TRes): ToolCall[];
  extractFinishReason(res: TRes): string | null;
  extractCachedTokens(res: TRes): number | null;
  extractInputTokens(res: TRes): number | null;
  extractOutputTokens(res: TRes): number | null;
  extractResponseId(res: TRes): string | null;
  // Streaming reassembly (final response, when present, is preferred)
  reassembleStreamText(parsed: SendStreamResult<TRes>["parsed"]): string;
  reassembleStreamToolCalls(
    parsed: SendStreamResult<TRes>["parsed"],
  ): ToolCall[];
}

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers (testable without HTTP)
// ────────────────────────────────────────────────────────────────────────────

/** Build deterministic filler text of approximately `bytes` bytes. */
export function buildLongPrefix(seed: string, bytes: number): string {
  if (bytes <= 0) return "";
  const sentence = `${seed} `.trim() + " ";
  const out: string[] = [];
  let len = 0;
  let i = 0;
  while (len < bytes) {
    const piece = `[${i}] ${sentence}`;
    out.push(piece);
    len += piece.length;
    i += 1;
  }
  return out.join("").slice(0, bytes);
}

export function buildHaystackWithNeedle(opts: {
  fillerBytes: number;
  needle: string;
  position?: "start" | "middle" | "end";
}): string {
  const filler = buildLongPrefix(
    "The quick brown fox jumps over the lazy dog.",
    opts.fillerBytes,
  );
  const half = Math.floor(filler.length / 2);
  switch (opts.position ?? "middle") {
    case "start":
      return `${opts.needle}\n\n${filler}`;
    case "end":
      return `${filler}\n\n${opts.needle}`;
    case "middle":
    default:
      return `${filler.slice(0, half)}\n\n${opts.needle}\n\n${filler.slice(half)}`;
  }
}

/** Run `factory(i)` for i in [0, n) at most `concurrency` at a time. */
export async function runConcurrent<T>(
  n: number,
  concurrency: number,
  factory: (i: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(n);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, n));
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= n) return;
      results[i] = await factory(i);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

/** Validator-style: returns errors[] (empty if pass). */
export function assertContains(
  haystack: string,
  needle: string | RegExp,
  label: string,
): string[] {
  const ok =
    needle instanceof RegExp
      ? needle.test(haystack)
      : haystack.includes(needle);
  if (ok) return [];
  const display =
    needle instanceof RegExp ? String(needle) : JSON.stringify(needle);
  const preview =
    haystack.length > 200 ? `${haystack.slice(0, 200)}…` : haystack;
  return [`${label}: expected response to contain ${display}, got: ${preview}`];
}

export function assertNotContains(
  haystack: string,
  needle: string | RegExp,
  label: string,
): string[] {
  const present =
    needle instanceof RegExp
      ? needle.test(haystack)
      : haystack.includes(needle);
  if (!present) return [];
  const display =
    needle instanceof RegExp ? String(needle) : JSON.stringify(needle);
  return [`${label}: expected response to NOT contain ${display}`];
}

export function assertJsonObject(
  raw: string,
  requiredKeys: string[],
  label: string,
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return [
      `${label}: response is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    ];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [`${label}: parsed JSON is not an object`];
  }
  const missing = requiredKeys.filter((k) => !(k in (parsed as object)));
  if (missing.length) {
    return [`${label}: missing required keys: ${missing.join(", ")}`];
  }
  return [];
}

/**
 * Token-Jaccard similarity on lower-cased word tokens. Resilient to small
 * whitespace/punctuation differences while still catching genuinely different
 * outputs. Returns 0 when both inputs are empty.
 */
/**
 * Length-style finish reasons across specs: chat-completions reports
 * `length`, Anthropic reports `max_tokens`, and the Responses API reports
 * `incomplete_details.reason = "max_output_tokens"`.
 */
export function isLengthStyleFinish(finishReason: string): boolean {
  return /length|max[_-](output[_-])?tokens/i.test(finishReason);
}

export function approxTextSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(Boolean));
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

// ────────────────────────────────────────────────────────────────────────────
// Result aggregation helpers used by scenario functions.
// ────────────────────────────────────────────────────────────────────────────

export interface ScenarioMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export function makeFailure(
  meta: ScenarioMeta,
  errors: string[],
  options: {
    duration?: number;
    request?: unknown;
    response?: unknown;
    subResults?: TestResult[];
  } = {},
): TestResult {
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    status: "failed",
    duration: options.duration,
    request: options.request,
    response: options.response,
    errors,
    tags: meta.tags,
    subResults: options.subResults,
  };
}

export function makePass(
  meta: ScenarioMeta,
  options: {
    duration?: number;
    request?: unknown;
    response?: unknown;
    subResults?: TestResult[];
  } = {},
): TestResult {
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    status: "passed",
    duration: options.duration,
    request: options.request,
    response: options.response,
    tags: meta.tags,
    subResults: options.subResults,
  };
}

export function makeSkipped(meta: ScenarioMeta, reason: string): TestResult {
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    status: "skipped",
    duration: 0,
    errors: [reason],
    tags: meta.tags,
  };
}

/** Wrap an async scenario in try/catch so engine errors become TestResults. */
export async function runScenarioSafe(
  meta: ScenarioMeta,
  fn: () => Promise<TestResult>,
): Promise<TestResult> {
  const start = Date.now();
  try {
    return await fn();
  } catch (err) {
    return makeFailure(
      meta,
      [`scenario threw: ${err instanceof Error ? err.message : String(err)}`],
      { duration: Date.now() - start },
    );
  }
}
