#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

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
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { open: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--no-open':
        opts.open = false;
        break;
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
        console.error('Run `limn --help` for usage.');
        process.exit(1);
    }
  }
  return opts;
}

function printUsage(): void {
  console.log(`limn — ${'local-only GitHub PR activity dashboard'}

Usage:
  limn [options]
  limn status [options]
  limn ai install
  limn ml install

Commands:
  status           Your cross-repo "my turn" queue in the terminal, with
                   clickable links (see \`limn status --help\`)
  ai install       Download the AI runtime Claude Review and AI Fix run on
                   (one time, about 110 MB). The app offers the same button.
  ai status        Say whether the AI runtime is set up
  ml install       Download the model that scores bot review comments
                   (one time, about 240 MB). The app offers the same button.
  ml status        Say whether bot comment scoring is set up

Options:
  --no-open        Don't open the browser (also honours NO_OPEN env)
  --port <n>       Port to listen on (also PORT env, default 4000)
  --db <path>      SQLite DB path (also DATABASE_URL env)
  -h, --help       Show this help

The old \`pierre-review\` package now only forwards to this one; it will be removed.

Your data lives in ~/.limn (LIMN_DATA_DIR overrides). An existing ~/.pierre-review
is moved there once, on first start.

Prerequisite:
  Requires the GitHub CLI (https://cli.github.com), authenticated via
  \`gh auth login\`. The dashboard reads your activity using your gh token.
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
// read-only) install dir. Shared by the server boot and `limn status`. The FILE keeps its
// pre-rename name on purpose: the one-time move of ~/.pierre-review → ~/.limn carries it (and its
// WAL files) across untouched, and renaming a live SQLite file is a second migration for nothing.
async function defaultLocalDbPath(): Promise<string> {
  const { resolveDataDir } = await import('./data-dir.js');
  return join(resolveDataDir(), 'pierre-review.sqlite');
}

// Move a pre-rename ~/.pierre-review to ~/.limn, once, before anything reads a path inside it.
// Never clobbers an existing ~/.limn; never moves into an explicit LIMN_DATA_DIR.
async function migrateDataDir(): Promise<void> {
  const { migrateLegacyDataDir } = await import('./data-dir.js');
  migrateLegacyDataDir({ log: (msg) => console.log(`  ${dim(msg)}`) });
}

// Fail fast with a friendly message when the GitHub CLI isn't installed / authed.
// Both the local server boot and `limn status` need a working `gh` token.
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

// ── `limn status` — a self-contained, read-only subcommand ────────────────
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
        console.error('Run `limn status --help` for usage.');
        process.exit(1);
    }
  }
  return opts;
}

function printStatusUsage(): void {
  console.log(`limn status — your cross-repo "my turn" queue in the terminal

Usage:
  limn status [options]

Options:
  --sync           Fetch fresh state from GitHub first (otherwise shows data as of
                   the last sync). Under --watch, re-syncs at most every 5 minutes.
  --watch          Repaint on an interval until you quit (Ctrl-C)
  --interval <n>   Seconds between repaints under --watch (default 60, min 10)
  --db <path>      SQLite DB path (also DATABASE_URL env)
  -h, --help       Show this help

Reads the local Limn database. Without --sync it shows data as of the last sync
— run it alongside \`limn\`, or pass --sync to fetch fresh state first. Links are
clickable in terminals that support OSC-8 hyperlinks.
`);
}

