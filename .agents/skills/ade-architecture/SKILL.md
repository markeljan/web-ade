---
name: ade-architecture
description: >-
  Complete architectural reference and implementation runbook for web-ade.
  Use this skill when designing, modifying, debugging, or verifying AI SDK 7
  streaming routes, the 5-tier provider/billing waterfall, Sign in with Vercel
  OAuth and Vercel Connect, Astryx design tokens, @ui-sdk/react agent bridge,
  json-render generative UI, libfx/workflow harnesses, just-bash/wterm/Vercel
  Sandbox execution, or screen-relay/agent-browser live streaming.
---

# web-ade Architecture & Runbook

## 1. Stack & File Ownership Overview

- **Runtime & Build**: Next.js 16 (App Router, `reactCompiler: true`, `withWorkflow`), React 19, TypeScript (strict), Tailwind CSS v4, Bun package manager, Biome v2 (`bun run lint`).
- **Deployment Config**: [vercel.ts](../../vercel.ts) (`fluid: true`, queue trigger `queue/v2beta` on `app/api/libfx/route.ts` for topic `__libfx_wkf_workflow_session`, `retryAfterSeconds: 5`; optional commented `bunVersion: '1.4.x'`).
- **Storage & Auth**:
  - Neon Postgres (`DATABASE_URL`) via Drizzle ORM (`drizzle-orm` + `@neondatabase/serverless`) with local zero-DB fallback when unset.
  - Vercel Blob (`BLOB_READ_WRITE_TOKEN`) for multimodal attachments/images with inline base64 data URL fallback.
  - Better Auth (`BETTER_AUTH_SECRET`) supporting anonymous guest sessions + native `socialProviders.vercel` (and optional `@vercel/connect/betterauth`).
  - Upstash Redis (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) is strictly optional for `resumable-stream`.

## 2. AI SDK 7 Streaming, Tools & Multimodal Patterns

Always cross-check `node_modules/ai/docs/` and `node_modules/@ai-sdk/react/` for exact exported signatures.

- **Server Route Pattern**:
  - Validate incoming messages with `validateUIMessages`.
  - Stream via `createUIMessageStream` + `writer.merge(pipeJsonRender(result.toUIMessageStream({ messageMetadata })))` -> `createUIMessageStreamResponse`.
  - Bound multi-step tool loops with `stopWhen: stepCountIs(N)`.
  - Define tools with `tool({ description, inputSchema: z.object(...), execute })`.
- **Client Chat Hook Pattern**:
  - `useChat({ transport: new DefaultChatTransport({ api: '/api/chat', body }), ... })`
  - Send turns with `sendMessage({ text, files })`; render `message.parts` in exact interleaved order (`text`, `reasoning`, `tool-*`, `source-*`, `SPEC_DATA_PART_TYPE`).
- **Multimodal Inputs & Voice**:
  - Attachments: unified `{ type: 'file', data, mediaType }` (never `{ type: 'image' }`).
  - Image gen tool: `generateText` with `google/gemini-3.1-flash-image` (`result.files`) or `generateImage` with `openai/gpt-image-2`.
  - Voice 3-tier stack: STT (`transcribe`), TTS (`generateSpeech`), Live Realtime (`experimental_useRealtime` + `/api/realtime/token` -> `gateway.experimental_realtime.getToken`), with Web Speech API fallback on custom endpoints.

## 3. 5-Tier Provider Waterfall & Sign in with Vercel Billing

Resolve the active language model in strict priority order:

1. **Custom OpenAI-Compatible Endpoint**: Request/UI override or `OPENAI_COMPATIBLE_BASE_URL` (+ optional key/model) -> `createOpenAICompatible(...)`.
2. **User's Own Token**:
   - User-saved BYOK key in Settings (`vck_*` -> `createGateway`, `sk-*` -> `createOpenAI`).
   - Signed-in Vercel user's OAuth access token (`vca_*`, 1h TTL, auto-refreshed via 30d `refresh_token` at `POST https://api.vercel.com/login/oauth/token`): verify positive credit balance via `GET https://ai-gateway.vercel.sh/v1/credits` (cache ~60s) and pass to `createGateway({ apiKey: userAccessToken })`. Automatically fall back to Tier 3+ on HTTP `401`, `402`, or `403`.
