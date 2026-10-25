// THE OPT-IN LIVE TEST for Phase 3 stream (c) — SKIPPED unless LIMN_CODEX_LIVE=1. Two model runs, both
// through the REAL runner and the REAL prompt builders (worded for Codex), on gpt-6-luna at low effort
// (a Haiku id stands in for the runner's model: Codex maps a Claude id to its role, `fast` = luna/low —
// for this test only; the runners' own models are unchanged):
//   1. a TICKET REVIEW of one member worktree (MEMBERS.md in the scratch cwd): the strict final answer
//      reaches the runner's handler, CSV is met by PR1 and PDF is not delivered;
//   2. a CHECK AGAINST DOCS over one shortlisted document, READ-ONLY: the answer passes the SAME shape
//      judge, and its references check out against the section (validateAlignment).
// ⚠ Limn's OWN Codex home only (~/.limn/codex, or LIMN_CODEX_LIVE_HOME) — never ~/.codex, and nothing
// here reads a sign-in file. No ledger row is written (no `usageRecord`; the DB is a scratch file).
//
//   LIMN_CODEX_LIVE=1 LIMN_CODEX_LIVE_BIN=/path/to/codex \
//   ./node_modules/.bin/vitest run src/ai/codex/kinds/tickets-live.test.ts
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  // db/client opens the database at import: a scratch file, never the real one.
  process.env.DATABASE_URL = path.join(os.tmpdir(), `limn-tickets-live-${process.pid}.sqlite`);
  process.env.DISABLE_SCHEDULER = 'true';
});

const LIVE = process.env.LIMN_CODEX_LIVE === '1';
const LIVE_MODEL = 'claude-haiku-4-5' as unknown as 'claude-sonnet-5';

