// db/ai-usage-report.ts — Reports → AI usage. Pinned:
//  • the PURE fold: groups, the day chart, top PRs, top stories (own ticket reviews + other rows of
//    their PRs), the 12 weeks, the slope, every suggestion's trigger and saving, and the cost rule
//    (Claude rows only, null unit ⇒ null cost);
//  • the READ, on a THROWAWAY sqlite DB: a row tied to another workspace's PR never counts, a
//    machine-wide row counts and is disclosed, another account's rows never count, and the cost
//    arrives already converted (a subscription never sees US$).
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jiraApiRoot, trackerTicketIdent } from '@pierre-review/shared';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiUsageFoldInput, LedgerRowIn, ReviewRowIn } from './ai-usage-report.js';

const DB_PATH = join(tmpdir(), 'pierre-ai-usage-report-test.sqlite');
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let m: typeof import('./ai-usage-report.js');

const DAY = 86_400_000;
// UTC days so the test does not depend on the machine's zone.
const utcDay = (ms: number): number => Math.floor(ms / DAY) * DAY;
const NOW = Date.parse('2026-10-29T12:00:00Z'); // a Thursday
const FROM = Date.parse('2026-10-16T00:00:00Z');

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  const { runMigrations } = await import('./run-migrations.js');
  await runMigrations();
  m = await import('./ai-usage-report.js');
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const row = (o: Partial<LedgerRowIn>): LedgerRowIn => ({
  feature: 'claude_review',
  provider: 'claude',
  model: 'claude-opus-5-5',
  cost: 1,
  inputTokens: 1000,
  outputTokens: 100,
  prId: 1,
  repoId: 10,
  occurredAtMs: FROM + DAY,
  ...o,
});

const review = (o: Partial<ReviewRowIn>): ReviewRowIn => ({
  prId: 1,
  status: 'succeeded',
  trigger: 'manual',
  kind: null,
  provider: 'claude',
  model: 'claude-opus-5-5',
  cost: 1,
  inputTokens: 10_000,
  outputTokens: 1000,
  cacheReadTokens: 0,
  diffBytes: 5000,
  createdAtMs: FROM + DAY,
  ...o,
});

const base = (o: Partial<AiUsageFoldInput>): AiUsageFoldInput => ({
  nowMs: NOW,
  fromMs: FROM,
  toMs: NOW,
  costUnit: 'week_pct',
  ledger: [],
  reviews: [],
  ticketReviews: [],
  prs: new Map([
    [1, { id: 1, number: 11, title: 'One', repoFullName: 'acme/web' }],
    [2, { id: 2, number: 12, title: 'Two', repoFullName: 'acme/web' }],
  ]),
  storyLinks: new Map(),
  dayStart: utcDay,
  ...o,
});

