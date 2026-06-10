import {
  approxTextSimilarity,
  buildLongPrefix,
  makeFailure,
  makePass,
  makeSkipped,
  type ScenarioMeta,
} from "../behavior-helpers";
import type { Scenario } from "./types";

const tags = ["behavioral", "cache"];

const PROMPT = "Reply with only the single word 'banana'.";

const cacheDeterminismMeta: ScenarioMeta = {
  id: "cache-determinism",
  name: "Cache — determinism at temp=0",
  description:
    "The same prompt sent twice at temperature=0 produces matching outputs (≥0.9 similarity).",
  tags,
};

export const cacheDeterminism: Scenario = {
  meta: cacheDeterminismMeta,
  async run(adapter, config) {
    const start = Date.now();
    const [a, b] = await Promise.all([
      adapter.send(config, {
        turns: [{ type: "user", text: PROMPT }],
        temperature: 0,
        maxTokens: 16,
      }),
      adapter.send(config, {
        turns: [{ type: "user", text: PROMPT }],
        temperature: 0,
        maxTokens: 16,
      }),
    ]);
    const ta = adapter.extractFinalText(a.raw);
    const tb = adapter.extractFinalText(b.raw);
    const sim = approxTextSimilarity(ta, tb);
    if (sim < 0.9) {
      return makeFailure(
        cacheDeterminismMeta,
        [
          `temp=0 outputs not deterministic (similarity ${sim.toFixed(3)})\n  run 1: ${ta}\n  run 2: ${tb}`,
        ],
        { duration: Date.now() - start },
      );
    }
    return makePass(cacheDeterminismMeta, { duration: Date.now() - start });
  },
};

const cacheHitMeta: ScenarioMeta = {
  id: "cache-hit-reported",
  name: "Cache — repeated long prefix reports cache hit",
  description:
    "After a long shared prefix is sent twice, the engine reports cached_tokens > 0 on the second response.",
  tags,
};

export const cacheHit: Scenario = {
  meta: cacheHitMeta,
  async run(adapter, config) {
    const start = Date.now();
    // 8 KB shared prefix, distinct trailing question to avoid full hit.
    const prefix = buildLongPrefix(
      "The quick brown fox jumps over the lazy dog.",
      8192,
    );
    // First request to warm the cache.
    await adapter.send(config, {
      turns: [
        {
          type: "user",
          text: `${prefix}\n\nWhat is 1 + 1? Reply with just the number.`,
        },
      ],
      temperature: 0,
      maxTokens: 8,
    });
    // Second request shares the prefix, asks a different short tail.
    const second = await adapter.send(config, {
      turns: [
        {
          type: "user",
          text: `${prefix}\n\nWhat is 2 + 2? Reply with just the number.`,
        },
      ],
      temperature: 0,
      maxTokens: 8,
    });
    const cached = adapter.extractCachedTokens(second.raw);
    if (cached === null) {
      return makeSkipped(
        cacheHitMeta,
        "engine did not report cached-token usage on this response",
      );
    }
    if (cached <= 0) {
      return makeFailure(
        cacheHitMeta,
        [
          `expected cached_tokens > 0 on second request after 8 KB shared prefix; got ${cached}`,
        ],
        { duration: Date.now() - start, response: second.raw },
      );
    }
    return makePass(cacheHitMeta, { duration: Date.now() - start });
  },
};

const previousResponseIdMeta: ScenarioMeta = {
  id: "cache-previous-response-id-chain",
  name: "Cache — previous_response_id chain",
  description:
    "Two-turn conversation via previous_response_id produces an answer equivalent to inline multi-turn.",
  tags,
};

export const previousResponseIdChain: Scenario = {
  meta: previousResponseIdMeta,
  requires: { previousResponseId: true },
  async run(adapter, config) {
    const start = Date.now();
    const turn1 = await adapter.send(config, {
      turns: [
        {
          type: "user",
          text: "Remember the codeword 'quasar'. Acknowledge briefly.",
        },
      ],
      temperature: 0,
      maxTokens: 32,
    });
    const id = adapter.extractResponseId(turn1.raw);
    if (!id) {
      return makeFailure(
        previousResponseIdMeta,
        ["turn 1 did not return a response id"],
        { duration: Date.now() - start, response: turn1.raw },
      );
    }
    const chained = await adapter.send(config, {
      turns: [
        {
          type: "user",
          text: "What was the codeword? Reply with just the word.",
        },
      ],
      previousResponseId: id,
      temperature: 0,
      maxTokens: 16,
    });
    const text = adapter.extractFinalText(chained.raw);
    if (!/quasar/i.test(text)) {
      return makeFailure(
        previousResponseIdMeta,
        [
          `chained response did not recall codeword. response: ${text.slice(0, 200)}`,
        ],
        { duration: Date.now() - start, response: chained.raw },
      );
    }
    return makePass(previousResponseIdMeta, { duration: Date.now() - start });
  },
};

const promptCacheKeyMeta: ScenarioMeta = {
  id: "cache-prompt-cache-key",
  name: "Cache — prompt_cache_key sharing",
  description:
    "Two requests with the same prompt_cache_key and a long shared prefix; second reports more cached tokens than the first.",
  tags,
};

export const promptCacheKey: Scenario = {
  meta: promptCacheKeyMeta,
  requires: { promptCacheKey: true },
  async run(adapter, config) {
    const start = Date.now();
    const prefix = buildLongPrefix("The quick brown fox jumps.", 8192);
    const key = `llmprobe-cache-${Date.now()}`;
    const first = await adapter.send(config, {
      turns: [{ type: "user", text: `${prefix}\n\nWhat is 1+1?` }],
      promptCacheKey: key,
      temperature: 0,
      maxTokens: 8,
    });
    const second = await adapter.send(config, {
      turns: [{ type: "user", text: `${prefix}\n\nWhat is 2+2?` }],
      promptCacheKey: key,
      temperature: 0,
      maxTokens: 8,
    });
    const c1 = adapter.extractCachedTokens(first.raw);
    const c2 = adapter.extractCachedTokens(second.raw);
    if (c1 === null && c2 === null) {
      return makeSkipped(
        promptCacheKeyMeta,
        "engine does not report cached-token usage",
      );
    }
    if ((c2 ?? 0) <= (c1 ?? 0)) {
      return makeFailure(
        promptCacheKeyMeta,
        [
          `expected cached_tokens to grow under shared prompt_cache_key; got ${c1} → ${c2}`,
        ],
        { duration: Date.now() - start },
      );
    }
    return makePass(promptCacheKeyMeta, { duration: Date.now() - start });
  },
};

export const cacheScenarios: Scenario[] = [
  cacheDeterminism,
  cacheHit,
  previousResponseIdChain,
  promptCacheKey,
];
