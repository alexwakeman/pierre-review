// THE STORY VIEW (docs/FRONTEND.md § The story view) — the ticket tab drawn Open PRs style.
//
// Pins:
//   1. THE STORY SECTION'S FOLD (`storySummaryOf`): the ticket review leads when one exists; else the
//      CURRENT brief; else "reading" while the brief pass will still read it; else nothing.
//   2. The ticket as written for a ticket with no PR (`storyFallbackTicket`), and the design offer.
//   3. The header ticket (`storyViewTicket`): the sprint row leads for a sprint ticket, the PR row
//      otherwise, gaps filled from the other, then the tab's own meta.
//   4. THE ONE STACK (`storyStack`): every PR handed in is a row, the stack exists with none, `alsoIn`
//      is each row's OTHER tickets, header gaps filled from the PRs' links.
//   5. The tab's words: "KEY · Story", "KEY: story and pull requests", "Close story tab".
//   6. NOTHING imports what was removed: the sprint drawer, "Check against code", the old Story check
//      panel and the PR-sections fold.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/storyView.test.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SprintBrief, TicketPrsTicket, TicketStoryResponse, TicketStoryTicket, TimelinePr } from '@pierre-review/shared';
import { storyDesignOffered, storyFallbackTicket, storySummaryOf, storyViewTicket } from '../src/lib/ticketStory.js';
import { storyStack, storyStackId } from '../src/lib/openPrsStacks.js';
import { storyTabLabels } from '../src/lib/ticketTab.js';
import type { CardTicket } from '../src/lib/cardTickets.js';

const IDENT = 'jira:https://acme.atlassian.net#BMD-7';
const BRIEF: SprintBrief = {
  summary: 'Let people save a basket.',
  criteria: [{ n: 1, text: 'The basket survives a reload.' }],
  criteriaDerived: true,
  references: [],
  linkReasons: [],
  createdAt: '2026-10-01T00:00:00.000Z',
};
const story = (o: Partial<TicketStoryResponse> = {}): TicketStoryResponse => ({
  workspaceId: 1,
  ident: IDENT,
  found: true,
  ticket: null,
  briefState: 'current',
  brief: BRIEF,
  story: { description: 'As a shopper…', acceptanceCriteria: '' },
  ...o,
});

describe('the Story section fold', () => {
  it('the ticket review leads whenever one exists', () => {
    expect(storySummaryOf({ latestRunId: 9 }, story())).toEqual({ kind: 'review', runId: 9 });
    expect(storySummaryOf({ latestRunId: 9 }, undefined)).toEqual({ kind: 'review', runId: 9 });
  });

  it('else the current brief; else "reading" while pending; else nothing', () => {
    expect(storySummaryOf(undefined, story())).toEqual({ kind: 'brief', brief: BRIEF });
    expect(storySummaryOf({ latestRunId: null }, story())).toEqual({ kind: 'brief', brief: BRIEF });
    expect(storySummaryOf(undefined, story({ briefState: 'pending', brief: null }))).toEqual({ kind: 'reading' });
    for (const s of [story({ briefState: 'off', brief: null }), story({ briefState: 'none', brief: null }), undefined]) {
      expect(storySummaryOf(undefined, s)).toEqual({ kind: 'none' });
    }
    // A brief that is not current is never shown, even if one rode along.
    expect(storySummaryOf(undefined, story({ briefState: 'pending' }))).toEqual({ kind: 'reading' });
  });

  it('the ticket as written comes from the sprint text when there is any', () => {
    expect(storyFallbackTicket(story(), 'BMD-7', 'https://x/BMD-7')).toMatchObject({
      key: 'BMD-7',
      url: 'https://x/BMD-7',
      description: 'As a shopper…',
      source: 'jira',
    });
    expect(storyFallbackTicket(story({ story: { description: ' ', acceptanceCriteria: '' } }), 'BMD-7', null)).toBeNull();
    expect(storyFallbackTicket(story({ story: null }), 'BMD-7', null)).toBeNull();
    expect(storyFallbackTicket(undefined, 'BMD-7', null)).toBeNull();
  });

  it('the design is offered only with agentic AI and at least one PR', () => {
    expect(storyDesignOffered(true, 1)).toBe(true);
    expect(storyDesignOffered(true, 0)).toBe(false);
    expect(storyDesignOffered(false, 3)).toBe(false);
  });
});

describe('the header ticket', () => {
  const prs: TicketPrsTicket = {
    key: 'BMD-7',
    title: 'Saved basket (PR row)',
    url: 'https://acme.atlassian.net/browse/BMD-7',
    provider: 'jira',
    status: { name: 'In Review', category: 'indeterminate' },
  };
  const sprint: TicketStoryTicket = {
    key: 'BMD-7',
    title: 'Saved basket (sprint row)',
    url: null,
    provider: 'jira',
    status: { name: 'PO Review', category: 'indeterminate' },
    issueType: 'Story',
    assignee: { name: 'Amy Pond', avatarUrl: null },
    epic: null,
    inSprint: true,
  };

  it('a sprint ticket leads with the sprint row, gaps from the PR row', () => {
    const t = storyViewTicket(IDENT, { key: 'BMD-7', title: null }, prs, sprint);
    expect(t).toMatchObject({
      ident: IDENT,
      key: 'BMD-7',
      title: 'Saved basket (sprint row)',
      url: 'https://acme.atlassian.net/browse/BMD-7',
      status: 'PO Review',
      statusCategory: 'indeterminate',
      issueType: 'Story',
      assignee: { name: 'Amy Pond' },
    });
  });

  it('a ticket out of the sprint leads with the PR row; nothing read → the tab’s own meta', () => {
    const t = storyViewTicket(IDENT, { key: 'BMD-7', title: null }, prs, { ...sprint, inSprint: false });
    expect(t.title).toBe('Saved basket (PR row)');
    expect(t.status).toBe('In Review');
    expect(storyViewTicket(IDENT, { key: 'BMD-7', title: 'From the link' }, null, null)).toEqual({
      ident: IDENT,
      key: 'BMD-7',
      title: 'From the link',
      url: null,
    });
  });
});

