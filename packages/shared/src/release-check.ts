// THE RELEASE CHECK (docs/RELEASES.md § The release check) — ONE pure fold, DB-only inputs. AUTOMATIC
// and deterministic: no start tag, no AI, no window.
//
// ONLY THE WORKSPACE'S RELEASABLE REPOSITORIES are folded ("Released from this workspace", Settings →
// Releases); the caller hands in no other. EACH REPOSITORY IS JUDGED ON ITS OWN:
//
//   1. BASELINE = the newest RELEASE tag (`<tag><release suffix>`) whose commit is on the default
//      branch. None ⇒ NO baseline, and the walk starts at the OLDEST version tag on the default branch.
//   2. Walk the version tags after the baseline OLDEST → NEWEST. A tag's increment is what it adds since
//      the version tag before it (or the baseline; the oldest tag with no base: everything merged into
//      the default branch up to it). The FIRST tag whose increment holds
//        • a PR linked to a ticket that is not Complete (`done` — the This Sprint stage resolver's
//          Complete ONLY; Cancelled and every other stage hold),
//        • a ticket the tracker refused or failed to read (`not_found` / `no_access` / `failed`),
//        • a PR that could not be read from GitHub, or
//        • more commits than can be read (`too_large`)
//      HOLDS ITSELF AND EVERY LATER TAG (tags are cumulative).
//   3. The CANDIDATE is the tag just before it; nothing holds ⇒ the latest version tag.
//   Work not done yet — a tag whose place on the default branch is unknown, an increment the history
//   pass has not finished, a ticket not read yet — is CHECKING, never a blocker: the walk stops there,
//   so a candidate proven so far is shown with "Still reading later tags", and with none the row says
//   "Checking…". NEWEST FIRST, AN EARLY UPPER LIMIT: the history pass reads the default branch newest
//   first, so before it reaches the baseline (or the root) the newest tags are known first. H = the
//   oldest HELD tag found so far (tags are cumulative: every tag at or after H is held) ⇒ the
//   candidate can be at most the tag just before H (`upperLimit`; the latest tag when none is held).
//   Once the pass is complete and every ticket read, the candidate is confirmed.
//   A ticket "not read yet" while the workspace's tracker cannot read at all is unreadable (it holds).
//   Authorship never changes a block (a bot PR on a not-done ticket blocks). A human PR with no ticket
//   is a WARNING; a bot PR with no ticket is listed under "Dependency and bot changes"; commits with no
//   PR (direct pushes) are a note. A PR into any other branch (a hotfix branch) is in no stored range.
//
// RANGES are the per-tag INCREMENTS (previous default-branch tag, tag], derived from the history pass's
// walked commits (backend releases/history-fold.ts). An increment missing (the pass has not passed the
// tag below it yet) or stale (its tag moved, or its base is no longer the previous tag) is pending.
//
// PROGRESS. The fold derives, from the same stored rows, what is left per repository (`progress`: the
// first unfinished step of history → tickets, with `releaseScanLine`'s words); the backend overlays the
// scan's live step (sync/release-history.ts) when it is fresher.
//
// The fold never reads the clock and never fetches. Timestamps come in as Date and go out as ISO-8601.
import { tagKind, releaseTagName, type ReleaseSettings, type TagKind } from './releases.js';

/** A ticket's read state, as `tracker_tickets.state` stores it; `not_read` = no row on the site. */
export type ReleaseTicketReadState = 'ok' | 'not_found' | 'no_access' | 'failed' | 'not_read';

export interface TagOrderKey {
  name: string;
  committedAt: Date | null;
  taggedAt: Date | null;
}

/** Oldest first: commit date, then tag date (a lightweight tag sorts first), then name. Pure. THE ONE
 *  tag order — the history view (backend releases/history-fold.ts) and the release check share it. */
