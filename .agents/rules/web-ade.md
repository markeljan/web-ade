---
trigger: always_on
description: Core engineering, design system, AI SDK 7, billing waterfall, and security rules for web-ade.
---

# web-ade Workspace Rules

## 1. Framework & SDK Compliance
- **Next.js 16 + React 19 + Bun**: Use App Router Server Components by default; add `'use client'` only at interactive leaves. Never use `forwardRef` (pass `ref` as a regular prop in React 19).
- **AI SDK 7 Only**:
  - Server: `streamText`, `ToolLoopAgent`, `createUIMessageStream`, `createUIMessageStreamResponse`, `stepCountIs(N)`, `validateUIMessages`, `tool({ inputSchema, execute })` with Zod v4.
  - Client: `useChat` with `DefaultChatTransport`, `sendMessage`, `status`, and typed `message.parts`.
  - Multimodal: Always emit `{ type: 'file', data, mediaType }` — never `{ type: 'image' }`.
  - Never use removed pre-v7 APIs (`parameters`, `maxSteps`, `handleSubmit`, `isLoading`, `toDataStreamResponse`).
- **Next.js External Packages**: Keep `libfx`, `screen-relay`, `just-bash`, and `@agent-browser/sandbox` in `serverExternalPackages`.

## 2. 5-Tier Model & Billing Resolution
Always resolve models strictly through the shared server provider resolver in this exact order:
1. Custom OpenAI-compatible endpoint (`OPENAI_COMPATIBLE_BASE_URL` or UI override).
2. User BYOK API key (`vck_*` / `sk-*`) OR signed-in Vercel OAuth access token (`vca_*`, auto-refreshed, verified via `GET https://ai-gateway.vercel.sh/v1/credits` with automatic fallback on `401`/`402`/`403`).
3. Host sponsor `OPENAI_API_KEY` (prioritized ahead of `AI_GATEWAY_API_KEY`).
4. Host sponsor `AI_GATEWAY_API_KEY`.
5. Vercel project OIDC (`VERCEL_OIDC_TOKEN`).

Always return the resolved `BillingSource` label in response metadata; never return, persist, or log raw credentials.

## 3. Astryx Visual Craft & UI Primitives
- Follow Astryx token semantics: CSS `light-dark()` with `color-scheme` + `data-astryx-theme` (`neutral` | `stone` | `matcha` | `obsidian`), `Figtree` + `JetBrains Mono`, concentric radii (`inner 8px`, `element 12px`, `container 16px`, `chat 28px`, `page 32px`), 4px spacing rhythm, translucent hairline borders, and disciplined motion (`fast 125ms`, `medium 300ms`, `slow 700ms`; instant hover/list highlights; honor `prefers-reduced-motion`).
- Build interactive chrome with `@ui-sdk/react` (`resizable`, `command`, `tree`, `trigger-menu`, `waterfall`, `preferences`, `agent`) and Base UI (`@base-ui/react`).
- Stream generative UI through `@json-render/core` + `@json-render/react` (`pipeJsonRender`) using Astryx-styled registry components, and render streaming Markdown via `streamdown` with `@source` globs registered in `app/globals.css`.

## 4. Security & Graceful Degradation
- **Zero Secret Leakage**: Never print `.env.local` values, never expose raw `screen-relay` session tokens to the client (mint scoped `watch`/`control` grants server-side), and keep `/api/libfx` queue-triggered only.
- **Human-in-the-Loop Gates**: Require explicit approval before destructive shell/file mutations, external PR/write actions, or `@ui-sdk/react/agent` UI bridge actions.
- **Optional Infrastructure**: Every feature must degrade cleanly when Redis (`UPSTASH_REDIS_*`), Vercel OAuth (`VERCEL_CLIENT_*`), Sandbox (`VERCEL_SANDBOX_SNAPSHOT_ID`), or Blob (`BLOB_READ_WRITE_TOKEN`) is unconfigured.

## 5. Verification Before Finishing Changes
Run `bun run typecheck && bun run lint` after edits, and `bun run build` before marking a feature complete.
