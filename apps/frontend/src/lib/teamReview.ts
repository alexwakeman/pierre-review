// THE AI REVIEW TAB'S TEAM LAYOUT — the pure half (docs/FRONTEND.md § The AI Review tab → Team layout;
// docs/CLAUDE-REVIEW.md § Teammates' reviews → The tab's team layout). The server folds once
// (`ClaudeReviewResponse.teamView`: `standings`, `allFindings`); these are the words and the rules the
// tab applies to it, so they can be tested:
//   • `standingRows`     — "Where this PR stands": one line per Limn reviewer, newest first;
//   • `splitPointsByState` / `raisedByLabel` / `closedReason` — findings by their state now, across
//     every review, each naming who raised it;
//   • `reviewsOnPr`      — "Reviews on this PR": the reader's runs and teammates' posted reviews;
//   • `nextShownReview`  — NEWEST ALWAYS SHOWS: a picked past review gives way to the next new one.
//   • `pointCard` / `teammateFindingCard` — every finding is drawn with the reader's OWN card
//     (`FindingRow`): the same fields, minus the actions that would rewrite someone else's words.
import {
  aiProviderName,
  aiRunProviderName,
  PAIR_RUN_LABEL,
  postedFindingDisplay,
  type AiProviderId,
  type ClaudeFinding,
  type ClaudeFindingSeverity,
  type ClaudeTeammateFinding,
  type ClaudeReviewStanding,
  type ClaudeReviewStandings,
  type ClaudeReviewStatus,
  type ClaudeReviewSummary,
  type ClaudeReviewVerdict,
  type ClaudeTeamAuthor,
  type ClaudeTeammatePoster,
  type ClaudeTeammateReview,
  type ClaudeTeamPoint,
} from '@pierre-review/shared';
import { AUTO_REVIEW_LABEL as AUTO_WORD } from '../components/Activity/pendingLabels.js';
import { CLAUDE_VERDICT_LABEL, shortDay } from './claudeReviewColumn.js';
import { REPLIES_CHECK_LABEL as REPLIES_WORD } from './repliesCheck.js';
import { joinNames, teammateName } from './teammateReviews.js';

// ---- WHO ----

/** "You", or a teammate's first name ("Robin"). */
export function authorName(a: Pick<ClaudeTeamAuthor, 'you' | 'poster'>): string {
  return a.you || a.poster == null ? 'You' : teammateName(a.poster);
}

/** "Your review", "Robin’s review". */
function possessive(a: Pick<ClaudeTeamAuthor, 'you' | 'poster'>): string {
  return a.you || a.poster == null ? 'Your' : `${teammateName(a.poster)}’s`;
}

const personKey = (a: Pick<ClaudeTeamAuthor, 'you' | 'poster'>): string =>
  a.you || a.poster == null ? 'you' : `u${a.poster.userId}`;

/** "Claude", "Codex", or "Claude + Codex" for both. null when unknown. */
export function providersLabel(providers: readonly AiProviderId[]): string | null {
  const set = new Set(providers);
  if (set.size === 0) return null;
  if (set.size > 1) return PAIR_RUN_LABEL;
  return aiProviderName([...set][0]);
}

// ---- WHERE THIS PR STANDS ----

export interface StandingRow {
  key: string;
  you: boolean;
  poster: ClaudeTeammatePoster | null;
  name: string;
  // The newest review's verdict word ("Request changes"); "Reviewed" when it had none.
  verdict: string;
  verdictKind: ClaudeReviewVerdict | null;
  day: string;
  sha: string | null;
  at: string | null;
  // What GitHub still holds for them: "still blocking on GitHub", "Request changes from 3 Nov still
  // blocking on GitHub", "approval stands on GitHub", "dismissed on GitHub". null = nothing to say.
  note: string | null;
  // Their Request changes is still in force (the strictest verdict): the row is flagged.
  blocking: boolean;
}

function standingAt(s: ClaudeReviewStanding): string | null {
  return s.latest?.at ?? s.inForce?.at ?? null;
}

