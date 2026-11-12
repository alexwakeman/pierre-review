import {
  TICKET_REVIEW_MAX_PRS,
  TICKET_REVIEW_STATES_MAX,
  criteriaDoneWords,
  jiraApiRoot,
  ticketIdentForLink,
  type ClaudeTicketAlignment,
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
  type TicketAutoCheck,
  type TicketReviewState,
} from '@pierre-review/shared';
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

/** "web#412": the repository's own name (no owner) and the PR number. A review loop's BRANCH (no PR yet:
 *  `label` set, `number` 0) is named by its label ("branch PAY-142"). */
export function memberLabel(m: Pick<TicketReviewMember, 'repo' | 'number'> & { label?: string | null }): string {
  if (m.label != null && m.label !== '') return m.label;
  const name = m.repo.includes('/') ? m.repo.slice(m.repo.indexOf('/') + 1) : m.repo;
  return `${name}#${m.number}`;
}

/**
 * `ticketCurrency`'s `labelOf` over the PRs a view knows ("web#412"), so one changed PR is named
 * ("web#412 pushed since") rather than "PR pushed since". An unknown id (or repo) names nothing.
 */
export function prLabelOf(
  prs: ReadonlyArray<{ prId: number; repo: string | null | undefined; number: number }>,
): (prId: number) => string | null {
  const byId = new Map<number, string>();
  for (const p of prs) if (p.repo) byId.set(p.prId, memberLabel({ repo: p.repo, number: p.number }));
  return (prId) => byId.get(prId) ?? null;
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

const CHANGE_VERB: Record<Exclude<TicketReviewStaleReason, 'story_edited' | 'new_comments'>, string> = {
  pr_pushed: 'pushed since',
  pr_merged: 'merged since',
  pr_added: 'added',
  pr_left: 'left',
};

const REASON_SENTENCE: Record<TicketReviewStaleReason, string> = {
  story_edited: 'The ticket was edited.',
  pr_added: 'A PR now names this ticket.',
  pr_left: 'A PR no longer names this ticket.',
  pr_pushed: 'A PR was pushed.',
  pr_merged: 'A PR was merged.',
  new_comments: 'Someone commented on the ticket, and a criterion is not done yet.',
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
      if (first === 'story_edited') return { tone: 'stale', label: 'Ticket edited since', title };
      if (first === 'new_comments') return { tone: 'stale', label: 'New comments since', title };
      const ids = state.changedPrIds;
      if (ids.length > 1) return { tone: 'stale', label: `${ids.length} PRs changed since`, title };
      const one = ids.length === 1 ? labelOf(ids[0]!) : null;
      return { tone: 'stale', label: `${one ?? 'PR'} ${CHANGE_VERB[first]}`, title };
    }
  }
}

/**
 * "2 new comments since this check" — people commented on the ticket after the latest check
 * (docs/TRACKERS.md § Ticket comments). They make the check stale only while a criterion is not done
 * (the server's 'new_comments'); this line tells the reader either way. null when there are none (or
 * while a check runs).
 */
export function newCommentsWords(
  state: Pick<TicketReviewState, 'status' | 'newComments'> | null | undefined,
): { label: string; title: string } | null {
  const n = state?.newComments ?? 0;
  if (state == null || n <= 0 || state.status === 'running' || state.status === 'none') return null;
  return {
    label: `${plural(n, 'new comment')} since this check`,
    title: 'People commented on the ticket after this check. Re-check to include them.',
  };
}

/** "1m 40s", "45s", "2m" — a short countdown. */
export function shortDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  if (m === 0) return `${sec}s`;
  return sec === 0 ? `${m}m` : `${m}m ${sec}s`;
}

/**
 * THE AUTOMATIC STORY CHECK IN ONE LINE — when it starts, or why it will not (the server's
 * `autoCheck`, the sweeper's own rule). null when there is nothing to say: up to date, running now,
 * or an older server. `labelOf` names a PR ("backend#615"); `nowMs` drives the countdown.
 */
