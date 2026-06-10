import { describe, expect, it } from "bun:test";
import {
  approxTextSimilarity,
  isLengthStyleFinish,
  assertContains,
  assertJsonObject,
  assertNotContains,
  buildHaystackWithNeedle,
  buildLongPrefix,
  runConcurrent,
} from "./behavior-helpers";

describe("buildLongPrefix", () => {
  it("produces approximately the requested byte length", () => {
    const out = buildLongPrefix("hello world", 1000);
    expect(out.length).toBe(1000);
  });
  it("is deterministic for the same seed and length", () => {
    expect(buildLongPrefix("x", 200)).toBe(buildLongPrefix("x", 200));
  });
});

describe("buildHaystackWithNeedle", () => {
  it("places the needle in the middle by default", () => {
    const out = buildHaystackWithNeedle({
      fillerBytes: 200,
      needle: "MARKER",
    });
    expect(out).toContain("MARKER");
    const idx = out.indexOf("MARKER");
    expect(idx).toBeGreaterThan(50);
    expect(idx).toBeLessThan(out.length - 50);
  });
  it("supports start and end positions", () => {
    const start = buildHaystackWithNeedle({
      fillerBytes: 200,
      needle: "MARKER",
      position: "start",
    });
    expect(start.startsWith("MARKER")).toBe(true);
    const end = buildHaystackWithNeedle({
      fillerBytes: 200,
      needle: "MARKER",
      position: "end",
    });
    expect(end.endsWith("MARKER")).toBe(true);
  });
});

describe("runConcurrent", () => {
  it("runs all workers and returns results in order", async () => {
    const out = await runConcurrent(8, 3, async (i) => i * i);
    expect(out).toEqual([0, 1, 4, 9, 16, 25, 36, 49]);
  });
  it("never exceeds the requested concurrency", async () => {
    let active = 0;
    let max = 0;
    await runConcurrent(20, 4, async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    expect(max).toBeLessThanOrEqual(4);
  });
});

describe("assert helpers", () => {
  it("assertContains accepts string and regex", () => {
    expect(assertContains("hello world", "world", "lbl")).toEqual([]);
    expect(assertContains("hello world", /WORLD/i, "lbl")).toEqual([]);
    expect(assertContains("hello world", "xyz", "lbl").length).toBe(1);
  });

  it("assertNotContains is the inverse", () => {
    expect(assertNotContains("hello", "world", "lbl")).toEqual([]);
    expect(assertNotContains("hello world", "world", "lbl").length).toBe(1);
  });

  it("assertJsonObject parses and checks required keys", () => {
    expect(assertJsonObject('{"a":1,"b":2}', ["a", "b"], "lbl")).toEqual([]);
    expect(assertJsonObject('{"a":1}', ["a", "b"], "lbl").length).toBe(1);
    expect(assertJsonObject("not json", ["a"], "lbl").length).toBe(1);
    expect(assertJsonObject("[1,2,3]", ["a"], "lbl").length).toBe(1);
  });
});

describe("approxTextSimilarity", () => {
  it("returns 1 for identical text", () => {
    expect(approxTextSimilarity("hello world", "hello world")).toBe(1);
  });
  it("ignores case and whitespace", () => {
    expect(approxTextSimilarity("Hello,  World!", "hello world")).toBe(1);
  });
  it("returns 0 for completely disjoint sets", () => {
    expect(approxTextSimilarity("alpha beta", "gamma delta")).toBe(0);
  });
  it("returns 1 when both are empty", () => {
    expect(approxTextSimilarity("", "")).toBe(1);
  });
  it("scales with overlap", () => {
    const sim = approxTextSimilarity(
      "the quick brown fox jumped",
      "the quick brown fox sprinted",
    );
    // 4 shared / (5 + 5 - 4) = 4/6 = ~0.667
    expect(sim).toBeGreaterThan(0.6);
    expect(sim).toBeLessThan(0.7);
  });
});

describe("isLengthStyleFinish", () => {
  it("accepts the length-style finish reasons each spec produces", () => {
    expect(isLengthStyleFinish("length")).toBe(true); // chat-completions
    expect(isLengthStyleFinish("max_tokens")).toBe(true); // anthropic
    expect(isLengthStyleFinish("max-tokens")).toBe(true);
    expect(isLengthStyleFinish("max_output_tokens")).toBe(true); // responses
  });
  it("rejects non-length finish reasons", () => {
    expect(isLengthStyleFinish("stop")).toBe(false);
    expect(isLengthStyleFinish("end_turn")).toBe(false);
    expect(isLengthStyleFinish("incomplete")).toBe(false);
    expect(isLengthStyleFinish("tool_use")).toBe(false);
  });
});