/** One reviewer's line. */
export function standingRow(s: ClaudeReviewStanding): StandingRow {
  const shown = s.latest ?? s.inForce;
  const force = s.inForce;
  const sameReview = force != null && (s.latest == null || (force.reviewId != null && force.reviewId === s.latest.reviewId));
  let note: string | null = null;
  if (force != null) {
    if (force.verdict === 'REQUEST_CHANGES') {
      note = sameReview ? 'still blocking on GitHub' : `Request changes from ${shortDay(force.at)} still blocking on GitHub`;
    } else {
      note = sameReview ? 'approval stands on GitHub' : `Approval from ${shortDay(force.at)} stands on GitHub`;
    }
  } else if (s.dismissed) {
    note = 'dismissed on GitHub';
  }
  const verdictKind = shown?.verdict ?? null;
  return {
    key: personKey(s),
    you: s.you,
    poster: s.poster,
    name: authorName(s),
    verdict: verdictKind != null ? CLAUDE_VERDICT_LABEL[verdictKind] : 'Reviewed',
    verdictKind,
    day: shown != null ? shortDay(shown.at) : '',
    sha: shown?.headSha != null && shown.headSha !== '' ? shown.headSha.slice(0, 7) : null,
    at: shown?.at ?? null,
    note,
    blocking: force?.verdict === 'REQUEST_CHANGES',
  };
}

/** "Where this PR stands": one line per Limn reviewer, NEWEST REVIEW FIRST. [] = none. */
export function standingRows(standings: ClaudeReviewStandings | null | undefined): StandingRow[] {
  const reviewers = standings?.reviewers ?? [];
  return reviewers
    .filter((s) => s.latest != null || s.inForce != null)
    .map((s, i) => ({ s, i, at: standingAt(s) }))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || a.i - b.i)
    .map(({ s }) => standingRow(s));
}

/** The line as text: "You · Request changes · 3 Nov · 8a8ec14 · still blocking on GitHub". */
export function standingLine(r: StandingRow): string {
  return [r.name, r.verdict, r.day, r.sha, r.note].filter((x): x is string => x != null && x !== '').join(' · ');
}

// ---- FINDINGS BY STATE ----

const SEVERITY_RANK: Record<Exclude<ClaudeFindingSeverity, 'praise'>, number> = {
  blocker: 0,
  warning: 1,
  question: 2,
  nit: 3,
};
const rank = (s: ClaudeFindingSeverity | null): number => (s == null || s === 'praise' ? 9 : SEVERITY_RANK[s]);

/**
 * "Open" (unresolved, not judged addressed) and "Resolved or addressed". An IGNORED point of the
 * reader's (never said to the author) is left out unless it is in `keepFindingIds` — the latest
 * review's own findings, whose card shows it ignored with its Include. Open: severity first, then
 * newest raise first; closed: server order.
 */
export function splitPointsByState(
  points: readonly ClaudeTeamPoint[],
  keepFindingIds: ReadonlySet<number> = new Set(),
): { open: ClaudeTeamPoint[]; closed: ClaudeTeamPoint[] } {
  const open: ClaudeTeamPoint[] = [];
  const closed: ClaudeTeamPoint[] = [];
  for (const p of points) {
    if (p.ignored && !keepFindingIds.has(p.findingId)) continue;
    (p.state.kind === 'open' ? open : closed).push(p);
  }
  open.sort((a, b) => rank(a.severity) - rank(b.severity) || b.raisedAt.localeCompare(a.raisedAt));
  return { open, closed };
}

/** One row of the Open list: a folded point (with the latest run's own finding when it is one), or a
 *  latest-run finding the fold does not name (an older server; a point folded under another raise). */
export type OpenEntry<F> = { kind: 'point'; point: ClaudeTeamPoint; own: F | null } | { kind: 'own'; finding: F };