3. **Host Sponsor `OPENAI_API_KEY` FIRST**: If `process.env.OPENAI_API_KEY` is configured, route OpenAI models (stripping `openai/` prefix) directly via `createOpenAI({ apiKey })`. Route non-OpenAI models to AI Gateway if Tier 4/5 credentials exist, or gracefully fall back to a default OpenAI model.
4. **Host Sponsor `AI_GATEWAY_API_KEY`**: `createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY })`.
5. **Vercel Project OIDC (`VERCEL_OIDC_TOKEN`)**: Automatic zero-config AI Gateway billing on Vercel deployments (charges the deployer's team credits on one-click deploy).

### Sign in with Vercel & Vercel Connect Setup Notes
- Create a Vercel App in Dashboard (`https://vercel.com/<team>/~/settings/apps`), set callback URL `<ORIGIN>/api/auth/callback/vercel`, enable scopes `openid profile email offline_access`, and (if enrolled in Vercel Apps Team Permissions private beta) request `AI Gateway: Use` + `Team: Read Only`.
- Set `VERCEL_CLIENT_ID` and `VERCEL_CLIENT_SECRET` in Vercel project env vars.
- For third-party OAuth/MCP connectors without static client secrets, attach connectors via `vercel connect attach <uid>` and authenticate exchanges using `@vercel/connect/betterauth` + `VERCEL_OIDC_TOKEN`.

## 4. Astryx Design System, `@ui-sdk/react` & `json-render`

- **Tokens**: Define semantic tokens using native CSS `light-dark(light, dark)` paired with `color-scheme` and `data-astryx-theme` (`neutral`, `stone`, `matcha`, `obsidian`), exposed to Tailwind v4 via `@theme inline`.
  - Neutral Light: canvas `#F1F4F7`, elevated surface `#FFFFFF`, hairline `#05365919`, accent `#0064E0`.
  - Neutral Dark: canvas `#111112`, surface `#1F1F22`, popover `#28292C`, hairline `#F2F4F619`, accent `#3D87FF`.
- **Fonts**: `Figtree` (UI/body) + `JetBrains Mono` (code/terminal/traces).
- **Concentric Radii**: `inner: 8px`, `element: 12px`, `container: 16px`, `chat: 28px`, `page: 32px` (`innerRadius = outerRadius - padding`).
- **Core Chrome (`@ui-sdk/react`)**:
  - `./resizable` (Chat <-> Workbench split), `./command` (`⌘K` palette), `./tree` (workspace files), `./trigger-menu` (`/` & `@` composer menus), `./waterfall` (tool/latency traces), `./preferences` (zero-flash theme/layout script).
  - `./agent` (`createAgent()`): expose semantic UI controls so the chat assistant can inspect and operate the ADE UI with human `allow` approval hooks.
- **Generative UI (`@json-render/*`)**:
  - Define Zod v4 catalog via `defineCatalog(schema, { components, actions })`, inject `catalog.prompt({ mode: 'inline' })`, pipe server stream with `pipeJsonRender`, render via `useJsonRenderMessage` + `<Renderer />`, and offer React export via `@json-render/codegen`.
- **Markdown (`streamdown`)**:
  - Register `@source "../node_modules/streamdown/dist/*.js";` and matching `@source` lines for `@streamdown/code`, `@streamdown/math`, and `@streamdown/mermaid` in `app/globals.css`.

## 5. Harnesses, Sandbox, Terminal & Live Browser/Desktop

- **Selectable Harnesses (`HarnessMode = 'ai-sdk' | 'fx' | 'workflow'`)**:
  - `ai-sdk`: Default universal runtime with `bash-tool` + `just-bash` (`InMemoryFs`) -> seamless upgrade to `@vercel/sandbox`.
  - `fx`: `libfx` durable sessions with custom `fetch` per-turn credential injection, `idempotent` tool annotations, and private queue consumer at `app/api/libfx/route.ts`.
  - `workflow`: `@ai-sdk/workflow` + `workflow` (`withWorkflow` in `next.config.ts`) for durable multi-step runs.
- **Terminal (`@wterm/react`)**:
  - Instant browser mode: `@wterm/react` + `@wterm/just-bash` sharing virtual workspace files.
  - Sandbox mode: bridge `@wterm/react` to `@vercel/sandbox` shell execution.
- **Unified `<BrowserPane />` Modes (Progressive Fallback)**:
  - **Mode A (`preview`)**: `<iframe>` targeting Sandbox preview URL (`sandbox.domain(3000)`) or local dev URL.
  - **Mode B (`screen-relay`)**: `screen-relay/protocol` (`NSL1` over WS + WebCodecs `VideoDecoder` `<canvas>` + cursor canvas). Always mint scoped `watch`/`control` grants server-side; toggle `/stream?view=1` <-> `/stream?take=1` for instant human takeover.
  - **Mode C (`agent-browser`)**: Live WS JPEG stream (`createImageBitmap` -> `<canvas>`) + mouse/keyboard forwarding via `@agent-browser/sandbox/vercel` (`startAgentBrowserMcp`).
  - **Mode D (`snapshot`)**: Screenshot + accessibility tree snapshot fallback (`remote-agent-browser` or non-WebCodecs browsers).

## 6. Verification Checklist

Run these commands from the repository root before shipping changes:

```bash
bun run typecheck   # Zero TypeScript errors
bun run lint        # Zero Biome errors
bun run build       # Clean Next.js 16 production build
bun run test        # Unit tests pass
bun run test:e2e    # Playwright smoke/E2E tests pass
```

Check Vercel environment sync (names only — never print values):

```bash
grep -E '^[A-Z0-9_]+=' .env.local | cut -d= -f1 | sort
```
