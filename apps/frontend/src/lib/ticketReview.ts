import {
  TICKET_REVIEW_MAX_PRS,
  TICKET_REVIEW_STATES_MAX,
  jiraApiRoot,
  isTrackerIdent,
  ticketIdentForLink,
  parseTicketIdent,
  type ClaudeReviewTicketInput,
  type ClaudeTicketAlignment,
  type StartTicketReviewBody,
  type TicketCriterion,
  type TicketExpectedIn,
  type TicketPrCard,
  type TicketPrCardChange,
  type TicketPrCardInterfaceKind,
  type TicketReview,
  type TicketReviewItem,
  type TicketReviewMember,
  type TicketReviewProgress,
  type TicketReviewRefusal,
  type TicketReviewStaleReason,
  type TicketReviewState,
} from '@pierre-review/shared';
import { ticketInputFromStored } from './claudeReviewFollowUp.js';
import { relativeTime } from './ui.js';

// THE TICKET REVIEW — the pure half of the PR pane's "User stories" section (TicketCoverage.tsx)
// and the Open PRs ticket stacks / card pills. One review per TICKET across every PR that names
// it; this file turns the wire (`TicketReview`, `TicketReviewState`) into the few words a screen
// prints. Nothing here decides currency: the server compares fingerprints, this only names what it
// said moved.

// ---- idents ----

/**
 * The Jira API root a browse link belongs to — the plugin's own fold (shared `jiraApiRoot`), run on
 * `<base>/browse/<KEY>`, so it lands on the root the plugin stored. null for a non-http(s) URL.
 */
export const jiraApiRootOf = (url: string | null | undefined): string | null => jiraApiRoot(url);

/** A detected ticket's ident — 'jira:<apiRoot>#<KEY>', 'github:https://github.com/<owner>/<repo>#<n>'
 *  or 'linear:https://linear.app/<org>#<KEY>' (shared `ticketIdentForLink`, the same rule the server's
 *  rows follow); null with no usable link. */
export function ticketIdentOf(link: { key: string; url: string | null; provider?: string }): string | null {
  return ticketIdentForLink(link);
}

/** The batched states request's ident list: de-duplicated, sorted (a stable query key), capped. */
export function statesRequestIdents(idents: readonly (string | null | undefined)[]): string[] {
  const set = new Set<string>();
  for (const i of idents) if (i != null && i !== '') set.add(i);
  return [...set].sort().slice(0, TICKET_REVIEW_STATES_MAX);
}

export function anyTicketRunning(states: readonly TicketReviewState[] | undefined): boolean {
  return (states ?? []).some((s) => s.status === 'running');
}

// ---- PR labels ----

/** "web#412": the repository's own name (no owner) and the PR number. */
export function memberLabel(m: Pick<TicketReviewMember, 'repo' | 'number'>): string {
  const name = m.repo.includes('/') ? m.repo.slice(m.repo.indexOf('/') + 1) : m.repo;
  return `${name}#${m.number}`;
}

/** "a", "a and b", "a, b and c". */
function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "Done in web#412 and api#88" — only member PRs the run knows; null when none. */
export function deliveredByLabel(
  c: Pick<TicketCriterion, 'deliveredBy'>,
  members: readonly TicketReviewMember[],
): string | null {
  const byId = new Map(members.map((m) => [m.prId, m]));
  const labels = c.deliveredBy
    .map((id) => byId.get(id))
    .filter((m): m is TicketReviewMember => m != null)
    .map(memberLabel);
  return labels.length > 0 ? `Done in ${joinAnd(labels)}` : null;
}

/** Where unmet work belongs: "Belongs in api#88", or "Belongs in api" (a repo with no PR yet). */
export function expectedInLabel(
  e: TicketExpectedIn | null | undefined,
  members: readonly TicketReviewMember[],
): string | null {
  if (e == null) return null;
  if (e.prId != null) {
    const m = members.find((x) => x.prId === e.prId);
    if (m != null) return `Belongs in ${memberLabel(m)}`;
  }
  if (e.repoId != null) {
    const m = members.find((x) => x.repoId === e.repoId);
    if (m != null) return `Belongs in ${memberLabel(m).replace(/#\d+$/, '')}`;
  }
  return null;
}

