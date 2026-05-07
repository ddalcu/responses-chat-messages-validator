#!/usr/bin/env node

import { buildAuthHeader } from "../src/lib/compliance/core/http";
import { runAllTests } from "../src/lib/compliance/core/runner";
import type {
  SpecSuite,
  TestConfig,
  TestResult,
} from "../src/lib/compliance/core/types";
import { anthropicMessagesSuite } from "../src/lib/compliance/anthropic-messages/suite";
import { chatCompletionsSuite } from "../src/lib/compliance/chat-completions/suite";
import { responsesSuite } from "../src/lib/compliance/responses/suite";

// Spec registry. Keys are user-facing values for the `--spec` flag.
const specs = {
  responses: responsesSuite,
  "chat-completions": chatCompletionsSuite,
  "anthropic-messages": anthropicMessagesSuite,
} as const satisfies Record<string, SpecSuite>;

type SpecId = keyof typeof specs;

const specIds = Object.keys(specs) as SpecId[];

const colors = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
};

interface CliArgs {
  spec?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  authHeader?: string;
  noBearer?: boolean;
  filter?: string[];
  verbose?: boolean;
  json?: boolean;
  help?: boolean;
  timeout?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    const nextArg = argv[i + 1];

    switch (arg) {
      case "--spec":
        args.spec = nextArg;
        i += 2;
        break;
      case "--base-url":
      case "-u":
        args.baseUrl = nextArg;
        i += 2;
        break;
      case "--api-key":
      case "-k":
        args.apiKey = nextArg;
        i += 2;
        break;
      case "--model":
      case "-m":
        args.model = nextArg;
        i += 2;
        break;
      case "--auth-header":
        args.authHeader = nextArg;
        i += 2;
        break;
      case "--no-bearer":
        args.noBearer = true;
        i += 1;
        break;
      case "--filter":
      case "-f":
        args.filter = nextArg.split(",").map((s) => s.trim());
        i += 2;
        break;
      case "--verbose":
      case "-v":
        args.verbose = true;
        i += 1;
        break;
      case "--json":
        args.json = true;
        i += 1;
        break;
      case "--timeout": {
        const n = Number(nextArg);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(
            `--timeout must be a positive number, got "${nextArg}"`,
          );
        }
        args.timeout = n;
        i += 2;
        break;
      }
      case "--help":
      case "-h":
        args.help = true;
        i += 1;
        break;
      default:
        // First non-flag argument is treated as the base URL, e.g.
        // `npx llmprobe localhost:1234`. Subsequent positional args are
        // ignored to avoid silently overriding an explicit `--base-url`.
        if (!arg.startsWith("-") && args.baseUrl === undefined) {
          args.baseUrl = arg;
        }
        i += 1;
    }
  }

  return args;
}

/**
 * Normalize bare host inputs like `localhost:1234` or `example.com:8080` into
 * full URLs by prepending `http://`. Already-qualified URLs (with a scheme)
 * pass through unchanged so users can still pass `https://api.openai.com/v1`.
 */
function normalizeBaseUrl(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  return `http://${input}`;
}