describe('the story view’s one stack', () => {
  const pr = (id: number, updatedAt: string): TimelinePr => ({ id, updatedAt }) as TimelinePr;
  const ticket: CardTicket & { ident: string } = { ident: IDENT, key: 'bmd-7', title: 'Saved basket', url: null };

  it('exists with no PR at all', () => {
    const s = storyStack({ ticket, merged: [] }, [], () => []);
    expect(s.stacks).toHaveLength(1);
    expect(s.stacks[0]).toMatchObject({ id: storyStackId(IDENT), rows: [], ticket: { key: 'BMD-7' } });
  });

  it('lists every PR handed in (once), with its OTHER tickets, and fills header gaps from the links', () => {
    const links: Record<number, CardTicket[]> = {
      1: [{ key: 'BMD-7', title: null, url: 'https://acme.atlassian.net/browse/BMD-7', status: 'In Review' }],
      // Detection never named BMD-7 on this one: it is still a row (membership is the read's).
      2: [{ key: 'BMD-9', title: 'Other', url: null }],
    };
    const s = storyStack({ ticket, merged: [] }, [pr(1, '2026-10-02'), pr(2, '2026-10-03'), pr(1, '2026-10-02')], (p) => links[p.id] ?? []);
    const st = s.stacks[0]!;
    expect(st.rows.map((r) => [r.pr.id, r.alsoIn.map((t) => t.key)])).toEqual([
      [1, []],
      [2, ['BMD-9']],
    ]);
    expect(st.ticket).toMatchObject({ key: 'BMD-7', title: 'Saved basket', url: 'https://acme.atlassian.net/browse/BMD-7', status: 'In Review' });
    expect(st.latestActivity).toBe('2026-10-03');
  });
});

describe('the story tab’s words', () => {
  it('names the story, not only its pull requests', () => {
    expect(storyTabLabels('BMD-7')).toEqual({ chip: 'BMD-7 · Story', title: 'BMD-7: story and pull requests', closeAria: 'Close story tab' });
    expect(storyTabLabels(null)).toEqual({ chip: 'Story', title: 'Story and pull requests', closeAria: 'Close story tab' });
  });
});

describe('what was removed stays removed', () => {
  const root = join(__dirname, '..', 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  walk(root);

  it('no module imports the drawer, "Check against code", the old Story check panel or the PR-sections fold', () => {
    // Module names as an import would spell them (`useStackStoryCheck` is the surviving store, not the panel).
    const gone =
      /\/(SprintTicketDrawer|SprintAssessment|SprintCodeCheck|SprintCopyButton|StackStoryCheck|TicketPrsSections|SprintStoryDiagram)\.js'|\bdrawerReferenceGroups\b|lib\/copy\.js'|\buseOpenTicketTab\b|sprint-assess\/|\bsprintSetRepos\b|\bsprintAssess(ment)?\b|\buseSprintTicket\b/;
    const hits = files.filter((f) => gone.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1));
    expect(hits).toEqual([]);
  });

  it('the force graph is gone: no module imports it, its model, its strip or its CSS', () => {
    const gone = /\/(SprintGraph|sprintGraphModel|SprintPathsStrip|SprintStoryStrip|sprintReferences)\.js'|sprint-canvas/;
    const hits = files.filter((f) => gone.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1));
    expect(hits).toEqual([]);
    expect(readFileSync(join(root, 'index.css'), 'utf8')).not.toMatch(/\.sprint-canvas/);
  });

  it('every sprint view draws ONE card, TicketCard, on the shared lane board', () => {
    const boards = readFileSync(join(root, 'components/Activity/SprintBoards.tsx'), 'utf8');
    expect(boards).toMatch(/<LaneBoard\b/);
    expect(boards.match(/<TicketCard\b/g)).toHaveLength(1);
    // The design grid routes its arrows through the board's shared pieces.
    const grid = readFileSync(join(root, 'components/DesignGrid.tsx'), 'utf8');
    expect(grid).toMatch(/useRoutedArrows\(/);
    expect(grid).toMatch(/<ArrowLayer\b/);
  });

  it('the story view draws the Open PRs stack, never a copy', () => {
    const view = readFileSync(join(root, 'components/Ticket/TicketTabView.tsx'), 'utf8');
    expect(view).toMatch(/<OpenPrsCards[^>]*story=\{story\}/);
    // Every opener goes through the one hook.
    const sprint = readFileSync(join(root, 'components/Activity/SprintView.tsx'), 'utf8');
    expect(sprint).toMatch(/useOpenStory\(\)/);
  });
});
