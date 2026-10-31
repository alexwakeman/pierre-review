// THE PR VIEW'S TAB ON THE WIRE, THE STORY TAB, AND THE AI REVIEW TAB'S WIDE LAYOUT
// (docs/FRONTEND.md § PrDetail, § The AI Review tab → Wide layout).
//
// Pins:
//   1. `?prTab=ai_review` opens AI Review; the old `?prTab=claude_review` still does (an alias), and
//      the serializer only ever writes `ai_review`.
//   2. `?prTab=story` is a PR tab; the Story tab is listed only while the PR names a story (an ident),
//      LAST in the strip, and mounts the ONE story body (never a copy).
//   3. The AI Review tab mounts the shared rail layout; the run controls, Reviews and actions and Post
//      go through rail pieces (in place when narrow); the design is wide content.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/prTabWire.test.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PR_DETAIL_TABS } from '../src/store/filters.js';

const location = { pathname: '/app/', search: '' };
(globalThis as unknown as { window: unknown }).window = {
  location,
  history: { replaceState: (): void => {} },
};
const { readFromUrl, prTabFromUrl, prTabToUrl } = await import('../src/hooks/useUrlState.js');

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, '../src', rel), 'utf8');

describe('prTab on the wire', () => {
  it('writes ai_review for the AI Review tab, every other tab by its id', () => {
    expect(prTabToUrl('claude_review')).toBe('ai_review');
    for (const t of PR_DETAIL_TABS.filter((x) => x !== 'claude_review')) expect(prTabToUrl(t)).toBe(t);
  });
  it('reads ai_review, and the old claude_review as an alias', () => {
    expect(prTabFromUrl('ai_review')).toBe('claude_review');
    expect(prTabFromUrl('claude_review')).toBe('claude_review');
    expect(prTabFromUrl('threads')).toBe('changes');
    expect(prTabFromUrl('story')).toBe('story');
    expect(prTabFromUrl('nope')).toBeNull();
    expect(prTabFromUrl(null)).toBeNull();
  });
  it('a deep link seats the pair from either spelling', () => {
    location.search = '?view=pr-detail:7&prTab=ai_review';
    expect(readFromUrl().prDetailTab).toEqual({ prId: 7, tab: 'claude_review' });
    location.search = '?view=pr-detail:7&prTab=claude_review';
    expect(readFromUrl().prDetailTab).toEqual({ prId: 7, tab: 'claude_review' });
    location.search = '?view=pr-detail:7&prTab=story';
    expect(readFromUrl().prDetailTab).toEqual({ prId: 7, tab: 'story' });
  });
  it('the serializer goes through prTabToUrl (never the raw id)', () => {
    const src = read('hooks/useUrlState.ts');
    expect(src).toMatch(/p\.set\('prTab', prTabToUrl\(s\.prDetailTab\.tab\)\)/);
  });
});

describe('the Story tab', () => {
  const pd = read('components/PrDetail.tsx');
  it('is listed only while the PR names a story, and last', () => {
    expect(pd).toMatch(/const storyTabVisible = storyTickets\.length > 0;/);
    expect(pd).toMatch(/\.\.\.\(aiFixTabEnabled \? \(\['ai_fix'\] as Tab\[\]\) : \[\]\),\s*\/\/[^\n]*\n\s*\.\.\.\(storyTabVisible \? \(\['story'\] as Tab\[\]\) : \[\]\),/);
    // A stale ?prTab=story on a PR with no story reads as Overview, derived.
    expect(pd).toMatch(/tab === 'story' && pr != null && !storyTabVisible/);
  });
  it('mounts the one story body', () => {
    const tab = read('components/pr/PrStoryTab.tsx');
    expect(tab).toMatch(/<StoryViewBody key=\{current\.ident\}/);
    expect(tab).toMatch(/useOpenStory\(\)/);
    // The "Open story" menu item stays.
    expect(pd).toMatch(/label: 'Open story'/);
  });
});

describe('the AI Review tab wide layout', () => {
  const tab = read('components/ClaudeReviewTab.tsx');
  it('mounts the shared rail layout', () => {
    expect(tab).toMatch(/<RailLayout config=\{REVIEW_RAIL\} oneColumn=\{oneColumn\}>/);
    expect(read('components/Ticket/StoryLayout.tsx')).toMatch(/<RailLayout config=\{embedded \? STORY_RAIL_EMBEDDED : STORY_RAIL\} oneColumn=\{oneColumn\}>/);
  });
  it('actions and post render in place when narrow; status, counts and nav are rail-only', () => {
    expect(tab).toMatch(/<RailPiece slot="actions" inline>/);
    expect(tab).toMatch(/<RailPiece slot="run" inline>/);
    expect(tab).toMatch(/<RailPiece slot="post" inline>/);
    expect(tab).toMatch(/<RailPiece slot="status">/);
    expect(tab).toMatch(/<RailPiece slot="counts">/);
    expect(tab).toMatch(/<RailPiece slot="nav">/);
  });
  it('the design spans the rail, and the run button keeps its AiRunGate', () => {
    expect(tab).toMatch(/<RailWide>\s*<ClaudeReviewDiagramsSection/);
    expect(tab).toMatch(/<AiRunGate kind="review" auth=\{data\?\.auth\} anyProvider provider=\{modelPick\.chosen\.provider\}>/);
  });
  it('every section the nav lists is marked where it renders', () => {
    const marks: Record<string, string> = {
      previous: 'components/ClaudeReviewFollowUp.tsx',
      threads: 'components/ClaudeReviewThreads.tsx',
      stories: 'components/TicketCoverage.tsx',
      ci: 'components/CiCheckSection.tsx',
      sonar: 'components/ClaudeReviewSonar.tsx',
      refs: 'components/DocReferences.tsx',
      design: 'components/ClaudeReviewDiagrams.tsx',
      chat: 'components/ClaudeReviewChat.tsx',
    };
    for (const [id, file] of Object.entries(marks)) expect(read(file)).toContain(`section="${id}"`);
    expect(tab).toContain('section="review"');
    expect(tab).toContain('section="findings"');
  });
});
