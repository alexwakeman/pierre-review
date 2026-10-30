// THE PLAN PASS'S PROMPTS (prompts.ts). Pinned:
//   1. ⚠ CLAUDE'S TEXT IS A GOLDEN: every prompt this file renders for Claude equals
//      __fixtures__/story-plan-prompts.json byte for byte (a wording change is a deliberate fixture update:
//      STORY_PLAN_GOLDEN_WRITE=1 rewrites it);
//   2. CODEX'S WORDS: no Claude tool name, no `submit_story_plan` call — the workspace tools by name and
//      the final-answer sentence;
//   3. FENCES: every untrusted text sits inside a fence with the pass's nonce; the reader's chat is the ONE
//      steering block, the model's own replies context only; the docs blocks (WP3) are passed through.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StoryBuildCandidate, StoryBuildCoverage, StoryBuildPlan } from '@pierre-review/shared';
import type { StoryBuildSeed } from './persist.js';
import { buildStoryPlanSystemPrompt, buildStoryPlanUserPrompt, reposMd, storyPlanUntrustedTexts } from './prompts.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'story-plan-prompts.json');
const NONCE = 'q7k2m9x4';

const SEED: StoryBuildSeed = {
  version: 1,
  story: { key: 'ACME-214', title: 'Refund by card', text: 'Customers can refund a paid order.\n\nAcceptance criteria:\n- Refund by card\n- Email a receipt', url: 'https://acme.atlassian.net/browse/ACME-214' },
  criteria: [
    { n: 1, text: 'Refund by card' },
    { n: 2, text: 'Email a receipt' },
  ],
  comments: 'Dana, 2026-10-01:\nOnly full refunds for now.',
  cards: [{ prId: 5, repoId: 2, number: 12, text: 'Adds the refunds table.' }],
};
const COVERAGE: StoryBuildCoverage = {
  state: 'checked',
  ticketReviewId: 9,
  checkedAt: '2026-10-01T00:00:00.000Z',
  criteria: [
    { ref: 'AC1', text: 'Refund by card', verdict: 'partly_met', coveredByPrIds: [] },
    { ref: 'AC2', text: 'Email a receipt', verdict: 'met', coveredByPrIds: [5] },
  ],
  missing: [{ ref: 'M1', text: 'An audit log line' }],
  existingPrs: [{ prId: 5, repoId: 2, number: 12, state: 'merged', headSha: 'abc' }],
  note: null,
};
const cand = (ref: string, repoId: number, fullName: string, extra: Partial<StoryBuildCandidate> = {}): StoryBuildCandidate => ({
  ref,
  repoId,
  fullName,
  source: 'picked',
  baseRef: 'main',
  baseSha: 'f00dfacecafe1234',
  stackedOnPrId: null,
  stackedOnPrNumber: null,
  baseNote: null,
  ...extra,
});
const CHECKOUTS = [
  { candidate: cand('R1', 1, 'acme/web'), path: '/clones/acme__web/.worktrees/a' },
  { candidate: cand('R2', 2, 'acme/api', { source: 'ticket_pr', baseRef: 'feat/refunds', stackedOnPrId: 6, stackedOnPrNumber: 13 }), path: '/clones/acme__api/.worktrees/b' },
  { candidate: cand('R3', 3, 'acme/infra'), path: null },
];
const PLAN: StoryBuildPlan = {
  revision: 1,
  summary: 'The API gains a refund endpoint. The web app calls it.',
  repos: [{ ref: 'R2', repoId: 2, why: 'The endpoint.', branchSlug: 'refunds', steps: [{ title: 'Add POST /refunds', files: ['src/refunds.ts'], change: 'Add it.', refs: ['AC1'] }], tests: [] }],
  readOnlyRepos: [],
  criteria: [
    { ref: 'AC1', how: 'planned', repo: 'R2', reason: null },
    { ref: 'M1', how: 'not_planned', repo: null, reason: 'Out of scope.' },
  ],
  risks: [],
};

