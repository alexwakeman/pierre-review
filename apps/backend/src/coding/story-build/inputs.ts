import type { ClaudeReviewTicket, StoryDocsCriteriaSource, StoryDocsCriterion, TicketComment } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { defaultInputSeams, resolveStoryDocsInputs, type StoryDocsInputSeams, type StoryText } from '../../review/story-docs/inputs.js';
import type { StoryBuildSeed } from './persist.js';

// THE STORY A BUILD STARTS FROM ("Implement story", docs/STORY-BUILD.md § Inputs). Resolved EXACTLY as
// the docs check resolves it (`review/story-docs/inputs.ts resolveStoryDocsInputs` — the same criteria
// order the story view numbers AC1, AC2, …: the latest succeeded ticket check's, else the current
// brief's, else none and the planner works from the text), plus what only a build needs:
//
//   ticket PRs   the tracker's members of the ticket, read live from `pull_requests` (open + merged;
//                closed-unmerged dropped) — the gap fold and the candidates start from them;
//   cards        the contribution cards stored for those PRs at their CURRENT heads ("already delivered");
//   url          the ticket's browse URL (stored, never fetched).
//
// The result is FROZEN into `story_builds.seed_json` (`StoryBuildSeed`) at assess time, so every later
// pass (each chat re-plan, the build) reads the SAME story the plan was made from. Everything here is
// UNTRUSTED text (the ticket, its comments, other people's PR cards): fenced with the pass's nonce in
// every prompt. DB + disk only — no tracker call, no model. Every source is a SEAM (tests use fakes).
//
// ⚠ `tracker/runtime.ts` opens the DB at import: every tracker-side import here is LAZY.

export interface StoryBuildTicketPr {
  prId: number;
  repoId: number;
  number: number;
  title: string;
  headSha: string;
  state: 'open' | 'merged';
  /** The PR's source branch (the stacking base), or null when not synced. */
  headRefName: string | null;
  /** The PR's author is the reader (owner decision 1: only the reader's own open PR is stacked on). */
  byReader: boolean;
}

export interface StoryBuildInputs {
  ident: string;
  ticketKey: string;
  title: string | null;
  url: string | null;
  story: StoryText;
  criteriaSource: StoryDocsCriteriaSource;
  criteria: StoryDocsCriterion[];
  comments: TicketComment[];
  storyHash: string;
  /** No story text and no criteria: the start refuses `NoStory`. */
  empty: boolean;
  ticketPrs: StoryBuildTicketPr[];
  cards: StoryBuildSeed['cards'];
}