/**
 * THE FINDINGS LIST, ONCE (the section and the rail counts read the same rows): `points` minus the
 * findings shown elsewhere (`hiddenIds`, Story check), split by state; the latest run's own findings
 * (`ownFindings`) ride on their point so their card keeps its actions. Open: severity first (stable).
 */
export function teamFindingRows<F extends { id: number; severity: ClaudeFindingSeverity }>(
  points: readonly ClaudeTeamPoint[],
  ownFindings: readonly F[],
  hiddenIds: ReadonlySet<number> = new Set(),
): { open: OpenEntry<F>[]; closed: ClaudeTeamPoint[] } {
  const ownById = new Map(ownFindings.map((f) => [f.id, f]));
  const visible = points.filter((p) => !hiddenIds.has(p.findingId));
  const { open, closed } = splitPointsByState(visible, new Set(ownById.keys()));
  const covered = new Set<number>();
  for (const p of points) {
    covered.add(p.findingId);
    for (const o of p.alsoRaisedBy) covered.add(o.findingId);
  }
  const rows: OpenEntry<F>[] = open.map((p) => ({
    kind: 'point' as const,
    point: p,
    own: p.origin === 'own' ? (ownById.get(p.findingId) ?? null) : null,
  }));
  for (const f of ownFindings) if (!covered.has(f.id) && !hiddenIds.has(f.id)) rows.push({ kind: 'own', finding: f });
  const sev = (e: OpenEntry<F>): ClaudeFindingSeverity | null => (e.kind === 'own' ? e.finding.severity : e.point.severity);
  rows.sort((a, b) => rank(sev(a)) - rank(sev(b)));
  return { open: rows, closed };
}

/** Who raised a point, and their avatar(s). */
export interface RaisedBy {
  // "You · Codex", "You · Claude + Codex", "Robin", "You and Robin".
  label: string;
  // The teammates among them, first raise first (for the avatar).
  posters: ClaudeTeammatePoster[];
}

/**
 * WHO RAISED IT. One person: their name, plus the model when the review that raised it was a
 * Claude + Codex pair (`pairReviewIds`: every pair half's id, the reader's and teammates'). Several:
 * "You and Robin" (no model).
 */
export function raisedByLabel(
  p: Pick<ClaudeTeamPoint, 'author' | 'providers' | 'reviewId' | 'alsoRaisedBy'>,
  pairReviewIds: ReadonlySet<number>,
): RaisedBy {
  const people = new Map<string, { a: ClaudeTeamAuthor; providers: AiProviderId[]; pair: boolean }>();
  const add = (a: ClaudeTeamAuthor, providers: readonly AiProviderId[], reviewId: number): void => {
    const k = personKey(a);
    const cur = people.get(k) ?? { a, providers: [], pair: false };
    cur.providers.push(...providers);
    cur.pair = cur.pair || pairReviewIds.has(reviewId);
    people.set(k, cur);
  };
  add(p.author, p.providers, p.reviewId);
  for (const o of p.alsoRaisedBy) add(o, o.providers, o.reviewId);
  const list = [...people.values()];
  // The reader first when they are among them ("You and Robin").
  list.sort((x, y) => Number(y.a.you) - Number(x.a.you));
  const posters = list.filter((x) => !x.a.you && x.a.poster != null).map((x) => x.a.poster as ClaudeTeammatePoster);
  if (list.length === 1) {
    const only = list[0]!;
    const model = only.pair ? providersLabel(only.providers) : null;
    return { label: [authorName(only.a), model].filter(Boolean).join(' · '), posters };
  }
  return { label: joinNames(list.map((x) => authorName(x.a))), posters };
}

/** Why a point is no longer open: "Resolved on GitHub", "Robin’s review found it addressed · 4 Nov". */
export function closedReason(state: ClaudeTeamPoint['state']): string | null {
  switch (state.kind) {
    case 'open':
      return null;
    case 'resolved_on_github':
      return 'Resolved on GitHub';
    case 'addressed':
      return `${possessive(state.by)} review found it addressed · ${shortDay(state.at)}`;
    case 'no_longer_applies':
      return `${possessive(state.by)} review found it no longer applies · ${shortDay(state.at)}`;
  }
}

