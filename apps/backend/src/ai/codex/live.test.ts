// OPT-IN LIVE CHECK of stream C's Codex wiring (docs/CODEX-PLAN.md Phase 2c) against the REAL Codex
// CLI and the reader's REAL ChatGPT account. Skipped unless LIMN_CODEX_LIVE=1. ZERO model runs: it
// reads the account, the rate-limit windows and the token counts through `codex app-server`, and
// checks that the config.toml Limn writes passes the real CLI's `--strict-config`.
//
//   LIMN_CODEX_LIVE=1 pnpm --filter @pierre-review/backend test ai/codex/live
//   (LIMN_CODEX_LIVE_BIN=<codex native program> overrides the default spike install in /tmp.)
//
// ⚠ IT RUNS ON A COPY OF ~/.codex/auth.json in a scratch Limn home under /tmp, deleted afterwards,
// and never prints it. The copy is read with `refreshToken: false`, and the test FAILS if the copy
// changed — a refresh would ROTATE the refresh token and sign the reader's own Codex out (CODEX-SPIKE
// § 5). Production Limn never copies: it has its own `codex login` in ~/.limn/codex.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LIVE = process.env.LIMN_CODEX_LIVE === '1';
const SPIKE_PREFIX = '/tmp/limn-codex-spike';

let scratch = '';
let bin = '';
let authBefore = '';

describe.skipIf(!LIVE)('Codex, live (no model runs)', () => {
  let H: typeof import('./home.js');
  let AS: typeof import('./app-server.js');

  beforeAll(async () => {
    const { codexBinaryIn } = await import('../runtime.js');
    bin = process.env.LIMN_CODEX_LIVE_BIN ?? codexBinaryIn(SPIKE_PREFIX) ?? '';
    if (!bin || !existsSync(bin)) throw new Error(`no Codex program (set LIMN_CODEX_LIVE_BIN); looked in ${SPIKE_PREFIX}`);
    scratch = mkdtempSync('/tmp/limn-codex-live-');
    process.env.LIMN_DATA_DIR = scratch;
    process.env.LIMN_CODEX_PATH = bin;
    H = await import('./home.js');
    AS = await import('./app-server.js');
    await H.ensureCodexHomeConfig({
      override: '',
      stateKey: '/<session-flags>/config.toml:pre_tool_use:0:0',
      trustedHash: 'sha256:0b8fde24c1b177198f2066bc3b1af8a513c479d58c8b299f587e49eed29a42c8',
    });
    const src = join(homedir(), '.codex', 'auth.json');
    if (!existsSync(src)) throw new Error('no ~/.codex/auth.json to copy — sign in to Codex first');
    copyFileSync(src, join(H.codexHome(), 'auth.json'));
    authBefore = readFileSync(join(H.codexHome(), 'auth.json'), 'utf8');
  });

  afterAll(() => {
    // The copy goes with the scratch home.
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("`app-server --strict-config` refuses a bogus key (so the probe below, which passes it, validates Limn's config.toml)", () => {
    expect(AS.limnAppServerOptions()?.args).toEqual(['--strict-config']);
    // A negative control: the same config plus one unknown key. (`login`, `debug` and `features`
    // refuse the flag; `app-server` and `exec` honour it.)
    const bad = mkdtempSync('/tmp/limn-codex-live-bad-');
    try {
      writeFileSync(
        join(bad, 'config.toml'),
        'bogus_key_zz = 1\n' + readFileSync(join(H.codexHome(), 'config.toml'), 'utf8'),
      );
      const no = spawnSync(bin, ['app-server', '--strict-config'], {
        env: { ...H.codexProcessEnv(), CODEX_HOME: bad },
        input: '',
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(no.status).not.toBe(0);
      expect(no.stderr).toMatch(/unknown configuration field `bogus_key_zz`/);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });

  it('reads the account, both windows and the token counts in one app-server process', async () => {
    const opts = AS.limnAppServerOptions();
    expect(opts?.env.CODEX_HOME).toBe(H.codexHome());
    expect(opts?.env.OPENAI_API_KEY).toBeUndefined();
    const first = await AS.probeCodexAccount(opts!, Date.now, { refreshToken: false });
    expect(first.account?.signedIn).toBe(true);
    expect(first.account?.type).toBe('chatgpt');
    expect(typeof first.account?.plan).toBe('string');
    // The windows: whole percent, resets ahead, both lengths present.
    for (const w of [first.reading?.fiveHour, first.reading?.week]) {
      expect(w).toBeTruthy();
      expect(Number.isInteger(w!.utilization)).toBe(true);
      expect(w!.resetsAtMs!).toBeGreaterThan(Date.now());
    }
    const second = await AS.probeCodexAccount(opts!, Date.now, { refreshToken: false });
    // Shapes and magnitudes only — no account detail is printed.
    console.log(
      JSON.stringify({
        plan: first.account?.plan,
        fiveHourPct: first.reading?.fiveHour?.utilization,
        weekPct: first.reading?.week?.utilization,
        fiveHourResetsInMin: Math.round((first.reading!.fiveHour!.resetsAtMs! - Date.now()) / 60_000),
        weekResetsInH: Math.round((first.reading!.week!.resetsAtMs! - Date.now()) / 3_600_000),
        lifetimeTokens: first.lifetimeTokens,
        lifetimeDelta: first.lifetimeTokens != null && second.lifetimeTokens != null ? second.lifetimeTokens - first.lifetimeTokens : null,
        dailyBuckets: first.daily?.length ?? null,
        newestBucket: first.daily?.length ? new Date(Math.max(...first.daily.map((d) => d.startMs))).toISOString() : null,
      }),
    );
  }, 90_000);

  it('the copied sign-in was NOT refreshed (no token rotation, the reader stays signed in)', () => {
    expect(readFileSync(join(H.codexHome(), 'auth.json'), 'utf8') === authBefore).toBe(true);
    // And Limn never wrote its config into the reader's own home.
    const theirs = join(homedir(), '.codex', 'config.toml');
    expect(existsSync(theirs) && readFileSync(theirs, 'utf8').includes("Limn's own Codex home")).toBe(false);
  });
});
