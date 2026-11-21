# web-ade — Agent Engineering Handbook

`web-ade` is an open-source **Web Agent Development Environment (ADE)** built on **Next.js 16**, **React 19**, **AI SDK 7**, **Bun**, **Vercel Labs** (`@ui-sdk/react`, `@json-render/*`, `streamdown`, `libfx`, `just-bash`, `bash-tool`, `@wterm/*`, `@agent-browser/sandbox`, `screen-relay`, `mcp-handler`, `@github-tools/sdk`), and the **Astryx Design Language**.

## Core Architecture & Non-Negotiable Rules

1. **AI SDK 7 Strictness (NO v4/v5/v6 Patterns)**
   - Use `streamText` / `ToolLoopAgent` + `toUIMessageStream()` / `createUIMessageStreamResponse()` + `stepCountIs(N)` (never `maxSteps`).
   - Use `inputSchema` (Zod v4) on `tool()` definitions (never `parameters`).
   - Client uses `@ai-sdk/react` `useChat` with `DefaultChatTransport`, `sendMessage({ text, files })`, `status`, and `message.parts` (never `handleSubmit`, `input`, `isLoading`, or `message.content` strings).
   - Multimodal inputs use unified `{ type: 'file', data, mediaType }` (never deprecated `{ type: 'image' }`).
   - Always check bundled docs in `node_modules/ai/docs/` and `node_modules/next/dist/docs/` before writing new SDK code.

2. **5-Tier Provider & Billing Waterfall (Strict Order)**
   1. **Custom OpenAI-Compatible Endpoint** (UI Settings override or `OPENAI_COMPATIBLE_BASE_URL`) via `@ai-sdk/openai-compatible`.
   2. **User's Own Token** — user-saved BYOK key in Settings (`vck_*` -> `createGateway`, `sk-*` -> `createOpenAI`) OR signed-in Vercel user's `vca_*` OAuth access token (auto-refreshed, checked against `GET https://ai-gateway.vercel.sh/v1/credits` with auto-fallback on `401`/`402`/`403`).
   3. **Host Sponsor `OPENAI_API_KEY` FIRST** — when `process.env.OPENAI_API_KEY` is set, prioritize direct `createOpenAI({ apiKey })` (stripping `openai/` prefix; routing non-OpenAI models to AI Gateway if available, or falling back gracefully to an OpenAI model).
   4. **Host Sponsor `AI_GATEWAY_API_KEY`** via `createGateway({ apiKey })`.
   5. **Vercel Project OIDC (`VERCEL_OIDC_TOKEN`)** — zero-config default on Vercel deployments.
   - Surface the active `BillingSource` transparently in the UI; never log, return, or persist raw API keys or OAuth tokens in client payloads or chat logs.

3. **Astryx Design Language & Progressive-Disclosure UI**
   - Use native CSS `light-dark()` tokens driven by `color-scheme` on `<html>` + `data-astryx-theme` (`neutral`, `stone`, `matcha`, `obsidian`), mapped into Tailwind v4 `@theme inline`.
   - Typography: `Figtree` (UI/body) + `JetBrains Mono` (code/terminal/traces).
   - Concentric radii (`8px` inner -> `12px` element -> `16px` container -> `28px` floating composer -> `32px` page) and 4px rem rhythm.
   - Content-first serene chat canvas; the right-hand Workbench (`@ui-sdk/react/resizable`) opens progressively on demand (Preview/Browser, Terminal, Files/Artifacts, GenUI Canvas, Trace Waterfall).
   - Include `@source "../node_modules/streamdown/dist/*.js";` (and matching `@source` for installed `@streamdown/*` plugins) in `app/globals.css`.

4. **Multi-Harness & Dual-Tier Sandbox Execution**
   - Default harness: AI SDK 7 (`ai-sdk`) with `bash-tool` backed by `just-bash` (`InMemoryFs`) locally/serverless and seamlessly upgraded to `@vercel/sandbox` when available.
   - Optional harnesses: durable `libfx` (`fx`, backed by private `/api/libfx` Vercel Queue trigger `__libfx_wkf_workflow_session`) and `@ai-sdk/workflow` (`workflow`).
   - Web Terminal: `@wterm/react` + `@wterm/just-bash` (instant browser shell) or live Sandbox bridge.
   - Browser/Desktop Pane: Progressive fallback across Mode A (`<iframe>` preview), Mode B (`screen-relay` WebCodecs H.264 + Take Control), Mode C (`agent-browser` WS JPEG stream), Mode D (screenshot/snapshot fallback).

5. **Security Invariants**
   - Never expose raw `screen-relay` session tokens to the browser — always mint short-lived scoped `watch` or `control` grants server-side.
   - Never print, echo, or commit secrets from `.env.local` or user BYOK credentials.
   - Require human-in-the-loop confirmation (`Sentinel` approval gate) before destructive sandbox/shell mutations, external side effects, or UI Agent Bridge actions.
   - All server routes must degrade gracefully when optional services (`UPSTASH_REDIS_*`, `VERCEL_CLIENT_ID`, `VERCEL_SANDBOX_SNAPSHOT_ID`, `BLOB_READ_WRITE_TOKEN`) are absent.

## Verification Commands

```bash
bun run typecheck   # Strict TypeScript check
bun run lint        # Biome v2 lint & format check
bun run build       # Production Next.js 16 build
bun run test        # Unit / integration tests
bun run test:e2e    # Playwright end-to-end suite
```

## Deep Architecture Reference

For full implementation details, package contracts, and integration checklists, activate the workspace skill `.agents/skills/ade-architecture/SKILL.md`.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