function printHelp() {
  const specList = specIds.map((id) => `${id} (${specs[id].label})`).join(", ");
  console.log(`
Usage: npx llmprobe [base-url] [options]

The first positional argument is treated as the API base URL (a bare
host:port like \`localhost:1234\` is automatically prefixed with http://).
You can still use -u/--base-url instead.

Without --spec, auto-mode probes every registered suite at the target base
URL (trying both /v1/<path> and /<path> variants) and runs only the suites
whose endpoint exists. Pass --spec to run a single suite without probing.

Options:
      --spec <id>             Run a single spec suite: ${specIds.join(", ")}
                              (omit for auto mode)
  -u, --base-url <url>        API base URL (overrides positional and spec
                              default; required for auto mode against local
                              servers like Ollama or LM Studio)
  -k, --api-key <key>         API key (optional — local servers like Ollama
                              don't need one; or set LLMPROBE_API_KEY)
  -m, --model <model>         Model name (overrides spec default)
      --auth-header <name>    Auth header name (overrides spec default)
      --no-bearer             Disable Bearer prefix in auth header (overrides spec default)
  -f, --filter <ids>          Filter tests by ID (comma-separated). In auto
                              mode, applied per-suite; suites with no matching
                              templates run nothing.
  -v, --verbose               Verbose output with request/response details
      --json                  Output results as JSON
      --timeout <seconds>     Per-request timeout in seconds (default: 60)
  -h, --help                  Show this help message

Available specs:
  ${specList}

Examples:
  # Auto mode (probes all 3 specs against your endpoint)
  npx llmprobe localhost:11434/v1                          # Ollama (no key needed)
  npx llmprobe http://localhost:1234/v1                    # LM Studio
  npx llmprobe localhost:8080/v1                           # mlx-serve
  npx llmprobe https://api.openai.com/v1 -k $OPENAI_API_KEY

  # Single-suite mode
  npx llmprobe --spec responses -k $OPENAI_API_KEY
  npx llmprobe --spec chat-completions -k $OPENAI_API_KEY
  npx llmprobe --spec anthropic-messages -k $ANTHROPIC_API_KEY

  # Filter and JSON
  npx llmprobe $API_URL -k $API_KEY --filter basic-response
  npx llmprobe $API_URL -k $API_KEY --json > results.json

Environment Variables:
  LLMPROBE_API_KEY            Default API key if --api-key is not provided
`);
}

function getStatusIcon(status: TestResult["status"]): string {
  switch (status) {
    case "passed":
      return colors.green("✓");
    case "failed":
      return colors.red("✗");
    case "skipped":
      return colors.gray("○");
    case "running":
      return colors.yellow("◉");
    case "pending":
      return colors.gray("○");
  }
}

function printResult(result: TestResult, verbose: boolean) {
  const icon = getStatusIcon(result.status);
  const parts: string[] = [];
  if (result.duration !== undefined) parts.push(`${result.duration}ms`);
  if (result.outputTokens !== undefined)
    parts.push(`${result.outputTokens} tok`);
  if (result.tokensPerSecond !== undefined)
    parts.push(`${result.tokensPerSecond} tok/s`);
  const meta = parts.length ? ` (${parts.join(" · ")})` : "";
  const events =
    result.streamEvents !== undefined ? ` [${result.streamEvents} events]` : "";
  const name =
    result.status === "failed" ? colors.red(result.name) : result.name;

  console.log(`${icon} ${name}${meta}${events}`);

  if (result.status === "skipped" && result.errors?.length) {
    for (const error of result.errors) {
      console.log(`  ${colors.gray("-")} ${colors.gray(error)}`);
    }
  }

  if (result.status === "failed" && result.errors?.length) {
    for (const error of result.errors) {
      console.log(`  ${colors.red("✗")} ${error}`);
    }

    if (verbose) {
      if (result.request) {
        console.log(`\n  Request:`);
        console.log(
          `  ${JSON.stringify(result.request, null, 2).split("\n").join("\n  ")}`,
        );
      }
      if (result.response) {
        console.log(`\n  Response:`);
        const responseStr =
          typeof result.response === "string"
            ? result.response
            : JSON.stringify(result.response, null, 2);
        console.log(`  ${responseStr.split("\n").join("\n  ")}`);
      }
    }
  }
}

interface ProbeResult {
  supported: boolean;
  status: number | "network-error";
  reason?: string;
  /** Resolved baseUrl (without trailing endpoint) — only set when supported. */
  effectiveBaseUrl?: string;
  /** Resolved endpoint relative to effectiveBaseUrl — only set when supported. */
  effectiveEndpoint?: string;
  /** All URLs that were tried (in order). */
  triedUrls?: string[];
}

interface SuiteRunSummary {
  spec: SpecId;
  label: string;
  baseUrl: string;
  probe: ProbeResult;
  passed: number;
  failed: number;
  skipped: number;
  results: TestResult[];
}

function buildConfigForSuite(
  suite: SpecSuite,
  args: CliArgs,
  apiKey: string,
): TestConfig {
  return {
    baseUrl: args.baseUrl ?? suite.defaultBaseUrl,
    apiKey,
    model: args.model || suite.defaultModel,
    authHeaderName: args.authHeader || suite.defaultAuthHeaderName,
    // Default to the spec's preference, but `--no-bearer` overrides regardless.
    useBearerPrefix: args.noBearer ? false : suite.defaultUseBearerPrefix,
    runtime: "server",
    timeoutMs: args.timeout ? args.timeout * 1000 : undefined,
  };
}

