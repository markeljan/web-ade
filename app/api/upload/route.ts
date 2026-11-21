import { put } from '@vercel/blob';
import { metric } from '@vercel/functions';
import { NextResponse } from 'next/server';
import { GUEST_COOKIE_NAME, GUEST_HEADER_NAME, getServerSession } from '@/lib/auth/session';
import type { AttachmentItem } from '@/lib/types';
import { generateId, sanitizeFilename } from '@/lib/utils';

/** Vercel Functions request body upload limit (4.5 MB). */
const MAX_UPLOAD_BYTES = Math.floor(4.5 * 1024 * 1024);

/** Per-user sliding-window upload rate limit (20 uploads / 60s). */
const UPLOAD_RATE_LIMIT_MAX = 20;
const UPLOAD_RATE_LIMIT_WINDOW_MS = 60_000;
const UPLOAD_RATE_LIMIT_MAX_BUCKETS = 2_000;

/** Active browser-executable MIME types blocked from public Blob hosting (XSS prevention). */
const BLOCKED_MEDIA_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
]);

const BLOCKED_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'svg', 'svgz', 'xml']);

/** Explicit allowlist of safe upload MIME types. */
const ALLOWED_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/json',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/css',
  'text/javascript',
  'text/typescript',
  'text/x-python',
  'audio/mpeg',
  'audio/wav',
  'audio/webm',
  'audio/mp4',
  'audio/ogg',
  'application/octet-stream',
]);

interface GlobalUploadRateLimitState {
  __webAdeUploadRateLimit?: Map<string, number[]>;
}

const rateLimitGlobal = globalThis as unknown as GlobalUploadRateLimitState;

function getRateLimitMap(): Map<string, number[]> {
  if (!rateLimitGlobal.__webAdeUploadRateLimit) {
    rateLimitGlobal.__webAdeUploadRateLimit = new Map();
  }
  return rateLimitGlobal.__webAdeUploadRateLimit;
}

function checkRateLimitBucket(
  bucketKey: string,
  now: number,
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  const buckets = getRateLimitMap();
  const windowStart = now - UPLOAD_RATE_LIMIT_WINDOW_MS;

  // Periodic bounded cleanup so the map cannot grow unboundedly in long-lived instances.
  if (buckets.size > UPLOAD_RATE_LIMIT_MAX_BUCKETS) {
    for (const [key, timestamps] of buckets.entries()) {
      const active = timestamps.filter((ts) => ts > windowStart);
      if (active.length === 0) {
        buckets.delete(key);
      } else {
        buckets.set(key, active);
      }
    }
  }

  const recent = (buckets.get(bucketKey) ?? []).filter((ts) => ts > windowStart);
  if (recent.length >= UPLOAD_RATE_LIMIT_MAX) {
    const oldest = recent[0] ?? now;
    const retryAfterSec = Math.max(
      1,
      Math.ceil((oldest + UPLOAD_RATE_LIMIT_WINDOW_MS - now) / 1000),
    );
    buckets.set(bucketKey, recent);
    return { allowed: false, retryAfterSec };
  }

  recent.push(now);
  buckets.set(bucketKey, recent);
  return { allowed: true };
}

function getClientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || null;
}

function recordUploadMetric(
  outcome: 'blob' | 'data-url' | 'too-large' | 'invalid' | 'rate-limited' | 'error',
) {
  try {
    metric('ade.upload.requests', 1, { outcome });
  } catch {
    // Metrics are non-fatal outside Vercel runtime.
  }
}

function getFileExtension(filename: string): string | null {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return null;
  }
  return filename.slice(lastDot + 1).toLowerCase();
}

function normalizeMimeType(rawType?: string | null): string | null {
  const clean = rawType?.split(';')[0]?.trim().toLowerCase();
  return clean || null;
}

function inferMediaType(filename: string, rawType?: string | null): string {
  const clean = normalizeMimeType(rawType);
  if (clean && clean !== 'application/octet-stream') {
    return clean;
  }

  const ext = getFileExtension(filename);
  const byExt: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    css: 'text/css',
    js: 'text/javascript',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    py: 'text/x-python',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    webm: 'audio/webm',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
  };

  return (ext && byExt[ext]) || clean || 'application/octet-stream';
}

function isDisallowedUploadType(
  filename: string,
  rawType: string | null,
  mediaType: string,
): boolean {
  const ext = getFileExtension(filename);
  if (ext && BLOCKED_EXTENSIONS.has(ext)) {
    return true;
  }
  const declared = normalizeMimeType(rawType);
  if (declared && BLOCKED_MEDIA_TYPES.has(declared)) {
    return true;
  }
  if (BLOCKED_MEDIA_TYPES.has(mediaType)) {
    return true;
  }
  return !ALLOWED_MEDIA_TYPES.has(mediaType);
}

