// THE OPEN PRs ROWS (components/Activity/OpenPrsRows.tsx) — the redesign's one-line Open PRs list
// (docs/redesign/DESIGN.md). Pinned here:
//
//   1. The row's icons say what the old card's chips said, with colour only by rule: the lead is the
//      merge verdict (red conflicts / blocked, green ready, grey otherwise, Draft quiet); CI failing is
//      red and passing is NOT green (it is not news); the review standing is red / green or nothing.
//   2. The rows draw what OpenPrsCards folded: every read stays ONE batched request in OpenPrsCards,
//      and the rows file asks for none (nothing fetches on selection or on mount).
//   3. Every fact the card carried is reachable: the side panel names checks, reviews, threads, the
//      tickets (story view / tracker / "Also in"), author, opened, updated, size, large-PR flag, reach
//      and the AI review panel; its footer opens the PR, the AI review and GitHub.
//   4. Open PRs mounts the rows; the story view and Open PRs → Merged keep the cards.
//   6. Open PRs has two tabs, Open | Merged; Merged is the old This Sprint → "Merged so far".
//   5. The Feed's My Turn marker is the accent bar + the words (it was a yellow border).
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TimelinePr } from '@pierre-review/shared';
import { ciStatusIcon, leadStatus, openPrsColumns, reviewStanding } from '../src/components/Activity/OpenPrsRows.js';

const src = (p: string): string => readFileSync(join(__dirname, '..', 'src', p), 'utf8');

const pr = (over: Partial<TimelinePr>): TimelinePr =>
  ({
    id: 1,
    number: 7,
    title: 't',
    repoId: 1,
    isDraft: false,
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    isApproved: false,
    isChangesRequested: false,
    ciStatus: 'success',
    ...over,
  }) as unknown as TimelinePr;

describe('the row icons', () => {
  it('leads with can-it-land: red blocks, green ready, grey otherwise', () => {
    expect(leadStatus(pr({ mergeStateStatus: 'dirty' }))).toMatchObject({ tone: 'blocked', label: 'Conflicts' });
    expect(leadStatus(pr({ mergeStateStatus: 'blocked' }))).toMatchObject({ tone: 'blocked', label: 'Blocked' });
    expect(leadStatus(pr({ mergeStateStatus: 'clean' }))).toMatchObject({ tone: 'ready', label: 'Ready to merge' });
    expect(leadStatus(pr({ mergeStateStatus: 'behind' }))).toMatchObject({ tone: 'neutral', label: 'Behind base' });
    expect(leadStatus(pr({ mergeStateStatus: 'unknown' }))).toMatchObject({ tone: 'neutral', label: 'Open' });
  });
  it('a draft is quiet unless its branch has a fact that survives it (conflicts)', () => {
    expect(leadStatus(pr({ isDraft: true, mergeStateStatus: 'clean' }))).toMatchObject({ tone: 'quiet', label: 'Draft' });
    expect(leadStatus(pr({ isDraft: true, mergeStateStatus: 'dirty' }))).toMatchObject({ tone: 'blocked', label: 'Conflicts' });
  });
  it('CI: failing red, passing grey, no reading = no icon', () => {
    expect(ciStatusIcon('failure')).toMatchObject({ tone: 'blocked', label: 'CI failing' });
    expect(ciStatusIcon('error')?.tone).toBe('blocked');
    expect(ciStatusIcon('success')).toMatchObject({ tone: 'quiet', label: 'CI passing' });
    expect(ciStatusIcon('pending')).toMatchObject({ tone: 'neutral', label: 'CI running' });
    expect(ciStatusIcon('unknown')).toBeNull();
    expect(ciStatusIcon(null)).toBeNull();
  });
  it('review standing: changes requested red, approved green, else nothing', () => {
    expect(reviewStanding(pr({ isChangesRequested: true, isApproved: true }))).toMatchObject({ tone: 'blocked', label: 'Changes requested' });
    expect(reviewStanding(pr({ isApproved: true }))).toMatchObject({ tone: 'ready', label: 'Approved' });
    expect(reviewStanding(pr({}))).toBeNull();
  });
});

