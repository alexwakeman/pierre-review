// THE SHARED PR CARD SHELL (components/Activity/PrCardShell.tsx) — the one card layout the Open PRs
// tab and the Pending board both render. Pinned here:
//
//   1. The meta line separates its parts with ONE decorative "·" and skips empty parts, so a missing
//      clock or an absent "updated" never leaves a doubled or dangling separator.
//   2. The CI chip says nothing without a reading (no "no checks" chip) and is red-toned when red.
//   3. The frame is whole-card clickable and focusable ONLY with `onOpen`; a click on a control is
//      left to that control (`cardClickActivates`).
//   4. Both surfaces actually mount the shell, and the Pending board adds no per-card fetch: the
//      Claude Review states are ONE batched request for the board, and the panel never fetches.
//   5. The two subjects that are NOT pull requests (a red trunk, a reviewer's load) are not drawn
//      as one: `pendingCardPrId` gives them no PR.
//
// No JSX: this directory is plain `.ts`, so components are built with `createElement`.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InsightCard } from '@pierre-review/shared';
import {
  CiChip,
  PrCardChips,
  PrCardFrame,
  PrCardMeta,
  PrCardTitle,
  cardClickActivates,
  filesLabel,
} from '../src/components/Activity/PrCardShell.js';
import { pendingCardPrId, stateChipBesideKind } from '../src/components/Activity/AttentionCards.js';

const textOf = (html: string): string => html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&');
const src = (p: string): string => readFileSync(join(__dirname, '..', 'src', p), 'utf8');

describe('PrCardMeta', () => {
  it('separates parts with one "·" and skips empty ones', () => {
    const html = renderToStaticMarkup(
      createElement(PrCardMeta, { parts: ['#12', null, 'acme/api', false, '', 'opened 3d'] }),
    );
    expect(textOf(html)).toBe('#12·acme/api·opened 3d');
    expect(html.match(/decorative-mark/g)?.length).toBe(2);
  });

  it('puts trailing content after the parts with no separator', () => {
    const html = renderToStaticMarkup(
      createElement(PrCardMeta, { parts: ['#1'], trailing: createElement('span', null, '+3') }),
    );
    expect(textOf(html)).toBe('#1+3');
    expect(html.match(/decorative-mark/g)).toBeNull();
  });

  it('pluralises the file count', () => {
    expect(filesLabel(1)).toBe('1 file');
    expect(filesLabel(0)).toBe('0 files');
    expect(filesLabel(7)).toBe('7 files');
  });
});

describe('CiChip', () => {
  it('renders nothing without a checks reading', () => {
    expect(renderToStaticMarkup(createElement(CiChip, { ci: null }))).toBe('');
  });
  it('is red-toned when CI failed, neutral when it passed', () => {
    expect(renderToStaticMarkup(createElement(CiChip, { ci: 'failure' }))).toContain('bg-red-500/10');
    expect(renderToStaticMarkup(createElement(CiChip, { ci: 'success' }))).not.toContain('bg-red-500/10');
  });
});

describe('PrCardFrame + PrCardTitle + PrCardChips', () => {
  it('is focusable and clickable only with onOpen', () => {
    const live = renderToStaticMarkup(createElement(PrCardFrame, { onOpen: () => {} }, 'x'));
    expect(live).toContain('tabindex="0"');
    expect(live).toContain('cursor-pointer');
    const inert = renderToStaticMarkup(createElement(PrCardFrame, null, 'x'));
    expect(inert).not.toContain('tabindex');
    expect(inert).not.toContain('cursor-pointer');
  });

  it('carries an accent and the flash ring when asked', () => {
    const html = renderToStaticMarkup(
      createElement(PrCardFrame, { accentClass: 'border-l-4 border-l-red-400', flash: true }, 'x'),
    );
    expect(html).toContain('border-l-4 border-l-red-400');
    expect(html).toContain('ring-sky-400/70');
  });

  it('names the card by its title, and keeps the end slot outside the heading', () => {
    const html = renderToStaticMarkup(
      createElement(PrCardTitle, { id: 't1', end: createElement('a', { href: '#' }, 'gh') }, 'Fix the build'),
    );
    expect(html).toMatch(/<h3 id="t1"[^>]*><span[^>]*title="Fix the build"[^>]*>Fix the build<\/span><\/h3>/);
    expect(html.indexOf('gh')).toBeGreaterThan(html.indexOf('</h3>'));
  });

  it('hides an empty chips row', () => {
    expect(renderToStaticMarkup(createElement(PrCardChips, null))).toContain('empty:hidden');
  });
});