interface UploadPayload extends AttachmentItem {
  storage: 'vercel-blob' | 'data-url';
  pathname?: string;
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(request.headers);
    if (!session.userId?.trim()) {
      recordUploadMetric('invalid');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const now = Date.now();
    const userLimit = checkRateLimitBucket(`user:${session.userId}`, now);
    if (!userLimit.allowed) {
      recordUploadMetric('rate-limited');
      return NextResponse.json(
        { error: 'Upload rate limit exceeded. Please wait before uploading more files.' },
        {
          status: 429,
          headers: { 'Retry-After': String(userLimit.retryAfterSec) },
        },
      );
    }

    // Also rate-limit by IP when request carries no persistent session cookie/header
    // so unauthenticated callers cannot bypass per-user limits with ephemeral IDs.
    const cookieHeader = request.headers.get('cookie') ?? '';
    const hasPersistentIdentity =
      session.isAuthenticated ||
      cookieHeader.includes(`${GUEST_COOKIE_NAME}=`) ||
      request.headers.has(GUEST_HEADER_NAME);

    if (!hasPersistentIdentity) {
      const ip = getClientIp(request.headers);
      if (ip) {
        const ipLimit = checkRateLimitBucket(`ip:${ip}`, now);
        if (!ipLimit.allowed) {
          recordUploadMetric('rate-limited');
          return NextResponse.json(
            { error: 'Upload rate limit exceeded. Please wait before uploading more files.' },
            {
              status: 429,
              headers: { 'Retry-After': String(ipLimit.retryAfterSec) },
            },
          );
        }
      }
    }

    const contentTypeHeader = request.headers.get('content-type') ?? '';

    let fileBytes: Buffer;
    let rawFilename = 'upload.bin';
    let rawMediaType: string | null = null;

    if (contentTypeHeader.includes('multipart/form-data')) {
      const formData = await request.formData();
      const entry = formData.get('file');

      if (!(entry instanceof File)) {
        recordUploadMetric('invalid');
        return NextResponse.json(
          { error: 'Expected a "file" field in multipart/form-data payload' },
          { status: 400 },
        );
      }

      if (entry.size === 0) {
        recordUploadMetric('invalid');
        return NextResponse.json({ error: 'Uploaded file is empty' }, { status: 400 });
      }

      if (entry.size > MAX_UPLOAD_BYTES) {
        recordUploadMetric('too-large');
        return NextResponse.json(
          { error: 'File exceeds the 4.5 MB server upload limit' },
          { status: 413 },
        );
      }

      rawFilename = entry.name || rawFilename;
      rawMediaType = entry.type || null;
      fileBytes = Buffer.from(await entry.arrayBuffer());
    } else {
      const arrayBuffer = await request.arrayBuffer();
      if (arrayBuffer.byteLength === 0) {
        recordUploadMetric('invalid');
        return NextResponse.json({ error: 'Request body is empty' }, { status: 400 });
      }
      if (arrayBuffer.byteLength > MAX_UPLOAD_BYTES) {
        recordUploadMetric('too-large');
        return NextResponse.json(
          { error: 'File exceeds the 4.5 MB server upload limit' },
          { status: 413 },
        );
      }
      rawFilename = request.headers.get('x-filename') ?? rawFilename;
      rawMediaType = contentTypeHeader || null;
      fileBytes = Buffer.from(arrayBuffer);
    }

    const safeName = sanitizeFilename(rawFilename);
    const mediaType = inferMediaType(safeName, rawMediaType);

    if (isDisallowedUploadType(safeName, rawMediaType, mediaType)) {
      recordUploadMetric('invalid');
      return NextResponse.json(
        {
          error: `Unsupported or disallowed file type "${mediaType}". HTML, SVG, and XML uploads are blocked for security.`,
        },
        { status: 415 },
      );
    }

    const id = generateId('att');
    const isPreviewable = mediaType.startsWith('image/');

    if (process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
      const pathname = `uploads/${sanitizeFilename(session.userId, 48)}/${Date.now()}-${safeName}`;
      const blobContentType =
        mediaType === 'text/javascript' || mediaType === 'text/typescript'
          ? 'text/plain'
          : mediaType;

      const blob = await put(pathname, fileBytes, {
        access: 'public',
        addRandomSuffix: true,
        contentType: blobContentType,
      });

      recordUploadMetric('blob');

      const responsePayload: UploadPayload = {
        id,
        name: safeName,
        mediaType,
        size: fileBytes.byteLength,
        url: blob.url,
        ...(isPreviewable ? { previewUrl: blob.url } : {}),
        storage: 'vercel-blob',
        pathname: blob.pathname,
      };

      return NextResponse.json(responsePayload, { status: 201 });
    }

    const dataUrl = `data:${mediaType};base64,${fileBytes.toString('base64')}`;
    recordUploadMetric('data-url');

    const responsePayload: UploadPayload = {
      id,
      name: safeName,
      mediaType,
      size: fileBytes.byteLength,
      url: dataUrl,
      ...(isPreviewable ? { previewUrl: dataUrl } : {}),
      storage: 'data-url',
    };

    return NextResponse.json(responsePayload, { status: 201 });
  } catch (error) {
    recordUploadMetric('error');
    const message = error instanceof Error ? error.message : 'File upload failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
