# Responses / Chat / Messages Validator

Compliance test suites for three LLM API surfaces, each runnable independently:

- **OpenAI Responses** — Open Responses spec (forked upstream): `POST /responses`
- **OpenAI Chat Completions** — `POST /chat/completions`
- **Anthropic Messages** — `POST /v1/messages`

Each suite ships its own OpenAPI schema, Zod validators, streaming parser, and test templates. Point any of them at any compliant backend and get pass/fail results.

This repo is a fork of [openresponses/openresponses](https://github.com/openresponses/openresponses) extended into a multi-spec hub.

## What's in this repo

- Specs: `schema/{responses,chat-completions,anthropic-messages}/openapi.json`
- Built/inlined specs: `public/openapi/{responses,chat-completions,anthropic-messages}.json`
- Generated Zod: `src/generated/kubb/{responses,chat-completions,anthropic-messages}/zod/`
- Compliance suites: `src/lib/compliance/{responses,chat-completions,anthropic-messages}/`
- Generic runner core: `src/lib/compliance/core/`
- CLI: `bin/compliance-test.ts`
- Web tester: `src/components/ComplianceTester.tsx`, mounted at `/compliance/{responses,chat-completions,anthropic-messages}`

## Compliance testing

The CLI dispatches to a suite via `--spec`. Each suite carries its own defaults (base URL, model, auth header, endpoint, extra headers) so you typically only supply the API key.

### Responses

```bash
bun run test:compliance:responses --base-url http://localhost:8000/v1 --api-key $API_KEY
```

### Chat Completions

```bash
bun run test:compliance:chat --base-url https://api.openai.com/v1 --api-key $OPENAI_API_KEY
```

### Anthropic Messages

The suite auto-applies `x-api-key` auth (no Bearer prefix) and `anthropic-version: 2023-06-01`.

```bash
bun run test:compliance:anthropic --base-url https://api.anthropic.com --api-key $ANTHROPIC_API_KEY
```

### Filter or get help

```bash
bun run test:compliance --spec chat-completions --filter basic-completion,streaming-completion
bun run test:compliance --help
```

### Web UI

`bun run dev` then visit:

- `/compliance` — hub
- `/compliance/responses`
- `/compliance/chat-completions`
- `/compliance/anthropic-messages`

## Adding a new spec

Each suite is a `SpecSuite<TReq, TRes, TStreamCtx>` (see `src/lib/compliance/core/types.ts`). To add a fourth surface:

1. Drop an OpenAPI document at `schema/<spec-id>/openapi.json` and a matching `kubb.<spec-id>.config.ts`.
2. Add `spec:<spec-id>` and `generate:zod:<spec-id>` scripts to `package.json`.
3. Implement `src/lib/compliance/<spec-id>/{suite.ts,templates.ts,sse-events.ts,validators.ts}` and export a `SpecSuite`.
4. Register it in the `specs` map in `bin/compliance-test.ts` and add a sibling MDX page under `src/pages/compliance/`.
