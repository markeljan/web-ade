#!/usr/bin/env tsx

/**
 * Pre-bake a @vercel/sandbox snapshot with:
 * - agent-browser + Chromium system deps (Mode C live pair-browsing)
 * - screen-relay + XFCE/X11 engine (Mode B 60fps WebCodecs H.264 streaming)
 * - agent-desktop (OS accessibility automation)
 * - fx CLI (Vercel Labs native coding agent CLI)
 *
 * Usage:
 *   bun run sandbox:snapshot
 *   bun run sandbox:snapshot -- --skip-desktop   # Fast browser-only snapshot
 *   bun run sandbox:snapshot -- --dry-run        # Validate credentials & steps only
 */

import {
  installAgentBrowserInVercelSandbox,
  type VercelSandboxSession,
} from '@agent-browser/sandbox/vercel';
import { Sandbox } from '@vercel/sandbox';
import { config as loadEnv } from 'dotenv';
import ms from 'ms';

loadEnv({ path: '.env.local' });
loadEnv();

interface CliFlags {
  dryRun: boolean;
  skipDesktop: boolean;
  skipFx: boolean;
  vcpus: number;
}

function parseFlags(argv: string[]): CliFlags {
  const flags = new Set(argv);
  const vcpuIdx = argv.indexOf('--vcpus');
  const parsedVcpus = vcpuIdx >= 0 ? Number(argv[vcpuIdx + 1]) : 4;

  return {
    dryRun: flags.has('--dry-run'),
    skipDesktop: flags.has('--skip-desktop'),
    skipFx: flags.has('--skip-fx'),
    vcpus: Number.isFinite(parsedVcpus) && parsedVcpus >= 2 ? Math.min(8, parsedVcpus) : 4,
  };
}

function hasCredentials(): boolean {
  return Boolean(
    process.env.VERCEL_OIDC_TOKEN ||
      (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID) ||
      process.env.VERCEL_TOKEN,
  );
}