export interface StoryBuildInputSeams {
  story?: StoryDocsInputSeams;
  /** The ticket's PR ids (the tracker's members). */
  ticketPrIds(ctx: AgentContext, accountId: number, ident: string): Promise<number[]>;
  /** The live rows of those PRs (open + merged only), with the reader-authorship flag. */
  ticketPrs(ctx: AgentContext, accountId: number, prIds: readonly number[]): Promise<StoryBuildTicketPr[]>;
  /** The stored contribution cards at the PRs' current heads, as prompt text. */
  cards(ctx: AgentContext, accountId: number, prs: readonly StoryBuildTicketPr[]): Promise<StoryBuildSeed['cards']>;
  /** The ticket's stored browse URL, or null. */
  url(ctx: AgentContext, accountId: number, workspaceId: number, ident: string): Promise<string | null>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const S = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export const defaultStoryBuildInputSeams: StoryBuildInputSeams = {
  async ticketPrIds(_ctx, accountId, ident) {
    const { jiraMemberIds } = await import('../../review/ticket-review/prepare.js');
    return jiraMemberIds(accountId, ident);
  },
  async ticketPrs(ctx, accountId, prIds) {
    const ids = [...new Set(prIds)];
    if (ids.length === 0) return [];
    const { and, eq, inArray } = await import('drizzle-orm');
    const { pullRequests: pr, users, accounts } = S(ctx);
    const me = (
      (await ctx.db
        .select({ login: accounts.githubLogin, node: accounts.githubUserId })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1)
        .execute()) as Array<{ login: string; node: string }>
    )[0];
    const rows = (await ctx.db
      .select({
        id: pr.id,
        repoId: pr.repoId,
        number: pr.number,
        title: pr.title,
        headSha: pr.headSha,
        state: pr.state,
        headRefName: pr.headRefName,
        authorLogin: users.githubLogin,
        authorNode: users.githubNodeId,
      })
      .from(pr)
      .leftJoin(users, eq(users.id, pr.authorId))
      .where(and(eq(pr.accountId, accountId), inArray(pr.id, ids)))
      .execute()) as Array<{
      id: number;
      repoId: number;
      number: number;
      title: string;
      headSha: string | null;
      state: string;
      headRefName: string | null;
      authorLogin: string | null;
      authorNode: string | null;
    }>;
    return rows
      .filter((r) => r.state === 'open' || r.state === 'merged')
      .map((r) => ({
        prId: r.id,
        repoId: r.repoId,
        number: r.number,
        title: r.title,
        headSha: r.headSha ?? '',
        state: r.state as 'open' | 'merged',
        headRefName: r.headRefName ?? null,
        byReader:
          me != null &&
          ((r.authorNode != null && r.authorNode === me.node) ||
            (r.authorLogin != null && r.authorLogin.toLowerCase() === me.login.toLowerCase())),
      }))
      .sort((a, b) => a.prId - b.prId);
  },
  async cards(ctx, accountId, prs) {
    if (prs.length === 0) return [];
    const { readCardsAt, cardText } = await import('../../review/ticket-review/cards.js');
    const got = await readCardsAt(ctx, accountId, prs.map((p) => ({ prId: p.prId, headSha: p.headSha })));
    return prs
      .filter((p) => got.has(p.prId))
      .map((p) => ({ prId: p.prId, repoId: p.repoId, number: p.number, text: cardText(got.get(p.prId)!.card) }));
  },
  async url(_ctx, accountId, workspaceId, ident) {
    const tracked: ClaudeReviewTicket | null = await defaultInputSeams.trackerStory(accountId, ident).catch(() => null);
    if (tracked?.url) return tracked.url;
    const sprint = await defaultInputSeams.sprintStory(accountId, workspaceId, ident).catch(() => null);
    return sprint?.ticket?.url ?? null;
  },
};

/** null ⇒ not a tracker ticket (the route's 400). */
export async function resolveStoryBuildInputs(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
  ident: string,
  seams: StoryBuildInputSeams = defaultStoryBuildInputSeams,
): Promise<StoryBuildInputs | null> {
  const base = await resolveStoryDocsInputs(ctx, accountId, workspaceId, ident, seams.story ?? defaultInputSeams);
  if (base == null || base.ticketKey == null) return null;
  const prIds = await seams.ticketPrIds(ctx, accountId, ident).catch(() => []);
  const [ticketPrs, url] = await Promise.all([
    seams.ticketPrs(ctx, accountId, prIds).catch(() => []),
    seams.url(ctx, accountId, workspaceId, ident).catch(() => null),
  ]);
  const cards = await seams.cards(ctx, accountId, ticketPrs).catch(() => []);
  return {
    ident,
    ticketKey: base.ticketKey,
    title: base.story.title,
    url,
    story: base.story,
    criteriaSource: base.criteriaSource,
    criteria: base.criteria,
    comments: base.comments,
    storyHash: base.storyHash,
    empty: base.empty,
    ticketPrs,
    cards,
  };
}

/** The ticket's comments folded to plain text for the seed (TRACKERS § Ticket comments), or null. */
export async function commentsText(comments: readonly TicketComment[]): Promise<string | null> {
  if (comments.length === 0) return null;
  const { ticketCommentsBlock } = await import('../../review/ticket-review/prompts.js');
  const block = ticketCommentsBlock(comments);
  return block.body.trim() === '' ? null : block.body;
}

/** THE FROZEN SEED (`story_builds.seed_json`). Never on the wire. */
export async function seedOf(inputs: StoryBuildInputs): Promise<StoryBuildSeed> {
  const s = inputs.story;
  const text = [s.description.trim(), s.acceptanceCriteria.trim() !== '' ? `Acceptance criteria:\n${s.acceptanceCriteria.trim()}` : '']
    .filter(Boolean)
    .join('\n\n');
  return {
    version: 1,
    story: { key: inputs.ticketKey, title: s.title ?? inputs.title ?? '', text, url: inputs.url },
    criteria: inputs.criteria,
    comments: await commentsText(inputs.comments),
    cards: inputs.cards,
  };
}
