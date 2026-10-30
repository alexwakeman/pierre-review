// ── THE PENDING BOARD AS SLACK SECTIONS (slack/pending-blocks.ts) ───────────────────────────
//
// Pure: a board snapshot in, `section` blocks out. What it pins:
//   • sections follow PENDING_TABS, empty ones skipped, My turn names whose turn it is;
//   • a PR is mentioned ONCE — in the first tab (board order) that lists it — and a later tab
//     neither lists nor counts it;
//   • top 5 per section in the board's own order, then an honest "and N more" linking to the tab;
//   • every kind and My turn reason has plain wording (a new one fails here first);
//   • every section ≤ 3000 chars, links balanced, attacker-authored titles escaped.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/slack-pending-blocks.test.ts
import { describe, expect, it } from 'vitest';
import type {
  InsightCard,
  InsightKind,
  MyTurnCardReason,
  PendingBoardSnapshot,
  PendingTab,
  PendingTabKey,
} from '@pierre-review/shared';
import { PENDING_TABS } from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import {
  MY_TURN_REASON_TEXT,
  PENDING_SLACK_PER_TAB,
  buildPendingBlocks,
  buildPendingSections,
  pendingCardText,
} from '../slack/pending-blocks.js';

const BASE = 'https://limn.example';
const ctx = (appWebUrl: string | undefined = BASE): ProContext =>
  ({ host: { version: '0', appWebUrl } }) as unknown as ProContext;
const mk = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text, verbatim: true } });
const texts = (blocks: unknown[]): string[] =>
  (blocks as Array<{ text: { text: string } }>).map((b) => b.text.text);

const pr = (id: string, kind: InsightKind, prId: number, extra: Record<string, unknown> = {}): InsightCard =>
  ({
    id,
    kind,
    severity: 'warn',
    prId,
    prNumber: prId,
    prTitle: `Title ${prId}`,
    repoId: 10,
    repoFullName: 'acme/api',
    authorId: 1,
    ...extra,
  }) as unknown as InsightCard;

function board(tabs: Partial<Record<PendingTabKey, { total?: number; cards: InsightCard[] }>>): PendingBoardSnapshot {
  const cards: InsightCard[] = [];
  const out: PendingTab[] = [];
  for (const def of PENDING_TABS) {
    const t = tabs[def.key];
    const listed = t?.cards ?? [];
    cards.push(...listed);
    out.push({ key: def.key, total: t?.total ?? listed.length, kindTotals: {}, cardIds: listed.map((c) => c.id) } as unknown as PendingTab);
  }
  return {
    workspaceId: 3,
    viewerLogin: 'alex',
    cards,
    tabs: out,
    users: [{ id: 1, githubLogin: 'alice' }],
  } as unknown as PendingBoardSnapshot;
}

