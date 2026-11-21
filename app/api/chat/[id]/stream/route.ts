import { Redis } from '@upstash/redis';
import { after, NextResponse } from 'next/server';
import {
  createResumableStreamContext,
  type Publisher,
  type ResumableStreamContext,
  type Subscriber,
} from 'resumable-stream/generic';
import { getServerSession } from '@/lib/auth/session';
import { getChatById } from '@/lib/db/queries';

export const maxDuration = 300;

interface ResumableBusState {
  context?: ResumableStreamContext;
  listeners?: Map<string, Set<(message: string) => void>>;
}

const globalResumable = globalThis as typeof globalThis & {
  __webAdeResumable?: ResumableBusState;
};

function getUpstashResumableContext(): ResumableStreamContext | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) {
    return null;
  }

  if (!globalResumable.__webAdeResumable) {
    globalResumable.__webAdeResumable = {
      listeners: new Map(),
    };
  }

  if (globalResumable.__webAdeResumable.context) {
    return globalResumable.__webAdeResumable.context;
  }

  const redis = new Redis({ url, token });
  const listeners = globalResumable.__webAdeResumable.listeners ?? new Map();
  globalResumable.__webAdeResumable.listeners = listeners;

  const publisher: Publisher = {
    connect: async () => undefined,
    publish: async (channel, message) => {
      const subs = listeners.get(channel);
      if (subs) {
        for (const cb of subs) {
          cb(message);
        }
      }
      return subs?.size ?? 0;
    },
    set: async (key, value, options) => {
      if (options?.EX) {
        return redis.set(key, value, { ex: options.EX });
      }
      return redis.set(key, value);
    },
    get: async (key) => {
      const value = await redis.get<string | number | null>(key);
      return value ?? null;
    },
    incr: async (key) => redis.incr(key),
  };

  const subscriber: Subscriber = {
    connect: async () => undefined,
    subscribe: async (channel, callback) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(callback);
    },
    unsubscribe: async (channel) => {
      listeners.delete(channel);
    },
  };

  const context = createResumableStreamContext({
    keyPrefix: 'web-ade:stream',
    waitUntil: after,
    publisher,
    subscriber,
  });

  globalResumable.__webAdeResumable.context = context;
  return context;
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Resumes an in-progress chat SSE stream when Upstash Redis is configured.
 * Enforces fail-closed chat ownership on private chats and degrades cleanly to
 * HTTP 204 when Redis is absent or no active stream exists.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  if (!id?.trim()) {
    return new Response(null, { status: 204 });
  }

  const session = await getServerSession(request.headers);

  let existingChat: Awaited<ReturnType<typeof getChatById>>;
  try {
    existingChat = await getChatById(id);
  } catch {
    return NextResponse.json({ error: 'Unable to verify chat stream ownership.' }, { status: 503 });
  }

  if (
    existingChat &&
    existingChat.visibility !== 'public' &&
    existingChat.userId !== session.userId
  ) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const streamContext = getUpstashResumableContext();
  if (!streamContext) {
    return new Response(null, { status: 204 });
  }

  const url = new URL(request.url);
  const resumeAtParam = url.searchParams.get('resumeAt');
  const skipCharacters = resumeAtParam !== null ? Number.parseInt(resumeAtParam, 10) : undefined;

  try {
    const resumed = await streamContext.resumeExistingStream(
      id,
      skipCharacters !== undefined && Number.isFinite(skipCharacters) && skipCharacters >= 0
        ? skipCharacters
        : undefined,
    );

    if (!resumed) {
      return new Response(null, { status: 204 });
    }

    return new Response(resumed, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch {
    return new Response(null, { status: 204 });
  }
}
