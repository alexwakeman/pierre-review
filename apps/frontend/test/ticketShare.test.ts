// ONE PR'S SHARE OF A TICKET REVIEW — lib/ticketShare.ts and its wiring.
//
//   1. THE SPLIT: the criteria this PR delivers and the unmet work that belongs in it; the rest is
//      the story view's (no count line, no "What this PR adds" in the pane). An item that names no
//      owner stays postable (it is this PR's).
//   2. SLIM OR FULL: only where the story view can hold the whole story.
//   3. WIRING: the Story section is the story view's alone (the board never mounts it), always open,
//      its heading carrying the two run buttons; no Post buttons there; "See the whole story" opens
//      the story view tab.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/ticketShare.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewDocReference, TicketAssessment, TicketCriterion, TicketReviewItem } from '@pierre-review/shared';
import { prTicketShare, shareDocReferences, slimStoryCheck } from '../src/lib/ticketShare.js';

const THIS = { id: 10, repoId: 1 };

const crit = (ref: string, over: Partial<TicketCriterion> = {}): TicketCriterion => ({
  ref,
  index: 0,
  text: ref,
  status: 'met',
  explanation: null,
  deliveredBy: [],
  evidence: [],
  expectedIn: null,
  ...over,
});
const item = (ref: string, over: Partial<TicketReviewItem> = {}): TicketReviewItem => ({
  id: Number(ref.replace(/\D/g, '')) + (ref.startsWith('M') ? 100 : 0),
  ticketReviewId: 1,
  ref,
  status: 'not_met',
  title: ref,
  body: '',
  ownerPrId: null,
  path: null,
  line: null,
  priorItemId: null,
  posted: null,
  ...over,
});
const assess = (over: Partial<TicketAssessment>): Pick<TicketAssessment, 'criteria' | 'missing' | 'notRequested'> => ({
  criteria: [],
  missing: [],
  notRequested: [],
  ...over,
});

describe('prTicketShare', () => {
  it('keeps what this PR delivers and what belongs in it; leaves out the rest', () => {
    const a = assess({
      criteria: [
        crit('AC1', { deliveredBy: [10] }),
        crit('AC2', { deliveredBy: [11] }),
        crit('AC3', { deliveredBy: [11, 12] }),
        crit('AC4', { status: 'not_met' }),
        crit('AC5', { status: 'partly_met', deliveredBy: [10] }),
        crit('AC6', { status: 'not_met' }),
      ],
      missing: [
        { ref: 'M1', title: 'm1', explanation: null, expectedIn: { prId: 10, repoId: null } },
        { ref: 'M2', title: 'm2', explanation: null, expectedIn: { prId: 12, repoId: null } },
      ],
    });
    const items = [
      item('AC4', { ownerPrId: 10 }),
      item('AC6', { ownerPrId: 11 }),
      item('AC5', { status: 'partly_met', ownerPrId: 11 }),
      item('M1', { status: 'missing', ownerPrId: 10 }),
      item('M2', { status: 'missing', ownerPrId: 12 }),
    ];
    const s = prTicketShare(a, items, THIS);
    // AC5 is partly delivered HERE, so it is this PR's even though its gap belongs elsewhere.
    expect(s.criteria.map((c) => c.ref)).toEqual(['AC1', 'AC4', 'AC5']);
    expect(s.missing.map((i) => i.ref)).toEqual(['M1']);
  });

  it("falls back to the criterion's expectedIn, then its repo", () => {
    const a = assess({
      criteria: [
        crit('AC1', { status: 'not_met', expectedIn: { prId: 10, repoId: null } }),
        crit('AC2', { status: 'not_met', expectedIn: { prId: null, repoId: 1 } }),
        crit('AC3', { status: 'not_met', expectedIn: { prId: null, repoId: 2 } }),
        crit('AC4', { status: 'unclear', expectedIn: { prId: 11, repoId: null } }),
      ],
    });
    const s = prTicketShare(a, [], THIS);
    expect(s.criteria.map((c) => c.ref)).toEqual(['AC1', 'AC2']);
  });

  it('an item that names no owner is this PR’s, so its Post stays reachable', () => {
    const a = assess({
      criteria: [crit('AC1', { status: 'not_met' })],
      missing: [{ ref: 'M1', title: 'm', explanation: null, expectedIn: null }],
    });
    const s = prTicketShare(a, [item('AC1'), item('M1', { status: 'missing' })], THIS);
    expect(s.criteria.map((c) => c.ref)).toEqual(['AC1']);
    expect(s.missing.map((i) => i.ref)).toEqual(['M1']);
  });

  it('a missing item with no owner PR but another repo is not listed', () => {
    const a = assess({ missing: [{ ref: 'M1', title: 'm', explanation: null, expectedIn: { prId: null, repoId: 2 } }] });
    const s = prTicketShare(a, [item('M1', { status: 'missing' })], THIS);
    expect(s.missing).toEqual([]);
  });

  it('lists only the not-asked-for work this PR did', () => {
    const a = assess({
      notRequested: [
        { title: 'a', explanation: null, prId: 10, path: null, line: null },
        { title: 'b', explanation: null, prId: 11, path: null, line: null },
        { title: 'c', explanation: null, prId: null, path: null, line: null },
      ],
    });
    expect(prTicketShare(a, [], THIS).notRequested.map((g) => g.title)).toEqual(['a']);
  });
});