/**
 * Probe whether a base URL appears to support a suite's endpoint by issuing
 * a tiny POST with an empty JSON body. Tries both `/v1/<path>` and `/<path>`
 * variants so users can supply http://host or http://host/v1 interchangeably.
 *
 * POST (rather than HEAD) is used because real-world servers (e.g. mlx-serve)
 * don't always route HEAD even when the POST endpoint exists — they return
 * 404 for HEAD which would falsely report "not supported". Empty-body POST
 * incurs zero token cost: the server fails validation (typically 400 for
 * missing required fields) before any inference happens.
 *
 * - 404/405 on a variant → try the next variant.
 * - Anything else (400, 401, 403, 422, 500, 200) → endpoint exists; supported.
 * - Network error on the first probe → host unreachable; bail immediately
 *   (no point trying other paths on a dead host).
 */
async function probeSuite(
  suite: SpecSuite,
  config: TestConfig,
): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...buildAuthHeader(config),
    ...(suite.extraHeaders?.(config) ?? {}),
  };

  // Strip trailing slash and any trailing /v1 from the user-supplied base
  // so we can rebuild candidate URLs cleanly.
  const root = config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

  // The "version-less" path of this suite (e.g. `/responses`, `/messages`).
  const versionless = suite.defaultEndpoint.replace(/^\/v1(?=\/)/, "");

  // Each suite has a baseUrl/endpoint split convention we MUST preserve, since
  // some templates use `config.baseUrl` directly (e.g. WebSocket runners,
  // /responses/compact). If the suite's defaultEndpoint already includes /v1
  // (Anthropic), keep /v1 inside the endpoint. Otherwise (OpenAI suites) put
  // /v1 in the baseUrl alongside the existing convention.
  const v1InEndpoint = suite.defaultEndpoint.startsWith("/v1/");

  // Variants in preference order: /v1 form first (canonical for both OpenAI
  // and Anthropic), bare path second for unconventional servers.
  const candidates = v1InEndpoint
    ? [
        { baseUrl: root, endpoint: `/v1${versionless}` },
        { baseUrl: root, endpoint: versionless },
      ]
    : [
        { baseUrl: `${root}/v1`, endpoint: versionless },
        { baseUrl: root, endpoint: versionless },
      ];
  const seen = new Set<string>();
  const variants = candidates.filter((c) => {
    const key = c.baseUrl + c.endpoint;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const triedUrls: string[] = [];
  let lastNotFound: ProbeResult | null = null;

  for (const v of variants) {
    const url = `${v.baseUrl}${v.endpoint}`;
    triedUrls.push(url);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: "{}",
        signal: AbortSignal.timeout(5000),
      });
      // 404 = path missing. 405 = method not allowed (path doesn't take POST,
      // which for a JSON API means the path doesn't really exist either).
      if (res.status === 404 || res.status === 405) {
        lastNotFound = {
          supported: false,
          status: res.status,
          reason:
            res.status === 405 ? "method not allowed" : "endpoint not found",
          triedUrls: [...triedUrls],
        };
        continue;
      }
      return {
        supported: true,
        status: res.status,
        effectiveBaseUrl: v.baseUrl,
        effectiveEndpoint: v.endpoint,
        triedUrls: [...triedUrls],
      };
    } catch (err) {
      // Host is unreachable — no point trying other paths on the same host.
      return {
        supported: false,
        status: "network-error",
        reason: err instanceof Error ? err.message : String(err),
        triedUrls: [...triedUrls],
      };
    }
  }

  return (
    lastNotFound ?? {
      supported: false,
      status: 404,
      reason: "endpoint not found",
      triedUrls,
    }
  );
}

