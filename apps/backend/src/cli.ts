#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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
  pierre status [options]

Commands:
  status           Your cross-repo "my turn" queue in the terminal, with
                   clickable links (see \`pierre status --help\`)

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
  Postgres + a GitHub sign-in method (an OAuth App and/or a GitHub App). See
  docs/GITHUB-AUTH-SETUP.md. Provide DATABASE_URL, APP_BASE_URL, SESSION_SECRET,
  ENCRYPTION_KEY, and at least one of GITHUB_OAUTH_CLIENT_ID+SECRET or
  GITHUB_APP_CLIENT_ID+SECRET.
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

// The default local SQLite location — a user-writable home dir, never the (possibly
// read-only) install dir. Shared by the server boot and `pierre status`.
function defaultLocalDbPath(): string {
  return join(homedir(), '.pierre-review', 'pierre-review.sqlite');
}

// Fail fast with a friendly message when the GitHub CLI isn't installed / authed.
// Both the local server boot and `pierre status` need a working `gh` token.
function ghAuthPreCheck(): void {
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

// ── `pierre status` — a self-contained, read-only subcommand ────────────────
interface StatusOptions {
  watch: boolean;
  sync: boolean;
  intervalSeconds: number;
  db?: string;
  help: boolean;
}

function parseStatusArgs(argv: string[]): StatusOptions {
  const opts: StatusOptions = {
    watch: false,
    sync: false,
    intervalSeconds: 60,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--watch':
        opts.watch = true;
        break;
      case '--sync':
        opts.sync = true;
        break;
      case '--interval': {
        const v = argv[++i];
        const n = v ? Number.parseInt(v, 10) : NaN;
        if (!Number.isFinite(n)) {
          console.error('--interval requires a number of seconds');
          process.exit(1);
        }
        opts.intervalSeconds = Math.max(10, n);
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
        console.error('Run `pierre status --help` for usage.');
        process.exit(1);
    }
  }
  return opts;
}

function printStatusUsage(): void {
  console.log(`pierre status — your cross-repo "my turn" queue in the terminal

Usage:
  pierre status [options]

Options:
  --sync           Fetch fresh state from GitHub first (otherwise shows data as of
                   the last sync). Under --watch, re-syncs at most every 5 minutes.
  --watch          Repaint on an interval until you quit (Ctrl-C)
  --interval <n>   Seconds between repaints under --watch (default 60, min 10)
  --db <path>      SQLite DB path (also DATABASE_URL env)
  -h, --help       Show this help

Reads the local pierre database. Without --sync it shows data as of the last sync
— run it alongside \`pierre\`, or pass --sync to fetch fresh state first. Links are
clickable in terminals that support OSC-8 hyperlinks.
`);
}

async function runStatusCommand(argv: string[]): Promise<void> {
  const opts = parseStatusArgs(argv);
  if (opts.help) {
    printStatusUsage();
    process.exit(0);
  }

  // status is LOCAL-only — it reads your on-disk SQLite database directly.
  if (process.env.DEPLOYMENT_MODE === 'cloud') {
    console.error(
      '`pierre status` is local-only — it reads your local SQLite database.',
    );
    process.exit(1);
  }
  // Pin local BEFORE the dynamic import: config.ts loads .env files on import, and
  // process.loadEnvFile never overrides an already-set var — so an .env-declared
  // DEPLOYMENT_MODE=cloud can't flip status onto the Postgres driver after the guard.
  process.env.DEPLOYMENT_MODE = 'local';

  // ── map flags → env BEFORE any dynamic import (config/db snapshot env on load) ──
  // resolve() the --db flag against the CWD (what the user means by a relative path);
  // config.ts resolves relative paths against the INSTALL dir, so an unresolved value
  // would make this guard check one file while the DB opens another.
  process.env.NODE_ENV ??= 'production';
  if (opts.db !== undefined) process.env.DATABASE_URL = resolve(opts.db);
  if (!process.env.DATABASE_URL) process.env.DATABASE_URL = defaultLocalDbPath();
  try {
    mkdirSync(dirname(process.env.DATABASE_URL), { recursive: true });
  } catch {
    /* best-effort; client.ts also mkdirs */
  }

  // Friendlier than the server path: don't silently create an empty DB just to show
  // an empty queue. --sync legitimately bootstraps a fresh DB, so skip the guard then.
  if (!opts.sync && !existsSync(process.env.DATABASE_URL)) {
    console.error(
      `No pierre database found at ${process.env.DATABASE_URL} — run \`pierre\` first to sync, or pass --db.`,
    );
    process.exit(1);
  }

  // ensureLocalAccount (`gh api user`) and --sync both need a working gh token.
  ghAuthPreCheck();

  const { runStatus } = await import('./status.js');
  await runStatus({
    watch: opts.watch,
    sync: opts.sync,
    intervalSeconds: opts.intervalSeconds,
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // `pierre status` — a read-only subcommand with its own parser, usage, and env
  // mapping. Peeled off BEFORE parseArgs (whose default case rejects any bare token),
  // and it never reaches the server boot below.
  if (argv[0] === 'status') {
    await runStatusCommand(argv.slice(1));
    return;
  }

  const opts = parseArgs(argv);

  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  // ── map flags → env BEFORE importing config/app (config reads these) ──────
  // --db is resolved against the CWD (config.ts resolves relative paths against the
  // install dir, which is never what a user typing a relative path means).
  if (opts.port !== undefined) process.env.PORT = String(opts.port);
  if (opts.db !== undefined) process.env.DATABASE_URL = resolve(opts.db);
  if (opts.open === false) process.env.NO_OPEN = '1';
  if (opts.cloud) process.env.DEPLOYMENT_MODE = 'cloud';
  const isCloud = process.env.DEPLOYMENT_MODE === 'cloud';

  // Production mode: skip pino-pretty (not shipped) and enable static serving.
  process.env.NODE_ENV ??= 'production';

  if (!isCloud) {
    // ── local: default the DB to a user-writable home location (mkdir -p) ────
    // The package dir is read-only for global installs, so never write there.
    if (!process.env.DATABASE_URL) {
      process.env.DATABASE_URL = defaultLocalDbPath();
    }
    try {
      mkdirSync(dirname(process.env.DATABASE_URL), { recursive: true });
    } catch {
      /* best-effort; client.ts also mkdirs */
    }

    // ── pre-check gh auth with a friendly message (contract §6) ─────────────
    ghAuthPreCheck();
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