async function runStatusCommand(argv: string[]): Promise<void> {
  const opts = parseStatusArgs(argv);
  if (opts.help) {
    printStatusUsage();
    process.exit(0);
  }

  // ── map flags → env BEFORE any dynamic import (config/db snapshot env on load) ──
  // resolve() the --db flag against the CWD (what the user means by a relative path);
  // config.ts resolves relative paths against the INSTALL dir, so an unresolved value
  // would make this guard check one file while the DB opens another.
  process.env.NODE_ENV ??= 'production';
  if (opts.db !== undefined) process.env.DATABASE_URL = resolve(opts.db);
  await migrateDataDir();
  if (!process.env.DATABASE_URL) process.env.DATABASE_URL = await defaultLocalDbPath();
  try {
    mkdirSync(dirname(process.env.DATABASE_URL), { recursive: true });
  } catch {
    /* best-effort; client.ts also mkdirs */
  }

  // Friendlier than the server path: don't silently create an empty DB just to show
  // an empty queue. --sync legitimately bootstraps a fresh DB, so skip the guard then.
  if (!opts.sync && !existsSync(process.env.DATABASE_URL)) {
    console.error(
      `No Limn database found at ${process.env.DATABASE_URL} — run \`limn\` first to sync, or pass --db.`,
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

// ── `limn ai install|status|login|logout` — the AI runtime and Codex's sign-in, from the terminal ──
// The same download the app's "Set up AI" button runs (ai/runtime.ts): the pinned Agent SDK and
// its three peers into ~/.limn/ai-runtime via `npm install --prefix` — plus, with `codex`, the Codex
// CLI. `login codex` / `logout codex` sign Limn's OWN Codex home (~/.limn/codex) in and out; the
// reader's own ~/.codex is never touched.
async function runAiCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  const target = argv[1];
  const known = sub === 'install' || sub === 'status' || sub === 'login' || sub === 'logout';
  const targetOk =
    sub === 'install' ? target === undefined || target === 'claude' || target === 'codex'
    : sub === 'login' || sub === 'logout' ? target === 'codex'
    : true;
  if (!known || !targetOk) {
    console.log(`limn ai — the AI runtime Claude Review and AI Fix run on

Usage:
  limn ai install          Download it (one time, about 110 MB) into ~/.limn/ai-runtime
  limn ai install codex    The same, plus the Codex CLI
  limn ai status           Say whether it is set up
  limn ai login codex      Sign Limn's own Codex in (add --device-auth on a headless machine)
  limn ai logout codex     Sign it out

Claude Review and AI Fix are free. They run on your own Claude Code login or
Anthropic API key: sign in to Claude Code, or set ANTHROPIC_API_KEY.
Set LIMN_AI_USE_API_KEY=true to use the key even when you are signed in.
Set LIMN_CLAUDE_PATH to use your installed \`claude\` and skip its bundled copy.

Codex keeps its own ChatGPT sign-in in ~/.limn/codex (your ~/.codex is not used).
Codex with an OpenAI API key is not available yet. Set LIMN_CODEX_PATH to use your
installed codex program.
`);
    process.exit(sub === undefined || sub === '--help' || sub === '-h' ? 0 : 1);
  }
  if (process.env.LIMN_AI_DISABLED === 'true') {
    console.error('AI is turned off here (LIMN_AI_DISABLED=true).');
    process.exit(1);
  }
  await migrateDataDir();
  const { getAiRuntimeStatus, getCodexRuntimeStatus, installAiRuntime, aiRuntimePins, codexRuntimePin } =
    await import('./ai/runtime.js');

  if (sub === 'status') {
    const s = getAiRuntimeStatus();
    const words =
      s.runtime === 'ready' ? 'AI is set up.' : 'AI is not set up. Run: limn ai install';
    console.log(s.runtimeMessage ? `${words} ${s.runtimeMessage}` : words);
    const c = getCodexRuntimeStatus();
    if (c.runtime === 'ready') {
      const { detectCodex } = await import('./ai/codex/detect.js');
      const d = await detectCodex();
      const plan = d.plan ? ` (${d.plan})` : '';
      console.log(
        d.route === 'login'
          ? `Codex is set up and signed in${plan}.`
          : d.route === 'api_key'
            ? 'Codex is set up and uses an API key.'
            : 'Codex is set up but not signed in. Run: limn ai login codex',
      );
    } else if (c.runtimeMessage) {
      console.log(`Codex: ${c.runtimeMessage}`);
    }
    process.exit(s.runtime === 'ready' ? 0 : 1);
  }

  if (sub === 'login' || sub === 'logout') {
    const { codexBinaryPath } = await import('./ai/runtime.js');
    const { codexHome, codexProcessEnv, ensureCodexHomeConfig, CODEX_NOT_INSTALLED_MESSAGE } = await import(
      './ai/codex/home.js'
    );
    const bin = codexBinaryPath();
    if (!bin) {
      console.error(CODEX_NOT_INSTALLED_MESSAGE);
      process.exit(1);
    }
    // File-store auth in Limn's own home BEFORE anything is written there.
    await ensureCodexHomeConfig(null);
    const args = sub === 'logout' ? ['logout'] : ['login', ...(argv.includes('--device-auth') ? ['--device-auth'] : [])];
    if (sub === 'login') console.log(dim(`Signing Limn's own Codex in (${codexHome()}). Your ~/.codex is not used.`));
    const { spawnSync } = await import('node:child_process');
    // The terminal is attached: Codex prints its own URL or device code and waits for the reader.
    const r = spawnSync(bin, args, { stdio: 'inherit', env: codexProcessEnv(process.env, { interactive: true }), cwd: codexHome() });
    process.exit(r.status ?? 1);
  }

  const withCodex = target === 'codex';
  const pins = aiRuntimePins();
  if (pins) {
    console.log(bold(`Setting up AI (one-time download, about 110 MB${withCodex ? ', plus Codex' : ''}):`));
    for (const [name, version] of Object.entries(pins)) console.log(`  ${dim(`${name}@${version}`)}`);
    const codexPin = withCodex ? codexRuntimePin() : null;
    if (codexPin) console.log(`  ${dim(`@openai/codex@${codexPin}`)}`);
  }
  const result = await installAiRuntime(
    (p) => {
      if (p.phase === 'downloading') console.log(`  ${dim(p.message)}`);
      else if (p.phase !== 'failed') console.log(`${cyan('▸')} ${p.message}`);
    },
    { providers: withCodex ? ['claude', 'codex'] : ['claude'] },
  );
  if (result.ok && withCodex) console.log(dim('Next: limn ai login codex'));
  if (!result.ok) {
    console.error(bold(result.message));
    process.exit(1);
  }
}

// ── `limn ml install` / `limn ml status` — local bot-comment scoring ───────────────
// The same download the app's "Set up" runs (ml/runtime.ts): onnxruntime-node + the tokenizer
// into ~/.limn/ml-runtime, and the severity model into ~/.limn/ml-models.
async function runMlCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub !== 'install' && sub !== 'status') {
    console.log(`limn ml — the model that scores bot review comments

Usage:
  limn ml install   Download it (one time, about 240 MB) into ~/.limn
  limn ml status    Say whether it is set up

It runs on this machine. Nothing is sent anywhere to score a comment.
`);
    process.exit(sub === undefined || sub === '--help' || sub === '-h' ? 0 : 1);
  }
  if (process.env.LIMN_ML_DISABLED === 'true') {
    console.error('Bot comment scoring is turned off here (LIMN_ML_DISABLED=true).');
    process.exit(1);
  }
  await migrateDataDir();
  const { getMlStatus, installMl } = await import('./ml/runtime.js');

  if (sub === 'status') {
    const st = getMlStatus();
    const words =
      st.state === 'ready' ? 'Bot comment scoring is set up.' : 'Bot comment scoring is not set up. Run: limn ml install';
    console.log(st.message ? `${words} ${st.message}` : words);
    process.exit(st.state === 'ready' ? 0 : 1);
  }

  let lastPct = '';
  const result = await installMl((p) => {
    if (p.phase === 'downloading') {
      // The model download reports every percent; print each tenth.
      const pct = /(\d+)%$/.exec(p.message)?.[1];
      if (pct !== undefined) {
        const tenth = String(Math.floor(Number(pct) / 10));
        if (tenth === lastPct) return;
        lastPct = tenth;
      }
      console.log(`  ${dim(p.message)}`);
    } else if (p.phase !== 'failed') console.log(`${cyan('▸')} ${p.message}`);
  });
  if (!result.ok) {
    console.error(bold(result.message));
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // The package was renamed `pierre-review` → `limn-review` (bin `limn`). The old name survives as
  // the forwarding stub's bin (scripts/deprecated-pierre-review/, never limn-review's own — that
  // collides with an old global install); say so, once per start, on stderr so piped output is clean.
  if (/^pierre(-review)?(\.(c?js|cmd|ps1))?$/.test(basename(process.argv[1] ?? ''))) {
    console.error(dim('`pierre-review` is now `limn` (npm package: limn-review). The old name will be removed.'));
  }

  // `limn status` — a read-only subcommand with its own parser, usage, and env
  // mapping. Peeled off BEFORE parseArgs (whose default case rejects any bare token),
  // and it never reaches the server boot below.
  if (argv[0] === 'status') {
    await runStatusCommand(argv.slice(1));
    return;
  }
  if (argv[0] === 'ai') {
    await runAiCommand(argv.slice(1));
    return;
  }
  if (argv[0] === 'ml') {
    await runMlCommand(argv.slice(1));
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

  // Production mode: skip pino-pretty (not shipped) and enable static serving.
  process.env.NODE_ENV ??= 'production';

  // ── default the DB to a user-writable home location (mkdir -p) ────────────
  // The package dir is read-only for global installs, so never write there.
  await migrateDataDir();
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = await defaultLocalDbPath();
  }
  try {
    mkdirSync(dirname(process.env.DATABASE_URL), { recursive: true });
  } catch {
    /* best-effort; client.ts also mkdirs */
  }

  // ── pre-check gh auth with a friendly message (contract §6) ─────────────
  ghAuthPreCheck();

  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 4000;
  const base = `http://localhost:${port}`;
  const url = `${base}/app`;

  // ── banner ────────────────────────────────────────────────────────────────
  const { LIMN_ASCII, TAGLINE } = await import('./ascii.js');
  console.log(cyan(LIMN_ASCII));
  console.log(`  ${dim(TAGLINE)}`);
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
  // The product NAME, not the command — the banner above already says Limn. A literal rather
  // than shared's PRODUCT_NAME on purpose: this module has no top-level imports outside
  // `node:*` (everything else is a dynamic import, to keep `npx` startup lean) and one word is
  // not worth loading shared before the failure can be printed.
  console.error('Failed to start Limn:', err);
  process.exit(1);
});
