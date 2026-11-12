import { and, eq, isNull } from 'drizzle-orm';
import {
  ticketReviewSeed,
  ticketUpdateBody,
  type BuildPlanRevision,
  type StoryBuildEndToEndTicket,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { getStoryBuildRow, listStoryBuildRepoRows, storyBuildRepoNames, updateStoryBuild } from './persist.js';
import { listPlanRows, listPlannedPrRows, toPlanRevision } from './plan-persist.js';

// BUILD END TO END — THE TICKET STEP (docs/STORY-BUILD.md § Build end to end). After the review loop of a
// build the reader started with "Build end to end" has opened its pull requests, Limn:
//
//   1. updates the Jira ticket from the APPROVED plan's `ticketUpdate` — the SAME diff rule (shared
//      `ticketUpdateBody`) and the SAME writer (tracker/ticket-update.ts `writeTicketUpdate`) as the build
//      tab's "Update ticket" button; only the fields that differ from the ticket as Limn holds it;
//   2. posts ONE comment on the ticket: the pull requests and what changed on the ticket, in plain English
//      for every reader (`postTicketComment`) — never the tool's name, the review rounds, the plan's
//      reasoning or its internal references (AC1, C2). ⚠ PR titles are the AGENT'S words: `wikiLabel`
//      escapes every character that could open a mention (`[~…]`) or a macro. Both run under the reader's
//      own Jira login (the workspace's tracker token). The status is never changed.
//
// ⚠ THE READER'S ONE PRESS IS THE CONSENT, and it is spent ONCE: `story_builds.e2e_ticket_claimed_at` is
// claimed (compare-and-set from NULL) BEFORE the first Jira write; a failure is recorded on
// `e2e_ticket_json` and NEVER retried. A failed update leaves the build tab's ticket step open, so the reader
// can still press "Update ticket"; a successful one (or no change to make) closes it (`ticket_review_done_at`).
// ⚠ Jira only (Limn's only ticket writer). Another tracker: recorded `skipped: 'not_jira'`, nothing written.
// ⚠ Never throws: the loop has already finished; this can only add to it.

/** What `runEndToEndTicketStep` needs from outside (tests replace them). */
export interface EndToEndDeps {
  now(): Date;
  /** One line in the build's session log. */
  notice(text: string): void;
  trackerIsJira(ctx: AgentContext, accountId: number, workspaceId: number): Promise<boolean>;
  currentTicket(
    ctx: AgentContext,
    accountId: number,
    workspaceId: number,
    ident: string,
  ): Promise<{ description: string; acceptanceCriteria: string; acLocation: Parameters<typeof ticketUpdateBody>[1]['acLocation'] } | null>;
  writeTicket(
    ctx: AgentContext,
    a: { accountId: number; workspaceId: number; ident: string; description: string | null; acceptanceCriteria: string | null },
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  comment(ctx: AgentContext, a: { accountId: number; workspaceId: number; ident: string; wiki: string }): Promise<{ ok: true } | { ok: false; message: string }>;
}

// LAZY: tracker/runtime.ts opens the database at import (CLAUDE.md § The agentic features).
const tracker = async () => {
  const [{ trackerContext }, upd, settings, ac] = await Promise.all([
    import('../../tracker/runtime.js'),
    import('../../tracker/ticket-update.js'),
    import('../../tracker/settings.js'),
    import('../../tracker/ac-location.js'),
  ]);
  return { tctx: trackerContext(), upd, settings, ac };
};

export function defaultEndToEndDeps(notice: (text: string) => void): EndToEndDeps {
  return {
    now: () => new Date(),
    notice,
    async trackerIsJira(_ctx, accountId, workspaceId) {
      const t = await tracker();
      return (await t.settings.readWorkspaceTrackerAccess(t.tctx, accountId, workspaceId)).issue.provider === 'jira';
    },
    async currentTicket(_ctx, accountId, workspaceId, ident) {
      const t = await tracker();
      const stored = await t.ac.storedTicketText(t.tctx, accountId, workspaceId, ident);
      return stored == null ? null : { description: stored.description, acceptanceCriteria: stored.acceptanceCriteria, acLocation: stored.acLocation };
    },
    async writeTicket(_ctx, a) {
      const t = await tracker();
      const out = await t.upd.writeTicketUpdate(t.tctx, a);
      return out.ok ? { ok: true } : { ok: false, message: out.message };
    },
    async comment(_ctx, a) {
      const t = await tracker();
      const out = await t.upd.postTicketComment(t.tctx, a);
      return out.ok ? { ok: true } : { ok: false, message: out.message };
    },
  };
}

/** A Jira wiki link label: the characters that would end or restyle the link are escaped. Pure. */
export function wikiLabel(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/([[\]|{}*_^~+?-])/g, '\\$1').trim();
}

export interface EndToEndCommentFacts {
  prs: Array<{ repo: string; number: number; url: string; title: string | null }>;
  /** The fields written; null when the plan proposed no change; 'failed' with the sentence. */
  ticket: { updated: Array<'description' | 'acceptanceCriteria'> } | { failed: string } | null;
}

// The plan's internal references (AC1, C2, P1, Q3) mean nothing to a reader of the ticket.
const INTERNAL_REF = /\s*[([]\s*(?:AC|C|P|Q)\d+(?:\s*[,/&]\s*(?:AC|C|P|Q)\d+)*\s*[)\]]/g;

/** A pull request title for the ticket's readers: internal references removed. Pure. */
export function plainTitle(title: string): string {
  return title.replace(INTERNAL_REF, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * THE COMMENT, in Jira wiki markup. Pure (end-to-end.test.ts). Written for EVERYONE who reads the
 * ticket, technical or not: the pull requests and what changed on the ticket, in plain English.
 * Never the tool's name, the review rounds, the plan's reasoning or its internal references.
 */
export function endToEndCommentWiki(f: EndToEndCommentFacts): string {
  const out: string[] = ['*Pull requests*'];
  if (f.prs.length === 0) out.push('None yet.');
  for (const p of f.prs) {
    const title = p.title != null ? plainTitle(p.title) : '';
    out.push(`* [${wikiLabel(`${p.repo}#${p.number}`)}|${p.url}]${title ? ` ${wikiLabel(title)}` : ''}`);
  }
  out.push('', '*What changed on this ticket*');
  const t = f.ticket;
  if (t == null || ('updated' in t && t.updated.length === 0)) {
    out.push('Nothing. The ticket stays as written.');
  } else if ('failed' in t) {
    out.push('Nothing. The ticket text could not be updated.');
  } else {
    const what = t.updated.map((x) => (x === 'description' ? 'description' : 'acceptance criteria')).join(' and ');
    out.push(`The ${what} ${t.updated.length === 1 && t.updated[0] === 'description' ? 'was' : 'were'} updated to match the work. The earlier version is in this ticket's history.`);
  }
  return out.join('\n');
}

/** Claim the one ticket step (compare-and-set from NULL). False ⇒ another run has it, or it already ran. */
async function claim(ctx: AgentContext, accountId: number, buildId: number, now: Date): Promise<boolean> {
  const b = ctx.schema.storyBuilds;
  const rows = (await ctx.db
    .update(b)
    .set({ e2eTicketClaimedAt: now })
    .where(and(eq(b.id, buildId), eq(b.accountId, accountId), eq(b.endToEnd, true), isNull(b.e2eTicketClaimedAt)))
    .returning({ id: b.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

/**
 * THE STEP. Called once the loop is `done` (loop/driver.ts → the `afterLoopDone` seam). Null when this is not
 * an end-to-end build or the step was already claimed; else what it did (also stored on the row).
 */
export async function runEndToEndTicketStep(
  ctx: AgentContext,
  accountId: number,
  buildId: number,
  deps: EndToEndDeps,
): Promise<StoryBuildEndToEndTicket | null> {
  try {
    const row = await getStoryBuildRow(ctx, accountId, buildId);
    if (row == null || row.endToEnd !== true || row.e2eTicketClaimedAt != null) return null;
    if (!(await claim(ctx, accountId, buildId, deps.now()))) return null;
    const result = await doStep(ctx, accountId, row, deps);
    await updateStoryBuild(ctx, accountId, buildId, {
      e2eTicketJson: result,
      // The tab's ticket step closes once Jira holds the plan's text (or there was none to write). A failed
      // update, or a tracker that is not Jira, leaves it open: "Update ticket" / the copy text is still there.
      ...(result.skipped == null && (result.error == null || result.updated.length > 0) ? { ticketReviewDoneAt: deps.now() } : {}),
    });
    deps.notice(noticeLine(result));
    return result;
  } catch (err) {
    ctx.log.warn({ err, buildId }, 'build end to end: the ticket step failed');
    return null;
  }
}

function noticeLine(r: StoryBuildEndToEndTicket): string {
  if (r.skipped === 'not_jira') return 'Limn did not update the ticket: it writes to Jira only.';
  const parts: string[] = [];
  if (r.updated.length > 0) parts.push('updated the ticket');
  if (r.commented) parts.push('commented on it');
  const did = parts.length > 0 ? `Limn ${parts.join(' and ')}.` : 'Limn made no change to the ticket.';
  return r.error != null ? `${did} ${r.error}` : did;
}

async function doStep(
  ctx: AgentContext,
  accountId: number,
  row: NonNullable<Awaited<ReturnType<typeof getStoryBuildRow>>>,
  deps: EndToEndDeps,
): Promise<StoryBuildEndToEndTicket> {
  const done = (r: Omit<StoryBuildEndToEndTicket, 'at'>): StoryBuildEndToEndTicket => ({ at: deps.now().toISOString(), ...r });
  if (!(await deps.trackerIsJira(ctx, accountId, row.workspaceId))) {
    return done({ updated: [], commented: false, skipped: 'not_jira', error: null });
  }
  const base = { accountId, workspaceId: row.workspaceId, ident: row.ident };

  // 1. The ticket text, from the APPROVED plan (the same diff rule as the button).
  const planRows = await listPlanRows(ctx, accountId, row.id);
  const approved = row.approvedPlanId != null ? planRows.find((p) => p.id === row.approvedPlanId) : undefined;
  const plan: BuildPlanRevision | null = approved ? toPlanRevision(approved) : null;
  const tu = plan?.ticketUpdate ?? null;
  let ticket: EndToEndCommentFacts['ticket'] = null;
  let error: string | null = null;
  if (tu != null) {
    const current = await deps.currentTicket(ctx, accountId, row.workspaceId, row.ident);
    if (current == null) {
      error = 'Limn holds no copy of this ticket, so it could not update it.';
      ticket = { failed: error };
    } else {
      const body = ticketUpdateBody(ticketReviewSeed(tu, current), current);
      const updated: Array<'description' | 'acceptanceCriteria'> = [];
      if (body.description != null) updated.push('description');
      if (body.acceptanceCriteria != null) updated.push('acceptanceCriteria');
      if (updated.length === 0) {
        ticket = { updated: [] };
      } else {
        const w = await deps.writeTicket(ctx, { ...base, description: body.description, acceptanceCriteria: body.acceptanceCriteria });
        if (w.ok) ticket = { updated };
        else {
          error = w.message;
          ticket = { failed: w.message };
        }
      }
    }
  }

  // 2. The comment: the pull requests and what changed on the ticket, in plain English.
  const [repoRows, prRows] = await Promise.all([listStoryBuildRepoRows(ctx, accountId, row.id), listPlannedPrRows(ctx, accountId, row.id)]);
  const opened = [
    ...prRows.filter((p) => p.pushedPrNumber != null && p.pushedPrUrl != null).map((p) => ({ repoId: p.repoId, number: p.pushedPrNumber!, url: p.pushedPrUrl!, title: p.prTitle ?? null })),
    ...(prRows.length === 0
      ? repoRows.filter((r) => r.pushedPrNumber != null && r.pushedPrUrl != null).map((r) => ({ repoId: r.repoId, number: r.pushedPrNumber!, url: r.pushedPrUrl!, title: r.prTitle ?? null }))
      : []),
  ];
  const names = await storyBuildRepoNames(ctx, accountId, [...new Set(opened.map((p) => p.repoId))]);
  const wiki = endToEndCommentWiki({
    prs: opened.map((p) => ({ repo: names.get(p.repoId) ?? `repo ${p.repoId}`, number: p.number, url: p.url, title: p.title })),
    ticket,
  });
  const c = await deps.comment(ctx, { ...base, wiki });
  if (!c.ok && error == null) error = c.message;
  return done({ updated: ticket != null && 'updated' in ticket ? ticket.updated : [], commented: c.ok, skipped: null, error });
}
