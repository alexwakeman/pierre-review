// ── THE CLAUDE REVIEW CREDENTIAL LADDER IS TWO RUNGS ───────────────────────────────────────────
//
// It used to be three: an ambient Claude session, then a BYO Anthropic key stored in
// `~/.pierre-review/config.json`, then the environment's `ANTHROPIC_API_KEY`. The stored key is
// RETIRED — the Settings form, `GET`/`PUT /api/claude-review/key`, `ReviewSeam.setLocalKey` and
// every reader of that field are gone.
//
// Two properties are pinned here, and the second is the one a removal breaks quietly:
//
//   1. THE AMBIENT RUNG STILL STRIPS `ANTHROPIC_API_KEY` FOR THE RUN. That is what makes a
//      subscription pay instead of a meter: the Agent SDK prefers an API key when it sees one, so
//      leaving it in place would silently bill every review to Anthropic.
//   2. A STORED KEY IS NEVER RESURRECTED. A file left over from before the retirement must not
//      make `detectClaudeAuth` answer "ok" (a green pre-flight in front of a guaranteed auth
//      failure) and must not be written into the environment.
//
// `hasAmbientClaudeAuth` probes the real home directory, so every test here points `HOME` at an
// empty temp dir — Node's `os.homedir()` reads `$HOME` on POSIX — and only the ambient cases opt
// back in, via `CLAUDE_CODE_OAUTH_TOKEN` (deterministic, no filesystem).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE PER-KIND PRE-FLIGHT under Codex (below) reads Codex's CACHED detail and the allow-list. Both are
// faked: the detail is set per test, and stream (a)'s file is made to carry 'review' — as if that
// stream had ported it — so a kind Codex can run and one it cannot are both exercised.
const codex = vi.hoisted(() => ({
  detail: { runnable: false, message: 'Codex is not set up yet. Run: limn ai install codex' as string | null },
}));
vi.mock('../ai/codex/detect.js', async (orig) => ({
  ...(await orig<typeof import('../ai/codex/detect.js')>()),
  codexDetailCached: () => codex.detail,
}));
vi.mock('../ai/codex/kinds/review.js', () => ({ CODEX_REVIEW_KINDS: ['review'] }));
// 'fix' stands for a kind Codex cannot run here (its stream's real file ports it; this suite pins the
// pre-flight's two answers, not which kinds are ported).
vi.mock('../ai/codex/kinds/fix.js', () => ({ CODEX_FIX_KINDS: [] }));

import { applyClaudeReviewAuth, detectClaudeAuth, hasAmbientClaudeAuth } from './auth.js';

let home: string;
let prevHome: string | undefined;
let prevApiKey: string | undefined;
let prevOauth: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pierre-auth-'));
  prevHome = process.env.HOME;
  prevApiKey = process.env.ANTHROPIC_API_KEY;
  prevOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.HOME = home;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevApiKey;
  if (prevOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOauth;
  rmSync(home, { recursive: true, force: true });
});

/** Leave a pre-retirement config file in the temp home, exactly as an upgrading user has. */
const seedStoredKey = (key = 'sk-ant-stored-should-never-be-used'): void => {
  mkdirSync(join(home, '.pierre-review'), { recursive: true });
  writeFileSync(
    join(home, '.pierre-review', 'config.json'),
    JSON.stringify({ anthropicApiKey: key, maxReviewBudgetUsd: 2 }, null, 2),
  );
};

describe('detectClaudeAuth — two rungs', () => {
  it('reports the ambient subscription first, even when an API key is also present', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    expect(detectClaudeAuth()).toEqual({ status: 'ok', method: 'oauth_token' });
  });

  it('falls back to the ENVIRONMENT key', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    expect(hasAmbientClaudeAuth()).toBe(false);
    expect(detectClaudeAuth()).toEqual({ status: 'ok', method: 'api_key' });
  });

  it('answers `none` with neither rung available', () => {
    const r = detectClaudeAuth();
    expect(r.status).toBe('none');
    // The message names the two rungs that exist and nothing else — it must not send anybody to a
    // Settings form that has been deleted.
    expect(r.status === 'none' && r.message).toMatch(/ANTHROPIC_API_KEY/);
    expect(r.status === 'none' && r.message).not.toMatch(/Settings/i);
  });

  it('⚠ A STORED KEY DOES NOT MAKE IT REPORT `ok` — the middle rung is gone', () => {
    // The regression this whole change turns on. A config file left over from before the
    // retirement is inert: reporting `ok` off it would paint a green pre-flight in front of a run
    // that has no usable credential at all.
    seedStoredKey();
    expect(detectClaudeAuth().status).toBe('none');
  });
});

