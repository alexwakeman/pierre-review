// THE TICKET A SESSION IS TOLD ABOUT (docs/SANDBOX.md § The ticket): read FRESH at session start (and
// again at Start build, WP7) — open points change while a ticket is in flight.
//
//   1. the tracker is read again (tracker/open-points-ticket.ts `refreshTicketForSession`: the PR
//      path when the ticket has PRs, else the sprint list read) — never fatal;
//   2. the story is then resolved EXACTLY as the story view shows it (story-build/inputs.ts
//      `resolveStoryBuildInputs`: the same criteria order, AC1, AC2, …), plus its PRs and comments.
//
// The result is plain data for the seed fold (seed.ts). Everything in it is UNTRUSTED tracker text.
// ⚠ `tracker/runtime.ts` opens the DB at import: every tracker import here is LAZY.
import { findAcSection, type StoryBuildCoverage, type StoryDocsCriteriaSource, type TicketAcLocation, type TicketOpenPoint } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import type { StoryBuildInputs } from '../../coding/story-build/inputs.js';

export interface SessionTicketPr {
  fullName: string;
  number: number;
  title: string;
  state: 'open' | 'merged';
  byReader: boolean;
}

export interface SessionTicketGap {
  ref: string;
  text: string;
  /** Done criteria ('met', 'met_outside_code') are listed too, so the agent does not redo them. */
  verdict: string;
  /** 'met_outside_code' only: the person's ticket comment it rests on. */
  metBy?: { author: string; createdAt: string } | null;
}

export interface SessionTicket {
  ident: string;
  key: string;
  title: string;
  url: string | null;
  description: string;
  /** The ticket's own acceptance-criteria text (used when there is no numbered list). */
  acceptanceCriteriaText: string;
  criteria: Array<{ n: number; text: string }>;
  criteriaSource: StoryDocsCriteriaSource;
  openPoints: TicketOpenPoint[];
  comments: string | null;
  prs: SessionTicketPr[];
  /** Fill gaps only: the ticket check's verdict per criterion, and the items it found missing. */
  gaps: { criteria: SessionTicketGap[]; missing: Array<{ ref: string; text: string }>; note: string | null } | null;
  /** The tracker was read again just now. false: Limn's stored copy (`readAt` says when). */
  fresh: boolean;
  readAt: string | null;
  /**
   * Where the ticket keeps its criteria — what the plan's ticket update writes (tracker/ac-location.ts,
   * docs/TRACKERS.md § The ticket update). Absent = not known (an older fixture): seed.ts reads the
   * description for an AC heading instead. The layout facts are computed from the text in seed.ts.
   */
  acLocation?: TicketAcLocation;
}

export interface SessionTicketSeams {
  refresh(
    accountId: number,
    workspaceId: number,
    ident: string,
    prs: ReadonlyArray<{ prId: number; state: 'open' | 'merged' }>,
  ): Promise<{ points: TicketOpenPoint[]; fresh: boolean; fetchedAt: string | null }>;
  inputs(ctx: AgentContext, accountId: number, workspaceId: number, ident: string): Promise<StoryBuildInputs | null>;
  /** `owner/name` per repo id (this account's). */
  repoNames(accountId: number, repoIds: readonly number[]): Promise<Map<number, string>>;
  /** The ticket's PRs before the refresh (the refresh needs them; `inputs` re-reads them after). */
  ticketPrs(ctx: AgentContext, accountId: number, ident: string): Promise<Array<{ prId: number; state: 'open' | 'merged' }>>;
  /** Where the criteria live (stored rows; null = not known). Optional: absent ⇒ the description's AC heading. */
  acLocation?(accountId: number, workspaceId: number, ident: string): Promise<TicketAcLocation | null>;
}