export function compareTagOrder(a: TagOrderKey, b: TagOrderKey): number {
  const ca = a.committedAt?.getTime() ?? 0;
  const cb = b.committedAt?.getTime() ?? 0;
  if (ca !== cb) return ca - cb;
  const ta = a.taggedAt?.getTime() ?? 0;
  const tb = b.taggedAt?.getTime() ?? 0;
  if (ta !== tb) return ta - tb;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * THE BASELINE of one repository (pure; the fold and the range planner share it): the ordered index
 * of the newest RELEASE tag on the default branch, −1 = none. `ordered` = the tags on the default
 * branch with a commit date, oldest first (`compareTagOrder`).
 */
export function releaseBaselineOf(ordered: readonly TagOrderKey[], settings: ReleaseSettings): number {
  let idx = -1;
  for (let i = 0; i < ordered.length; i += 1) if (tagKind(ordered[i]!.name, settings) === 'release') idx = i;
  return idx;
}

/** One workspace's view of a repository the range planner serves: its suffixes. */
export interface ReleaseRangeView {
  workspaceId?: number;
  settings: ReleaseSettings;
}

/**
 * The oldest index of `ordered` (default-branch tags, oldest first by `compareTagOrder`) that must have a
 * stored range, given every workspace that RELEASES this repository: just after the OLDEST baseline any
 * of them gives, 0 for one with no baseline (the whole history). No such workspace ⇒ `ordered.length`
 * (no range is needed at all). Pure.
 */
export function tagRangeKeepFrom(ordered: readonly TagOrderKey[], views: readonly ReleaseRangeView[]): number {
  let from = ordered.length;
  for (const v of views) {
    const b = releaseBaselineOf(ordered, v.settings);
    from = Math.min(from, b >= 0 ? b + 1 : 0);
  }
  return from;
}

/**
 * A repository's LATEST RELEASE (docs/RELEASES.md § Words): the newest release OR hotfix tag, on ANY
 * branch, by `compareTagOrder` (the tagged commit's date, ties by tag creation). The hotfix base. null when
 * the suffixes are not both set or the repository has no such tag. Pure — THE ONE rule, shared by the
 * release check and the hotfix bases (hotfix.ts).
 */
export function latestReleaseTag<T extends TagOrderKey>(tags: readonly T[], settings: ReleaseSettings): { tag: T; kind: 'release' | 'hotfix' } | null {
  let best: { tag: T; kind: 'release' | 'hotfix' } | null = null;
  for (const t of tags) {
    const k = tagKind(t.name, settings);
    if (k !== 'release' && k !== 'hotfix') continue;
    if (best == null || compareTagOrder(best.tag, t) < 0) best = { tag: t, kind: k };
  }
  return best;
}

// ── Progress ────────────────────────────────────────────────────────────────────────────────────

/** The scan's steps, in the order they run for a repository: ONE pass over the default branch's
 *  history, then the tickets (read in batches). */
export type ReleaseScanStep = 'history' | 'tickets';
export const RELEASE_SCAN_STEPS: readonly ReleaseScanStep[] = ['history', 'tickets'];

/** What the scan of one repository is doing now: one step, its counts and ONE short line. */
export interface ReleaseScanProgress {
  step: ReleaseScanStep;
  done: number;
  total: number;
  line: string;
}

export interface ReleaseScanLineInput {
  step: ReleaseScanStep;
  done: number;
  total: number;
  /** history: the default branch's name ("main"). */
  branch?: string | null;
  /** tickets: the workspace's tracker ("Jira"). */
  tracker?: string | null;
  /** GitHub's rate budget is spent: the step waits. */
  paused?: boolean;
}

/** A count with thousands separators ("5,400"). Pure (no locale). */
export function releaseCount(n: number): string {
  return String(Math.max(0, Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The ONE line for a scan step: "Reading main's history: 1,200 of 5,400 commits", "Reading tickets
 *  from Jira: 300 of 420". Pure. */
export function releaseScanLine(p: ReleaseScanLineInput): string {
  const done = releaseCount(Math.min(p.done, p.total));
  const total = releaseCount(p.total);
  const what = p.step === 'history' ? `Reading ${p.branch ?? 'the default branch'}'s history` : `Reading tickets from ${p.tracker ?? 'the tracker'}`;
  // No total yet (the first page has not answered): the words alone.
  const line = p.total <= 0 ? what : p.step === 'history' ? `${what}: ${done} of ${total} commits` : `${what}: ${done} of ${total}`;
  return p.paused === true ? `${line} (waiting for GitHub's rate limit)` : line;
}

/** A step's share done, 0–100 (the upper-limit line's "(40%)"). Pure. */
export function releaseProgressPercent(p: Pick<ReleaseScanProgress, 'done' | 'total'>): number {
  if (p.total <= 0) return 0;
  return Math.max(0, Math.min(99, Math.floor((p.done / p.total) * 100)));
}

// ── Input ──────────────────────────────────────────────────────────────────────────────────────

export interface ReleaseCheckTagInput extends TagOrderKey {
  sha: string;
  /** null = not known yet (the walk stops there: checking). */
  onDefaultBranch: boolean | null;
  /** The tag was moved to another commit since Ensemble first saw it. */
  moved: boolean;
}

export interface ReleaseCheckRangeInput {
  tagName: string;
  sha: string;
  baseTagName: string | null;
  baseSha: string | null;
  /** 'walk' = derived from the history pass; 'compare' / 'history' are the older stored kinds. */
  method: 'compare' | 'history' | 'walk';
  prIds: number[];
  /** PR numbers in the range with no record yet (checking until there is one). */
  unresolvedPrNumbers: number[];
  unmatchedCommits: number;
  truncated: boolean;
}

export interface ReleaseCheckRepoInput {
  repoId: number;
  /** `owner/name`. */
  fullName: string;
  /** The short name used in sentences ("api"). */
  name: string;
  /** The default branch's name, for the progress line ("main"). */
  defaultBranch?: string | null;
  /** The reader can push here (the synced permission): "Create release…" shows only then. */
  writable: boolean;
  tags: ReleaseCheckTagInput[];
  ranges: ReleaseCheckRangeInput[];
  /** The history pass (commits walked of an estimate). `complete` = it reached this workspace's
   *  baseline or the root, and no newer head is still being read. Absent = complete. */
  history?: { done: number; total: number; complete: boolean } | null;
}

export interface ReleaseCheckPrInput {
  /** The range PR's record id (`release_range_prs`): unique in the check. */
  id: number;
  /** Its full `pull_requests` row, when one is stored (the PR tab opens it); null = only the light
   *  record (the link goes to GitHub). */
  prId?: number | null;
  repoId: number;
  number: number;
  title: string;
  url: string;
  /** By author through the GLOBAL automation set, never the hidden-bots list. */
  isBot: boolean;
  /** The PR's base is the repo's default branch. */
  intoDefaultBranch: boolean;
  state: 'open' | 'merged' | 'closed';
  mergedAt: Date | null;
  /** Ticket idents the PR names (`trackerTicketIdent`). */
  ticketIdents: string[];
}

export interface ReleaseCheckTicketInput {
  ident: string;
  key: string;
  title: string | null;
  url: string | null;
  statusName: string | null;
  /** In the workspace's Complete stage — Complete ONLY: a Cancelled ticket ("Won't Do") is false. */
  done: boolean;
  readState: ReleaseTicketReadState;
}

export interface ReleaseCheckInput {
  settings: ReleaseSettings;
  /** The workspace's RELEASABLE repositories only. */
  repos: ReleaseCheckRepoInput[];
  /** Every PR in a stored range. */
  prs: ReleaseCheckPrInput[];
  tickets: ReleaseCheckTicketInput[];
  /** The workspace's tracker can read tickets (default true). False ⇒ a ticket not read yet will never
   *  be read: it HOLDS (unreadable), never "checking" forever. */
  ticketsReadable?: boolean;
  /** The tracker's name for the progress line ("Jira"). */
  trackerName?: string | null;
}

// ── Output ──────────────────────────────────────────────────────────────────────────────────────

/** Why a version tag is held back. */
export type ReleaseBlocker =
  | { kind: 'not_done'; ident: string; key: string; statusName: string | null }
  | { kind: 'unreadable'; ident: string; key: string; reason: Exclude<ReleaseTicketReadState, 'ok'> }
  /** A range PR GitHub could not give: its tickets are unknown. (No longer produced since the one
   *  history pass, which reads every PR with its commit; kept for the words.) */
  | { kind: 'pr_unreadable'; number: number }
  /** The tag's range has more commits than are read (`truncated`): its changes cannot be checked. (No
   *  longer produced by the history pass; kept for older rows and the words.) */
  | { kind: 'too_large'; tagName: string };

export type ReleaseWarning = { kind: 'untracked_pr'; repoId: number; prId: number };

export interface ReleaseTagRef {
  name: string;
  sha: string;
  committedAt: string | null;
}

/** clear (nothing of its own holds it) · held (its own blockers) · checking (its own changes are not
 *  all read yet, and nothing of its own holds it). */
export type ReleaseTagState = 'clear' | 'held' | 'checking';

export interface ReleaseTagCheck extends ReleaseTagRef {
  moved: boolean;
  isCandidate: boolean;
  /** Not in the release: held by itself, by an earlier tag, or after a tag still being checked. */
  blocked: boolean;
  /** Its OWN state. */
  state: ReleaseTagState;
  /** What this tag ADDS (since the previous version tag or the baseline) that holds it back. */
  blockers: ReleaseBlocker[];
  /** Earlier held tags' own blockers this tag also contains (tags are cumulative), first tag first. */
  alsoHeldBy: Array<{ blocker: ReleaseBlocker; fromTag: string }>;
  /** This tag's increment's PRs (since the previous version tag or the baseline). */
  prIds: number[];
  /** Ticket idents on those PRs. */
  ticketIdents: string[];
  /** Its changes are not all read yet. */
  pending: boolean;
  /** Commits with no pull request (direct pushes): a note only. */
  unmatchedCommits: number;
  truncated: boolean;
  /** Range PRs not fetched yet. */
  unresolvedPrCount: number;
}

/** candidate · blocked (the first tag after the baseline is held: no tag can be released) · checking
 *  (no candidate yet, and the first tag is still being read) · nothing_new. */
export type ReleaseRepoStatus = 'candidate' | 'blocked' | 'checking' | 'nothing_new';

export interface ReleaseRepoCheck {
  repoId: number;
  fullName: string;
  name: string;
  writable: boolean;
  status: ReleaseRepoStatus;
  /** `nothing_new` only: no version tag on the default branch at all, or none after the baseline. */
  nothingNewReason: 'no_tags' | 'no_new_tags' | null;
  /** The newest version tag on the default branch (null = none). */
  latestVersion: ReleaseTagRef | null;
  /** The oldest version tag after the baseline (the walk's first tag); null = none. */
  firstVersion: ReleaseTagRef | null;
  /** The newest release tag on the default branch; null = none (the whole history is checked). */
  baseline: ReleaseTagRef | null;
  /** The newest release OR hotfix tag (any branch) — the hotfix base. */
  latestRelease: (ReleaseTagRef & { kind: 'release' | 'hotfix' }) | null;
  candidate: (ReleaseTagRef & { releaseTagName: string; releaseTagExists: boolean }) | null;
  /** The first held-back version tag (by its own blockers); null = none held. */
  firstBlocked: string | null;
  /** That tag's first blocker (the row's sentence). */
  firstBlocker: ReleaseBlocker | null;
  /** Some work is left (the history pass, tickets): the tab polls while any repo is checking. */
  checking: boolean;
  /** While checking with no confirmed candidate: the newest tag the candidate can still be — the tag
   *  just before the oldest held tag found so far (`heldFrom`), or the latest version tag when none is
   *  held. null when the tag before `heldFrom` is not known yet, or nothing is checking. */
  upperLimit: ReleaseTagRef | null;
  /** The oldest held version tag found so far (its own blockers): it and every later tag are held. */
  heldFrom: string | null;
  /** What the scan is doing now (null = nothing left). */
  progress: ReleaseScanProgress | null;
  /** Version tags after the baseline, NEWEST first. */
  tags: ReleaseTagCheck[];
  /** Tickets in (baseline, candidate]. */
  ticketIdents: string[];
  /** Human PRs with no ticket in (baseline, candidate]. */
  untrackedPrIds: number[];
  /** Bot PRs with no ticket in (baseline, candidate] — "Dependency and bot changes". */
  botPrIds: number[];
  /** Commits with no PR in (baseline, candidate] — a note. */
  directCommits: number;
  warningCount: number;
}

/** A ticket in one repository: in that repository's candidate, or in a tag after it. */
export type ReleaseTicketRepoState = 'in_candidate' | 'after_candidate';

export interface ReleaseTicketCheck {
  ident: string;
  key: string;
  title: string | null;
  url: string | null;
  statusName: string | null;
  done: boolean;
  readState: ReleaseTicketReadState;
  /** Done and readable. */
  ready: boolean;
  /** Ready and in at least one repository's candidate. */
  inRelease: boolean;
  /** Not read yet (the tracker will answer): checking, not a blocker. */
  pending: boolean;
  /** Its own state when it holds (not Done, unreadable). */
  blocker: Extract<ReleaseBlocker, { kind: 'not_done' | 'unreadable' }> | null;
  /** Per releasable repository it appears in (after the baseline). */
  repos: Array<{ repoId: number; state: ReleaseTicketRepoState; prIds: number[] }>;
}

export interface ReleaseCheckPr {
  /** The range PR's record id (unique in the check). */
  id: number;
  /** The stored `pull_requests` id (the PR tab), or null (link to `url`). */
  prId: number | null;
  repoId: number;
  number: number;
  title: string;
  url: string;
  isBot: boolean;
  state: 'open' | 'merged' | 'closed';
  mergedAt: string | null;
  ticketIdents: string[];
}

export interface ReleaseCheckResult {
  repos: ReleaseRepoCheck[];
  tickets: ReleaseTicketCheck[];
  /** Warnings for what the release would ship (the candidates). Never block. */
  warnings: ReleaseWarning[];
  prs: ReleaseCheckPr[];
}

// ── The fold ────────────────────────────────────────────────────────────────────────────────────

const iso = (d: Date | null): string | null => (d == null ? null : d.toISOString());
const ref = (t: ReleaseCheckTagInput): ReleaseTagRef => ({ name: t.name, sha: t.sha, committedAt: iso(t.committedAt) });

/** One version tag after the baseline and the ordered indexes its increment spans. */
interface Span {
  tagIdx: number;
  /** Ordered indexes (prevVersionOrBaseline, tagIdx]. */
  from: number;
  /** A compare in the span was truncated: its PRs cannot all be known (holds). */
  tooLarge: boolean;
  /** An increment in the span is missing or stale. */
  rangePending: boolean;
  prIds: number[];
  /** PR numbers with no record yet (checking). */
  waitingPrs: number[];
  unmatched: number;
  truncated: boolean;
}

type TicketBlocker = Extract<ReleaseBlocker, { kind: 'not_done' | 'unreadable' }>;
type TicketVerdict = { kind: 'ok' } | { kind: 'pending' } | { kind: 'held'; blocker: TicketBlocker };

/** Fold ONE releasable repository. Pure. */
function foldRepo(
  repo: ReleaseCheckRepoInput,
  input: ReleaseCheckInput,
  prById: ReadonlyMap<number, ReleaseCheckPrInput>,
  verdictOf: (ident: string) => TicketVerdict,
  readOf: (ident: string) => boolean,
): { out: ReleaseRepoCheck; spans: Span[]; candidateSpan: number } {
  const settings = input.settings;
  const kindOf = (name: string): TagKind | null => tagKind(name, settings);
  const dated = repo.tags.filter((t) => t.committedAt != null);
  const ordered = dated.filter((t) => t.onDefaultBranch === true).sort(compareTagOrder);
  const rangeByName = new Map(repo.ranges.map((r) => [r.tagName, r]));
  const historyComplete = repo.history == null || repo.history.complete;
  const valid = (i: number): ReleaseCheckRangeInput | null => {
    const t = ordered[i]!;
    const prev = i > 0 ? ordered[i - 1]! : null;
    const r = rangeByName.get(t.name);
    if (r == null || r.sha !== t.sha) return null;
    if (r.baseTagName !== (prev?.name ?? null) || r.baseSha !== (prev?.sha ?? null)) return null;
    return r;
  };
  const baselineIdx = releaseBaselineOf(ordered, settings);
  const baselineSha = baselineIdx >= 0 ? ordered[baselineIdx]!.sha : null;
  const firstIdx = baselineIdx + 1;

  // Tags whose ancestry is not known yet: a version or release tag among them stops the walk where it
  // sorts (it may be on the default branch: a version tag to check, or a newer baseline).
  const unknown = dated
    .filter((t) => t.onDefaultBranch == null && (kindOf(t.name) === 'version' || kindOf(t.name) === 'release'))
    .sort(compareTagOrder);
  const baselineTag = baselineIdx >= 0 ? ordered[baselineIdx]! : null;
  const unknownAfterBase = unknown.filter((t) => baselineTag == null || compareTagOrder(baselineTag, t) < 0);

  // A PR is counted in the FIRST increment that holds it.
  const pos = new Map<number, number>();
  for (let i = firstIdx; i < ordered.length; i += 1) {
    const r = valid(i);
    if (r != null) for (const id of r.prIds) if (!pos.has(id)) pos.set(id, i);
  }
  const numberPos = new Map<number, number>();
  for (let i = firstIdx; i < ordered.length; i += 1) {
    const r = valid(i);
    if (r != null) for (const n of r.unresolvedPrNumbers) if (!numberPos.has(n)) numberPos.set(n, i);
  }

  const spans: Span[] = [];
  let from = firstIdx;
  for (let i = firstIdx; i < ordered.length; i += 1) {
    const t = ordered[i]!;
    if (kindOf(t.name) !== 'version' || t.sha === baselineSha) continue;
    const span: Span = { tagIdx: i, from, tooLarge: false, rangePending: false, prIds: [], waitingPrs: [], unmatched: 0, truncated: false };
    for (let j = from; j <= i; j += 1) {
      const r = valid(j);
      if (r == null) {
        span.rangePending = true;
        continue;
      }
      if (r.truncated) span.tooLarge = true;
      for (const id of r.prIds) if (pos.get(id) === j && !span.prIds.includes(id)) span.prIds.push(id);
      for (const n of r.unresolvedPrNumbers) if (numberPos.get(n) === j) span.waitingPrs.push(n);
      span.unmatched += r.unmatchedCommits;
      span.truncated ||= r.truncated;
    }
    spans.push(span);
    from = i + 1;
  }

  const identsOf = (span: Span): string[] => {
    const out: string[] = [];
    for (const id of span.prIds) for (const ident of prById.get(id)?.ticketIdents ?? []) if (!out.includes(ident)) out.push(ident);
    return out;
  };
  const ownBlockers = (span: Span): ReleaseBlocker[] => {
    const out: ReleaseBlocker[] = [];
    if (span.tooLarge) out.push({ kind: 'too_large', tagName: ordered[span.tagIdx]!.name });
    for (const ident of identsOf(span)) {
      const v = verdictOf(ident);
      if (v.kind === 'held') out.push(v.blocker);
    }
    return out;
  };
  const ownPending = (span: Span): boolean =>
    span.rangePending || span.waitingPrs.length > 0 || identsOf(span).some((ident) => verdictOf(ident).kind === 'pending');
  /** An unknown-ancestry tag sorting at or before this span's tag: the walk cannot pass it yet. */
  const unknownBefore = (span: Span): boolean => {
    const t = ordered[span.tagIdx]!;
    return unknownAfterBase.some((u) => compareTagOrder(u, t) <= 0);
  };

  // THE WALK, oldest first: the first held tag holds every later one; a tag still being read stops the
  // candidate there (it may yet be clear).
  let candidateSpan = -1;
  let firstHeld = -1;
  let stoppedAt = -1;
  const states: ReleaseTagState[] = [];
  for (let s = 0; s < spans.length; s += 1) {
    const span = spans[s]!;
    const blockers = ownBlockers(span);
    const state: ReleaseTagState = blockers.length > 0 ? 'held' : ownPending(span) || unknownBefore(span) ? 'checking' : 'clear';
    states.push(state);
    if (stoppedAt >= 0 || firstHeld >= 0) continue;
    if (state === 'held') firstHeld = s;
    else if (state === 'checking') stoppedAt = s;
    else candidateSpan = s;
  }
  // An unknown tag after every span (no span past it) still stops nothing already proven, but leaves
  // work: counted in `checking` below.

  const heldSoFar: Array<{ blocker: ReleaseBlocker; fromTag: string }> = [];
  const tagsOut: ReleaseTagCheck[] = spans.map((span, s) => {
    const t = ordered[span.tagIdx]!;
    const blockers = ownBlockers(span);
    const alsoHeldBy = heldSoFar.slice();
    for (const b of blockers) {
      const id = blockerId(b);
      if (!heldSoFar.some((h) => blockerId(h.blocker) === id)) heldSoFar.push({ blocker: b, fromTag: t.name });
    }
    return {
      ...ref(t),
      moved: t.moved,
      isCandidate: s === candidateSpan,
      blocked: s > candidateSpan,
      state: states[s]!,
      blockers,
      alsoHeldBy: alsoHeldBy.filter((h) => !blockers.some((b) => blockerId(b) === blockerId(h.blocker))),
      prIds: [...span.prIds],
      ticketIdents: identsOf(span),
      pending: ownPending(span),
      unmatchedCommits: span.unmatched,
      truncated: span.truncated,
      unresolvedPrCount: span.waitingPrs.length,
    };
  });

  const ticketIdents: string[] = [];
  const untrackedPrIds: number[] = [];
  const botPrIds: number[] = [];
  let directCommits = 0;
  for (const span of candidateSpan >= 0 ? spans.slice(0, candidateSpan + 1) : []) {
    directCommits += span.unmatched;
    for (const id of span.prIds) {
      const p = prById.get(id);
      if (p == null) continue;
      if (p.ticketIdents.length === 0) (p.isBot ? botPrIds : untrackedPrIds).push(id);
      for (const ident of p.ticketIdents) if (!ticketIdents.includes(ident)) ticketIdents.push(ident);
    }
  }

  const candTag = candidateSpan >= 0 ? ordered[spans[candidateSpan]!.tagIdx]! : null;
  const suffix = settings.releaseSuffix ?? '';
  const candidate =
    candTag == null
      ? null
      : {
          ...ref(candTag),
          releaseTagName: releaseTagName(candTag.name, suffix),
          releaseTagExists: repo.tags.some((t) => t.name === releaseTagName(candTag.name, suffix)),
        };
  const versions = ordered.filter((t) => kindOf(t.name) === 'version');
  const latestVersion = versions.length > 0 ? ref(versions[versions.length - 1]!) : null;

  // PROGRESS, derived from the stored rows: the first unfinished step.
  const progress = deriveProgress({ repo, input, spans, identsOf, readOf });
  const checking = progress != null || !historyComplete || states.some((st) => st === 'checking') || unknownAfterBase.length > 0;

  // The first tag after the baseline is held, and nothing older can still turn up: no tag can be released.
  const provenBlocked = firstHeld === 0 && historyComplete && !unknownBefore(spans[0]!);
  const status: ReleaseRepoStatus =
    candidate != null
      ? 'candidate'
      : provenBlocked
        ? 'blocked'
        : spans.length === 0 && unknownAfterBase.length === 0 && historyComplete
          ? 'nothing_new'
          : spans.length === 0 || stoppedAt >= 0 || unknownAfterBase.length > 0 || !historyComplete || firstHeld === 0
            ? 'checking'
            : 'blocked';
  // THE EARLY UPPER LIMIT: H = the oldest held tag found so far; the candidate is at most the one
  // before it (the latest when none is held).
  const oldestHeld = states.indexOf('held');
  const upperSpan = status !== 'checking' ? null : oldestHeld < 0 ? spans[spans.length - 1] ?? null : oldestHeld > 0 ? spans[oldestHeld - 1]! : null;
  const latestHit = latestReleaseTag(repo.tags, settings);
  const heldSpan = firstHeld >= 0 ? spans[firstHeld]! : null;
  const heldBlockers = heldSpan != null ? ownBlockers(heldSpan) : [];
  const firstSpan = spans[0] ?? null;
  const out: ReleaseRepoCheck = {
    repoId: repo.repoId,
    fullName: repo.fullName,
    name: repo.name,
    writable: repo.writable,
    status,
    nothingNewReason: status !== 'nothing_new' ? null : latestVersion == null ? 'no_tags' : 'no_new_tags',
    latestVersion,
    firstVersion: firstSpan != null ? ref(ordered[firstSpan.tagIdx]!) : null,
    baseline: baselineTag != null ? ref(baselineTag) : null,
    latestRelease: latestHit != null ? { ...ref(latestHit.tag), kind: latestHit.kind } : null,
    candidate,
    firstBlocked: heldSpan != null ? ordered[heldSpan.tagIdx]!.name : null,
    firstBlocker: heldBlockers[0] ?? null,
    checking,
    upperLimit: upperSpan != null ? ref(ordered[upperSpan.tagIdx]!) : null,
    heldFrom: oldestHeld >= 0 ? ordered[spans[oldestHeld]!.tagIdx]!.name : null,
    progress,
    tags: tagsOut.reverse(),
    ticketIdents,
    untrackedPrIds,
    botPrIds,
    directCommits,
    warningCount: 0,
  };
  return { out, spans, candidateSpan };
}

function blockerId(b: ReleaseBlocker): string {
  switch (b.kind) {
    case 'not_done':
    case 'unreadable':
      return `t:${b.ident}`;
    case 'pr_unreadable':
      return `p:${b.number}`;
    case 'too_large':
      return `l:${b.tagName}`;
  }
}

/** The first unfinished step of one repository's scan, from the stored rows: the history pass, then
 *  the tickets. Pure. */
function deriveProgress(a: {
  repo: ReleaseCheckRepoInput;
  input: ReleaseCheckInput;
  spans: Span[];
  identsOf: (span: Span) => string[];
  readOf: (ident: string) => boolean;
}): ReleaseScanProgress | null {
  const h = a.repo.history;
  if (h != null && !h.complete) {
    const total = h.total <= 0 ? 0 : Math.max(h.total, h.done + 1);
    const p = { step: 'history' as const, done: h.done, total, branch: a.repo.defaultBranch ?? null };
    return { step: p.step, done: p.done, total: p.total, line: releaseScanLine(p) };
  }
  const idents = new Set<string>();
  for (const s of a.spans) for (const ident of a.identsOf(s)) idents.add(ident);
  let read = 0;
  for (const ident of idents) if (a.readOf(ident)) read += 1;
  if (read < idents.size && a.input.ticketsReadable !== false) {
    const p = { step: 'tickets' as const, done: read, total: idents.size, tracker: a.input.trackerName ?? null };
    return { step: p.step, done: p.done, total: p.total, line: releaseScanLine(p) };
  }
  return null;
}

/** Run the release check. Pure. */
export function foldReleaseCheck(input: ReleaseCheckInput): ReleaseCheckResult {
  const prById = new Map(input.prs.map((p) => [p.id, p]));
  const ticketByIdent = new Map(input.tickets.map((t) => [t.ident, t]));
  const readable = input.ticketsReadable !== false;
  const ticketOf = (ident: string): ReleaseCheckTicketInput =>
    ticketByIdent.get(ident) ?? { ident, key: ident, title: null, url: null, statusName: null, done: false, readState: 'not_read' };
  const verdictOf = (ident: string): TicketVerdict => {
    const t = ticketOf(ident);
    if (t.readState === 'not_read') return readable ? { kind: 'pending' } : { kind: 'held', blocker: { kind: 'unreadable', ident, key: t.key, reason: 'not_read' } };
    if (t.readState !== 'ok') return { kind: 'held', blocker: { kind: 'unreadable', ident, key: t.key, reason: t.readState } };
    if (!t.done) return { kind: 'held', blocker: { kind: 'not_done', ident, key: t.key, statusName: t.statusName } };
    return { kind: 'ok' };
  };
  const readOf = (ident: string): boolean => ticketOf(ident).readState !== 'not_read';

  const warnings: ReleaseWarning[] = [];
  const repos: ReleaseRepoCheck[] = [];
  /** ident → per repo: state and PRs. */
  const ticketRepos = new Map<string, Map<number, { state: ReleaseTicketRepoState; prIds: number[] }>>();
  const population: string[] = [];
  for (const repo of input.repos) {
    const { out, spans, candidateSpan } = foldRepo(repo, input, prById, verdictOf, readOf);
    spans.forEach((span, s) => {
      for (const id of span.prIds) {
        for (const ident of prById.get(id)?.ticketIdents ?? []) {
          if (!ticketRepos.has(ident)) {
            ticketRepos.set(ident, new Map());
            population.push(ident);
          }
          const per = ticketRepos.get(ident)!;
          const state: ReleaseTicketRepoState = s <= candidateSpan ? 'in_candidate' : 'after_candidate';
          const cur = per.get(repo.repoId);
          if (cur == null) per.set(repo.repoId, { state, prIds: [id] });
          else {
            if (!cur.prIds.includes(id)) cur.prIds.push(id);
            // A ticket split across the candidate is "after" for the repository: not all of it ships.
            if (state === 'after_candidate') cur.state = 'after_candidate';
          }
        }
      }
    });
    for (const prId of out.untrackedPrIds) warnings.push({ kind: 'untracked_pr', repoId: repo.repoId, prId });
    out.warningCount = out.untrackedPrIds.length;
    repos.push(out);
  }

  const tickets: ReleaseTicketCheck[] = population.map((ident) => {
    const t = ticketOf(ident);
    const v = verdictOf(ident);
    const per = [...(ticketRepos.get(ident) ?? new Map()).entries()]
      .sort((a, z) => a[0] - z[0])
      .map(([repoId, x]) => ({ repoId, state: x.state, prIds: [...x.prIds].sort((p, q) => p - q) }));
    return {
      ident,
      key: t.key,
      title: t.title,
      url: t.url,
      statusName: t.statusName,
      done: t.done,
      readState: t.readState,
      ready: v.kind === 'ok',
      inRelease: v.kind === 'ok' && per.some((r) => r.state === 'in_candidate'),
      pending: v.kind === 'pending',
      blocker: v.kind === 'held' ? v.blocker : null,
      repos: per,
    };
  });

  const prs: ReleaseCheckPr[] = input.prs.map((p) => ({
    id: p.id,
    prId: p.prId ?? null,
    repoId: p.repoId,
    number: p.number,
    title: p.title,
    url: p.url,
    isBot: p.isBot,
    state: p.state,
    mergedAt: iso(p.mergedAt),
    ticketIdents: [...p.ticketIdents],
  }));
  return { repos, tickets, warnings, prs };
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────────

export interface ReleaseWordsContext {
  repoName: (repoId: number) => string;
  prNumber: (prId: number) => number | null;
}

const READ_WORDS: Record<Exclude<ReleaseTicketReadState, 'ok'>, string> = {
  not_found: 'it was not found',
  no_access: 'there is no access to it',
  failed: 'the tracker did not answer',
  not_read: 'the tracker cannot read it',
};

/** One plain sentence for a blocker. Pure. */
export function releaseBlockerText(b: ReleaseBlocker, _ctx?: ReleaseWordsContext): string {
  switch (b.kind) {
    case 'too_large':
      return `${b.tagName} has more commits than can be read, so its changes cannot be checked.`;
    case 'pr_unreadable':
      return `Pull request #${b.number} could not be read from GitHub.`;
    case 'not_done':
      return b.statusName != null ? `${b.key} is not done (${b.statusName}).` : `${b.key} is not done.`;
    case 'unreadable':
      return `${b.key} could not be read: ${READ_WORDS[b.reason]}.`;
  }
}

/** A blocker in a few words, after "contains": "BMD-127 (In Progress)", "#88, which could not be read".
 *  Pure. */
export function releaseBlockerShort(b: ReleaseBlocker): string {
  switch (b.kind) {
    case 'not_done':
      return b.statusName != null ? `${b.key} (${b.statusName})` : `${b.key} (not done)`;
    case 'unreadable':
      return `${b.key}, which could not be read`;
    case 'pr_unreadable':
      return `#${b.number}, which could not be read`;
    case 'too_large':
      return 'more commits than can be read';
  }
}

// ── The wire ────────────────────────────────────────────────────────────────────────────────────

/** GET /api/releases?workspace=<id> — DB only, never fetches GitHub or the tracker. */
export interface ReleasesResponse {
  workspaceId: number;
  /** Both suffixes are set. False → `check` is null and the tab shows its ONE setup line. */
  configured: boolean;
  /** At least one repository is ticked "Released from this workspace". False (and configured) →
   *  `check` is null and the tab shows its ONE setup line. */
  hasReleasableRepos: boolean;
  releaseSuffix: string | null;
  hotfixSuffix: string | null;
  /** The newest release made from this workspace (null = none yet). */
  latestRelease: { id: number; createdAt: string; state: 'writing' | 'done' | 'partial' | 'failed' | 'stopped' } | null;
  /** The newest release or hotfix tag across the releasable repos, by its commit date. */
  latestReleaseTagAt: string | null;
  check: ReleaseCheckResult | null;
}

/** POST /api/releases/refresh?workspace=<id> — Refresh: the held tickets read again from the tracker
 *  (the reader's press), then the check. `unread` = tickets the tracker did not answer for. */
export interface ReleasesRefreshResponse extends ReleasesResponse {
  reread: number;
  unread: string[];
}

/** Any releasable repository still being checked: the tab polls GET /api/releases while true. Pure. */
export function releasesChecking(r: Pick<ReleasesResponse, 'check'> | null | undefined): boolean {
  return r?.check?.repos.some((x) => x.checking) === true;
}
