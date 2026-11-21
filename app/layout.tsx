import type { Metadata, Viewport } from 'next';
import { Figtree, JetBrains_Mono } from 'next/font/google';
import type * as React from 'react';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getAstryxBootstrapScript } from '@/lib/theme/astryx-tokens';
import { UiAgentProvider } from '@/lib/ui-agent/bridge';
import './globals.css';

const figtree = Figtree({
  subsets: ['latin'],
  variable: '--font-figtree',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ||
      (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : 'https://web-ade.com'),
  ),
  title: {
    default: 'Web ADE — Open-Source Web Agent Development Environment',
    template: '%s | Web ADE',
  },
  description:
    'Open-source Web Agent Development Environment powered by Next.js 16, AI SDK 7, Vercel Labs, and the Astryx Design System.',
  openGraph: {
    title: 'Web ADE — Open-Source Web Agent Development Environment',
    description:
      'Open-source Web Agent Development Environment powered by Next.js 16, AI SDK 7, Vercel Labs, and the Astryx Design System.',
    url: 'https://web-ade.com',
    siteName: 'Web ADE',
    type: 'website',
  },
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
  width: 'device-width',
  initialScale: 1,
};

const bootstrapThemeScript = getAstryxBootstrapScript();

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-color-scheme="system"
      data-astryx-theme="neutral"
      className={`${figtree.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Zero-flash color-scheme + Astryx palette hydration script via @ui-sdk/core preferencesScript */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted static theme bootstrap script before hydration
          dangerouslySetInnerHTML={{ __html: bootstrapThemeScript }}
        />
      </head>
      <body className="min-h-dvh bg-[var(--bg-canvas)] font-sans text-[var(--fg-primary)] antialiased">
        <a href="#main-content" className="visually-hidden skip-link">
          Skip to workspace
        </a>
        <TooltipProvider>
          <UiAgentProvider>
            {children}
            <Toaster
              position="bottom-right"
              closeButton
              toastOptions={{
                style: {
                  background: 'var(--bg-popover)',
                  color: 'var(--fg-primary)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-element)',
                  boxShadow: 'var(--shadow-med)',
                },
              }}
            />
          </UiAgentProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
