import { createHmac, timingSafeEqual } from 'node:crypto';
import { createModelCallToUIChunkTransform, type ModelCallStreamPart } from '@ai-sdk/workflow';
import { pipeJsonRender } from '@json-render/core';
import { createUIMessageStreamResponse } from 'ai';
import { NextResponse } from 'next/server';
import { getRun } from 'workflow/api';
import { getServerSession } from '@/lib/auth/session';

export const maxDuration = 300;

const WORKFLOW_RUN_COOKIE = 'ade_wf_runs';
const RUN_TTL_MS = 24 * 60 * 60 * 1_000;

interface WorkflowRunOwnership {
  userId: string;
  chatId: string;
  createdAt: number;
}

const globalWorkflowState = globalThis as typeof globalThis & {
  __webAdeWorkflowRuns?: Map<string, WorkflowRunOwnership>;
};

function getRunOwnerSecret(): string | null {
  return process.env.BETTER_AUTH_SECRET?.trim() || process.env.AUTH_SECRET?.trim() || null;
}

function signRunPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
}

function readCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    if (part.slice(0, eqIdx).trim() === name) {
      return decodeURIComponent(part.slice(eqIdx + 1).trim());
    }
  }
  return null;
}

function findOwnershipFromSignedCookie(
  cookieHeader: string | null,
  runId: string,
): WorkflowRunOwnership | null {
  const secret = getRunOwnerSecret();
  if (!secret) {
    return null;
  }

  const raw = readCookieValue(cookieHeader, WORKFLOW_RUN_COOKIE);
  if (!raw) {
    return null;
  }

  const entries = raw.split(',').slice(-12);
  for (const encoded of entries) {
    try {
      const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
      const parts = decoded.split('|');
      if (parts.length !== 4) continue;
      const [entryRunId, userId, chatId, sig] = parts;
      if (entryRunId !== runId || !userId || !chatId || !sig) continue;

      const expected = signRunPayload(`${entryRunId}|${userId}|${chatId}`, secret);
      if (sig.length !== expected.length) continue;
      if (timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
        return { userId, chatId, createdAt: Date.now() };
      }
    } catch {
      // Ignore malformed token entries.
    }
  }

  return null;
}

function resolveWorkflowRunOwner(request: Request, runId: string): WorkflowRunOwnership | null {
  const map = globalWorkflowState.__webAdeWorkflowRuns;
  const cached = map?.get(runId);
  if (cached) {
    if (Date.now() - cached.createdAt <= RUN_TTL_MS) {
      return cached;
    }
    map?.delete(runId);
  }

  return findOwnershipFromSignedCookie(request.headers.get('cookie'), runId);
}

interface RouteContext {
  params: Promise<{ runId: string }>;
}

async function authorizeWorkflowRun(
  request: Request,
  runId: string,
): Promise<{ ok: true; owner: WorkflowRunOwnership } | { ok: false; response: Response }> {
  const session = await getServerSession(request.headers);
  const owner = resolveWorkflowRunOwner(request, runId);

  if (!owner || owner.userId !== session.userId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }

  return { ok: true, owner };
}

/**
 * Resume or inspect a durable Vercel Workflow 5 agent run.
 * Requires verified run ownership matching the caller's session.
 * - `GET /api/workflow/:runId?status=1` returns JSON run status metadata.
 * - `GET /api/workflow/:runId[?startIndex=N]` reconnects to the UI message stream.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { runId } = await context.params;
  if (!runId?.trim()) {
    return NextResponse.json({ error: 'Missing workflow runId.' }, { status: 400 });
  }

  const auth = await authorizeWorkflowRun(request, runId);
  if (!auth.ok) {
    return auth.response;
  }

  const url = new URL(request.url);
  const wantStatusOnly =
    url.searchParams.get('status') === '1' || url.searchParams.get('format') === 'status';

  try {
    const run = getRun(runId);
    const exists = await run.exists;
    if (!exists) {
      return NextResponse.json({ error: `Workflow run "${runId}" not found.` }, { status: 404 });
    }

    if (wantStatusOnly) {
      const [status, createdAt, startedAt, completedAt] = await Promise.all([
        run.status,
        run.createdAt,
        run.startedAt,
        run.completedAt,
      ]);

      return NextResponse.json({
        runId,
        chatId: auth.owner.chatId,
        exists: true,
        status,
        createdAt: createdAt.toISOString(),
        startedAt: startedAt?.toISOString() ?? null,
        completedAt: completedAt?.toISOString() ?? null,
      });
    }

    const startIndexParam = url.searchParams.get('startIndex');
    const parsedStartIndex =
      startIndexParam !== null ? Number.parseInt(startIndexParam, 10) : undefined;
    const uiStartIndex =
      parsedStartIndex !== undefined &&
      Number.isSafeInteger(parsedStartIndex) &&
      parsedStartIndex >= 0
        ? parsedStartIndex
        : undefined;

    const sourceReadable = run.getReadable<ModelCallStreamPart>({ startIndex: 0 });
    const tailIndex = await sourceReadable.getTailIndex();

    const uiStream = pipeJsonRender(
      sourceReadable.pipeThrough(createModelCallToUIChunkTransform({ uiStartIndex })),
    );

    return createUIMessageStreamResponse({
      stream: uiStream,
      headers: {
        'x-workflow-run-id': runId,
        'x-workflow-stream-tail-index': String(tailIndex),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to resume workflow run.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Cancel an active durable Workflow 5 agent run.
 * Requires verified run ownership matching the caller's session.
 */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const { runId } = await context.params;
  if (!runId?.trim()) {
    return NextResponse.json({ error: 'Missing workflow runId.' }, { status: 400 });
  }

  const auth = await authorizeWorkflowRun(request, runId);
  if (!auth.ok) {
    return auth.response;
  }

  try {
    const run = getRun(runId);
    const exists = await run.exists;
    if (!exists) {
      return NextResponse.json({ error: `Workflow run "${runId}" not found.` }, { status: 404 });
    }

    await run.cancel({ cancelReason: 'Cancelled by user' });
    return NextResponse.json({ ok: true, runId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to cancel workflow run.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