describe('foldAiUsageReport', () => {
  it('groups features, sums tokens across providers and costs Claude rows only', () => {
    const out = m.foldAiUsageReport(
      base({
        ledger: [
          row({ feature: 'claude_review' }),
          row({ feature: 'claude_review:security', provider: 'codex', model: 'gpt-6.1-sol', cost: 0 }),
          row({ feature: 'replies_check', cost: 0.5 }),
          row({ feature: 'ai_fix_plan', prId: 2 }),
          row({ feature: 'sprint_briefs', prId: null, repoId: null }),
          row({ feature: 'digest', prId: null, repoId: null, inputTokens: null, outputTokens: null }),
          // Outside the window: the 12 weeks only.
          row({ feature: 'ci_review', occurredAtMs: FROM - 3 * DAY }),
        ],
      }),
    );
    expect(out.totals.runs).toBe(6);
    expect(out.totals.tokens).toBe(5 * 1100);
    expect(out.totals.codexTokens).toBe(1100);
    expect(out.totals.claudeCost).toBeCloseTo(4.5);
    expect(out.machineWideRuns).toBe(2);
    expect(out.unmeasuredRuns).toBe(1);
    const code = out.groups.find((g) => g.group === 'code')!;
    expect(code.figures.runs).toBe(3);
    expect(code.figures.claudeCost).toBeCloseTo(1.5);
    expect(out.groups[0]!.group).toBe('code');
    expect(out.groups.map((g) => g.group)).toEqual(expect.arrayContaining(['fix', 'sprint', 'other']));
    expect(out.groups.some((g) => g.group === 'ci')).toBe(false);
    // The day chart: every day of the window, tokens by group on the right day.
    expect(out.days.length).toBe(14);
    expect(out.days[1]!.tokens.code).toBe(3300);
    // The weeks see the out-of-window row.
    expect(out.weeks.length).toBe(12);
    expect(out.weeks[11]!.partial).toBe(true);
    expect(out.weeks.reduce((n, w) => n + w.figures.runs, 0)).toBe(7);
    // Specialists share is an insight.
    expect(out.insights.find((i) => i.kind === 'specialists')?.text).toMatch(/^Specialists used 33%/);
  });

  it('carries no cost at all when there is no unit', () => {
    const out = m.foldAiUsageReport(base({ costUnit: null, ledger: [row({})] }));
    expect(out.totals.claudeCost).toBeNull();
    expect(out.groups[0]!.figures.claudeCost).toBeNull();
  });

  it('ranks top PRs by tokens and builds stories from ticket reviews plus the other rows of their PRs', () => {
    const ident = trackerTicketIdent('jira', 'https://acme.atlassian.net', 'ENG-1');
    const out = m.foldAiUsageReport(
      base({
        ledger: [
          row({ prId: 1, inputTokens: 100, outputTokens: 0 }),
          row({ prId: 2, inputTokens: 5000, outputTokens: 0 }),
          // The ledger's ticket-review row is NOT counted into the story a second time.
          row({ prId: 2, feature: 'ticket_review', inputTokens: 9999, outputTokens: 0 }),
          row({ prId: 99, inputTokens: 1 }), // a PR outside the scope map: never listed
        ],
        ticketReviews: [
          {
            ident,
            key: 'ENG-1',
            title: 'Login',
            status: 'succeeded',
            trigger: 'manual',
            provider: null,
            cost: 2,
            inputTokens: 700,
            outputTokens: 0,
            createdAtMs: FROM + DAY,
          },
        ],
        storyLinks: new Map([[2, [{ ident, key: 'ENG-1', title: 'Login' }]]]),
      }),
    );
    expect(out.topPrs.map((p) => p.prId)).toEqual([2, 1]);
    expect(out.topPrs[0]!.figures.tokens).toBe(5000 + 9999);
    expect(out.topStories).toHaveLength(1);
    expect(out.topStories[0]!.figures.tokens).toBe(5700);
    expect(out.topStories[0]!.prCount).toBe(1);
    expect(out.topStories[0]!.figures.claudeCost).toBeCloseTo(3);
  });

  it('suggests fewer auto re-reviews, with the runs past the second as the saving', () => {
    const reviews = [0, 1, 2, 3, 4].map((i) => review({ trigger: 'auto', createdAtMs: FROM + DAY + i * 1000 }));
    const out = m.foldAiUsageReport(base({ reviews }));
    const s = out.suggestions.find((x) => x.kind === 'auto_rereviews')!;
    expect(s.fact).toBe('Auto review ran 5 times on 1 pull request; 4 were re-reviews after new pushes or comments.');
    expect(s.saving.tokens).toBe(3 * 11_000);
    expect(s.saving.claudeCost).toBeCloseTo(3);
    expect(s.setting).toBe('auto-review');
    expect(s.prs.map((p) => p.prId)).toEqual([1]);
    expect(s.prs[0]!.number).toBe(11);
  });

  it('counts failed and stopped runs that spent tokens', () => {
    const out = m.foldAiUsageReport(
      base({
        reviews: [
          review({ status: 'failed', trigger: 'auto' }),
          review({ status: 'cancelled', prId: 2 }),
          review({ status: 'failed', inputTokens: null, outputTokens: null }), // spent nothing
        ],
      }),
    );
    const s = out.suggestions.find((x) => x.kind === 'failed_runs')!;
    expect(s.fact).toBe('2 runs failed or were stopped after using 22k tokens.');
    expect(s.setting).toBe('auto-review');
  });

  it('flags large diffs only when they dominate, saving what they cost above a typical review', () => {
    const small = [1, 2, 3].map((i) => review({ prId: 1, createdAtMs: FROM + DAY + i, inputTokens: 1000, outputTokens: 0 }));
    const large = [1, 2].map((i) => review({ prId: 2, createdAtMs: FROM + 2 * DAY + i, diffBytes: 400_000, inputTokens: 21_000, outputTokens: 0 }));
    const out = m.foldAiUsageReport(base({ reviews: [...small, ...large] }));
    const s = out.suggestions.find((x) => x.kind === 'large_diffs')!;
    expect(s.fact).toBe('2 reviews of diffs over 150 KB used 93% of code review tokens.');
    expect(s.saving.tokens).toBe(2 * 20_000);
    expect(s.prs.map((p) => p.prId)).toEqual([2]);
  });

  it('compares the deepest model with the standard one on the workspace’s own runs', () => {
    const deep = [1, 2, 3].map((i) => review({ createdAtMs: FROM + DAY + i, cost: 3, inputTokens: 30_000, outputTokens: 0 }));
    const std = [1, 2, 3].map((i) => review({ prId: 2, createdAtMs: FROM + DAY + i, model: 'claude-sonnet-5', cost: 1, inputTokens: 10_000, outputTokens: 0 }));
    const out = m.foldAiUsageReport(base({ reviews: [...deep, ...std] }));
    const s = out.suggestions.find((x) => x.kind === 'deep_model')!;
    expect(s.saving.tokens).toBe(60_000);
    expect(s.saving.claudeCost).toBeCloseTo(6);
    expect(s.setting).toBe('ai-effort');
    expect(out.insights.find((i) => i.kind === 'model_mix')?.text).toBe('75% of code review tokens went to the deepest model (Opus 5.5).');
  });

  it('flags pull requests reviewed by hand more than three times', () => {
    const reviews = [0, 1, 2, 3, 4].map((i) => review({ createdAtMs: FROM + DAY + i }));
    const out = m.foldAiUsageReport(base({ reviews }));
    const s = out.suggestions.find((x) => x.kind === 'many_reviews')!;
    expect(s.fact).toBe('1 pull request had more than 3 reviews started by hand (5 in all).');
    expect(s.saving.tokens).toBe(2 * 11_000);
  });

  it('reports the cache share and makes no suggestion from a quiet window', () => {
    const out = m.foldAiUsageReport(base({ reviews: [review({ inputTokens: 1000, cacheReadTokens: 3000 })] }));
    expect(out.suggestions).toEqual([]);
    expect(out.insights.find((i) => i.kind === 'cache')?.text).toBe('Claude read 75% of its review input from its cache.');
  });

  it('fits a weekly slope over complete weeks only', () => {
    expect(m.slopeOf([1, 2, 3, 4])).toBeCloseTo(1);
    expect(m.slopeOf([5, 5])).toBeNull();
  });
});