/** Every pair half's review id, the reader's runs and teammates' posted reviews alike. */
export function pairReviewIdsOf(
  history: readonly Pick<ClaudeReviewSummary, 'id' | 'pair'>[],
  teammateReviews: readonly Pick<ClaudeTeammateReview, 'reviewId' | 'pair'>[],
): Set<number> {
  const ids = new Set<number>();
  for (const h of history) if (h.pair != null) ids.add(h.id);
  for (const t of teammateReviews) if (t.pair) ids.add(t.reviewId);
  return ids;
}

// ---- THE SHARED FINDING CARD ----

/**
 * What the reader's own card (`FindingRow`) shows for a finding that is NOT one of the latest run's
 * own: the finding itself, plus which actions it keeps. A teammate's finding keeps Copy and, while
 * open and on GitHub, "Post reminder" (posted AS THE READER, linking theirs — never an edit or reply
 * of theirs); never Post, Reword or Ignore (their words, already on GitHub), never "Posted
 * automatically" (that is about the reader's own auto-post). The reader's own older finding keeps
 * Copy only (its reminder belongs to the latest run's card).
 */
export interface FindingCard {
  finding: ClaudeFinding;
  // The commit it was raised at (the card's "view file" link).
  headSha: string | null;
  // Posted without a severity lead (a teammate's older post): no severity chip.
  unlabelled: boolean;
  // Why it is no longer open ("Resolved on GitHub"); null while open.
  reason: string | null;
  remind: boolean;
}

/** A point of `teamView.allFindings` as the shared card. Pure. */
export function pointCard(p: ClaudeTeamPoint): FindingCard {
  const teammate = p.origin === 'teammate';
  const posted = p.posted && p.postedAt != null;
  return {
    finding: {
      id: p.findingId,
      reviewId: p.reviewId,
      path: p.path,
      line: p.line,
      side: p.side ?? 'RIGHT',
      diffAnchorId: p.diffAnchorId ?? '',
      // The card needs a word for its type; `unlabelled` hides the chip.
      severity: p.severity ?? 'warning',
      title: p.title,
      body: p.body,
      editedBody: null,
      suggestion: p.suggestion ?? null,
      diffHunk: null,
      anchored: p.path !== '' && p.line != null,
      fileInDiff: p.path !== '',
      included: true,
      postedAt: posted ? p.postedAt! : null,
      githubCommentId: posted ? (p.githubCommentId ?? null) : null,
      postedCommentKind: posted ? (p.postedCommentKind ?? null) : null,
      // "Posted automatically" is the READER's auto-post only.
      postedAuto: !teammate && p.postedAuto === true,
      earlierPost: null,
      reminder: p.reminder ?? null,
      threadId: p.threadId,
      createdAt: p.raisedAt,
    },
    headSha: p.headSha !== '' ? p.headSha : null,
    unlabelled: p.severity == null,
    reason: closedReason(p.state),
    remind: teammate && p.remindable === true && p.state.kind === 'open',
  };
}

/**
 * A teammate's finding in their PAST review (opened from Reviews on this PR): the same card, read-only
 * (Copy only — a past review is never acted on).
 */
export function teammateFindingCard(
  f: ClaudeTeammateFinding,
  review: Pick<ClaudeTeammateReview, 'reviewId' | 'postedAt' | 'headSha'>,
): FindingCard {
  const shown = postedFindingDisplay(f.body, f.title);
  const postedAt = f.postedAt ?? review.postedAt;
  return {
    finding: {
      id: f.id,
      reviewId: review.reviewId,
      path: f.path,
      line: f.line,
      side: f.side ?? 'RIGHT',
      diffAnchorId: f.diffAnchorId ?? '',
      severity: f.severity ?? 'warning',
      title: shown.title,
      body: shown.body,
      editedBody: null,
      suggestion: shown.suggestion,
      diffHunk: null,
      anchored: f.path !== '' && f.line != null,
      fileInDiff: f.path !== '',
      included: true,
      postedAt,
      githubCommentId: f.githubCommentId ?? null,
      postedCommentKind: f.kind,
      postedAuto: false,
      earlierPost: null,
      reminder: f.reminder ?? null,
      threadId: f.threadId,
      createdAt: postedAt,
    },
    headSha: review.headSha !== '' ? review.headSha : null,
    unlabelled: f.severity == null,
    reason: null,
    remind: false,
  };
}

