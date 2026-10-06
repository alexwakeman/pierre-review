import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  TICKET_REVIEW_MAX_PRS,
  parseTicketIdent,
  storedList,
  type ClaudeReviewTicket,
  type TicketReviewRefusal,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { getAgenticProviders } from '../plugin-providers.js';
import { fetchPrDiff, stripNoiseFromDiff, splitDiffByFile } from '../post-review.js';
import { isNoiseFile } from '../prepare.js';
import { prepPeerWorktrees, type PeerCheckout } from '../clone-manager.js';
import { readLiveMembers, ticketHash, type LiveMember } from './fingerprint.js';
import type { LegacyStoryFinding } from './prompts.js';

// THE TICKET REVIEW'S INPUTS — who is on the ticket, what the ticket says, and what each member
// changed. Everything here is the SERVER's answer, read before any model runs:
//
//   members   the plugin's `ticketMembers` (a Jira ticket: any workspace of the account, the same
//             site) or the one PR of a pasted ('manual:') story; then the synced `pull_requests`
//             decide open / merged, and a closed-but-unmerged PR is dropped (readLiveMembers).
//   story     a Jira ticket's text: the freshest stored row across the members (`jiraStoryFor`,
//             the ONE story every caller hashes); a pasted story's from the run's own snapshot.
//   refusals  no story → no_ticket; no open or merged PR → no_members; more than
//             TICKET_REVIEW_MAX_PRS → too_many_prs (the count is stored and shown, never sampled).
//
// The diffs and worktrees are read per member in parallel; a member whose worktree cannot be
// prepared stays in the run marked `checked_out = false` (its criteria read `unclear`, never
// `not_met` — reconcile.ts), and a run where NO member could be checked out refuses
// `peer_unreadable`.

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type TicketInputs =
  | { ok: true; ticket: ClaudeReviewTicket; ticketHash: string; members: LiveMember[] }
  | { ok: false; reason: TicketReviewRefusal; prCount: number | null; ticket: ClaudeReviewTicket | null };

/**
 * THE story of a Jira ident — ONE answer whoever asks (the run, the sweeper, the states routes), so
 * a stored fingerprint and a live one hash the same text. The plugin's `ticketStory` (the freshest
 * stored row across every PR on the ticket); an older plugin without it: the newest `fetchedAt`
 * among the members' `ticketsForPr` answers, ties to the lowest prId. ⚠ Never "the first member
 * that has it": the worker refreshes OPEN PRs only, so a merged member keeps the text it merged
 * with, and callers passing members in different orders hashed different stories.
 */
export async function jiraStoryFor(
  accountId: number,
  ident: string,
  prIds: readonly number[],
): Promise<ClaudeReviewTicket | null> {
  const { ticketStory, ticketsForPr } = getAgenticProviders();
  if (ticketStory) {
    try {
      return await ticketStory(accountId, ident);
    } catch {
      return null;
    }
  }
  if (!ticketsForPr) return null;
  let best: ClaudeReviewTicket | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const prId of [...new Set(prIds)].sort((a, b) => a - b)) {
    try {
      const hit = (await ticketsForPr(accountId, prId)).find((t) => t.ident === ident);
      if (!hit) continue;
      const ms = hit.ticket.fetchedAt ? Date.parse(hit.ticket.fetchedAt) : Number.NaN;
      const at = Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
      if (best == null || at > bestMs) {
        best = hit.ticket;
        bestMs = at;
      }
    } catch {
      /* "nothing known" — try the next PR */
    }
  }
  return best;
}

/** The PR ids the plugin lists on a Jira ticket ([] when unknown or no plugin). */
export async function jiraMemberIds(accountId: number, ident: string): Promise<number[]> {
  const ticketMembers = getAgenticProviders().ticketMembers;
  if (!ticketMembers) return [];
  try {
    return [...new Set((await ticketMembers(accountId, ident)).map((m) => m.prId))];
  } catch {
    return [];
  }
}

/**
 * Who is on the ticket and what it says, with the refusals applied. `manualTicket` is the run's
 * stored snapshot (a pasted story); `originPrId` the PR that started it.
 */
