import { connect as vercelConnect } from '@vercel/connect/betterauth';
import { type BetterAuthPlugin, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { nextCookies } from 'better-auth/next-js';
import { anonymous } from 'better-auth/plugins/anonymous';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { getDb, isDatabaseConfigured } from '@/lib/db/index';
import { transferUserOwnership } from '@/lib/db/queries';
import { schema } from '@/lib/db/schema';

const DEV_FALLBACK_SECRET = 'web-ade-local-dev-secret-replace-in-production-32chars';

function resolveAuthSecret(): string {
  const configured = process.env.BETTER_AUTH_SECRET?.trim() || process.env.AUTH_SECRET?.trim();
  if (configured) {
    return configured;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('BETTER_AUTH_SECRET (or AUTH_SECRET) must be configured in production.');
  }
  return DEV_FALLBACK_SECRET;
}

/** Returns true when native Sign in with Vercel OAuth credentials are configured. */
export function isVercelOAuthConfigured(): boolean {
  return Boolean(process.env.VERCEL_CLIENT_ID?.trim() && process.env.VERCEL_CLIENT_SECRET?.trim());
}

/** Returns true when Vercel Connect OAuth connector UID is configured. */
export function isVercelConnectConfigured(): boolean {
  return Boolean(process.env.VERCEL_CONNECT_VERCEL_UID?.trim());
}

/** Returns true when either native Vercel OAuth or Vercel Connect is enabled. */
export function isVercelSignInEnabled(): boolean {
  return isVercelOAuthConfigured() || isVercelConnectConfigured();
}

function resolveBaseURL(): string {
  const explicit = process.env.BETTER_AUTH_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.trim()}`;
  }
  if (process.env.VERCEL_URL?.trim()) {
    return `https://${process.env.VERCEL_URL.trim()}`;
  }
  return 'http://localhost:3000';
}

function resolveTrustedOrigins(): string[] {
  const candidates = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://web-ade.com',
    'https://www.web-ade.com',
    process.env.BETTER_AUTH_URL?.trim(),
    process.env.NEXT_PUBLIC_APP_URL?.trim(),
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL.trim()}` : undefined,
    process.env.VERCEL_BRANCH_URL ? `https://${process.env.VERCEL_BRANCH_URL.trim()}` : undefined,
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL.trim()}`
      : undefined,
  ];

  const origins = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      // Ignore malformed origin values.
    }
  }
  return Array.from(origins);
}

function createAuthInstance() {
  const database = isDatabaseConfigured()
    ? drizzleAdapter(getDb(), {
        provider: 'pg',
        schema,
      })
    : memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
      });

  const hasNativeVercel = isVercelOAuthConfigured();
  const vercelConnectUid = process.env.VERCEL_CONNECT_VERCEL_UID?.trim();

  const plugins: BetterAuthPlugin[] = [
    anonymous({
      emailDomainName: 'guest.web-ade.local',
      onLinkAccount: async ({ anonymousUser, newUser }) => {
        await transferUserOwnership(anonymousUser.user.id, newUser.user.id);
      },
    }),
  ];

  if (vercelConnectUid) {
    plugins.push(
      genericOAuth({
        config: [
          vercelConnect({
            providerId: hasNativeVercel ? 'vercel-connect' : 'vercel',
            connector: vercelConnectUid,
            scopes: ['openid', 'profile', 'email'],
          }),
        ],
      }),
    );
  }

  // nextCookies() MUST always be the last plugin in the Better Auth plugins list.
  plugins.push(nextCookies());

  return betterAuth({
    appName: 'Web ADE',
    baseURL: resolveBaseURL(),
    secret: resolveAuthSecret(),
    trustedOrigins: resolveTrustedOrigins(),
    database,
    emailAndPassword: {
      enabled: true,
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 300,
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['vercel', 'vercel-connect'],
      },
    },
    ...(hasNativeVercel
      ? {
          socialProviders: {
            vercel: {
              clientId: process.env.VERCEL_CLIENT_ID!.trim(),
              clientSecret: process.env.VERCEL_CLIENT_SECRET!.trim(),
              scope: ['openid', 'profile', 'email', 'offline_access'],
            },
          },
        }
      : {}),
    plugins,
  });
}

export type AdeAuth = ReturnType<typeof createAuthInstance>;

interface GlobalAuthCache {
  __webAdeAuth?: AdeAuth;
}

const globalAuthCache = globalThis as unknown as GlobalAuthCache;

/** Lazily constructs and caches the Better Auth instance. */
export function getAuth(): AdeAuth {
  if (!globalAuthCache.__webAdeAuth) {
    globalAuthCache.__webAdeAuth = createAuthInstance();
  }
  return globalAuthCache.__webAdeAuth;
}