function render(provider: 'claude' | 'codex'): Record<string, string> {
  return {
    system: buildStoryPlanSystemPrompt(provider),
    first: buildStoryPlanUserPrompt({ seed: SEED, coverage: COVERAGE, checkouts: CHECKOUTS, wantDiagram: true, nonce: NONCE, provider }),
    replan: buildStoryPlanUserPrompt({
      seed: { ...SEED, comments: null, cards: [] },
      coverage: { ...COVERAGE, state: 'none', note: "Couldn't check the existing PRs: building every criterion." },
      checkouts: CHECKOUTS.slice(0, 2),
      previous: PLAN,
      transcript: [
        { role: 'reader', text: 'Leave the audit log out.', revision: 1, at: '2026-10-30T10:00:00.000Z' },
        { role: 'claude', text: 'Dropped M1.', revision: 2, at: '2026-10-30T10:01:00.000Z' },
        { role: 'reader', text: 'Put the endpoint behind a flag.', revision: 2, at: '2026-10-30T10:02:00.000Z' },
      ],
      docs: { included: `---BEGIN DOCS POINTS THE READER INCLUDED ${NONCE}---\nD1 …\n---END DOCS POINTS THE READER INCLUDED ${NONCE}---`, superseded: '', pending: 0 },
      wantDiagram: false,
      nonce: NONCE,
      provider,
    }),
    noCriteria: buildStoryPlanUserPrompt({
      seed: { ...SEED, criteria: [], comments: null, cards: [] },
      coverage: { ...COVERAGE, state: 'none', criteria: [], missing: [], existingPrs: [] },
      checkouts: CHECKOUTS.slice(0, 1),
      wantDiagram: false,
      nonce: NONCE,
      provider,
    }),
    repos: reposMd(CHECKOUTS),
  };
}

describe('the plan prompts', () => {
  it("⚠ Claude: byte-for-byte the golden", () => {
    const now = render('claude');
    if (process.env.STORY_PLAN_GOLDEN_WRITE === '1') {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
    }
    expect(now).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });

  it("Codex: no Claude tool name and no submit call; the workspace tools and the final answer", () => {
    const all = Object.values(render('codex')).join('\n');
    expect(all).not.toMatch(/\bRead\b, Glob and Grep|submit_story_plan|\bBash\b/);
    expect(all).toContain('read_file');
    expect(all).toContain('give your final JSON answer');
    expect(render('codex').system).toContain('give your final answer: ONE JSON object matching the given schema');
  });

  it('fences every untrusted text with the nonce; the chat is steering, replies context', () => {
    const p = render('claude');
    expect(p.first).toContain(`---BEGIN TICKET ${NONCE}---\nTitle: Refund by card`);
    expect(p.first).toContain(`---BEGIN TICKET COMMENTS ${NONCE}---\nDana, 2026-10-01:`);
    expect(p.first).toContain(`---BEGIN ALREADY DONE ${NONCE}---\nAC2: Email a receipt`);
    expect(p.first).toContain(`---BEGIN EXISTING PR #12 ${NONCE}---\nAdds the refunds table.`);
    expect(p.first).toContain(`---BEGIN GAPS TO CLOSE ${NONCE}---\nAC1 (partly met): Refund by card\nM1 (asked for outside the criteria): An audit log line`);
    expect(p.first).toContain('R2 acme/api, built on top of open PR #13');
    expect(p.first).toContain('R3 acme/infra, built from main (could not be checked out, so it cannot change in this build)');
    expect(p.replan).toContain(`---BEGIN STEERING FROM THE PERSON RUNNING THIS BUILD ${NONCE}---\nPut the endpoint behind a flag.`);
    expect(p.replan).toContain(`---BEGIN YOUR EARLIER REPLY (context only) ${NONCE}---\nDropped M1.`);
    expect(p.replan).toContain(`---BEGIN PREVIOUS PLAN ${NONCE}---`);
    expect(p.replan).toContain('DOCS POINTS THE READER INCLUDED');
    expect(p.replan).toContain("Note: Couldn't check the existing PRs");
    expect(p.noCriteria).toContain("This ticket lists no acceptance criteria");
    const scanned = storyPlanUntrustedTexts({ seed: SEED, coverage: COVERAGE, previous: PLAN, transcript: [] });
    expect(scanned).toEqual(expect.arrayContaining(['Customers can refund a paid order.\n\nAcceptance criteria:\n- Refund by card\n- Email a receipt', 'Adds the refunds table.', 'An audit log line']));
  });
});
