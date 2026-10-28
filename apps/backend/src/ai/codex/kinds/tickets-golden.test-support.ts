// The prompts of Phase 3 stream (c), rendered from FIXED inputs. `tickets.test.ts` compares the
// CLAUDE render against `__fixtures__/tickets-claude-prompts.json`, which was written from the code
// BEFORE the Codex port — so the port provably moved no Claude byte.
import { planCiReview, selectCiFailures, type CiPlan } from '../../../review/claude-review/ci-failures.js';
import * as ci from '../../../review/ci-review/prompts.js';
import * as sda from '../../../review/story-docs/agent.js';
import * as sd from '../../../review/story-docs/prompts.js';
import * as pp from '../../../review/ticket-review/prepass.js';
import * as tr from '../../../review/ticket-review/prompts.js';
import type { PromptTools } from '../../prompt-tools.js';

const member = (i: number, over: Partial<tr.PromptMember> = {}): tr.PromptMember => ({
  ref: `PR${i}`,
  prId: i * 10,
  repo: `acme/r${i}`,
  number: i,
  title: `Title ${i}`,
  state: 'open',
  headSha: 'abcdef1234567890',
  checkedOut: true,
  worktreePath: `/tmp/wt/${i}`,
  changedFiles: [`src/f${i}.ts`],
  diff: `diff --git a/src/f${i}.ts b/src/f${i}.ts\n+x`,
  omittedFiles: [],
  ...over,
});

const HEAD = 'a'.repeat(40);
function ciPlan(): CiPlan {
  const c = { name: 'build', state: 'failure' as const, url: null, runId: 1, jobId: 1 };
  return planCiReview(selectCiFailures([c], 'FAILURE', HEAD, null), [
    { check: { checkName: c.name, jobId: 1, url: null }, step: 'Compile', log: { text: 'Error: x', windowTruncated: false } },
  ]);
}

/** Every prompt of the stream, by name, rendered for `t`'s provider. */
export function ticketsPrompts(t: PromptTools): Record<string, string> {
  const ticket = { key: 'BMD-1', title: 'Export', description: 'd', acceptanceCriteria: '- CSV' };
  const args = {
    ticket,
    members: [member(1), member(2, { checkedOut: false, worktreePath: null })],
    prior: null,
    legacy: [{ prId: 10, ref: 'AC1', title: 'CSV not met', body: 'no' }],
    nonce: 'n0nce',
  };
  const story = {
    story: { title: 't', description: 'd', acceptanceCriteria: '' },
    criteriaSource: 'derived' as const,
    criteria: [],
    shortlist: [
      { path: 'refunds/sections/01-a.md', workspaceId: 1, anchor: null, docSlug: 'refunds', docTitle: 'Refunds', sectionTitle: 'A', reason: 'why' },
    ],
    sections: [{ path: 'refunds/sections/01-a.md', text: 'Refunds are paid within 14 days.', cut: false }],
    libraryDir: '/lib',
    nonce: 'abc123',
  };
  const storyCut = { ...story, sections: [{ path: 'refunds/sections/01-a.md', text: 'Refunds are paid within\n[…cut]', cut: true }] };
  const pr = {
    repoFullName: 'acme/api',
    number: 7,
    title: 'Add things',
    headSha: HEAD,
    worktreePath: '/tmp/wt/a',
    changedFiles: ['src/a.ts'],
    diff: 'diff --git a/src/a.ts b/src/a.ts\n+x',
  };
  const prep = { prId: 1, repo: 'acme/r1', number: 1, title: 'T', diff: 'diff --git a/x b/x\n+1' };
  const alignment = { criteriaSource: 'derived', criteria: [] } as unknown as Parameters<typeof sda.judgeSubmission>[2];
  const j = sda.judgeSubmission({}, 1, alignment, t);
  const jLast = sda.judgeSubmission({}, sda.MAX_SUBMIT_ATTEMPTS, alignment, t);
  // Ticket comments (docs/TRACKERS.md § Ticket comments), oldest first, in their own fence.
  const comments = [
    { id: 'c1', author: 'Dana Lee', createdAt: '2026-03-04T10:00:00.000Z', updatedAt: null, body: 'Drop the PDF export; CSV only.' },
    { id: 'c2', author: 'Sam Ito', createdAt: '2026-03-05T09:30:00.000Z', updatedAt: null, body: 'Agreed.' },
  ];
  return {
    ticketSystem: tr.ticketReviewSystemPrompt(null, t),
    ticketSystemDocs: tr.ticketReviewSystemPrompt('/lib/ws', t),
    ticketUser: tr.buildTicketReviewPrompt(args, t),
    ticketUserComments: tr.buildTicketReviewPrompt({ ...args, comments }, t),
    cardSystem: pp.ticketCardSystemPrompt(t),
    cardUser: pp.buildPrepassPrompt(prep, ticket, 'zz', t),
    ciSystem: ci.ciReviewSystemPrompt(t),
    ciUser: ci.buildCiReviewPrompt({ pr, plan: ciPlan(), nonce: 'n0nce' }, t),
    storySystem: sd.storyDocsSystemPrompt(t),
    storyUser: sd.buildStoryDocsPrompt(story, t),
    storyUserCut: sd.buildStoryDocsPrompt(storyCut, t),
    storyUserComments: sd.buildStoryDocsPrompt({ ...story, comments }, t),
    storyRefusal: 'reply' in j ? j.reply : '',
    storyRefusalLast: 'reply' in jLast ? jLast.reply : '',
  };
}