describe('applyClaudeReviewAuth — what it does to process.env', () => {
  it('⚠ AMBIENT STRIPS THE API KEY FOR THE RUN, and the restore puts it back', () => {
    // Load-bearing: the Agent SDK prefers an API key when it sees one, so leaving it in place
    // would silently meter every review instead of drawing on the subscription.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const restore = applyClaudeReviewAuth(true);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    restore();
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-env');
  });

  it('no ambient → the environment is left EXACTLY as it was', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const restore = applyClaudeReviewAuth(true);
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-env');
    restore();
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-env');
  });

  it('⚠ A STORED KEY IS NEVER WRITTEN INTO THE ENVIRONMENT', () => {
    // The old middle rung did exactly this — `process.env.ANTHROPIC_API_KEY = <stored key>` — and
    // it is the write path the retirement removes. With no ambient session and no env key, a run
    // now starts with no credential and the SDK surfaces the authoritative error.
    seedStoredKey();
    const restore = applyClaudeReviewAuth(true);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    restore();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('`mutate: false` is a no-op in every case (the env-race guard)', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    applyClaudeReviewAuth(false)();
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-env');
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
  });
});

describe('LIMN_AI_USE_API_KEY=true — the opt-in that puts the key first', () => {
  let prevOptIn: string | undefined;
  beforeEach(() => {
    prevOptIn = process.env.LIMN_AI_USE_API_KEY;
    process.env.LIMN_AI_USE_API_KEY = 'true';
  });
  afterEach(() => {
    if (prevOptIn === undefined) delete process.env.LIMN_AI_USE_API_KEY;
    else process.env.LIMN_AI_USE_API_KEY = prevOptIn;
  });

  it('reports the key even with a login', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    expect(detectClaudeAuth()).toEqual({ status: 'ok', method: 'api_key' });
  });

  it('keeps the key for the run and hides the OAuth token; restore puts it back', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const restore = applyClaudeReviewAuth(true);
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-env');
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    restore();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
  });

  it('without a key it changes nothing — the login is still used', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    expect(detectClaudeAuth()).toEqual({ status: 'ok', method: 'oauth_token' });
  });
});

// LIMN_AI_PROVIDER=codex selects a provider that cannot run yet. The pre-flight must say so — it
// is what /api/me's `ai.auth`, every Run gate and every background sweeper (`agenticRunReady`) read
// — or a signed-in Claude keeps every button live in front of a run that rejects at once.
describe('detectClaudeAuth — LIMN_AI_PROVIDER=codex', () => {
  let prevProvider: string | undefined;
  beforeEach(() => {
    prevProvider = process.env.LIMN_AI_PROVIDER;
  });
  afterEach(() => {
    if (prevProvider === undefined) delete process.env.LIMN_AI_PROVIDER;
    else process.env.LIMN_AI_PROVIDER = prevProvider;
  });

  it('answers none with the not-available sentence even when Claude is signed in', async () => {
    const { CODEX_NOT_AVAILABLE_MESSAGE } = await import('../ai/provider.js');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    process.env.LIMN_AI_PROVIDER = 'codex';
    expect(detectClaudeAuth()).toEqual({ status: 'none', message: CODEX_NOT_AVAILABLE_MESSAGE });
  });

  it('claude and auto are unchanged', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    for (const v of ['claude', 'auto', '']) {
      process.env.LIMN_AI_PROVIDER = v;
      expect(detectClaudeAuth()).toEqual({ status: 'ok', method: 'oauth_token' });
    }
  });

  it('on Claude every run kind gets the one answer', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    process.env.LIMN_AI_PROVIDER = 'claude';
    for (const kind of ['review', 'fix', 'docs_chat', 'complete'] as const) {
      expect(detectClaudeAuth(kind)).toEqual({ status: 'ok', method: 'oauth_token' });
    }
  });

  it('PER KIND: a kind Codex cannot run says so by name; one it can (and one-shots) needs the install + a ChatGPT sign-in', async () => {
    const { codexKindNotAvailableMessage, CODEX_NOT_AVAILABLE_MESSAGE } = await import('../ai/provider.js');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    process.env.LIMN_AI_PROVIDER = 'codex';
    // Not set up: the runnable kinds answer Codex's own sentence; the others name themselves.
    codex.detail = { runnable: false, message: 'Codex is not set up yet. Run: limn ai install codex' };
    expect(detectClaudeAuth('review')).toEqual({ status: 'none', message: 'Codex is not set up yet. Run: limn ai install codex' });
    expect(detectClaudeAuth('complete')).toEqual({ status: 'none', message: 'Codex is not set up yet. Run: limn ai install codex' });
    expect(detectClaudeAuth('fix')).toEqual({ status: 'none', message: codexKindNotAvailableMessage('fix') });
    // Installed and signed in with ChatGPT.
    codex.detail = { runnable: true, message: null };
    expect(detectClaudeAuth('review')).toEqual({ status: 'ok', method: 'chatgpt' });
    expect(detectClaudeAuth('complete')).toEqual({ status: 'ok', method: 'chatgpt' });
    expect(detectClaudeAuth('fix')).toEqual({ status: 'none', message: codexKindNotAvailableMessage('fix') });
    // No kind = "any agent": not until EVERY kind can run.
    expect(detectClaudeAuth()).toEqual({ status: 'none', message: CODEX_NOT_AVAILABLE_MESSAGE });
    // Not runnable for want of a known ChatGPT sign-in, with no sentence of its own: the sign-in line.
    codex.detail = { runnable: false, message: null };
    expect(detectClaudeAuth('complete')).toEqual({ status: 'none', message: 'Sign in to Codex with ChatGPT: limn ai login codex' });
  });
});