describe('cardClickActivates', () => {
  const at = (hit: boolean) => ({ closest: () => (hit ? {} : null) });
  it('ignores a click on a control and takes any other', () => {
    expect(cardClickActivates(at(true) as unknown as EventTarget)).toBe(false);
    expect(cardClickActivates(at(false) as unknown as EventTarget)).toBe(true);
  });
});

describe('both surfaces mount the shared shell', () => {
  it('Open PRs and Pending cards are built on PrCardFrame', () => {
    expect(src('components/Activity/OpenPrsCards.tsx')).toMatch(/<PrCardFrame /);
    const pending = src('components/Activity/AttentionCards.tsx');
    expect(pending).toMatch(/<PrCardFrame/);
    // Layout B: the card leads with the EVENT heading (the shell's optional slot), and the PR's
    // meta line ("by · opened · files") lives behind Details.
    expect(pending).toMatch(/<PrCardEventHeading/);
    expect(pending).toMatch(/<PrCardMeta\b/);
    // The old header strip, title line and chip row are gone from the Pending card.
    expect(pending).not.toMatch(/function PrLine\(/);
    expect(pending).not.toMatch(/<PrCardTitle\b/);
    expect(pending).not.toMatch(/<PrCardChips\b/);
  });

  it('the Pending board fetches Claude states ONCE, gated on agentic AI, and says Claude in one line', () => {
    const pending = src('components/Activity/AttentionCards.tsx');
    expect(pending).toMatch(/const claudeOn = useAiCapabilities\(\)\.enabled;/);
    expect(pending.match(/useClaudeReviewStates\(/g)?.length).toBe(1);
    expect(pending).toMatch(/useClaudeReviewStates\(claudePrIds, claudeOn\)/);
    // One line per card, its buttons in the card's own action row; never the full Open PRs panel.
    expect(pending).toMatch(/board\.claudeOn && prRef != null \? \(\s*<ClaudeReviewLine/);
    expect(pending).not.toMatch(/<ClaudeReviewPanel/);
    // …and nothing in the Pending Claude components fetches the states itself.
    expect(src('components/Activity/PendingClaude.tsx')).not.toMatch(/useClaudeReviewStates/);
  });

  it('the Pending card fetches nothing on mount: the thread and PR summary wait for Details', () => {
    const pending = src('components/Activity/AttentionCards.tsx');
    // The two fetching readers mount ONLY inside `PrDetails`, which renders only while open.
    expect(pending).toMatch(/hasDetails && detailsOpen && prRef != null && \(\s*<PrDetails/);
    const details = pending.slice(pending.indexOf('function PrDetails('), pending.indexOf('function InsightThreadById('));
    expect(details).toMatch(/<InsightThreadById/);
    expect(details).toMatch(/<InsightPrSummaryBody/);
    const card = pending.slice(pending.indexOf('function PendingCard('), pending.indexOf('export function AttentionCards('));
    expect(card).not.toMatch(/<InsightThreadById|<InsightPrSummaryBody|useThread\(|usePr\(/);
  });
});

describe('pendingCardPrId', () => {
  it('gives a PR card its PR and a repo- or person-grained card none', () => {
    expect(pendingCardPrId({ kind: 'merge', prId: 7, inMergeQueue: null } as unknown as InsightCard)).toBe(7);
    expect(pendingCardPrId({ kind: 'ci_failing', prId: 9, arm: 'trunk' } as unknown as InsightCard)).toBeNull();
    expect(
      pendingCardPrId({ kind: 'my_turn', reason: 'trunk_red', prId: 9 } as unknown as InsightCard),
    ).toBeNull();
    expect(pendingCardPrId({ kind: 'reviewer_load', reviewerId: 1 } as unknown as InsightCard)).toBeNull();
  });
});

describe('stateChipBesideKind', () => {
  it('drops a state chip that only repeats the kind chip', () => {
    expect(stateChipBesideKind('behind trunk', 'Behind trunk')).toBeNull();
    expect(stateChipBesideKind('unstable', 'Ready to merge')).toBe('unstable');
    expect(stateChipBesideKind(null, 'Ready to merge')).toBeNull();
  });
});