describe('slimStoryCheck', () => {
  const base = { ticketKey: 'BMD-1', trackerOn: true, prOpen: true, members: [] };
  it('is slim for a tracker ticket with a stack to link to', () => {
    expect(slimStoryCheck(base)).toBe(true);
  });
  it('keeps the full view with no tracker, no key, or no open PR', () => {
    expect(slimStoryCheck({ ...base, trackerOn: false })).toBe(false);
    expect(slimStoryCheck({ ...base, ticketKey: null })).toBe(false);
    expect(slimStoryCheck({ ...base, prOpen: false })).toBe(false);
    expect(slimStoryCheck({ ...base, prOpen: false, members: [{ state: 'merged' }] })).toBe(false);
  });
  it('a merged PR is slim while another PR on the ticket is open', () => {
    expect(slimStoryCheck({ ...base, prOpen: false, members: [{ state: 'merged' }, { state: 'open' }] })).toBe(true);
  });
});

describe('the wiring', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8');

  it('the Story section is always open and reads the run by the states’ latestRunId', () => {
    const panel = src('components/Activity/TicketStorySection.tsx');
    // No disclosure: a plain heading, no open/onToggle props.
    expect(panel).not.toMatch(/onToggle|ChevronIcon|open: boolean/);
    expect(panel).toMatch(/>\s*Ticket\s*<\/h4>/);
    expect(panel).toMatch(/<ReviewSummary\s+runId=\{summary\.runId\}/);
    expect(panel.match(/useTicketReviewById\(/g)).toHaveLength(1);
    // The docs check's notes ride along (empty unless written against this same list).
    // …and the story's design sits right under the criteria (both summaries).
    expect(panel).toMatch(/<TicketResults review=\{review\} viewedPrId=\{null\} docsItems=\{docsNotes\.items\} afterCriteria=\{design\} \/>/);
    expect(panel).toMatch(/<BriefSummary brief=\{summary\.brief\} docsItems=\{briefNotes\.items\} afterCriteria=\{designNode\} \/>/);
    expect(panel.match(/<StoryDesignSection\s/g)).toHaveLength(1);
    // No Post anywhere in the stack, and no dependency or reference cards.
    expect(panel).not.toMatch(/usePostStoryGaps|StoryGapsPost|references|Other tickets/);
    // The per-stack request never sits on the cards list itself, and the board never mounts the
    // section (every read in it starts on mount): only the story view's single stack does.
    const cards = src('components/Activity/OpenPrsCards.tsx');
    expect(cards).not.toMatch(/useTicketReviewById|useTicketReviews\(/);
    expect(cards).toMatch(/\{single && t\?\.ident != null && \(\s*<TicketStorySection\s/);
    expect(cards.match(/<TicketStorySection\s/g)).toHaveLength(1);
  });

  // The CARD stack (the story view's one stack, Merged so far) never collapses. The redesigned Open
  // PRs board draws its ticket GROUPS in OpenPrsRows.tsx, and those fold per session (test/openPrsRows.test.ts).
  it('a card stack never collapses, and its key + title are ONE button to the story view', () => {
    const cards = src('components/Activity/OpenPrsCards.tsx');
    expect(cards).not.toMatch(/data-stack-toggle|toggleCollapsed|collapsed\.includes|hidden=\{collapsed\}/);
    const header = cards.slice(cards.indexOf('function TicketStack('), cards.indexOf('function MergedPanel('));
    expect(header).toMatch(
      /!single && t\.ident != null \? \([\s\S]*?<TicketKeyButton[\s\S]*?\{t\.key\}[\s\S]*?\{t\.title\}[\s\S]*?<\/TicketKeyButton>/,
    );
    expect(header).not.toMatch(/onHeaderClick|cursor-pointer/);
    const store = src('store/openPrsView.ts');
    expect(store).not.toMatch(/collapsed|COLLAPSED_KEY/);
  });

  it('the Story heading carries both run buttons; the blocks share their mutations and carry none', () => {
    const panel = src('components/Activity/TicketStorySection.tsx');
    expect(panel).toMatch(/<StoryDocsButton q=\{docs\.q\} start=\{docs\.start\} starting=\{docs\.starting\} \/>/);
    expect(panel).toMatch(/<StoryDesignButton design=\{design\} \/>/);
    expect(panel).toMatch(/<StoryDesignSection design=\{design\} \/>/);
    // ONE start mutation each, owned by the section.
    expect(panel.match(/useStartStoryDocsAlignment\(/g)).toHaveLength(1);
    expect(panel.match(/useStoryDesign\(/g)).toHaveLength(1);
    const design = src('components/Activity/StoryDesignSection.tsx');
    expect(design.match(/useRedrawStoryDiagram\(/g)).toHaveLength(1);
    expect(design).toContain("'Redraw design'");
    expect(design).toContain("'Draw design'");
    expect(design).toMatch(/data\.memberCount < 2\) return null/);
    // The block draws no button of its own.
    const block = design.slice(design.indexOf('export function StoryDesignSection'));
    expect(block).not.toMatch(/<button/);
    const docs = src('components/Activity/StoryDocsAlignment.tsx');
    const docsBlock = docs.slice(docs.indexOf('export function StoryDocsAlignmentBlock'), docs.indexOf('function StoryDocsResultView'));
    expect(docsBlock).not.toMatch(/<button|AiRunGate/);
    const docsBtn = docs.slice(docs.indexOf('export function StoryDocsButton'), docs.indexOf('export function StoryDocsAlignmentBlock'));
    expect(docsBtn).toMatch(/!ai\.enabled \|\| data == null \|\| !data\.available\) return null/);
    expect(docsBtn).toMatch(/<AiRunGate kind="story_docs">/);
  });

  it('the pane shows only this PR’s share where the story view holds the story, and opens it', () => {
    const cov = src('components/TicketCoverage.tsx');
    expect(cov).toMatch(/slimStoryCheck\(\{/);
    expect(cov).toMatch(/prTicketShare\(a, review\.items, \{ id: pr\.id, repoId: pr\.repoId \}\)/);
    expect(cov).toMatch(/onClick=\{\(\) => openStory\(\{ ident, key: ticketKey, title: ticketTitle \}\)\}/);
    expect(cov).toContain('See the whole ticket');
    expect(cov).not.toContain('See the whole ticket in Open PRs');
    // The counts of the rest are the story view's: no "N more criteria are met by other PRs" here.
    expect(cov).not.toMatch(/shareRestLine|more criteria are met/);
  });

  it('"What each PR adds" rides the loaded review in the story view; the AI Review tab shows none', () => {
    const panel = src('components/Activity/TicketStorySection.tsx');
    expect(panel).toMatch(/<MemberCards members=\{members\} \/>/);
    const cov = src('components/TicketCoverage.tsx');
    expect(cov).not.toMatch(/PrCardDisclosure|prCardOf/);
    const parts = src('components/TicketReviewParts.tsx');
    expect(parts).toContain('What each PR adds');
    // No fetch of its own.
    expect(parts).not.toMatch(/useQuery\(|fetch\(/);
  });

  it('the ONE "Post N gaps" button per PR only renders with a viewed PR; no per-item Post', () => {
    const parts = src('components/TicketReviewParts.tsx');
    expect(parts).toContain('{viewedPrId != null && <StoryGapsPost review={review} viewedPrId={viewedPrId} />}');
    expect(parts).not.toMatch(/ItemPost|usePostTicketItem/);
    // The slim share offers the one for this PR.
    expect(src('components/TicketCoverage.tsx')).toContain('<StoryGapsPost review={review} viewedPrId={pr.id} onlyThisPr />');
  });
});

// A ticket review's library references are the WHOLE ticket's; the PR share lists only the ones
// about its own criteria / missing items, so a contradiction about another PR's AC is not shown here.
describe('shareDocReferences', () => {
  const docRef = (about: string | null): ReviewDocReference => ({
    path: 'h/sections/01-a.md',
    workspaceId: 3,
    anchor: null,
    docSlug: 'h',
    docTitle: 'H',
    sectionTitle: null,
    quote: 'some quoted words here',
    verdict: 'contradicts',
    note: '',
    about,
  });
  const share = { criteria: [crit('AC1')], missing: [item('M2')] };

  it('keeps references about this share’s criteria and missing items, as whole words', () => {
    const refs = [docRef('AC1'), docRef('ac1: refunds'), docRef('M2'), docRef('AC3'), docRef('AC10'), docRef(null), docRef('src/a.ts')];
    expect(shareDocReferences(refs, share).map((r) => r.about)).toEqual(['AC1', 'ac1: refunds', 'M2']);
  });

  it('a share with no criteria and no missing items lists none', () => {
    expect(shareDocReferences([docRef('AC1')], { criteria: [], missing: [] })).toEqual([]);
    expect(shareDocReferences(undefined, share)).toEqual([]);
  });

  it('the PR share filters; the whole story does not', () => {
    const src = readFileSync(join(__dirname, '../src/components/TicketCoverage.tsx'), 'utf8');
    expect(src).toContain('<DocReferencesBlock references={shareDocReferences(a?.references, share)} />');
    expect(src).not.toContain('<DocReferencesBlock references={a?.references} />');
  });
});
