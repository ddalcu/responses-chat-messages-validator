# Responses / Chat / Messages Validator

Compliance test suites for three LLM API surfaces, each runnable independently:

- **OpenAI Responses** — Open Responses spec (forked upstream): `POST /responses`
- **OpenAI Chat Completions** — `POST /chat/completions`
- **Anthropic Messages** — `POST /v1/messages`

Each suite ships its own OpenAPI schema, Zod validators, streaming parser, and test templates. Point any of them at any compliant backend and get pass/fail results.

This repo is a fork of [openresponses/openresponses](https://github.com/openresponses/openresponses) extended into a multi-spec hub.

## What's in this repo

- Specs (source): `schema/{responses,chat-completions,anthropic-messages}/openapi.json`
- Generated Zod schemas: `src/generated/kubb/{responses,chat-completions,anthropic-messages}/zod/`
- Compliance suites: `src/lib/compliance/{responses,chat-completions,anthropic-messages}/`
- Generic runner core: `src/lib/compliance/core/`
- CLI source: `bin/compliance-test.ts`
- Bundled CLI (built artifact): `bin/dist/llmprobe.mjs`

## Compliance testing

Published as the `llmprobe` CLI. The first positional arg is the base URL — bare hosts like `localhost:1234` are auto-prefixed with `http://` — and `--spec` selects a single suite (omit for auto-probe across all three).

### Quick start with `npx`

```bash
# Auto-probe every supported spec at a local endpoint (no install needed)
npx llmprobe localhost:11434/v1                                  # Ollama
npx llmprobe localhost:1234/v1                                   # LM Studio
npx llmprobe https://api.openai.com/v1 -k $OPENAI_API_KEY
```

### Single-spec runs

```bash
npx llmprobe --spec responses -k $OPENAI_API_KEY
npx llmprobe --spec chat-completions https://api.openai.com/v1 -k $OPENAI_API_KEY
# Anthropic Messages: auto-applies x-api-key auth and anthropic-version: 2023-06-01
npx llmprobe --spec anthropic-messages -k $ANTHROPIC_API_KEY
```

### Filter or get help

```bash
npx llmprobe --spec chat-completions --filter basic-completion,streaming-completion
npx llmprobe --help
```

### Local development

The `bun run test:compliance*` scripts still run the TypeScript source directly without a build step:

```bash
bun run test:compliance:responses --base-url http://localhost:8000/v1 --api-key $API_KEY
bun run test:compliance:chat --base-url https://api.openai.com/v1 --api-key $OPENAI_API_KEY
bun run test:compliance:anthropic --base-url https://api.anthropic.com --api-key $ANTHROPIC_API_KEY
```

Build the bundled CLI locally with `bun run build:cli` (output: `bin/dist/llmprobe.mjs`).

## Adding a new spec

Each suite is a `SpecSuite<TReq, TRes, TStreamCtx>` (see `src/lib/compliance/core/types.ts`). To add a fourth surface:

1. Drop an OpenAPI document at `schema/<spec-id>/openapi.json` and generate Zod schemas under `src/generated/kubb/<spec-id>/zod/` (kubb config is no longer in this repo; regenerate using your tool of choice or hand-author the schemas you need).
2. Implement `src/lib/compliance/<spec-id>/{suite.ts,templates.ts,sse-events.ts,validators.ts}` and export a `SpecSuite`.
3. Register it in the `specs` map in `bin/compliance-test.ts`.