describe('buildPendingBlocks', () => {
  it('follows board order, skips empty tabs, and NEVER sends a personal tab (team audience)', () => {
    const b = board({
      deps: { cards: [pr('d:1', 'dependency_bump', 41, { detail: 'Ready to merge' })] },
      my_turn: { cards: [pr('m:1', 'my_turn', 11, { reason: 'review_request', detail: '' })] },
      land: { cards: [pr('l:1', 'merge', 31)] },
    });
    const t = texts(buildPendingBlocks(ctx(), b, mk));
    expect(t.map((s) => s.split('\n')[0])).toEqual([':rocket: *Ready to land* · 1', ':package: *Dependencies* · 1']);
    expect(t.join('\n')).not.toContain('@alex');
    expect(t.join('\n')).not.toContain('%3A11|');
    expect(t[0]).toContain(`:white_check_mark: <${BASE}/app/?workspace=3&view=pr-detail%3A31|acme/api#31 Title 31> by @alice`);
    expect(t[1]).toContain('— Dependency bump: Ready to merge');
  });

  it('mentions a PR once, in the first tab that lists it; later tabs drop and do not count it', () => {
    const b = board({
      // My turn is never sent, so it claims nothing: #7 is named first under Needs fixing.
      my_turn: { cards: [pr('m:7', 'my_turn', 7, { reason: 'own_ci_red', detail: '' })] },
      fixing: { total: 2, cards: [pr('x:7', 'conflicts', 7), pr('x:8', 'conflicts', 8)] },
      land: { total: 1, cards: [pr('u:7', 'update_branch', 7)] },
    });
    const t = texts(buildPendingBlocks(ctx(), b, mk));
    const all = t.join('\n');
    expect(all.split('%3A7|').length - 1).toBe(1);
    expect(t[0]!.split('\n')[0]).toBe(':rotating_light: *Needs fixing* · 2');
    expect(t[0]).toContain('Merge conflicts');
    // Ready to land had only #7 — the whole section goes.
    expect(t).toHaveLength(1);
  });

  it("drops a card ABOUT the configuring account (a red build on its own PR): not listed, not counted", () => {
    const b = board({
      fixing: { total: 2, cards: [pr('c:7', 'ci_failing', 7, { arm: 'your_pr' }), pr('x:8', 'conflicts', 8)] },
    });
    const t = texts(buildPendingBlocks(ctx(), b, mk));
    expect(t).toHaveLength(1);
    expect(t[0]!.split('\n')[0]).toBe(':rotating_light: *Needs fixing* · 1');
    expect(t[0]).not.toContain('%3A7|');
    expect(t[0]).not.toContain('more>');
    // A tab holding only the viewer's own red build sends nothing.
    const only = board({ fixing: { cards: [pr('c:7', 'ci_failing', 7, { arm: 'your_pr' })] } });
    expect(buildPendingBlocks(ctx(), only, mk)).toEqual([]);
  });

  it('lists the top 5 in board order, then "and N more" linking to the tab', () => {
    const cards = Array.from({ length: 12 }, (_, i) => pr(`s:${i}`, 'stalled_review', 100 + i, { ageHours: 72 }));
    const t = texts(buildPendingBlocks(ctx(), board({ review: { total: 30, cards } }), mk));
    expect(t).toHaveLength(1);
    const lines = t[0]!.split('\n');
    expect(lines[0]).toBe(':eyes: *Waiting on review* · 30');
    const items = lines.filter((l) => l.startsWith(':hourglass_flowing_sand: '));
    expect(items).toHaveLength(PENDING_SLACK_PER_TAB);
    expect(items.map((l) => /%3A(\d+)\|/.exec(l)![1])).toEqual(['100', '101', '102', '103', '104']);
    expect(items[0]).toContain('— Waiting on review for 3 days');
    expect(lines[lines.length - 1]).toBe(
      `<${BASE}/app/?view=activity&workspace=3&activityRepo=attention&attnTab=review|and 25 more>`,
    );
  });

  it('a red default branch is one subject, linked to its repo', () => {
    const trunk = {
      id: 't:1', kind: 'my_turn', reason: 'trunk_red', repoId: 10, repoFullName: 'acme/api',
      branchName: 'main', prId: 55, failingChecks: ['build', 'lint'], failingCheckTotal: 3,
    } as unknown as InsightCard;
    const ci = { id: 'c:1', kind: 'ci_failing', arm: 'trunk', repoId: 10, repoFullName: 'acme/api', prId: null } as unknown as InsightCard;
    const ci2 = { ...ci, failingChecks: ['build', 'lint'], failingCheckTotal: 3, branchName: 'main' } as unknown as InsightCard;
    const t = texts(buildPendingBlocks(ctx(), board({ my_turn: { cards: [trunk] }, fixing: { cards: [ci2] } }), mk));
    expect(t).toEqual([
      `:rotating_light: *Needs fixing* · 1\n:red_circle: <${BASE}/app/?view=activity&workspace=3&activityRepo=10|acme/api main> — Default branch is red: build, lint and 1 more`,
    ]);
  });

  it('escapes attacker-authored titles and stays plain text with no base URL', () => {
    const evil = pr('e:1', 'merge', 9, { prTitle: 'x|<!channel> & <https://evil|y>' });
    const withBase = texts(buildPendingBlocks(ctx(), board({ land: { cards: [evil] } }), mk))[0]!;
    expect(withBase).not.toContain('<!channel>');
    expect(withBase.split('<').length).toBe(withBase.split('>').length);
    const plain = texts(buildPendingBlocks(ctx(''), board({ land: { cards: [evil] } }), mk))[0]!;
    expect(plain).not.toContain('<http');
    expect(plain).toContain('&lt;!channel&gt;');
  });

  it('keeps every section under Slack’s 3000 characters with the longest titles', () => {
    const tabs: Parameters<typeof board>[0] = {};
    for (const def of PENDING_TABS) {
      tabs[def.key] = {
        total: 99,
        cards: Array.from({ length: 8 }, (_, i) =>
          pr(`${def.key}:${i}`, 'stalled_review', 1000 * (PENDING_TABS.indexOf(def) + 1) + i, {
            prTitle: '&'.repeat(256),
            ageHours: 5,
          }),
        ),
      };
    }
    const blocks = buildPendingBlocks(ctx(), board(tabs), mk);
    expect(blocks.length).toBeLessThanOrEqual(12);
    for (const s of texts(blocks)) expect(s.length).toBeLessThanOrEqual(3000);
  });

  it('colours each team tab by what it asks: fixing red, waiting amber, ready green, deps grey', () => {
    const b = board({
      fixing: { cards: [pr('x:1', 'conflicts', 1)] },
      review: { cards: [pr('s:2', 'stalled_review', 2, { ageHours: 30 })] },
      threads: { cards: [pr('t:3', 'untouched_thread', 3, { path: 'a.ts' })] },
      land: { cards: [pr('l:4', 'merge', 4)] },
      deps: { cards: [pr('d:5', 'dependency_bump', 5)] },
    });
    const sections = buildPendingSections(ctx(), b, mk);
    expect(sections.map((s) => [s.key, s.tone])).toEqual([
      ['fixing', 'bad'],
      ['review', 'waiting'],
      ['threads', 'waiting'],
      ['land', 'good'],
      ['deps', 'info'],
    ]);
    // ⚠ Colour is never the only signal: the fallback and the heading both say the tab in words.
    expect(sections.map((s) => s.fallback)).toEqual([
      'Needs fixing · 1',
      'Waiting on review · 1',
      'Unanswered threads · 1',
      'Ready to land · 1',
      'Dependencies · 1',
    ]);
    for (const s of sections) {
      const first = (s.blocks[0] as { text: { text: string } }).text.text.split('\n');
      expect(first[0]).toContain(`*${s.fallback.split(' · ')[0]}*`);
      // One emoji per line at most.
      for (const line of first) expect((line.match(/:[a-z_]+:/g) ?? []).length).toBeLessThanOrEqual(1);
    }
  });

  it('has plain wording for every PR kind on the board and every My turn reason', () => {
    const boardKinds = PENDING_TABS.flatMap((t) => t.kinds).filter((k) => k !== 'reviewer_load');
    for (const kind of boardKinds) {
      expect(pendingCardText(pr(`k:${kind}`, kind, 1, { reason: 'mention', arm: 'your_pr', path: 'a.ts' })), kind).not.toBe('');
    }
    const reasons: MyTurnCardReason[] = [
      'review_request', 'mention', 'thread', 'thread_reply', 'comment_reply', 'pushed_since',
      'own_ci_red', 'own_conflicts', 'trunk_red', 'pr_approved', 'own_ready', 'your_pr',
      'own_thread', 'claude_review', 'watched_repo_pr',
    ];
    expect(Object.keys(MY_TURN_REASON_TEXT).sort()).toEqual([...reasons].sort());
  });

  it('labels an auto-started AI review "Auto review"', () => {
    const detail = 'AI review ready · COMMENT';
    expect(pendingCardText(pr('a', 'my_turn', 1, { reason: 'claude_review', trigger: 'auto', detail }))).toBe(
      `Auto review: ${detail}`,
    );
    expect(pendingCardText(pr('m', 'my_turn', 1, { reason: 'claude_review', trigger: 'manual', detail }))).toBe(
      `AI review: ${detail}`,
    );
  });
});