// ---- REVIEWS ON THIS PR ----

/** What the tab shows: the current state of the PR ("now", null), or one past review, read-only. */
export type ShownReview = { kind: 'own'; id: number } | { kind: 'teammate'; reviewId: number };

export interface ReviewListItem {
  key: string;
  target: ShownReview;
  // The stored runs it stands for (a pair: both halves).
  runIds: number[];
  you: boolean;
  poster: ClaudeTeammatePoster | null;
  who: string;
  verdict: ClaudeReviewVerdict | null;
  status: ClaudeReviewStatus;
  sha: string | null;
  at: string;
  // What ran it: "Claude + Codex", "Codex", "Replies checked", "Skipped"; null when unknown.
  what: string | null;
  auto: boolean;
}

const inFlight = (s: ClaudeReviewStatus): boolean => s === 'queued' || s === 'running';

/** A pair's halves as one status: in flight while either is; else succeeded when either did. */
function pairStatus(halves: readonly Pick<ClaudeReviewSummary, 'status'>[]): ClaudeReviewStatus {
  if (halves.some((h) => inFlight(h.status))) return halves.every((h) => h.status === 'queued') ? 'queued' : 'running';
  if (halves.some((h) => h.status === 'succeeded')) return 'succeeded';
  return halves[0]?.status ?? 'failed';
}

/**
 * EVERY REVIEW ON THE PR, newest first: the reader's runs (a Claude + Codex pair ONCE, addressed by its
 * latest half's id; a replies pass too) and every teammate's posted review.
 */
export function reviewsOnPr(
  history: readonly ClaudeReviewSummary[],
  teammateReviews: readonly ClaudeTeammateReview[],
): ReviewListItem[] {
  const out: ReviewListItem[] = [];
  const pairs = new Map<number, ClaudeReviewSummary[]>();
  for (const h of history) {
    if (h.pair == null) continue;
    pairs.set(h.pair.pairId, [...(pairs.get(h.pair.pairId) ?? []), h]);
  }
  const done = new Set<number>();
  for (const h of history) {
    if (h.pair != null) {
      if (done.has(h.pair.pairId)) continue;
      done.add(h.pair.pairId);
      // History is newest first: the first half seen is the latest, the item's id.
      const halves = pairs.get(h.pair.pairId) ?? [h];
      const latest = halves[0]!;
      const status = pairStatus(halves);
      out.push({
        key: `own-${latest.id}`,
        target: { kind: 'own', id: latest.id },
        runIds: halves.map((x) => x.id),
        you: true,
        poster: null,
        who: 'You',
        verdict: status === 'succeeded' ? (halves.find((x) => x.verdict != null)?.verdict ?? null) : null,
        status,
        sha: latest.headSha ? latest.headSha.slice(0, 7) : null,
        at: latest.finishedAt ?? latest.createdAt,
        what: PAIR_RUN_LABEL,
        auto: latest.trigger === 'auto',
      });
      continue;
    }
    out.push({
      key: `own-${h.id}`,
      target: { kind: 'own', id: h.id },
      runIds: [h.id],
      you: true,
      poster: null,
      who: 'You',
      verdict: h.status === 'succeeded' && h.kind !== 'replies' ? h.verdict : null,
      status: h.status,
      sha: h.headSha ? h.headSha.slice(0, 7) : null,
      at: h.finishedAt ?? h.createdAt,
      what: h.kind === 'replies' ? REPLIES_WORD : h.reviewMode === 'skip' ? 'Skipped' : aiRunProviderName(h),
      auto: h.trigger === 'auto',
    });
  }
  for (const t of teammateReviews) {
    const provider = t.runs[0]?.provider ?? null;
    out.push({
      key: `mate-${t.reviewId}`,
      target: { kind: 'teammate', reviewId: t.reviewId },
      runIds: [],
      you: false,
      poster: t.poster,
      who: teammateName(t.poster),
      verdict: t.verdict,
      status: 'succeeded',
      sha: t.headSha ? t.headSha.slice(0, 7) : null,
      at: t.postedAt,
      what: t.pair ? PAIR_RUN_LABEL : provider != null ? aiProviderName(provider) : null,
      auto: t.run === 'auto',
    });
  }
  // Stable: equal times keep the reader's order (newest first), then teammates'.
  return out.map((x, i) => ({ x, i })).sort((a, b) => b.x.at.localeCompare(a.x.at) || a.i - b.i).map(({ x }) => x);
}

