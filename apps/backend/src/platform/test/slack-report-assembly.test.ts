// ── THE SLACK SPRINT REPORT, ASSEMBLED END TO END ────────────────────────────────────────────
//
// `buildSlackReport` against a real SQLite file, with only the billed generator and the scope
// lookup stubbed. What it pins:
//
//   • no github.com href anywhere in the message — every link is a Limn link;
//   • the cross-repo sprint text never borrows another workspace's PR; no per-repo AI digest is
//     sent;
//   • the Pending board leads (when the host has the seam), the ONE-section sprint summary follows;
//   • the no-base-URL fallback is plain text; every mrkdwn object is `verbatim: true`; the footer
//     escapes the user-typed workspace name; the block budget keeps the footer.
//   Section-level Pending rules (dedup, order, caps, wording): slack-pending-blocks.test.ts.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/slack-report-assembly.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  DigestPrRef,
  InsightCard,
  PendingBoardSnapshot,
  PendingTab,
  SprintReport,
} from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import type { LlmClient } from '../llm/seam.js';

let sprintFixture: SprintReport | null = null;
let scopeRepoIds: number[] = [10, 11];

vi.mock('../insights/sprint-report.js', () => ({
  refreshSprintReport: async () => sprintFixture,
}));
vi.mock('../insights/workspace-request.js', () => ({
  workspaceScope: async (_ctx: unknown, _accountId: number, workspaceId: number) => ({
    workspaceId,
    repoIds: scopeRepoIds,
  }),
}));
vi.mock('../slack/targets.js', () => ({
  readTargetRow: async () => null,
}));

const { buildSlackReport } = await import('../slack/report.js');

// Stubs for the CORE tables the plugin reaches through `ctx.schema` — only the columns read here.
const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  name: text('name').notNull(),
});
const pullRequests = sqliteTable('pull_requests', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  repoId: integer('repo_id').notNull(),
  number: integer('number').notNull(),
  title: text('title'),
  state: text('state'),
  authorId: integer('author_id'),
  ciStatus: text('ci_status'),
  additions: integer('additions'),
  deletions: integer('deletions'),
  changedFiles: integer('changed_files'),
  openedAt: integer('opened_at', { mode: 'timestamp' }),
});
const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  githubLogin: text('github_login').notNull(),
});

const BASE = 'https://limn.example';
const PR = `${BASE}/app/?workspace=3&view=pr-detail%3A`;

const llm = {} as unknown as LlmClient;

const ref = (over: Partial<DigestPrRef> & Pick<DigestPrRef, 'prNumber' | 'repoFullName' | 'repoId'>): DigestPrRef => ({
  prId: null,
  title: null,
  authorLogin: null,
  authorId: null,
  state: 'open',
  ciStatus: null,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  openedAt: null,
  ...over,
});
const API12 = ref({ prNumber: 12, prId: 501, repoId: 10, repoFullName: 'acme/api', title: 'Fix the login redirect', authorLogin: 'alice', authorId: 1 });
const WEB12 = ref({ prNumber: 12, prId: 502, repoId: 11, repoFullName: 'acme/web', title: 'Tidy the footer', authorLogin: 'bob', authorId: 2 });
// Resolved account-wide by `enrichedPrRefs`, but outside THIS workspace.
const OTHER12 = ref({ prNumber: 12, prId: 777, repoId: 99, repoFullName: 'other/x', title: 'Secret thing', authorLogin: 'mallory', authorId: 9 });

const SPRINT_SUMMARY = [
  '**Day 3 of 14 — one PR red; one stalled**',
  '',
  '- **Deploy frequency (merges):** 4 (small sample — no trend yet)',
  '- **CI health:** 1 PR red: acme/web#12 (2 days red)',
  '',
  '**Action items**',
  '',
  '**acme/api**',
  '',
  '- acme/api#12 — Stalled 5 days; needs review from @bob.',
  '- other/x#12 — Also mentioned, but not this team’s repository.',
].join('\n');

const sprint = (summary: string, prRefs: DigestPrRef[]): SprintReport => ({
  summary,
  prRefs,
  model: 'test',
  generatedAt: '2026-09-20T00:00:00.000Z',
  costUsd: 0,
  stale: false,
  sprint: { from: '2026-09-18T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' },
});

type Block = { type: string; text?: { type: string; text: string; verbatim?: boolean }; elements?: Array<{ type: string; text: string; verbatim?: boolean }> };

function mrkdwnObjects(blocks: unknown[]): Array<{ type: string; text: string; verbatim?: boolean }> {
  const found: Array<{ type: string; text: string; verbatim?: boolean }> = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v != null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.type === 'mrkdwn') found.push(o as { type: string; text: string; verbatim?: boolean });
      Object.values(o).forEach(walk);
    }
  };
  walk(blocks);
  return found;
}

const sectionTexts = (blocks: unknown[]): string[] =>
  (blocks as Block[]).filter((b) => b.type === 'section').map((b) => b.text?.text ?? '');