describe('getAiUsageReport (the read)', () => {
  it('keeps the workspace, includes machine-wide rows and converts cost before the fold', async () => {
    const { accounts, workspaces, workspaceRepos, repos, pullRequests, aiUsage, trackerTickets } = schema;
    await db.insert(accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
    await db.insert(accounts).values({ id: 2, githubUserId: 'U_them', githubLogin: 'them' }).execute();
    const mkWs = async (accountId: number, name: string): Promise<number> =>
      (await db.insert(workspaces).values({ accountId, name, isDefault: false }).returning().execute())[0].id;
    const ws = await mkWs(1, 'Mine');
    const other = await mkWs(1, 'Other');
    const foreign = await mkWs(2, 'Theirs');
    const mkRepo = async (accountId: number, name: string, w: number): Promise<number> => {
      const id = (await db.insert(repos).values({ accountId, owner: 'acme', name, githubNodeId: `R_au_${name}` }).returning().execute())[0].id;
      await db.insert(workspaceRepos).values({ accountId, workspaceId: w, repoId: id }).execute();
      return id;
    };
    const rMine = await mkRepo(1, 'web', ws);
    const rOther = await mkRepo(1, 'engine', other);
    await mkRepo(2, 'evil', foreign);
    let seq = 0;
    const mkPr = async (repoId: number): Promise<number> => {
      seq += 1;
      return (
        await db
          .insert(pullRequests)
          .values({ githubNodeId: `PR_au_${seq}`, accountId: 1, repoId, number: seq, title: `PR ${seq}`, state: 'open', isDraft: false, openedAt: new Date(FROM), updatedAt: new Date(FROM) })
          .returning()
          .execute()
      )[0].id;
    };
    const pMine = await mkPr(rMine);
    const pOther = await mkPr(rOther);
    const at = new Date(FROM + DAY);
    const usage = (o: Record<string, unknown>) => ({ accountId: 1, seam: 'agent', feature: 'claude_review', model: 'claude-opus-5-5', costUsd: 2, inputTokens: 1000, outputTokens: 0, occurredAt: at, provider: 'claude', ...o });
    await db
      .insert(aiUsage)
      .values([
        usage({ prId: pMine, repoId: rMine }),
        usage({ prId: pOther, repoId: rOther }),
        usage({ feature: 'sprint_briefs', seam: 'summary' }),
        usage({ accountId: 2, prId: null }),
        usage({ prId: 9999, repoId: null }), // a pruned PR with no repository: cannot be placed
      ])
      .execute();
    const ACME = jiraApiRoot('https://acme.atlassian.net') as string;
    await db
      .insert(trackerTickets)
      .values({
        accountId: 1,
        workspaceId: ws,
        prId: pMine,
        provider: 'jira',
        issueKey: 'ENG-7',
        detectedFrom: 'title',
        detectOrder: 0,
        apiRoot: ACME,
        url: 'https://acme.atlassian.net/browse/ENG-7',
        state: 'ok',
        title: 'Checkout',
        checkedAt: at,
        nextCheckAt: at,
      })
      .execute();

    const out = await m.getAiUsageReport(1, { workspaceId: ws, repoIds: [rMine] }, { fromMs: FROM, toMs: NOW, mode: 'rolling_14' }, NOW, {
      unit: 'week_pct',
      perUsd: 0.5,
    });
    expect(out.workspaceId).toBe(ws);
    expect(out.totals.runs).toBe(2);
    expect(out.machineWideRuns).toBe(1);
    // US$2 × 0.5 %/US$ per row: a share, never dollars.
    expect(out.totals.claudeCost).toBeCloseTo(2);
    expect(out.topPrs.map((p) => p.prId)).toEqual([pMine]);
    expect(out.topPrs[0]!.repoFullName).toBe('acme/web');
    expect(out.topStories.map((s) => s.key)).toEqual(['ENG-7']);
    expect(out.topStories[0]!.ident).toBe(trackerTicketIdent('jira', ACME, 'ENG-7'));
    expect(out.window.mode).toBe('rolling_14');
  });
});