async function runSuite(
  suite: SpecSuite,
  config: TestConfig,
  args: CliArgs,
  probe: ProbeResult,
): Promise<SuiteRunSummary> {
  const allUpdates: TestResult[] = [];

  const onProgress = (result: TestResult) => {
    if (args.filter && !args.filter.includes(result.id)) {
      return;
    }
    allUpdates.push(result);
    if (!args.json) {
      printResult(result, args.verbose || false);
    }
  };

  const selectedTemplates = args.filter?.length
    ? suite.templates.filter((template) => args.filter?.includes(template.id))
    : suite.templates;

  await runAllTests(suite, config, onProgress, selectedTemplates);

  const finalResults = allUpdates.filter(
    (r) => r.status === "passed" || r.status === "failed",
  );
  const skippedResults = allUpdates.filter((r) => r.status === "skipped");
  const completedResults = [...finalResults, ...skippedResults];

  return {
    spec: suite.id as SpecId,
    label: suite.label,
    baseUrl: config.baseUrl,
    probe,
    passed: finalResults.filter((r) => r.status === "passed").length,
    failed: finalResults.filter((r) => r.status === "failed").length,
    skipped: skippedResults.length,
    results: completedResults,
  };
}

function printSuiteHeader(suite: SpecSuite, config: TestConfig, args: CliArgs) {
  console.log(`Spec: ${suite.label} (${suite.id})`);
  console.log(`Running compliance tests against: ${config.baseUrl}`);
  console.log(`Model: ${config.model}`);
  if (args.filter) {
    console.log(`Filter: ${args.filter.join(", ")}`);
  }
  console.log();
}

function printSuiteFooter(summary: SuiteRunSummary) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(
    `Results: ${colors.green(`${summary.passed} passed`)}, ${colors.red(`${summary.failed} failed`)}, ${colors.gray(`${summary.skipped} skipped`)}, ${summary.results.length} total`,
  );

  if (summary.failed > 0) {
    console.log(`\nFailed tests:`);
    for (const r of summary.results) {
      if (r.status === "failed") {
        console.log(`\n${r.name}:`);
        for (const e of r.errors || []) {
          console.log(`  - ${e}`);
        }
      }
    }
  } else {
    const message =
      summary.skipped > 0
        ? "✓ All runnable tests passed!"
        : "✓ All tests passed!";
    console.log(`\n${colors.green(message)}`);
  }
}