describe('the wiring', () => {
  const rows = src('components/Activity/OpenPrsRows.tsx');
  const cards = src('components/Activity/OpenPrsCards.tsx');

  it('Open PRs mounts the rows; the story view and Merged so far keep the cards', () => {
    expect(src('components/Activity/OpenPrsDetail.tsx')).toMatch(/<OpenPrsCards\s+layout="rows"/);
    expect(cards).toMatch(/const rowsLayout = layout === 'rows' && story == null && !merged;/);
    expect(cards).toMatch(/<OpenPrsRows\s/);
    expect(src('components/Ticket/StoryViewBody.tsx')).not.toMatch(/layout="rows"/);
    expect(src('components/Activity/MergedPrsView.tsx')).not.toMatch(/layout="rows"/);
  });

  it('Open PRs has an Open | Merged strip; Merged mounts MergedPrsView and This Sprint no longer does', () => {
    const detail = src('components/Activity/OpenPrsDetail.tsx');
    expect(detail).toMatch(/\{ id: 'open', label: 'Open' \}/);
    expect(detail).toMatch(/\{ id: 'merged', label: 'Merged' \}/);
    expect(detail).toMatch(/tab === 'merged' \? \([\s\S]*<MergedPrsView \/>/);
    expect(src('components/Sprint/SprintTabView.tsx')).not.toMatch(/<MergedPrsView|import \{ MergedPrsView/);
    // The window heading is the server's, through the shared spelling (this sprint so far / last 14 days).
    expect(src('components/Activity/MergedPrsView.tsx')).toMatch(/reportingWindowCaption\(w\)/);
  });

  it('the rows read nothing of their own: every batched request stays in OpenPrsCards', () => {
    expect(rows).not.toMatch(/useClaudeReviewStates|useCiReviewStates|useTicketReviewStates|useTicketLinks|useTicketMergedPrs\(|useQuery\(/);
    expect(cards.match(/useClaudeReviewStates\(/g)).toHaveLength(1);
  });

  it('the side panel carries every fact and action the card had', () => {
    const panel = rows.slice(rows.indexOf('function PrPanelBody('));
    for (const f of ['Can it land', 'Checks', 'Reviews', 'Threads', 'Tickets', 'Also in', 'Author', 'Opened', 'Updated', 'Size', 'Reach']) {
      expect(panel, f).toContain(f);
    }
    expect(panel).toMatch(/<LargePrFlag pr=\{pr\} \/>/);
    expect(panel).toMatch(/<BlastRadiusChip pr=\{pr\} \/>/);
    expect(panel).toMatch(/<DrawerAiReview/);
    expect(panel).toMatch(/openStory\(/);
    expect(rows).toMatch(/View PR/);
    expect(rows).toMatch(/what="PR link"/);
    // The AI work chip ("<provider> is working on this PR") survives in the panel and the row.
    expect(rows.match(/is working on this PR/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("the panel's AI review is a fact list that keeps every fact and action the strip had", () => {
    const ai = src('components/Activity/OpenPrsAiReview.tsx');
    for (const f of [
      'Review failed', 'Not reviewed', 'Starting…', 'Queued', 'Reviewing…', 'AUTO_REVIEW_LABEL', 'Reviewed by @', 'Being reviewed by @',
      'Commit', 'Findings', 'No issues', 'Earlier', 'still open', "label=\"CI\"", 'Story check', 'Posted', 'Last run', 'AI Fix',
      'Re-review', 'Open review', 'Could not start the review.',
    ]) {
      expect(ai, f).toContain(f);
    }
    // The ONE gate around the run button; what it ran on through the shared labeller.
    expect(ai).toMatch(/<AiRunGate kind="review">\s*<Button/);
    expect(ai).toMatch(/pairModelsLabel\(state\.ranOn\)/);
    // A red mark only for blockers; no chips, no nested box.
    expect(ai.match(/bg-ui-danger/g)).toHaveLength(1);
    expect(ai).not.toMatch(/PILL|rounded-ui bg-|bg-ai-surface|ring-1/);
  });

  it('a ticket group folds (per session, never stored); its line is the key and the story name only, no PR count', () => {
    const group = rows.slice(rows.indexOf('function TicketGroup('), rows.indexOf('function MergedRows('));
    expect(group).toMatch(/aria-expanded=\{!folded\}/);
    expect(group).toMatch(/<TicketKeyButton/);
    expect(group).not.toMatch(/prCountLabel/);
    // Status, type, assignee, criteria met, Re-check, "changed since", "reviewed ago" and the roll-up
    // live in the story view, not on the group line.
    expect(group).not.toMatch(/TicketFacts|GroupCoverage|stackRollup|<ReviewedAgo|useStartTicketReview|t\.assignee|t\.issueType|t\.status/);
    expect(src('store/openPrsView.ts')).not.toMatch(/folded|collapsed/);
  });

  it('the icon columns: ONE spec for the heading row and every row, fixed widths, plain labels', () => {
    const all = openPrsColumns({ claudeOn: true });
    expect(all.map((c) => c.label)).toEqual(['Review', 'CI', 'Threads', 'AI review']);
    for (const c of all) {
      expect(c.width).toBeGreaterThanOrEqual(36);
      expect(c.title.length).toBeGreaterThan(0);
    }
    // No AI column where AI does not run.
    expect(openPrsColumns({ claudeOn: false }).map((c) => c.key)).not.toContain('ai');
    // The row and the heading draw the same cells from the same spec.
    const row = rows.slice(rows.indexOf('function PrRow('), rows.indexOf('function TicketGroup('));
    expect(row).toMatch(/openPrsColumns\(\{ claudeOn: data\.claudeOn \}\)/);
    expect(row).toMatch(/<ColCell key=\{col\.key\} col=\{col\}/);
    expect(rows).toMatch(/<ColumnHeadings columns=\{openPrsColumns\(\{ claudeOn: props\.claudeOn \}\)\}/);
  });

  it('a row is the same with the drawer open or closed: always two lines, author and age on the second', () => {
    const row = rows.slice(rows.indexOf('function PrRow('), rows.indexOf('function TicketGroup('));
    expect(row).toMatch(/data-testid="open-prs-row-two-line"/);
    // Nothing in the row or the column spec reads the drawer.
    expect(row).not.toMatch(/compact|panelOpen|docked/);
    expect(rows).not.toMatch(/compactRows/);
    expect(rows.slice(rows.indexOf('export function openPrsColumns('), rows.indexOf('const HIDE_BELOW'))).not.toMatch(/compact/);
  });

  it('docked, the drawer column is always there, so the list keeps one width open or closed', () => {
    // The placeholder takes the drawer's width exactly when the drawer is not drawn.
    expect(rows).toMatch(/\{docked && !\(panelOpen && selected != null\) && \(\s*<div\s+data-testid="open-prs-panel-reserved"/);
    expect(rows).toMatch(/open=\{panelOpen && selected != null\}/);
    const reserved = rows.slice(rows.indexOf('data-testid="open-prs-panel-reserved"'));
    expect(reserved.slice(0, 300)).toMatch(/w-panel shrink-0/);
  });

  it('the Feed marks My Turn with the accent bar and the words, not a yellow border', () => {
    const feed = src('components/Activity/FeedView.tsx');
    expect(feed).toMatch(/data-my-turn=\{isMyTurn \? 'true' : undefined\}/);
    expect(feed).not.toMatch(/border-yellow-400/);
    expect(feed).toMatch(/>\s*My Turn\s*</);
  });

  it("the drawer's links read as links: 'View PR', an underlined threads link to the Threads only view", () => {
    const rows = src('components/Activity/OpenPrsRows.tsx');
    const panel = rows.slice(rows.indexOf('function PrPanelBody('));
    expect(rows).toMatch(/>\s*View PR\s*</);
    expect(rows).toContain('`View PR ${label}`');
    expect(rows).not.toMatch(/Open pull request \$\{label\}|>\s*Open pull request\s*</);
    // The threads fact is a link, underlined at every width, to the PR's Threads only view.
    expect(panel).toMatch(/onClick=\{\(\) => data\.onOpenThreads\(pr\)\}[\s\S]{0,200}TEXT_LINK/);
    expect(src('components/Activity/OpenPrsCards.tsx')).toMatch(/onOpenThreads=\{\(pr\) => openPrThreadsView\(metaOf\(pr\)\)\}/);
    expect(src('components/PrDetail.tsx')).toMatch(/threadsViewRequest !== prId\) return;[\s\S]{0,120}seedThreadsView\(\)/);
    // The AI review section's links are the same primitive.
    expect(src('components/Activity/OpenPrsAiReview.tsx')).toMatch(/const LINK = cx\([^)]*TEXT_LINK/);
  });

  it('the text-link primitive: always-underlined, and a phone-only variant scoped below md', () => {
    const css = src('index.css');
    expect(css).toMatch(/\.text-link \{[^}]*text-decoration-line: underline/);
    expect(css).toMatch(/@media \(max-width: 767px\) \{\s*\.text-link-phone \{[^}]*text-decoration-line: underline/);
    // The phone variant is never declared outside that media query.
    expect(css.match(/\.text-link-phone \{/g)).toHaveLength(1);
  });
});

