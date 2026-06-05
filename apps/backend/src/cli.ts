#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ── tiny ANSI helpers (degrade gracefully when not a TTY) ──────────────────
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code: string, s: string): string =>
  useColor ? `[${code}m${s}[0m` : s;
const cyan = (s: string): string => paint('36', s);
const dim = (s: string): string => paint('2', s);
const bold = (s: string): string => paint('1', s);

interface CliOptions {
  open: boolean;
  port?: number;
  db?: string;
  cloud: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { open: true, cloud: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--no-open':
        opts.open = false;
        break;
      case '--cloud':
        opts.cloud = true;
        break;
      case '--mode': {
        const v = argv[++i];
        if (v !== 'local' && v !== 'cloud') {
          console.error('--mode requires `local` or `cloud`');
          process.exit(1);
        }
        opts.cloud = v === 'cloud';
        break;
      }
      case '--port': {
        const v = argv[++i];
        const n = v ? Number.parseInt(v, 10) : NaN;
        if (!Number.isFinite(n)) {
          console.error('--port requires a number');
          process.exit(1);
        }
        opts.port = n;
        break;
      }
      case '--db': {
        const v = argv[++i];
        if (!v) {
          console.error('--db requires a path');
          process.exit(1);
        }
        opts.db = v;
        break;
      }
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        console.error('Run `pierre --help` for usage.');
        process.exit(1);
    }
  }
  return opts;
}

function printUsage(): void {
  console.log(`pierre — ${'local-only GitHub PR activity dashboard'}

Usage:
  pierre [options]
  pierre-review [options]

Options:
  --no-open        Don't open the browser (also honours NO_OPEN env)
  --port <n>       Port to listen on (also PORT env, default 4000)
  --db <path>      SQLite DB path (also DATABASE_URL env)
  --cloud          Run the deployed (cloud) experience: Postgres + landing page
                   + GitHub-App OAuth. Requires cloud env (see docs). Equivalent
                   to DEPLOYMENT_MODE=cloud. Skips the gh-auth pre-check.
  --mode <m>       'local' (default) or 'cloud'
  -h, --help       Show this help

Prerequisite (local mode):
  Requires the GitHub CLI (https://cli.github.com), authenticated via
  \`gh auth login\`. The dashboard reads your activity using your gh token.

Prerequisite (--cloud):
  Postgres + a GitHub App. See docs/LOCAL-CLOUD-TESTING.md. Provide
  DATABASE_URL, APP_BASE_URL, GITHUB_APP_*, SESSION_SECRET, ENCRYPTION_KEY.
`);
}

// Cross-platform browser open — no extra dependency.
function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  // Swallow failures — headless / no-DE environments are fine.
  execFile(cmd, args, () => {
    /* ignore */
  });
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  // ── map flags → env BEFORE importing config/app (config reads these) ──────
  if (opts.port !== undefined) process.env.PORT = String(opts.port);
  if (opts.db !== undefined) process.env.DATABASE_URL = opts.db;
  if (opts.open === false) process.env.NO_OPEN = '1';
  if (opts.cloud) process.env.DEPLOYMENT_MODE = 'cloud';
  const isCloud = process.env.DEPLOYMENT_MODE === 'cloud';

  // Production mode: skip pino-pretty (not shipped) and enable static serving.
  process.env.NODE_ENV ??= 'production';

  if (!isCloud) {
    // ── local: default the DB to a user-writable home location (mkdir -p) ────
    // The package dir is read-only for global installs, so never write there.
    if (!process.env.DATABASE_URL) {
      const dbPath = join(homedir(), '.pierre-review', 'pierre-review.sqlite');
      process.env.DATABASE_URL = dbPath;
    }
    try {
      mkdirSync(dirname(process.env.DATABASE_URL), { recursive: true });
    } catch {
      /* best-effort; client.ts also mkdirs */
    }

    // ── pre-check gh auth with a friendly message (contract §6) ─────────────
    try {
      execFileSync('gh', ['auth', 'token'], { stdio: 'ignore' });
    } catch {
      console.error('');
      console.error(bold('GitHub CLI not found or not authenticated.'));
      console.error(
        'Install the GitHub CLI (https://cli.github.com) and run `gh auth login`.',
      );
      console.error('');
      process.exit(1);
    }
  }
  // Cloud mode: no gh pre-check (each account brings its own OAuth token) and no
  // SQLite home default (DATABASE_URL must be a Postgres URL). config.ts /
  // assertCloudConfig validate the required cloud env at boot.

  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 4000;
  const base = `http://localhost:${port}`;
  // Local goes straight to the app; cloud opens the public landing page.
  const url = isCloud ? `${base}/` : `${base}/app`;

  // ── banner ────────────────────────────────────────────────────────────────
  const { PIERRE_ASCII, TAGLINE } = await import('./ascii.js');
  console.log(cyan(PIERRE_ASCII));
  console.log(`  ${dim(isCloud ? 'cloud mode — multi-tenant' : TAGLINE)}`);
  console.log('');
  console.log(`  ${cyan('▸')} ${bold(url)}`);
  console.log('');

  // ── boot the server (migrate → account → app → scheduler → listen) ────────
  const { start } = await import('./index.js');
  await start();

  // ── open the browser once we're listening ─────────────────────────────────
  const skipOpen = opts.open === false || process.env.NO_OPEN !== undefined;
  if (!skipOpen) openBrowser(url);
}

main().catch((err) => {
  console.error('Failed to start pierre:', err);
  process.exit(1);
});
