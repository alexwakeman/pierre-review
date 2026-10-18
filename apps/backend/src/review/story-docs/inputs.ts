import { createHash } from 'node:crypto';
import {
  STORY_DOCS_CRITERIA_MAX,
  STORY_DOCS_CRITERION_TEXT_MAX,
  parseTicketIdent,
  type ClaudeReviewTicket,
  type StoryDocsCriteriaSource,
  type StoryDocsCriterion,
  type TicketStoryResponse,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

// THE STORY A DOCS CHECK READS — resolved EXACTLY as the Story section shows it (docs/REFERENCE-DOCS.md
// § Check a story against the docs), so the per-criterion notes attach to the list the reader sees:
//
//   CRITERIA (lib/ticketStory.ts `storySummaryOf`, same order):
//     1. the latest SUCCEEDED ticket review's criteria, in array order (the SPA's AC1, AC2, …) — even
//        an empty list wins, because the section then shows that review, not the brief;
//     2. else the CURRENT sprint brief's numbered criteria;
//     3. else none: Claude works them out from the description (stored with the run).
//   STORY TEXT (the "As written" block's order): the tracker's stored story (`jiraStoryFor`), else the
//   latest succeeded ticket review's ticket snapshot, else the sprint read's stored text.
//
// DB + disk only — no tracker call, no model. Every source is a SEAM so the fold is tested on a fake.

export interface StoryText {
  title: string | null;
  description: string;
  acceptanceCriteria: string;
}

export interface StoryDocsInputs {
  ident: string;
  ticketKey: string | null;
  story: StoryText;
  criteriaSource: StoryDocsCriteriaSource;
  criteria: StoryDocsCriterion[];
  storyHash: string;
  criteriaHash: string;
  /** No story text and no criteria: the POST refuses `no_story`. */
  empty: boolean;
}

export interface LatestTicketReview {
  id: number;
  criteria: string[];
}

export interface StoryDocsInputSeams {
  latestTicketReview(ctx: AgentContext, accountId: number, ident: string): Promise<LatestTicketReview | null>;
  ticketReviewTicket(ctx: AgentContext, accountId: number, id: number): Promise<ClaudeReviewTicket | null>;
  trackerStory(accountId: number, ident: string): Promise<ClaudeReviewTicket | null>;
  sprintStory(accountId: number, workspaceId: number, ident: string): Promise<TicketStoryResponse | null>;
}

export const defaultInputSeams: StoryDocsInputSeams = {
  async latestTicketReview(ctx, accountId, ident) {
    const { getTicketStateInputs } = await import('../ticket-review/persist.js');
    const latest = (await getTicketStateInputs(ctx, accountId, [ident])).get(ident)?.latest ?? null;
    if (latest == null) return null;
    return { id: latest.id, criteria: (latest.assessment?.criteria ?? []).map((c) => c.text) };
  },
  async ticketReviewTicket(ctx, accountId, id) {
    const { getTicketReviewById } = await import('../ticket-review/persist.js');
    return (await getTicketReviewById(ctx, accountId, id))?.ticket ?? null;
  },
  async trackerStory(accountId, ident) {
    const { jiraStoryFor } = await import('../ticket-review/prepare.js');
    return jiraStoryFor(accountId, ident);
  },
  async sprintStory(accountId, workspaceId, ident) {
    const { getTicketStory } = await import('../../db/sprint-graph.js');
    return getTicketStory(accountId, workspaceId, ident, { aiEnabled: true });
  },
};

const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export function storyHashOf(story: StoryText): string {
  return sha([norm(story.title), norm(story.description), norm(story.acceptanceCriteria)].join('|'));
}

/** The criteria list's hash. A derived list is OUTPUT, never input, so it hashes the source alone. */
export function criteriaHashOf(source: StoryDocsCriteriaSource, criteria: readonly StoryDocsCriterion[]): string {
  if (source === 'derived') return sha('derived');
  return sha([source, ...criteria.map((c) => `${c.n}:${norm(c.text)}`)].join('\n'));
}

const clipText = (s: string): string => {
  const t = norm(s);
  return t.length <= STORY_DOCS_CRITERION_TEXT_MAX ? t : `${t.slice(0, STORY_DOCS_CRITERION_TEXT_MAX - 1).trimEnd()}…`;
};

const clipCriteria = (list: readonly StoryDocsCriterion[]): StoryDocsCriterion[] =>
  list.slice(0, STORY_DOCS_CRITERIA_MAX).map((c) => ({ n: c.n, text: clipText(c.text) }));

const fromTicket = (t: ClaudeReviewTicket | null | undefined): StoryText | null => {
  if (t == null) return null;
  const s = { title: t.title ?? null, description: t.description ?? '', acceptanceCriteria: t.acceptanceCriteria ?? '' };
  return norm(s.title) === '' && norm(s.description) === '' && norm(s.acceptanceCriteria) === '' ? null : s;
};

/** null ⇒ not a tracker ticket (the route's 400). */
export async function resolveStoryDocsInputs(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
  ident: string,
  seams: StoryDocsInputSeams = defaultInputSeams,
): Promise<StoryDocsInputs | null> {
  const parsed = parseTicketIdent(ident);
  if (parsed == null || parsed.kind === 'manual') return null;

  const review = await seams.latestTicketReview(ctx, accountId, ident).catch(() => null);
  // The sprint read is needed for the brief (no review) and maybe for the text: read it at most once.
  let sprint: TicketStoryResponse | null | undefined;
  const sprintStory = async (): Promise<TicketStoryResponse | null> => {
    if (sprint === undefined) sprint = await seams.sprintStory(accountId, workspaceId, ident).catch(() => null);
    return sprint;
  };

  let criteriaSource: StoryDocsCriteriaSource;
  let criteria: StoryDocsCriterion[];
  if (review != null) {
    criteriaSource = 'ticket_review';
    criteria = clipCriteria(review.criteria.map((text, i) => ({ n: i + 1, text })));
  } else {
    const s = await sprintStory();
    if (s?.briefState === 'current' && s.brief != null) {
      criteriaSource = 'brief';
      criteria = clipCriteria(s.brief.criteria);
    } else {
      criteriaSource = 'derived';
      criteria = [];
    }
  }

  let story = fromTicket(await seams.trackerStory(accountId, ident).catch(() => null));
  if (story == null && review != null) story = fromTicket(await seams.ticketReviewTicket(ctx, accountId, review.id).catch(() => null));
  if (story == null) {
    const s = await sprintStory();
    if (s?.story != null) {
      const t = { title: s.ticket?.title ?? null, description: s.story.description, acceptanceCriteria: s.story.acceptanceCriteria };
      if (norm(t.description) !== '' || norm(t.acceptanceCriteria) !== '' || norm(t.title) !== '') story = t;
    }
  }
  const text: StoryText = story ?? { title: null, description: '', acceptanceCriteria: '' };
  return {
    ident,
    ticketKey: parsed.key,
    story: text,
    criteriaSource,
    criteria,
    storyHash: storyHashOf(text),
    criteriaHash: criteriaHashOf(criteriaSource, criteria),
    // A title alone is not enough to check against anything when there are no criteria either.
    empty: criteria.length === 0 && norm(text.description) === '' && norm(text.acceptanceCriteria) === '',
  };
}