function formatProbeStatus(probe: ProbeResult): string {
  if (probe.supported) {
    const url = `${probe.effectiveBaseUrl ?? ""}${probe.effectiveEndpoint ?? ""}`;
    return `${colors.green(`supported (HTTP ${probe.status})`)}  ${colors.gray(url)}`;
  }
  const tried = probe.triedUrls?.length
    ? `  ${colors.gray(`tried: ${probe.triedUrls.join(", ")}`)}`
    : "";
  const detail =
    probe.status === "network-error"
      ? `unreachable (${probe.reason})`
      : `not supported (HTTP ${probe.status})`;
  return `${colors.gray(detail)}${tried}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  args.baseUrl = normalizeBaseUrl(args.baseUrl);

  // API key is optional — local servers (Ollama, LM Studio, mlx-serve) often
  // don't require auth at all. When empty, no auth header is sent.
  const apiKey = args.apiKey || process.env.LLMPROBE_API_KEY || "";

  // ── Single-suite mode ────────────────────────────────────────────────
  if (args.spec) {
    const specId = args.spec;
    if (!(specId in specs)) {
      console.error(
        `${colors.red("Error:")} unknown --spec "${specId}". Available: ${specIds.join(", ")}`,
      );
      process.exit(1);
    }
    const suite = specs[specId as SpecId] as SpecSuite;
    const config = buildConfigForSuite(suite, args, apiKey);

    if (args.filter?.length) {
      const availableIds = suite.templates.map((t) => t.id);
      const invalidFilters = args.filter.filter(
        (id) => !availableIds.includes(id),
      );
      if (invalidFilters.length) {
        console.error(
          `${colors.red("Error:")} Invalid test IDs: ${invalidFilters.join(", ")}`,
        );
        console.error(`Available test IDs: ${availableIds.join(", ")}`);
        process.exit(1);
      }
    }

    if (!args.json) printSuiteHeader(suite, config, args);

    const summary = await runSuite(suite, config, args, {
      supported: true,
      status: 0,
    });

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            spec: suite.id,
            summary: {
              passed: summary.passed,
              failed: summary.failed,
              skipped: summary.skipped,
              total: summary.results.length,
            },
            results: summary.results,
          },
          null,
          2,
        ),
      );
    } else {
      printSuiteFooter(summary);
    }

    process.exit(summary.failed > 0 ? 1 : 0);
  }

  // ── Auto mode (no --spec): probe every registered suite, run supported ──
  const summaries: SuiteRunSummary[] = [];

  if (!args.json) {
    const target = args.baseUrl ?? "(suite defaults)";
    console.log(`Auto mode: probing ${specIds.length} specs at ${target}`);
    console.log("─".repeat(60));
  }

  // First pass: probe all. Print probe results before running anything so the
  // user sees the plan. Each probe attempts both `/v1/<path>` and `/<path>`
  // so users can supply http://host or http://host/v1 interchangeably.
  const probes: { suite: SpecSuite; config: TestConfig; probe: ProbeResult }[] =
    [];
  for (const id of specIds) {
    const suite = specs[id] as SpecSuite;
    const config = buildConfigForSuite(suite, args, apiKey);
    const probe = await probeSuite(suite, config);

    // If the probe found a working variant, rewrite the config and a probed
    // copy of the suite so later test requests target that exact URL.
    let runSuiteRef: SpecSuite = suite;
    let runConfigRef: TestConfig = config;
    if (
      probe.supported &&
      probe.effectiveBaseUrl !== undefined &&
      probe.effectiveEndpoint !== undefined
    ) {
      runSuiteRef = { ...suite, defaultEndpoint: probe.effectiveEndpoint };
      runConfigRef = { ...config, baseUrl: probe.effectiveBaseUrl };
    }

    probes.push({ suite: runSuiteRef, config: runConfigRef, probe });
    if (!args.json) {
      console.log(`${suite.label.padEnd(28)} ${formatProbeStatus(probe)}`);
    }
  }

  // Second pass: run supported suites. Skipped suites still get a summary
  // entry so JSON consumers see the full picture.
  for (const { suite, config, probe } of probes) {
    if (!probe.supported) {
      summaries.push({
        spec: suite.id as SpecId,
        label: suite.label,
        baseUrl: config.baseUrl,
        probe,
        passed: 0,
        failed: 0,
        skipped: 0,
        results: [],
      });
      continue;
    }

    if (!args.json) {
      console.log(`\n${"━".repeat(60)}`);
      printSuiteHeader(suite, config, args);
    }
    const summary = await runSuite(suite, config, args, probe);
    summaries.push(summary);
    if (!args.json) printSuiteFooter(summary);
  }

  const totalSupported = summaries.filter((s) => s.probe.supported).length;
  const totalPassed = summaries.reduce((acc, s) => acc + s.passed, 0);
  const totalFailed = summaries.reduce((acc, s) => acc + s.failed, 0);
  const totalSkipped = summaries.reduce((acc, s) => acc + s.skipped, 0);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          mode: "auto",
          baseUrl: args.baseUrl ?? null,
          summary: {
            specsProbed: specIds.length,
            specsSupported: totalSupported,
            passed: totalPassed,
            failed: totalFailed,
            skipped: totalSkipped,
          },
          suites: summaries.map((s) => ({
            spec: s.spec,
            label: s.label,
            baseUrl: s.baseUrl,
            supported: s.probe.supported,
            probe: s.probe,
            ...(s.probe.supported && {
              summary: {
                passed: s.passed,
                failed: s.failed,
                skipped: s.skipped,
                total: s.results.length,
              },
              results: s.results,
            }),
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Auto-mode totals across ${totalSupported} supported spec(s):`);
    console.log(
      `  ${colors.green(`${totalPassed} passed`)}, ${colors.red(`${totalFailed} failed`)}, ${colors.gray(`${totalSkipped} skipped`)}`,
    );
    if (totalSupported === 0) {
      console.log(
        colors.yellow(
          "\nNo specs were detected as supported at the given base URL.",
        ),
      );
    }
  }

  // Exit non-zero if any failures, OR if we couldn't run anything at all.
  process.exit(totalFailed > 0 || totalSupported === 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(colors.red("Fatal error:"), error);
  process.exit(1);
});
