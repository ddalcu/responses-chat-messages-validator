#!/usr/bin/env bun

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
      case "--help":
      case "-h":
        args.help = true;
        i += 1;
        break;
      default:
        i += 1;
    }
  }

  return args;
}

function printHelp() {
  const specList = specIds.map((id) => `${id} (${specs[id].label})`).join(", ");
  console.log(`
Usage: bun run bin/compliance-test.ts [options]

Options:
      --spec <id>             Spec suite to run: ${specIds.join(", ")} (default: responses)
  -u, --base-url <url>        API base URL (overrides spec default)
  -k, --api-key <key>         API key (or set OPENRESPONSES_API_KEY env var)
  -m, --model <model>         Model name (overrides spec default)
      --auth-header <name>    Auth header name (overrides spec default)
      --no-bearer             Disable Bearer prefix in auth header (overrides spec default)
  -f, --filter <ids>          Filter tests by ID (comma-separated)
  -v, --verbose               Verbose output with request/response details
      --json                  Output results as JSON
  -h, --help                  Show this help message

Available specs:
  ${specList}

Examples:
  bun run test:compliance --spec responses -k $OPENAI_API_KEY
  bun run test:compliance --spec chat-completions -k $OPENAI_API_KEY
  bun run test:compliance --spec anthropic-messages -k $ANTHROPIC_API_KEY
  bun run test:compliance --base-url http://localhost:8000/v1 --api-key sk-test-123
  bun run test:compliance -u https://api.openai.com/v1 -k $OPENAI_API_KEY --filter basic-response
  bun run test:compliance -u $API_URL -k $API_KEY --json > results.json

Environment Variables:
  OPENRESPONSES_API_KEY       Default API key if --api-key is not provided
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
  const duration = result.duration ? ` (${result.duration}ms)` : "";
  const events =
    result.streamEvents !== undefined ? ` [${result.streamEvents} events]` : "";
  const name =
    result.status === "failed" ? colors.red(result.name) : result.name;

  console.log(`${icon} ${name}${duration}${events}`);

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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const specId = (args.spec ?? "responses") as string;
  if (!(specId in specs)) {
    console.error(
      `${colors.red("Error:")} unknown --spec "${specId}". Available: ${specIds.join(", ")}`,
    );
    process.exit(1);
  }
  // Widen the suite from the inferred union of concrete suites to the
  // generic `SpecSuite` shape so the runner's generics align across all
  // registered specs.
  const suite = specs[specId as SpecId] as SpecSuite;

  const baseUrl = args.baseUrl ?? suite.defaultBaseUrl;

  const apiKey = args.apiKey || process.env.OPENRESPONSES_API_KEY;
  if (!apiKey) {
    console.error(
      `${colors.red("Error:")} --api-key is required or set OPENRESPONSES_API_KEY environment variable`,
    );
    console.error(`Run with --help for usage information.`);
    process.exit(1);
  }

  const config: TestConfig = {
    baseUrl,
    apiKey,
    model: args.model || suite.defaultModel,
    authHeaderName: args.authHeader || suite.defaultAuthHeaderName,
    // Default to the spec's preference, but `--no-bearer` overrides regardless.
    useBearerPrefix: args.noBearer ? false : suite.defaultUseBearerPrefix,
    runtime: "server",
  };

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

  if (!args.json) {
    console.log(`Spec: ${suite.label} (${suite.id})`);
    console.log(`Running compliance tests against: ${config.baseUrl}`);
    console.log(`Model: ${config.model}`);
    if (args.filter) {
      console.log(`Filter: ${args.filter.join(", ")}`);
    }
    console.log();
  }

  const selectedTemplates = args.filter?.length
    ? suite.templates.filter((template) => args.filter?.includes(template.id))
    : suite.templates;

  await runAllTests(suite, config, onProgress, selectedTemplates);

  const finalResults = allUpdates.filter(
    (r) => r.status === "passed" || r.status === "failed",
  );
  const passed = finalResults.filter((r) => r.status === "passed").length;
  const failed = finalResults.filter((r) => r.status === "failed").length;
  const skippedResults = allUpdates.filter((r) => r.status === "skipped");
  const skipped = skippedResults.length;
  const completedResults = [...finalResults, ...skippedResults];

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          spec: suite.id,
          summary: {
            passed,
            failed,
            skipped,
            total: completedResults.length,
          },
          results: completedResults,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`\n${"=".repeat(50)}`);
    console.log(
      `Results: ${colors.green(`${passed} passed`)}, ${colors.red(`${failed} failed`)}, ${colors.gray(`${skipped} skipped`)}, ${completedResults.length} total`,
    );

    if (failed > 0) {
      console.log(`\nFailed tests:`);
      for (const r of finalResults) {
        if (r.status === "failed") {
          console.log(`\n${r.name}:`);
          for (const e of r.errors || []) {
            console.log(`  - ${e}`);
          }
        }
      }
    } else {
      const message =
        skipped > 0 ? "✓ All runnable tests passed!" : "✓ All tests passed!";
      console.log(`\n${colors.green(message)}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(colors.red("Fatal error:"), error);
  process.exit(1);
});