export function ticketAutoCheckWords(
  auto: TicketAutoCheck | null | undefined,
  labelOf: (prId: number) => string | null,
  nowMs: number,
): { label: string; title: string } | null {
  if (auto == null) return null;
  const after = ((): string | null => {
    const c = auto.lastChange;
    if (c == null) return null;
    const pr = c.prId != null ? (labelOf(c.prId) ?? 'a PR') : 'a PR';
    switch (c.kind) {
      case 'pushed':
        return `the last push to ${pr}`;
      case 'joined':
        return `${pr} joined the ticket`;
      case 'merged':
        return `${pr} merged`;
      case 'commented':
        return 'the last comment on the ticket';
      default:
        return 'the ticket changed';
    }
  })();
  const startsMs = auto.startsAt != null ? Date.parse(auto.startsAt) : null;
  switch (auto.status) {
    case 'waiting':
      if (auto.reason === 'lane_full') {
        return { label: 'Story check starts when a check slot is free', title: 'Other automatic checks are running first.' };
      }
      if (startsMs != null && startsMs > nowMs) {
        const wait = after != null ? ` — waiting 2 quiet minutes after ${after}` : '';
        return {
          label: `Story check starts in ${shortDuration(startsMs - nowMs)}${wait}`,
          title: 'Every push, joining PR, ticket change or new comment restarts the 2 minutes. After 20 minutes of changes it starts anyway.',
        };
      }
      return { label: 'Story check starts within a minute', title: 'The PRs have been quiet for 2 minutes.' };
    case 'due':
      return { label: 'Story check starts within a minute', title: 'The PRs have been quiet for 2 minutes.' };
    case 'held':
      if (auto.reason === 'daily_limit') {
        return {
          label: 'Story check starts at 00:00 UTC — the daily limit of automatic checks is reached',
          title: 'This workspace has used its automatic ticket checks for today. Tickets with your own PRs are not limited. Re-check runs one now.',
        };
      }
      if (auto.reason === 'over_budget') {
        return { label: 'No automatic story check — the AI spend limit is reached', title: 'It starts again when spend is under the limit (Settings → AI). Re-check runs one now.' };
      }
      return { label: 'No automatic story check — AI is not ready', title: 'Sign in to Claude or Codex in Settings → AI.' };
    case 'off':
      switch (auto.reason) {
        case 'auto_off':
          return { label: 'No automatic story check — auto review is off in this workspace', title: 'Turn it on in Settings → AI review. Re-check runs one now.' };
        case 'too_many_prs':
          return { label: 'No automatic story check — the ticket has too many PRs', title: 'Re-check says how many.' };
        case 'no_floor':
          return { label: 'No automatic story check — its PRs are older than auto review', title: 'Auto review checks tickets with a PR opened after it was turned on. Re-check runs one now.' };
        case 'already_tried':
          return { label: 'No automatic story check — the last one failed on these PRs', title: 'It tries again after the next push or change. Re-check runs one now.' };
        case 'stopped':
          return { label: 'No automatic story check — you stopped it', title: 'It starts again after the next push or change. Re-check runs one now.' };
        case 'all_met':
          return { label: 'No automatic story check — the last one found every criterion met', title: 'It checks again automatically only if the ticket text changes. Re-check runs one now.' };
        default:
          return null;
      }
    default:
      return null;
  }
}

// ---- coverage ----

/** "4 of 6 met" / "4 met + 1 outside code of 6"; null when the run had no criteria. */
export function coverageLabel(counts: TicketReviewState['counts']): string | null {
  if (counts == null || counts.total === 0) return null;
  const outside = counts.metOutsideCode ?? 0;
  return outside > 0 ? criteriaDoneWords(counts) : `${counts.met} of ${counts.total} met`;
}

export type CoverageTone = 'ok' | 'partial' | 'bad' | 'muted';

/** All DONE (met, or met outside code) → ok; any not met → bad; otherwise (partly met / can't tell) → partial. */
export function coverageTone(counts: TicketReviewState['counts']): CoverageTone {
  if (counts == null || counts.total === 0) return 'muted';
  if (counts.met + (counts.metOutsideCode ?? 0) === counts.total) return 'ok';
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
      return 'The ticket could not be read.';
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

/** One "Post N gaps to …" button: the not-yet-posted items whose comment lands on `prId`. */
export interface StoryGapGroup {
  prId: number;
  label: string | null;
  itemIds: number[];
}

/**
 * The unposted items of a run grouped by the PR their ONE collated comment lands on (owner PR, else
 * the PR being viewed) — the viewed PR's group first, then in the run's member order. Posted items
 * (own or inherited) are left out, so a group disappears once its comment is on GitHub.
 */
export function storyGapGroups(
  review: Pick<TicketReview, 'items' | 'members'>,
  viewedPrId: number,
): StoryGapGroup[] {
  const groups = new Map<number, StoryGapGroup>();
  for (const item of review.items) {
    if (item.posted != null) continue;
    const t = postTargetOf(item, viewedPrId, review.members);
    const g = groups.get(t.prId) ?? { prId: t.prId, label: t.label, itemIds: [] };
    g.itemIds.push(item.id);
    groups.set(t.prId, g);
  }
  const order = (prId: number): number => (prId === viewedPrId ? -1 : review.members.findIndex((m) => m.prId === prId));
  return [...groups.values()].sort((a, b) => order(a.prId) - order(b.prId));
}

/** "Post 3 gaps to this PR" / "Post 1 gap to api#88". */
export function postGapsButtonLabel(g: Pick<StoryGapGroup, 'prId' | 'label' | 'itemIds'>, viewedPrId: number): string {
  const n = g.itemIds.length;
  const what = `${n} ${n === 1 ? 'gap' : 'gaps'}`;
  const where = g.prId === viewedPrId ? 'this PR' : (g.label ?? 'its PR');
  return `Post ${what} to ${where}`;
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

// ---- met outside code changes ----

/** "Per Dana Lee's comment, 4 Mar" — the citation line of a "Met outside code changes" criterion
 *  (`metBy`, copied by the server from the stored comment). null without one. */
export function metByWords(metBy: TicketCriterion['metBy'], fmt: (iso: string) => string): string | null {
  if (metBy == null) return null;
  const who = metBy.author.trim() !== '' ? metBy.author.trim() : 'someone';
  return `Per ${who}'s comment, ${fmt(metBy.createdAt)}`;
}

/** The event a citation sends so the ticket's Comments list opens on that comment (TicketComments.tsx). */
export const SHOW_TICKET_COMMENT_EVENT = 'limn:show-ticket-comment';

/** Open the ticket's Comments list, where it is on screen, at this comment. */
export function showTicketComment(commentId: string): void {
  window.dispatchEvent(new CustomEvent(SHOW_TICKET_COMMENT_EVENT, { detail: { commentId } }));
}