const STATUS_WORD: Record<ClaudeReviewStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** After the name: "Request changes · 3 Nov · 8a8ec14 · Claude + Codex · Auto review", or "Running · …". */
export function reviewListLine(item: ReviewListItem): string {
  const outcome = item.status !== 'succeeded' ? STATUS_WORD[item.status] : item.verdict != null ? CLAUDE_VERDICT_LABEL[item.verdict] : null;
  return [outcome, shortDay(item.at), item.sha, item.what, item.auto ? AUTO_WORD : null]
    .filter((x): x is string => x != null && x !== '')
    .join(' · ');
}

/** Does `shown` stand for this item (a pair: either half)? */
/**
 * WHICH ROW IS NOW: the row holding the reader's latest FULL review (either half of a pair) — what
 * the tab shows with nothing picked. With no review of the reader's, the newest teammate review (the
 * team-only view). Never by position: a replies pass newer than the latest full review is listed
 * first, yet it is a past run.
 */
export function nowReviewKey(items: readonly ReviewListItem[], latestReviewId: number | null): string | null {
  if (latestReviewId != null) return items.find((i) => i.runIds.includes(latestReviewId))?.key ?? null;
  return items.find((i) => i.target.kind === 'teammate')?.key ?? null;
}

export function itemShows(item: ReviewListItem, shown: ShownReview): boolean {
  if (shown.kind !== item.target.kind) return false;
  return shown.kind === 'own' ? item.runIds.includes(shown.id) : item.target.kind === 'teammate' && item.target.reviewId === shown.reviewId;
}

// ---- NEWEST ALWAYS SHOWS ----

/**
 * What identifies the newest review on the PR: the reader's latest run (a new row appears the moment a
 * run is queued, by them or by auto review) and the newest teammate review imported. null = none.
 */
export function newestReviewKey(
  latestOwnId: number | null,
  teammateReviews: readonly Pick<ClaudeTeammateReview, 'reviewId' | 'postedAt'>[] | null | undefined,
): string | null {
  let mate: Pick<ClaudeTeammateReview, 'reviewId' | 'postedAt'> | null = null;
  for (const t of teammateReviews ?? []) if (mate == null || t.postedAt > mate.postedAt) mate = t;
  if (latestOwnId == null && mate == null) return null;
  return `${latestOwnId ?? '-'}|${mate?.reviewId ?? '-'}`;
}

/**
 * The review to show next (null = now). A past review the reader picked stays until a NEWER review
 * starts or lands — their own (queued, running, auto or manual) or a teammate's newly imported — which
 * takes over. `previousKey` is the key at the last read (null before the first one).
 */
export function nextShownReview(args: {
  shown: ShownReview | null;
  newestKey: string | null;
  previousKey: string | null;
}): ShownReview | null {
  const { shown, newestKey, previousKey } = args;
  if (shown == null) return null;
  if (previousKey != null && newestKey !== previousKey) return null;
  return shown;
}