export async function resolveTicketInputs(
  ctx: AgentContext,
  accountId: number,
  ident: string,
  opts: { originPrId: number | null; manualTicket: ClaudeReviewTicket | null },
): Promise<TicketInputs> {
  const parsed = parseTicketIdent(ident);
  if (parsed == null) return { ok: false, reason: 'no_ticket', prCount: null, ticket: null };
  let ticket: ClaudeReviewTicket | null;
  let memberIds: number[];
  if (parsed.kind === 'manual') {
    ticket = opts.manualTicket;
    memberIds = [parsed.prId];
  } else {
    memberIds = await jiraMemberIds(accountId, ident);
    ticket = await jiraStoryFor(accountId, ident, opts.originPrId != null ? [opts.originPrId, ...memberIds] : memberIds);
  }
  if (ticket == null) return { ok: false, reason: 'no_ticket', prCount: null, ticket: null };
  const members = await readLiveMembers(ctx, accountId, memberIds);
  if (members.length === 0) return { ok: false, reason: 'no_members', prCount: 0, ticket };
  if (members.length > TICKET_REVIEW_MAX_PRS) {
    return { ok: false, reason: 'too_many_prs', prCount: members.length, ticket };
  }
  return { ok: true, ticket, ticketHash: ticketHash(ticket), members };
}

export interface MemberRepo {
  owner: string;
  name: string;
  // The repo's default branch (synced), or null = the remote's HEAD.
  defaultBranch: string | null;
}

/** owner/name (+ default branch) per member (this account's repos only), keyed by prId. */
export async function memberRepos(
  ctx: AgentContext,
  accountId: number,
  members: readonly LiveMember[],
): Promise<Map<number, MemberRepo>> {
  const out = new Map<number, MemberRepo>();
  const repoIds = [...new Set(members.map((m) => m.repoId))];
  if (repoIds.length === 0) return out;
  const r = s(ctx).repos;
  const rows = (await ctx.db
    .select({
      id: r.id,
      owner: r.owner,
      name: r.name,
      defaultBranch: r.defaultBranch,
      defaultBranchName: r.defaultBranchName,
    })
    .from(r)
    .where(and(eq(r.accountId, accountId), inArray(r.id, repoIds)))
    .execute()) as Array<{
    id: number;
    owner: string;
    name: string;
    defaultBranch: string | null;
    defaultBranchName: string | null;
  }>;
  const byRepo = new Map(rows.map((x) => [x.id, x]));
  for (const m of members) {
    const repo = byRepo.get(m.repoId);
    if (repo) {
      out.set(m.prId, {
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch || repo.defaultBranchName || null,
      });
    }
  }
  return out;
}