async function runStep(
  sandbox: Sandbox,
  label: string,
  command: string,
  options?: { allowFailure?: boolean; timeoutMs?: number },
): Promise<boolean> {
  const started = Date.now();
  console.log(`\n→ ${label}...`);
  const result = await sandbox.runCommand('bash', ['-lc', command], {
    timeoutMs: options?.timeoutMs ?? ms('10m'),
  });
  const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);

  if (result.exitCode !== 0) {
    console.warn(`  ! ${label} exited with code ${result.exitCode} (${elapsedSec}s)`);
    if (stderr.trim()) {
      console.warn(stderr.trim().slice(-600));
    }
    if (!options?.allowFailure) {
      throw new Error(`Snapshot build step failed: ${label} (exit ${result.exitCode})`);
    }
    return false;
  }

  console.log(`  ✓ ${label} (${elapsedSec}s)`);
  if (stdout.trim()) {
    const preview = stdout.trim().split('\n').slice(-3).join('\n');
    console.log(`    ${preview.replaceAll('\n', '\n    ')}`);
  }
  return true;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  console.log('Web ADE · Vercel Sandbox Snapshot Builder');
  console.log('─────────────────────────────────────────────');
  console.log(`Mode: ${flags.skipDesktop ? 'Browser-only (fast)' : 'Full Desktop + Browser + fx'}`);
  console.log(`vCPUs: ${flags.vcpus}`);

  if (!hasCredentials()) {
    console.error(
      '\nError: Missing Vercel Sandbox credentials. Run `vercel env pull .env.local` (for VERCEL_OIDC_TOKEN) or set VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID.',
    );
    process.exitCode = 1;
    return;
  }

  if (flags.dryRun) {
    console.log('\n[dry-run] Credentials detected. Steps that would run:');
    console.log('  1. Boot @vercel/sandbox microVM exposing ports [3000, 4848, 8080]');
    console.log('  2. Install agent-browser + Chromium via @agent-browser/sandbox/vercel');
    if (!flags.skipDesktop) {
      console.log(
        '  3. Install screen-relay (`npm install -g screen-relay && screen-relay install --yes`)',
      );
      console.log('  4. Install agent-desktop (`npm install -g agent-desktop`)');
    }
    if (!flags.skipFx) {
      console.log('  5. Install fx CLI (`https://fx.sh/setup.sh`)');
    }
    console.log('  6. Create persistent snapshot and print VERCEL_SANDBOX_SNAPSHOT_ID');
    return;
  }

  console.log('\n→ Provisioning builder sandbox (ports 3000, 4848, 8080)...');
  const sandbox = await Sandbox.create({
    ports: [3000, 4848, 8080],
    resources: { vcpus: flags.vcpus },
    timeout: ms('30m'),
    persistent: false,
    tags: {
      app: 'web-ade',
      role: 'snapshot-builder',
    },
  });

  try {
    console.log(`  ✓ Builder sandbox ready: ${sandbox.name}`);

    const sessionAdapter: VercelSandboxSession = {
      runCommand: (cmd, args) => sandbox.runCommand(cmd, [...args]),
      snapshot: async () => {
        const snap = await sandbox.snapshot({ expiration: 0 });
        return { snapshotId: snap.snapshotId };
      },
      stop: async () => {
        await sandbox.stop();
      },
    };

    const pkgMgrCheck = await sandbox.runCommand('bash', [
      '-lc',
      'if command -v apt-get >/dev/null 2>&1; then echo apt; elif command -v dnf >/dev/null 2>&1; then echo dnf; else echo unknown; fi',
    ]);
    const pkgMgr = (await pkgMgrCheck.stdout()).trim();

    console.log(`\n→ Installing agent-browser & Chromium runtime (package manager: ${pkgMgr})...`);
    if (pkgMgr === 'apt') {
      await runStep(sandbox, 'Installing agent-browser CLI', 'npm install -g agent-browser', {
        timeoutMs: ms('5m'),
      });
      await runStep(
        sandbox,
        'Installing Chromium & Ubuntu system dependencies',
        'sudo env PATH="$PATH" agent-browser install --with-deps || (sudo apt-get update && sudo apt-get install -y --no-install-recommends libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2 libgtk-3-0 libdbus-1-3 || sudo apt-get install -y --no-install-recommends libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libgtk-3-0 libdbus-1-3) && agent-browser install',
        { timeoutMs: ms('10m') },
      );
    } else {
      await installAgentBrowserInVercelSandbox(sessionAdapter, {
        onStep: (event) => {
          const marker = event.status === 'done' ? '✓' : event.status === 'error' ? '!' : '·';
          console.log(`  ${marker} [agent-browser] ${event.step}`);
        },
      });
    }

    if (!flags.skipDesktop) {
      await runStep(
        sandbox,
        'Installing screen-relay CLI & desktop engine',
        'npm install -g screen-relay && sudo env PATH="$PATH" screen-relay install --yes || screen-relay install --yes',
        { timeoutMs: ms('15m') },
      );

      await runStep(sandbox, 'Installing agent-desktop CLI', 'npm install -g agent-desktop', {
        allowFailure: true,
        timeoutMs: ms('5m'),
      });
    }

    if (!flags.skipFx) {
      await runStep(
        sandbox,
        'Installing Vercel Labs fx CLI',
        'curl -fsSL https://fx.sh/setup.sh | bash',
        { allowFailure: true, timeoutMs: ms('5m') },
      );
    }

    await runStep(
      sandbox,
      'Verifying installed binaries',
      'command -v agent-browser && agent-browser --version; command -v screen-relay && screen-relay --version || true; command -v agent-desktop && agent-desktop --version || true; export PATH="$HOME/.local/bin:$PATH"; command -v fx && fx --version || true',
      { allowFailure: true },
    );

    console.log('\n→ Snapshotting sandbox filesystem...');
    const snap = await sandbox.snapshot({ expiration: 0 });

    console.log('\n════════════════════════════════════════════════════════════');
    console.log(
      'Snapshot created successfully! Add this to `.env.local` and Vercel Project Env Vars:\n',
    );
    console.log(`VERCEL_SANDBOX_SNAPSHOT_ID=${snap.snapshotId}`);
    console.log('════════════════════════════════════════════════════════════\n');
  } catch (error) {
    await sandbox.stop().catch(() => undefined);
    throw error;
  } finally {
    await sandbox.delete().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('\nSnapshot creation failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