const count = (s: string, sub: string): number => s.split(sub).length - 1;

describe('buildSlackReport — every link points into Limn', () => {
  let sqlite: Database.Database;

  const makeCtx = (appWebUrl?: string, board?: PendingBoardSnapshot): ProContext =>
    ({
      queries: board == null ? {} : { getPendingBoard: async () => board },
      db: drizzle(sqlite),
      log: { warn: () => {}, error: () => {}, info: () => {} },
      host: {
        version: '0.0.0',
        ...(appWebUrl === undefined ? {} : { appWebUrl }),
      },
      schema: { workspaces, pullRequests, users },
    }) as unknown as ProContext;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(
      'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text NOT NULL);' +
        'CREATE TABLE pull_requests (id integer PRIMARY KEY, account_id integer NOT NULL, repo_id integer NOT NULL, number integer NOT NULL, title text, state text, author_id integer, ci_status text, additions integer, deletions integer, changed_files integer, opened_at integer);' +
        'CREATE TABLE users (id integer PRIMARY KEY, github_login text NOT NULL);',
    );
    sqlite.prepare('INSERT INTO workspaces (id, account_id, name) VALUES (?,?,?)').run(3, 1, 'Team <A>|B');
    const pr = sqlite.prepare(
      'INSERT INTO pull_requests (id, account_id, repo_id, number, title, state, author_id) VALUES (?,?,?,?,?,?,?)',
    );
    pr.run(501, 1, 10, 12, 'Fix the login redirect', 'open', 1);
    pr.run(502, 1, 11, 12, 'Tidy the footer', 'open', 2);
    pr.run(503, 1, 10, 9, 'Bump the SDK', 'merged', 3);
    // ANOTHER TENANT holding the same repo id and number. Must never resolve for account 1.
    pr.run(900, 2, 10, 9, 'Not yours', 'open', 3);
    const u = sqlite.prepare('INSERT INTO users (id, github_login) VALUES (?,?)');
    u.run(1, 'alice');
    u.run(2, 'bob');
    u.run(3, 'carol');

    scopeRepoIds = [10, 11];
    sprintFixture = sprint(SPRINT_SUMMARY, [API12, WEB12, OTHER12]);
  });

  it('(a) carries no github.com href — every URL is a Limn URL', async () => {
    const msg = await buildSlackReport(makeCtx(BASE), llm, 1, 3);
    const json = JSON.stringify(msg!.blocks);
    expect(json).not.toMatch(/github\.com/i);
    const urls = [...json.matchAll(/<(https?:\/\/[^|>]+)\|/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(3);
    for (const u of urls) expect(u.startsWith(`${BASE}/app/`)).toBe(true);
  });

  it('(b) sprint references carry title and author; action items under their repo drop the prefix', async () => {
    const msg = await buildSlackReport(makeCtx(BASE), llm, 1, 3);
    const sprintText = sectionTexts(msg!.blocks)[0]!;
    expect(sprintText).toContain(`<${PR}502|acme/web#12 Tidy the footer> by @bob (2 days red)`);
    expect(sprintText).toContain(`<${PR}501|#12 Fix the login redirect> by @alice — Stalled 5 days`);
    expect(sprintText).toContain('*<https://limn.example/app/?view=activity&workspace=3&activityRepo=10|acme/api>*');
  });

  it('(c) a PR outside the workspace stays plain text, title and all', async () => {
    const msg = await buildSlackReport(makeCtx(BASE), llm, 1, 3);
    const json = JSON.stringify(msg!.blocks);
    expect(sectionTexts(msg!.blocks)[0]).toContain('• other/x#12 — Also mentioned');
    expect(json).not.toContain('%3A777');
    expect(json).not.toContain('Secret thing');
    expect(json).not.toContain('mallory');
  });

  it('(d) no per-repo AI digest is sent', async () => {
    const msg = await buildSlackReport(makeCtx(BASE), llm, 1, 3);
    const texts = sectionTexts(msg!.blocks);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.startsWith('*Sprint summary* · 2026-09-18 – 2026-10-02\n')).toBe(true);
    expect(JSON.stringify(msg!.blocks)).not.toContain('Two merges');
  });

  it('(f) with no base URL every reference is plain text and there is no footer link', async () => {
    const msg = await buildSlackReport(makeCtx(), llm, 1, 3);
    const texts = sectionTexts(msg!.blocks);
    for (const t of texts) expect(t).not.toContain('<http');
    expect(texts.join('\n')).toContain('#12 Fix the login redirect by @alice');
    expect((msg!.blocks as Block[]).some((b) => b.type === 'context')).toBe(false);
    expect(JSON.stringify(msg!.blocks)).not.toMatch(/github\.com/i);
  });

  it('(g) a long sprint report is cut to one section, whole lines, ending in …', async () => {
    const lines = ['**Day 3 of 14 — busy**', '', '**acme/api**'];
    for (let i = 0; i < 40; i++) lines.push(`- acme/api#12 — ${'waiting on a decision '.repeat(10)}${i}.`);
    sprintFixture = sprint(lines.join('\n'), [API12]);
    const msg = await buildSlackReport(makeCtx(BASE), llm, 1, 3);
    const texts = sectionTexts(msg!.blocks);
    expect(texts.length).toBe(1);
    for (const t of texts) {
      expect(t.length).toBeLessThanOrEqual(2900);
      expect(t.trim()).not.toBe('');
      expect(count(t, '<')).toBe(count(t, '>'));
    }
    expect(texts[texts.length - 1]!.endsWith('…')).toBe(true);
  });

  it('(h) every mrkdwn object is verbatim, Pending and footer included', async () => {
    const board = {
      workspaceId: 3,
      viewerLogin: 'alex',
      users: [],
      cards: [{ id: 'm:1', kind: 'merge', prId: 501, prNumber: 12, prTitle: '<!channel>', repoFullName: 'acme/api', authorId: null }],
      tabs: [{ key: 'land', total: 1, cardIds: ['m:1'] }],
    } as unknown as PendingBoardSnapshot;
    const msg = await buildSlackReport(makeCtx(BASE, board), llm, 1, 3);
    const objs = mrkdwnObjects(msg!.blocks);
    expect(objs.length).toBeGreaterThanOrEqual(3);
    expect(objs[0]!.text).toContain('&lt;!channel&gt;');
    for (const o of objs) expect(o.verbatim).toBe(true);
  });

  it('(i) the footer escapes the user-typed workspace name', async () => {
    const msg = await buildSlackReport(makeCtx(BASE), llm, 1, 3);
    const blocks = msg!.blocks as Block[];
    const footer = blocks[blocks.length - 1]!;
    expect(footer.type).toBe('context');
    expect(footer.elements?.[0]?.text).toBe(
      '<https://limn.example/app/?view=activity&workspace=3&activityRepo=feed|Open Team &lt;A&gt;¦B in Limn>',
    );
    expect(msg!.text).toContain('Team &lt;A&gt;|B');
  });

  it('(j) the Pending board leads, the sprint summary follows, inside the block budget', async () => {
    const sprintLines = ['**Day 3 of 14**'];
    for (let i = 0; i < 60; i++) sprintLines.push(`- ${'A long line of sprint narration. '.repeat(4)}${i}`);
    sprintFixture = sprint(sprintLines.join('\n'), []);
    const cards: InsightCard[] = [];
    const tabs: PendingTab[] = [];
    for (const key of ['my_turn', 'fixing', 'review', 'threads', 'land', 'deps'] as const) {
      const ids: string[] = [];
      for (let i = 0; i < 40; i++) {
        const prId = 1000 + tabs.length * 100 + i;
        const id = `${key}:${prId}`;
        ids.push(id);
        cards.push({
          id, kind: 'stalled_review', severity: 'warn', prId, repoId: 10, repoFullName: 'acme/api',
          prNumber: prId, prTitle: 'T'.repeat(250), authorId: 1, githubUrl: '', ciStatus: null,
          changedFiles: 0, additions: 0, deletions: 0, openedAt: '2026-09-01T00:00:00Z',
          authorIsBot: false, authorBotKind: null, automation: null, ageHours: 50,
          requestedReviewerIds: [], requestedTeamNames: [],
        } as unknown as InsightCard);
      }
      tabs.push({ key, total: 90, kindTotals: {}, cardIds: ids } as unknown as PendingTab);
    }
    const board = {
      workspaceId: 3, viewerLogin: 'alex', cards, tabs,
      users: [{ id: 1, githubLogin: 'alice' }],
    } as unknown as PendingBoardSnapshot;
    const msg = await buildSlackReport(makeCtx(BASE, board), llm, 1, 3);
    const blocks = msg!.blocks as Block[];
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(blocks[0]!.type).toBe('header');
    expect(blocks[blocks.length - 1]!.type).toBe('context');
    const texts = sectionTexts(blocks);
    // My turn is one person's board — never in a team channel.
    expect(texts[0]!.startsWith('*Needs fixing* · 90\n')).toBe(true);
    expect(texts.some((t) => t.includes('My turn') || t.includes('@alex'))).toBe(false);
    // The sprint summary comes after every Pending section, and is one section.
    const sprintIdx = texts.findIndex((t) => t.startsWith('*Sprint summary*'));
    expect(sprintIdx).toBe(texts.length - 1);
    expect(texts.slice(0, sprintIdx).every((t) => !t.startsWith('*Sprint'))).toBe(true);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(3000);
    expect(msg!.text).toBe('Team &lt;A&gt;|B · Pending');
  });

  it('(k) a host without the board seam still sends the sprint summary', async () => {
    const msg = await buildSlackReport(makeCtx(BASE), llm, 1, 3);
    expect(msg!.text).toBe('Team &lt;A&gt;|B · sprint summary');
  });
});