export const defaultSessionTicketSeams: SessionTicketSeams = {
  async refresh(accountId, workspaceId, ident, prs) {
    const [{ trackerContext }, { refreshTicketForSession }] = await Promise.all([
      import('../../tracker/runtime.js'),
      import('../../tracker/open-points-ticket.js'),
    ]);
    return refreshTicketForSession(trackerContext(), accountId, workspaceId, ident, prs);
  },
  async inputs(ctx, accountId, workspaceId, ident) {
    const { resolveStoryBuildInputs } = await import('../../coding/story-build/inputs.js');
    return resolveStoryBuildInputs(ctx, accountId, workspaceId, ident);
  },
  async repoNames(accountId, repoIds) {
    const out = new Map<number, string>();
    if (repoIds.length === 0) return out;
    const [{ db, schema }, { and, eq, inArray }] = await Promise.all([import('../../db/client.js'), import('drizzle-orm')]);
    const rows = await db
      .select({ id: schema.repos.id, owner: schema.repos.owner, name: schema.repos.name })
      .from(schema.repos)
      .where(and(eq(schema.repos.accountId, accountId), inArray(schema.repos.id, [...new Set(repoIds)])))
      .execute();
    for (const r of rows) out.set(r.id, `${r.owner}/${r.name}`);
    return out;
  },
  async ticketPrs(ctx, accountId, ident) {
    const { defaultStoryBuildInputSeams } = await import('../../coding/story-build/inputs.js');
    const ids = await defaultStoryBuildInputSeams.ticketPrIds(ctx, accountId, ident).catch(() => []);
    const prs = await defaultStoryBuildInputSeams.ticketPrs(ctx, accountId, ids).catch(() => []);
    return prs.map((p) => ({ prId: p.prId, state: p.state }));
  },
  async acLocation(accountId, workspaceId, ident) {
    const [{ trackerContext }, { storedTicketText }] = await Promise.all([
      import('../../tracker/runtime.js'),
      import('../../tracker/ac-location.js'),
    ]);
    return (await storedTicketText(trackerContext(), accountId, workspaceId, ident))?.acLocation ?? null;
  },
};

/** No stored answer: an AC heading in the description, else nowhere. Pure. */
function acLocationFromText(description: string): TicketAcLocation {
  const s = findAcSection(description);
  return s != null ? { kind: 'description', heading: s.heading } : { kind: 'none' };
}

/** null ⇒ not a tracker ticket, or no story at all (the start refuses it). */
export async function readSessionTicket(
  ctx: AgentContext,
  accountId: number,
  workspaceId: number,
  ident: string,
  opts: { coverage?: StoryBuildCoverage | null; seams?: SessionTicketSeams } = {},
): Promise<SessionTicket | null> {
  const seams = opts.seams ?? defaultSessionTicketSeams;
  const before = await seams.ticketPrs(ctx, accountId, ident).catch(() => []);
  const refreshed = await seams
    .refresh(accountId, workspaceId, ident, before)
    .catch(() => ({ points: [] as TicketOpenPoint[], fresh: false, fetchedAt: null }));
  const inputs = await seams.inputs(ctx, accountId, workspaceId, ident);
  if (inputs == null || inputs.empty) return null;
  const names = await seams.repoNames(accountId, inputs.ticketPrs.map((p) => p.repoId)).catch(() => new Map<number, string>());
  const { commentsText } = await import('../../coding/story-build/inputs.js');
  const comments = await commentsText(inputs.comments).catch(() => null);
  const cov = opts.coverage ?? null;
  const acLocation =
    (await seams.acLocation?.(accountId, workspaceId, ident).catch(() => null)) ?? acLocationFromText(inputs.story.description);
  return {
    ident,
    key: inputs.ticketKey,
    title: inputs.story.title ?? inputs.title ?? '',
    url: inputs.url,
    description: inputs.story.description,
    acceptanceCriteriaText: inputs.story.acceptanceCriteria,
    criteria: inputs.criteria.map((c) => ({ n: c.n, text: c.text })),
    criteriaSource: inputs.criteriaSource,
    openPoints: refreshed.points,
    comments,
    prs: inputs.ticketPrs.map((p) => ({
      fullName: names.get(p.repoId) ?? `repository ${p.repoId}`,
      number: p.number,
      title: p.title,
      state: p.state,
      byReader: p.byReader,
    })),
    gaps:
      cov == null
        ? null
        : {
            criteria: cov.criteria.map((c) => ({
              ref: c.ref,
              text: c.text,
              verdict: c.verdict,
              ...(c.metBy != null ? { metBy: { author: c.metBy.author, createdAt: c.metBy.createdAt } } : {}),
            })),
            missing: cov.missing.map((m) => ({ ref: m.ref, text: m.text })),
            note: cov.note,
          },
    fresh: refreshed.fresh,
    readAt: refreshed.fetchedAt,
    acLocation,
  };
}