describe.skipIf(!LIVE)('stream (c) on Codex, live (LIMN_CODEX_LIVE=1)', () => {
  let dir = '';
  let signedIn = false;
  const saved = process.env.LIMN_AI_PROVIDER;

  beforeAll(async () => {
    const liveHome = process.env.LIMN_CODEX_LIVE_HOME?.trim();
    if (liveHome) {
      if (basename(liveHome) !== 'codex') throw new Error('LIMN_CODEX_LIVE_HOME must be a folder named codex');
      if (liveHome.startsWith(join(process.env.HOME ?? '', '.codex'))) throw new Error("never the reader's own ~/.codex");
      process.env.LIMN_DATA_DIR = dirname(liveHome);
    }
    if (process.env.LIMN_CODEX_LIVE_BIN) process.env.LIMN_CODEX_PATH = process.env.LIMN_CODEX_LIVE_BIN;
    process.env.LIMN_AI_PROVIDER = 'codex';
    const { codexHome } = await import('../home.js');
    if (existsSync(join(codexHome(), 'auth.json'))) {
      const AS = await import('../app-server.js');
      try {
        signedIn = !!(await AS.probeCodexAccount(AS.limnAppServerOptions()!)).account?.signedIn;
      } catch {
        signedIn = false;
      }
    }
    if (!signedIn) console.log(`[tickets live] ${codexHome()} holds no live sign-in: the model runs are skipped`);
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'limn-tickets-live-')));
  }, 60_000);

  afterAll(() => {
    if (saved === undefined) delete process.env.LIMN_AI_PROVIDER;
    else process.env.LIMN_AI_PROVIDER = saved;
    if (dir) rmSync(dir, { recursive: true, force: true });
    rmSync(process.env.DATABASE_URL!, { force: true });
  });

  it('1. a ticket review on Codex: the real prompts, one worktree, the strict answer (model run 1)', async (ctx) => {
    if (!signedIn) ctx.skip();
    const { promptTools } = await import('../../prompt-tools.js');
    const P = await import('../../../review/ticket-review/prompts.js');
    const { runTicketReviewAgent } = await import('../../../review/ticket-review/agent.js');
    const t = promptTools('codex');
    const cwd = join(dir, 'ticket');
    const wt = join(dir, 'wt-api');
    mkdirSync(join(wt, 'src'), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(
      join(wt, 'src', 'export.ts'),
      "export function exportCsv(rows: string[][]): string {\n  return rows.map((r) => r.join(',')).join('\\n');\n}\n",
    );
    const member = {
      ref: 'PR1',
      prId: 1,
      repo: 'acme/api',
      number: 12,
      title: 'Add CSV export',
      state: 'open' as const,
      headSha: 'abcdef1234567890',
      checkedOut: true,
      worktreePath: wt,
      given: 'diff' as const,
      changedFiles: ['src/export.ts'],
      diff: "diff --git a/src/export.ts b/src/export.ts\n+export function exportCsv(rows: string[][]): string {\n+  return rows.map((r) => r.join(',')).join('\\n');\n+}\n",
      omittedFiles: [],
    };
    writeFileSync(join(cwd, 'MEMBERS.md'), P.membersIndex([member]));
    const ticket = { key: 'BMD-1', title: 'Export reports', description: 'Users export a report.', acceptanceCriteria: '- Export as CSV\n- Export as PDF' };
    const steps: string[][] = [];
    const res = await runTicketReviewAgent({
      model: LIVE_MODEL,
      cwd,
      worktrees: [wt],
      systemPrompt: P.ticketReviewSystemPrompt(null, t),
      prompt: P.buildTicketReviewPrompt({ ticket, members: [member], prior: null, legacy: [], nonce: 'k7q2' }, t),
      applyAuthEnv: false,
      abortController: new AbortController(),
      provider: 'codex',
      onProgress: (p) => steps.push(p.recentActivity),
    });
    console.log('[tickets live 1]', JSON.stringify({ failure: res.failureReason, model: res.model, tokens: [res.inputTokens, res.outputTokens], payload: res.payload }).slice(0, 2500));
    expect(res.failureReason).toBeUndefined();
    expect(res.submitted).toBe(true);
    expect(res).toMatchObject({ model: 'gpt-6-luna', costUsd: 0, ledgerByProvider: true });
    const crit = res.payload!.criteria ?? [];
    // Met or partly met is the model's judgement (the 2026-10-25 run said partly: no CSV escaping); the
    // pin is that the answer reached the handler naming PR1 for it, and PDF not delivered.
    expect(crit.some((c) => /csv/i.test(c.text) && c.status !== 'not_met' && (c.deliveredBy ?? []).includes('PR1'))).toBe(true);
    expect(crit.some((c) => /pdf/i.test(c.text) && c.status !== 'met')).toBe(true);
    expect(steps.length).toBeGreaterThan(0);
  }, 600_000);

  it('2. a check against docs on Codex: READ-ONLY document roots, the shape judge, quotes that check out (model run 2)', async (ctx) => {
    if (!signedIn) ctx.skip();
    const { promptTools } = await import('../../prompt-tools.js');
    const P = await import('../../../review/story-docs/prompts.js');
    const { runStoryDocsAgent } = await import('../../../review/story-docs/agent.js');
    const { validateAlignment } = await import('../../../review/story-docs/validate.js');
    const t = promptTools('codex');
    const lib = join(dir, 'library');
    const section = 'Refunds are paid within fourteen days of the request being approved. A refund needs a manager approval first.';
    mkdirSync(join(lib, 'refunds', 'sections'), { recursive: true });
    writeFileSync(join(lib, 'refunds', 'CONTENTS.md'), '# Refund policy\n\n- [Refunds](sections/01-refunds.md) — when refunds are paid\n');
    writeFileSync(join(lib, 'refunds', 'sections', '01-refunds.md'), `# Refunds\n\n${section}\n`);
    const cwd = join(dir, 'sd');
    mkdirSync(cwd);
    const shortlist = [
      { path: 'refunds/sections/01-refunds.md', workspaceId: 1, anchor: null, docSlug: 'refunds', docTitle: 'Refund policy', sectionTitle: 'Refunds', reason: 'refund timing' },
    ];
    const alignment = { criteriaSource: 'brief' as const, criteria: [{ n: 1, text: 'Refunds are paid within 30 days' }] };
    const res = await runStoryDocsAgent({
      cwd,
      roots: P.storyDocsRoots(lib, shortlist),
      systemPrompt: P.storyDocsSystemPrompt(t),
      prompt: P.buildStoryDocsPrompt(
        { story: { title: 'Refunds', description: 'A customer asks for a refund; we pay it within 30 days.', acceptanceCriteria: '- Refunds are paid within 30 days' }, ...alignment, shortlist, libraryDir: lib, nonce: 'z9x1' },
        t,
      ),
      alignment,
      applyAuthEnv: false,
      abortController: new AbortController(),
      model: LIVE_MODEL,
      provider: 'codex',
    });
    console.log('[tickets live 2]', JSON.stringify({ failure: res.failureReason, refusal: res.lastRefusal, model: res.model, payload: res.payload }).slice(0, 2500));
    expect(res.failureReason).toBeUndefined();
    expect(res.payload).not.toBeNull();
    expect(res).toMatchObject({ model: 'gpt-6-luna', ledgerByProvider: true });
    const snapshot = {
      workspaceId: 1,
      dir: lib,
      docs: [{ slug: 'refunds', title: 'Refund policy', sections: [{ path: 'refunds/sections/01-refunds.md', title: 'Refunds', summary: '', depth: 1, trail: [], headings: [], words: 20 }] }],
      read: (p: string) => (p === 'refunds/sections/01-refunds.md' ? `# Refunds\n\n${section}\n` : null),
    };
    const v = validateAlignment(res.payload, snapshot as never, alignment, shortlist);
    console.log('[tickets live 2] validation', JSON.stringify(v).slice(0, 1500));
    expect(v.ok).toBe(true);
  }, 600_000);
});

describe('stream (c) on Codex, live', () => {
  it('is skipped unless LIMN_CODEX_LIVE=1', () => {
    expect(true).toBe(true);
  });
});