/** The workspace a PR's repo sits in (the start route's cap/switch workspace), or null. */
export async function workspaceOfPr(ctx: AgentContext, accountId: number, prId: number): Promise<number | null> {
  const { pullRequests: pr, workspaceRepos: wr } = s(ctx);
  const rows = (await ctx.db
    .select({ workspaceId: wr.workspaceId })
    .from(pr)
    .innerJoin(wr, and(eq(wr.repoId, pr.repoId), eq(wr.accountId, pr.accountId)))
    .where(and(eq(pr.id, prId), eq(pr.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ workspaceId: number }>;
  return rows[0]?.workspaceId ?? null;
}

export interface MemberDiff {
  // Noise-stripped; null when it could not be read.
  diff: string | null;
  changedFiles: string[];
  // The lock / generated files the strip removed ([] when unread).
  noiseFiles: string[];
}

/** Each member's diff via the gh CLI, noise-stripped, in parallel. A failure costs that diff only. */
export async function fetchMemberDiffs(
  members: ReadonlyArray<{ prId: number; owner: string; name: string; number: number }>,
  fetchDiff: (owner: string, name: string, n: number) => Promise<string> = fetchPrDiff,
): Promise<Map<number, MemberDiff>> {
  const out = new Map<number, MemberDiff>();
  await Promise.all(
    members.map(async (m) => {
      try {
        const { diff, excluded } = stripNoiseFromDiff(await fetchDiff(m.owner, m.name, m.number), isNoiseFile);
        out.set(m.prId, { diff, changedFiles: splitDiffByFile(diff).map((f) => f.path), noiseFiles: excluded });
      } catch {
        out.set(m.prId, { diff: null, changedFiles: [], noiseFiles: [] });
      }
    }),
  );
  return out;
}

/** Read-only worktrees for every member, at its synced head (a merged PR: its final head). */
export async function prepareMemberWorktrees(
  members: ReadonlyArray<{ prId: number; owner: string; name: string; number: number; headSha: string }>,
): Promise<{ byPr: Map<number, PeerCheckout>; cleanup: () => Promise<void> }> {
  const withHead = members.filter((m) => m.headSha !== '');
  const { peers, cleanup } = await prepPeerWorktrees(
    withHead.map((m) => ({ owner: m.owner, name: m.name, number: m.number, headSha: m.headSha })),
  );
  const byPr = new Map<number, PeerCheckout>();
  withHead.forEach((m, i) => byPr.set(m.prId, peers[i]!));
  return { byPr, cleanup };
}

/**
 * The OPEN story items older single-PR reviews left on the members (legacy `claude_review_findings`
 * story rows, read-only): from each member's LATEST succeeded PR review, the story findings of THIS
 * ticket (matched by Jira key, else by title). Shown to the ticket run as "earlier single-PR
 * verdicts" so it can say another PR now delivers one. Never copied into the new run.
 */
export async function loadLegacyStoryFindings(
  ctx: AgentContext,
  accountId: number,
  prIds: readonly number[],
  ticket: Pick<ClaudeReviewTicket, 'key' | 'title'>,
): Promise<LegacyStoryFinding[]> {
  if (prIds.length === 0) return [];
  const { claudeReviews: cr, claudeReviewFindings: crf } = s(ctx);
  const runs = (await ctx.db
    .select({ id: cr.id, prId: cr.prId, ticket: cr.ticket })
    .from(cr)
    // ⚠ The latest succeeded run that CHECKED A STORY, not the latest run: a PR review written since
    // the split stores no story, so "latest run" would forget every legacy verdict the moment the PR
    // was re-reviewed.
    .where(
      and(
        eq(cr.accountId, accountId),
        inArray(cr.prId, [...new Set(prIds)]),
        eq(cr.status, 'succeeded'),
        isNotNull(cr.ticket),
      ),
    )
    .orderBy(desc(cr.id))
    .execute()) as Array<{ id: number; prId: number; ticket: ClaudeReviewTicket | ClaudeReviewTicket[] | null }>;
  const latest = new Map<number, (typeof runs)[number]>();
  for (const r of runs) if (!latest.has(r.prId)) latest.set(r.prId, r);
  const fold = (v: string | null | undefined): string => (v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const same = (t: ClaudeReviewTicket): boolean =>
    ticket.key ? fold(t.key) === fold(ticket.key) : !!ticket.title && fold(t.title) === fold(ticket.title);
  const wanted = new Map<number, { prId: number; indexes: Set<number> }>();
  for (const r of latest.values()) {
    const indexes = new Set<number>();
    storedList(r.ticket).forEach((t, i) => {
      if (same(t)) indexes.add(i);
    });
    if (indexes.size > 0) wanted.set(r.id, { prId: r.prId, indexes });
  }
  if (wanted.size === 0) return [];
  const rows = (await ctx.db
    .select({
      reviewId: crf.reviewId,
      title: crf.title,
      body: crf.body,
      storyIndex: crf.storyIndex,
      storyRef: crf.storyRef,
    })
    .from(crf)
    .where(and(inArray(crf.reviewId, [...wanted.keys()]), isNotNull(crf.storyRef)))
    .execute()) as Array<{ reviewId: number; title: string; body: string; storyIndex: number | null; storyRef: string }>;
  const out: LegacyStoryFinding[] = [];
  for (const f of rows) {
    const w = wanted.get(f.reviewId);
    if (!w || f.storyIndex == null || !w.indexes.has(f.storyIndex)) continue;
    out.push({ prId: w.prId, ref: f.storyRef, title: f.title, body: f.body });
  }
  return out;
}