// ---- currency ----

export type TicketCurrencyTone = 'current' | 'stale' | 'running';

export interface TicketCurrency {
  tone: TicketCurrencyTone;
  label: string;
  title: string;
}

const CHANGE_VERB: Record<Exclude<TicketReviewStaleReason, 'story_edited'>, string> = {
  pr_pushed: 'pushed since',
  pr_merged: 'merged since',
  pr_added: 'added',
  pr_left: 'left',
};

const REASON_SENTENCE: Record<TicketReviewStaleReason, string> = {
  story_edited: 'The story was edited.',
  pr_added: 'A PR now names this ticket.',
  pr_left: 'A PR no longer names this ticket.',
  pr_pushed: 'A PR was pushed.',
  pr_merged: 'A PR was merged.',
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The currency pill. `labelOf` names a PR ("web#412") when the caller knows it — a PR that joined
 * the ticket after the run is not among its members, so it may answer null. null for `none` (no
 * run to describe).
 */
export function ticketCurrency(
  state: Pick<TicketReviewState, 'status' | 'staleBecause' | 'changedPrIds' | 'memberCount'>,
  labelOf: (prId: number) => string | null = () => null,
): TicketCurrency | null {
  switch (state.status) {
    case 'none':
      return null;
    case 'running':
      return { tone: 'running', label: 'Checking…', title: 'A check of this ticket is running.' };
    case 'current':
      return {
        tone: 'current',
        label: `Checked against ${plural(state.memberCount, 'PR')}`,
        title: 'Nothing on this ticket has changed since.',
      };
    case 'stale': {
      const reasons = state.staleBecause;
      const title = `Changed since the last check. ${reasons.map((r) => REASON_SENTENCE[r]).join(' ')}`.trim();
      const first = reasons[0];
      if (first == null) return { tone: 'stale', label: 'Changed since', title };
      if (first === 'story_edited') return { tone: 'stale', label: 'Story edited since', title };
      const ids = state.changedPrIds;
      if (ids.length > 1) return { tone: 'stale', label: `${ids.length} PRs changed since`, title };
      const one = ids.length === 1 ? labelOf(ids[0]!) : null;
      return { tone: 'stale', label: `${one ?? 'PR'} ${CHANGE_VERB[first]}`, title };
    }
  }
}

// ---- coverage ----

/** "4 of 6 met"; null when the run had no criteria. */
export function coverageLabel(counts: TicketReviewState['counts']): string | null {
  if (counts == null || counts.total === 0) return null;
  return `${counts.met} of ${counts.total} met`;
}

export type CoverageTone = 'ok' | 'partial' | 'bad' | 'muted';

/** All met → ok; any not met → bad; otherwise (partly met / can't tell) → partial. */
export function coverageTone(counts: TicketReviewState['counts']): CoverageTone {
  if (counts == null || counts.total === 0) return 'muted';
  if (counts.met === counts.total) return 'ok';
  if (counts.notMet > 0) return 'bad';
  return 'partial';
}

const ALIGNMENT_SHORT: Record<ClaudeTicketAlignment, string> = {
  aligned: 'Matches',
  partly_aligned: 'Partly matches',
  not_aligned: "Doesn't match",
  unclear: "Can't tell",
  not_checked: 'Not checked',
};

function alignmentShort(a: ClaudeTicketAlignment | null): string | null {
  return a == null ? null : ALIGNMENT_SHORT[a];
}

function alignmentTone(a: ClaudeTicketAlignment | null): CoverageTone {
  if (a === 'aligned') return 'ok';
  if (a === 'not_aligned') return 'bad';
  if (a === 'partly_aligned') return 'partial';
  return 'muted';
}

/** One ticket's reading for a compact surface (a stack header, a card pill). null = nothing yet. */
export interface TicketCoverage {
  label: string;
  tone: CoverageTone;
  stale: boolean;
  running: boolean;
  title: string;
}

export function ticketCoverage(state: TicketReviewState | undefined): TicketCoverage | null {
  if (state == null) return null;
  const running = state.status === 'running';
  // A ticket with no acceptance criteria is judged on its missing pieces alone, so a finished run
  // has no "n of m" to show: its alignment stands in, or the stack would offer "Check story" again.
  const cov = coverageLabel(state.counts) ?? ((state.status === 'current' || state.status === 'stale') && state.latestRunId != null ? alignmentShort(state.alignment) : null);
  if (cov == null && !running) return null;
  const currency = ticketCurrency(state);
  const label = cov ?? 'Checking…';
  return {
    label,
    tone: coverageLabel(state.counts) != null ? coverageTone(state.counts) : alignmentTone(state.alignment),
    stale: state.status === 'stale',
    running,
    title: [cov != null ? `${cov}.` : null, currency?.title ?? null].filter(Boolean).join(' '),
  };
}

/** The Open PRs card's ticket pills, from the batched states. `skipKey` = the stack's own ticket. */
export interface CardTicketPill extends TicketCoverage {
  key: string;
}

export function cardTicketPills(
  tickets: readonly { key: string; ident?: string | null }[],
  statesByIdent: ReadonlyMap<string, TicketReviewState>,
  skipKey: string | null = null,
): CardTicketPill[] {
  const out: CardTicketPill[] = [];
  for (const t of tickets) {
    if (t.ident == null || t.key === skipKey) continue;
    const cov = ticketCoverage(statesByIdent.get(t.ident));
    if (cov != null) out.push({ key: t.key, ...cov });
  }
  return out;
}

// ---- refusals ----

/** Why the server declined to run, in one sentence. */
export function refusalSentence(r: { reason: TicketReviewRefusal; prCount: number | null }): string {
  switch (r.reason) {
    case 'too_many_prs':
      return r.prCount != null
        ? `${r.prCount} PRs name this ticket. One check covers at most ${TICKET_REVIEW_MAX_PRS}.`
        : `More than ${TICKET_REVIEW_MAX_PRS} PRs name this ticket.`;
    case 'no_members':
      return 'No open or merged PR names this ticket.';
    case 'no_ticket':
      return 'The story could not be read.';
    case 'peer_unreadable':
      return 'None of the PRs could be checked out.';
  }
}

// ---- items ----

/** The unmet / partly met criterion items by ref ('AC3'). Missing items ('M1') are listed apart. */
export function itemsByRef(items: readonly TicketReviewItem[]): Map<string, TicketReviewItem> {
  return new Map(items.map((i) => [i.ref, i]));
}

export function missingItems(items: readonly TicketReviewItem[]): TicketReviewItem[] {
  return items.filter((i) => i.status === 'missing');
}

/** Where Post puts the comment: the item's owner PR, else the PR being viewed. */
export function postTargetOf(
  item: Pick<TicketReviewItem, 'ownerPrId'>,
  viewedPrId: number,
  members: readonly TicketReviewMember[],
): { prId: number; label: string | null } {
  const prId = item.ownerPrId ?? viewedPrId;
  if (prId === viewedPrId) return { prId, label: null };
  const m = members.find((x) => x.prId === prId);
  return { prId, label: m != null ? memberLabel(m) : null };
}

export function postButtonLabel(target: { prId: number; label: string | null }, viewedPrId: number): string {
  if (target.prId === viewedPrId) return 'Post';
  return target.label != null ? `Post on ${target.label}` : 'Post on its PR';
}

/** The posted marker, or null while not posted. */
export function postedLabel(
  item: Pick<TicketReviewItem, 'posted'>,
  members: readonly TicketReviewMember[],
  viewedPrId: number,
): string | null {
  const p = item.posted;
  if (p == null) return null;
  const m = p.prId !== viewedPrId ? members.find((x) => x.prId === p.prId) : undefined;
  const where = m != null ? ` on ${memberLabel(m)}` : '';
  if (p.carried) return `Posted${where} on an earlier check`;
  return p.auto === true ? `Posted automatically${where} · ${relativeTime(p.postedAt)}` : `Posted${where}`;
}

/**
 * A "Not asked for" item auto-posting put on GitHub (it has no item row; the run's `autoPost` record
 * names it by index), else null.
 */
export function notRequestedPostedLabel(
  review: Pick<TicketReview, 'autoPost'>,
  index: number,
): string | null {
  const p = review.autoPost?.notRequested.find((n) => n.index === index);
  if (p == null) return null;
  return p.carried ? 'Posted on an earlier check' : `Posted automatically · ${relativeTime(p.postedAt)}`;
}

// ---- starting ----

/** What a block's Check / Re-check sends: a pasted story re-sends its stored text, else the ident. */
export function recheckBody(
  prId: number,
  ident: string,
  review: Pick<TicketReview, 'ticket'> | null | undefined,
): StartTicketReviewBody {
  if (parseTicketIdent(ident)?.kind === 'manual' && review?.ticket != null) {
    return { prId, tickets: [ticketInputFromStored(review.ticket)] };
  }
  return { prId, ident };
}

/**
 * The story panel's Check: a Jira story the server already lists for this PR goes by its ident
 * (the plugin's stored text is what gets judged); everything else is sent as a pasted story.
 */
export function planStoryStart(
  tickets: readonly ClaudeReviewTicketInput[],
  known: readonly { ident: string; ticketKey: string | null }[],
): { idents: string[]; pasted: ClaudeReviewTicketInput[] } {
  const identByKey = new Map<string, string>();
  for (const k of known) {
    if (k.ticketKey == null || !isTrackerIdent(parseTicketIdent(k.ident))) continue;
    identByKey.set(k.ticketKey.trim().toUpperCase(), k.ident);
  }
  const idents: string[] = [];
  const pasted: ClaudeReviewTicketInput[] = [];
  for (const t of tickets) {
    const ident = t.source === 'jira' && t.key != null ? identByKey.get(t.key.trim().toUpperCase()) : undefined;
    if (ident != null) {
      if (!idents.includes(ident)) idents.push(ident);
    } else pasted.push(t);
  }
  return { idents, pasted };
}

// ---- progress ----

export const TICKET_PHASE_LABEL: Record<TicketReviewProgress['phase'], string> = {
  queued: 'Waiting to start',
  preparing: 'Checking out the PRs',
  reviewing: 'Reading the PRs',
  saving: 'Saving',
};

/** A determinate 0–100 reading for the progress bar; null = indeterminate. */
export function ticketProgressPct(p: TicketReviewProgress | null | undefined): number | null {
  if (p == null) return null;
  switch (p.phase) {
    case 'queued':
      return 5;
    case 'preparing':
      return 20;
    case 'reviewing':
      return Math.min(90, 40 + (p.recentActivity?.length ?? 0) * 3);
    case 'saving':
      return 95;
  }
}

/** Every member PR id of a run, plus the PR it was started from (the cache keys `done` refreshes). */
export function memberPrIdsOf(review: Pick<TicketReview, 'members' | 'originPrId'> | null | undefined): number[] {
  if (review == null) return [];
  const ids = new Set(review.members.map((m) => m.prId));
  if (review.originPrId != null) ids.add(review.originPrId);
  return [...ids];
}

// ---- contribution cards ("What this PR adds") ----

export const TICKET_PR_CARD_KIND_LABEL: Record<TicketPrCardInterfaceKind, string> = {
  endpoint: 'Endpoint',
  field: 'Field',
  event: 'Event',
  config: 'Setting',
  export: 'Export',
  schema: 'Schema',
  other: 'Other',
};

export const TICKET_PR_CARD_CHANGE_LABEL: Record<TicketPrCardChange, string> = {
  added: 'Added',
  changed: 'Changed',
  removed: 'Removed',
};

/**
 * The members that HAVE a card at their current head, in the run's member order. A member with no
 * card is left out: nothing is shown for it (never a placeholder claim).
 */
export function membersWithCards(
  members: readonly TicketReviewMember[],
): Array<{ member: TicketReviewMember; card: TicketPrCard }> {
  const out: Array<{ member: TicketReviewMember; card: TicketPrCard }> = [];
  for (const m of members) if (m.card != null) out.push({ member: m, card: m.card });
  return out;
}

/** True when a card has anything beyond its summary to expand into. */
export function cardHasDetail(card: Pick<TicketPrCard, 'interfaces' | 'looseEnds'>): boolean {
  return card.interfaces.length > 0 || card.looseEnds.length > 0;
}
