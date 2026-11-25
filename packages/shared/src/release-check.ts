// THE RELEASE CHECK (docs/RELEASES.md § The release check) — ONE pure fold, DB-only inputs. AUTOMATIC
// and deterministic: no start tag, no AI. THE CUMULATIVE RULE (owner, 2026-11-16): releasing a tag ships
// everything below it, so the candidate is the NEWEST version tag such that it AND every version tag below
// it (down to the last release, or the start of the history) are clear — the tag just below the OLDEST
// blocked tag.
//
// ONLY THE WORKSPACE'S RELEASABLE REPOSITORIES are folded ("Released from this workspace", Settings →
// Releases); the caller hands in no other. EACH REPOSITORY IS JUDGED ON ITS OWN:
//
//   1. BASELINE = the newest RELEASE tag (`<tag><release suffix>`) whose commit is on the default
//      branch, or none.
//   2. Walk the version tags after the baseline NEWEST → OLDEST.
//   3. A tag's SCOPE = the tickets named by every PR merged into the default branch up to the tag:
//        • with a baseline: every PR in (baseline, tag] — the whole content since the last release;
//        • with none: every PR from the start of the history up to the tag (the WHOLE history the tag
//          read reaches: no floor, owner 2026-11-16).
//   4. The tag QUALIFIES when every ticket in its scope that the tracker returned is Complete
//      (`stage === 'done'`) or Cancelled (`stage === 'cancelled'`, "Won't Do": it never stops a tag, owner
//      2026-11-16 — every other stage does not qualify) AND has no OPEN pull
//      request in any of the workspace's releasable repos.
//   5. The FIRST tag that qualifies is the CANDIDATE (every tag below it then qualifies too). The walk
//      stops there. A candidate needs the whole scope read, so the history pass reads to the baseline or
//      the root first.
//   • A ticket the tracker could not give (not found, no access, failed past the retry limit, or a
//     tracker that cannot read at all) does NOT block: it is listed under the tag ("BMD-123 not found")
//     for the reader to check. A ticket NOT READ YET (the tracker will answer) makes the tag CHECKING.
//   • PRs with no ticket (human or bot) never block and are never a warning: listed under the tag.
//   • Work not done yet — a scope the history pass has not read, a ticket not read yet, a tag whose
//     place on the default branch is unknown — is CHECKING: the walk stops at that tag (it may yet
//     qualify). A tag that does not qualify says why ("BMD-1048 is In PO Review"); a reason may come from
//     an earlier tag in its scope ("BMD-1040 (from 0.391.0) is In Progress").
//   • A reason that disqualifies a tag is certain even while other parts of its scope are still read
//     (more reading only adds tickets), so a tag can be ruled out early.
//
// PICKED TOGETHER (owner, 2026-11-16): no Complete ticket may ship half. After each repository's own walk, a
// ticket with merged work AT OR BELOW one repository's candidate and merged work ABOVE ANOTHER releasable
// repository's candidate ("not in a tag yet" and a repository with no candidate count as above) blocks — as
// `split` — the tags that hold it in each repository where part of it would ship. Later work in the SAME
// repository never splits (owner, 2026-11-23): releasing a tag ships everything below it, so that work is
// just the next increment (BNG: BMD-887's bng-library #129, three months after #28, pulled every repository
// back to June). The candidates are walked again until nothing changes (they only ever move down, so it ends). A repository
// still CHECKING, or with no version tags, takes no part yet. Cancelled and not-found tickets never block, so
// they are never split either.
//
// RANGES are the per-tag INCREMENTS (previous default-branch tag, tag], derived from the history pass's
// walked commits (backend releases/history-fold.ts). An increment missing (the pass has not passed the
// tag below it yet) or stale (its tag moved, or its base is no longer the previous tag) is not read yet.
//
// PROGRESS. While a repository is checking, the fold derives what it waits for (`progress`: the history
// pass or the tickets, with `releaseScanLine`'s words); the backend overlays the scan's live step.
//
// THE ROW'S THREE BANDS (docs/RELEASES.md § Releases tab; Implementation → Tag list and ticket detail):
// the tags NEWER than the candidate (`tags`, each with every reason), the CANDIDATE (`tags`, last), and
// the OLDER tags (`olderTags`) — for the reader to check, NEVER part of the walk: they cannot change the
// candidate. The older band holds at most `olderWanted` tags (RELEASE_OLDER_TAGS_DEFAULT; "Show 50 more"
// raises it). Below the candidate every tag is clear by the rule, so each older tag lists only its OWN
// increment (its own tickets); after a release the band STOPS at the baseline (older tags were released). Tags beyond the wanted number are not in the result (it stays bounded).
//
// The fold never reads the clock and never fetches. Timestamps come in as Date and go out as ISO-8601.
import { tagKind, releasePointNumber, releaseTagName, type ReleaseBasis, type ReleaseSettings, type TagKind } from './releases.js';
import type { SprintStage } from './sprint-stories.js';
import type { ReleaseBlockersState } from './release-blockers.js';
import type { TicketLinkBlocker } from './story-issues.js';

/** A ticket's read state: `ok`, or why the tracker gave nothing; `not_read` = no answer yet. */
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
 * THE BASELINE of one repository (pure): the ordered index of the newest RELEASE tag on the default
 * branch, −1 = none. `ordered` = the tags on the default branch with a commit date, oldest first
 * (`compareTagOrder`).
 */
export function releaseBaselineOf(ordered: readonly TagOrderKey[], settings: ReleaseSettings): number {
  let idx = -1;
  for (let i = 0; i < ordered.length; i += 1) if (tagKind(ordered[i]!.name, settings) === 'release') idx = i;
  return idx;
}

/** One workspace's view of a repository the history pass serves: its suffixes. */
export interface ReleaseRangeView {
  workspaceId?: number;
  settings: ReleaseSettings;
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

// ── The older band ──────────────────────────────────────────────────────────────────────────────

/** Older tags listed under the candidate by default (for checking only). */
export const RELEASE_OLDER_TAGS_DEFAULT = 10;
/** "Show 5 earlier tags": each press adds this many. */
export const RELEASE_OLDER_TAGS_STEP = 5;
/** The most older tags one repository's band may ask for (the tag read's own cap). */
export const RELEASE_OLDER_TAGS_MAX = 1000;

/** A wanted count made safe: an integer in [RELEASE_OLDER_TAGS_DEFAULT, RELEASE_OLDER_TAGS_MAX]. Pure. */
export function clampOlderTagsWanted(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n)) return RELEASE_OLDER_TAGS_DEFAULT;
  return Math.min(RELEASE_OLDER_TAGS_MAX, Math.max(RELEASE_OLDER_TAGS_DEFAULT, Math.floor(n)));
}

/** The commit page of a tag on GitHub (the caller still passes it through `safeExternalUrl`). Pure. */
export function releaseCommitUrl(fullName: string, sha: string): string {
  return `https://github.com/${fullName}/commit/${sha}`;
}

// ── Input ──────────────────────────────────────────────────────────────────────────────────────

export interface ReleaseCheckTagInput extends TagOrderKey {
  sha: string;
  /** null = not known yet (the history pass has not reached it). */
  onDefaultBranch: boolean | null;
  /** The tag was moved to another commit since Ensemble first saw it. */
  moved: boolean;
}

/** One tag's INCREMENT on the default branch (previous default-branch tag, tag], from the history pass. */
export interface ReleaseCheckRangeInput {
  tagName: string;
  sha: string;
  baseTagName: string | null;
  baseSha: string | null;
  /** The PR records in the increment. */
  prIds: number[];
  /** PR numbers in the increment with no record yet (not read yet). */
  unresolvedPrNumbers: number[];
  /** Commits with no pull request (direct pushes). */
  unmatchedCommits: number;
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
  /** How many tags the OLDER band lists (default RELEASE_OLDER_TAGS_DEFAULT; "Show 50 more" raises it). */
  olderWanted?: number;
  /** What a release is cut from (shared `releaseBasisOf`; absent = 'tags'). With 'prs' every `tags`
   *  entry that is not a release or hotfix tag is a RELEASE POINT — a merged PR's commit, named `#539`. */
  basis?: ReleaseBasis;
  /** Basis 'prs': the release tag a release would create (`2026.11.19-rc`); there is no version to name it. */
  pointReleaseTagName?: string | null;
}

/** A PR merged into the default branch, from the history pass (its LIGHT record). */
export interface ReleaseCheckPrInput {
  /** The PR's record id (`release_range_prs`): unique in the check. */
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
  mergedAt: Date | null;
  /** Ticket idents the PR names (`trackerTicketIdent`). */
  ticketIdents: string[];
  /** The author's GitHub login (null = unknown). */
  authorLogin?: string | null;
}

/** A MERGED pull request stored in `pull_requests` (into the default branch of a releasable repo) that
 *  names a ticket — the ticket detail's "Elsewhere" for a PR with no light record (merged after the
 *  newest tag, or older than the history read). */
export interface ReleaseCheckMergedPrInput {
  repoId: number;
  repoName: string;
  number: number;
  title: string;
  url: string;
  prId: number | null;
  authorLogin: string | null;
  mergedAt: Date | null;
  ticketIdents: string[];
}

/** An OPEN pull request in one of the workspace's releasable repos (a stored `pull_requests` row). */
export interface ReleaseCheckOpenPrInput {
  repoId: number;
  repoName: string;
  number: number;
  url: string;
  /** The stored `pull_requests` id (the PR tab). */
  prId: number | null;
  /** Ticket idents it names (THE detection rule). */
  ticketIdents: string[];
  title?: string;
  authorLogin?: string | null;
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
  /** The workspace's bucket for its status (This Sprint's stage resolver); null = not read. */
  stage?: SprintStage | null;
  /** The ticket's type ("Story") and assignee ("Robin Lee"), when a stored read has them. */
  typeName?: string | null;
  assigneeName?: string | null;
  /** The last SUCCESSFUL read (any store); null = never. */
  readAt?: Date | null;
  /** The tracker's "is blocked by" / "depends on" links, from the freshest read that stored them; null =
   *  none stored (never read as "no links"). The release graph's ticket → ticket edges. */
  blockedBy?: TicketLinkBlocker[] | null;
}

export interface ReleaseCheckInput {
  settings: ReleaseSettings;
  /** The workspace's RELEASABLE repositories only. */
  repos: ReleaseCheckRepoInput[];
  /** Every PR in a walked increment. */
  prs: ReleaseCheckPrInput[];
  /** Open PRs in the workspace's releasable repos that name a ticket. */
  openPrs?: ReleaseCheckOpenPrInput[];
  /** Merged stored PRs in the releasable repos that name a ticket (the ticket detail only). */
  mergedPrs?: ReleaseCheckMergedPrInput[];
  tickets: ReleaseCheckTicketInput[];
  /** The workspace's tracker can read tickets (default true). False ⇒ a ticket not read yet never will
   *  be: it is listed as "could not be read", never "checking" forever. */
  ticketsReadable?: boolean;
  /** The tracker's name for the progress line ("Jira"). */
  trackerName?: string | null;
}

// ── Output ──────────────────────────────────────────────────────────────────────────────────────

export interface ReleaseOpenPr {
  repoId: number;
  repoName: string;
  number: number;
  url: string;
  prId: number | null;
}

/** Why a version tag does not qualify (not_done, open_pr) or is not decided yet (checking). `fromTag`
 *  = the earlier tag in the scope whose PR names the ticket; null = the tag's own. `title` = the
 *  ticket's title from the tracker (null/absent = not known) — every reason names it beside the key. */
export type ReleaseBlocker =
  | { kind: 'not_done'; ident: string; key: string; title?: string | null; statusName: string | null; fromTag: string | null }
  | { kind: 'open_pr'; ident: string; key: string; title?: string | null; prs: ReleaseOpenPr[]; fromTag: string | null }
  /** `ident` null: the history of the scope is not read yet. Otherwise a ticket not read yet. */
  | { kind: 'checking'; ident: string | null; key: string | null; title?: string | null; fromTag: string | null }
  /** Complete, but more of its merged work sits ABOVE a candidate (picked together): releasing this tag
   *  would ship it without `repoName #number` (in `tagName`; null = not in a tag yet). `root` = what
   *  keeps that tag from being released, followed to the end (a ticket not Complete or with an open PR) —
   *  never another split, so the reason is never circular; null = not known (not in a tag yet). */
  | {
      kind: 'split';
      ident: string;
      key: string;
      title?: string | null;
      repoName: string;
      number: number;
      url: string;
      tagName: string | null;
      root?: ReleaseSplitRoot | null;
      fromTag: string | null;
    };

/** The root cause behind a split: the tag in `repoName` that holds a ticket not Complete or with an open PR. */
export interface ReleaseSplitRoot {
  repoName: string;
  tagName: string;
  blocker: Extract<ReleaseBlocker, { kind: 'not_done' } | { kind: 'open_pr' }>;
}

/** A ticket in a tag's scope that the tracker could not give: listed for the reader, never a block. */
export interface ReleaseUnverified {
  ident: string;
  key: string;
  title?: string | null;
  reason: Exclude<ReleaseTicketReadState, 'ok'>;
  fromTag: string | null;
}

export interface ReleaseTagRef {
  name: string;
  sha: string;
  committedAt: string | null;
}

/** qualifies (the candidate) · does_not_qualify (a reason in its scope) · checking (not decided yet). */
export type ReleaseTagState = 'qualifies' | 'does_not_qualify' | 'checking';

/** Where a tag sits in the expanded row: newer than the candidate (or every tag read, with none), the
 *  candidate, or an older tag listed for checking. */
export type ReleaseTagBand = 'newer' | 'candidate' | 'older';

export interface ReleaseTagCheck extends ReleaseTagRef {
  /** The commit on GitHub (`releaseCommitUrl`; pass it through `safeExternalUrl`). */
  url: string;
  band: ReleaseTagBand;
  moved: boolean;
  isCandidate: boolean;
  state: ReleaseTagState;
  /** Why it does not qualify, or what it waits for; its own tickets first. */
  blockers: ReleaseBlocker[];
  /** Tickets in its scope the tracker could not give (listed, not blocking). */
  unverified: ReleaseUnverified[];
  /** The PRs this tag ADDED (since the version tag before it, or the baseline). */
  prIds: number[];
  /** Ticket idents on those PRs. */
  ticketIdents: string[];
  /** Every PR in its scope — on the candidate, the tag the walk stopped at and the oldest tag read; on
   *  any other newer tag its own PRs only (= `prIds`), so a long history never sends n² ids. */
  scopePrIds: number[];
  /** Its own increment has been read. */
  historyRead: boolean;
  /** Commits with no pull request (direct pushes) in its own increment: a note only. */
  unmatchedCommits: number;
  /** The PRs listed under it (the candidate: its scope; any other tag: its own) that name no ticket. */
  noTicketPrIds: number[];
  /** Its ticket lines list its whole scope (`scopePrIds`) — the candidate after a release — else its
   *  own increment (`prIds`). Absent = the candidate's old rule (isCandidate). */
  listsScope?: boolean;
}

/** The OLDER band of one repository (for checking only — it never changes the candidate). */
export interface ReleaseOlderBand {
  /** How many older tags the band lists at most now. */
  wanted: number;
  /** More older tags exist than `olderTags` holds (known, or not placed on the default branch yet). */
  moreAvailable: boolean;
  /** Still being read: older history or tickets. The tab polls while true. */
  loading: boolean;
  /** The history pass must read further for the band (the scan asks this before it stops early). */
  needsHistory: boolean;
  /** What it waits for (null = nothing). */
  progress: ReleaseScanProgress | null;
  /** The baseline release tag, once the band has reached it — its last line ("0.380.0-rc — last release"). */
  lastRelease: ReleaseTagRef | null;
}

/** candidate · none (every tag is ruled out) · checking (not decided yet) · nothing_new. */
export type ReleaseRepoStatus = 'candidate' | 'none' | 'checking' | 'nothing_new';

export interface ReleaseRepoCheck {
  repoId: number;
  fullName: string;
  name: string;
  writable: boolean;
  /** What a release is cut from here: version tags, or each merged pull request (absent = 'tags'). With
   *  'prs' a "tag" of this result (`tags`, `candidate`, `latestVersion`, a reason's `fromTag`) is a release
   *  point named `#539`. */
  basis?: ReleaseBasis;
  status: ReleaseRepoStatus;
  /** `nothing_new` only: no version tag on the default branch at all, or none after the baseline. */
  nothingNewReason: 'no_tags' | 'no_new_tags' | null;
  /** The newest version tag on the default branch (null = none). */
  latestVersion: ReleaseTagRef | null;
  /** The newest release tag on the default branch; null = none. */
  baseline: ReleaseTagRef | null;
  /** What a tag's scope is here: since the baseline, or since the start of the history (no baseline). */
  scope: 'since_release' | 'since_start';
  /** The newest release OR hotfix tag (any branch) — the hotfix base. */
  latestRelease: (ReleaseTagRef & { kind: 'release' | 'hotfix' }) | null;
  candidate:
    | (ReleaseTagRef & {
        releaseTagName: string;
        releaseTagExists: boolean;
        /** Basis 'prs': the merged pull request the candidate point is (null otherwise, or not read). */
        point?: { number: number; title: string; url: string; prId: number | null } | null;
      })
    | null;
  /** The newest version tag's first reason when it is not the candidate (the `none` row's words). */
  newestReason: { tagName: string; blocker: ReleaseBlocker } | null;
  /** Not decided yet: the tab polls while any repo is checking. */
  checking: boolean;
  /** What the check waits for (null = nothing). */
  progress: ReleaseScanProgress | null;
  /** The version tags read, NEWEST first, down to the candidate (or the tag still being checked). */
  tags: ReleaseTagCheck[];
  /** Tags OLDER than the candidate, newest first, at most `older.wanted` — for checking only. Empty
   *  with no candidate. */
  olderTags: ReleaseTagCheck[];
  older: ReleaseOlderBand;
  /** Tickets in the candidate's scope. */
  ticketIdents: string[];
  /** Every PR in the candidate's scope. */
  candidatePrIds: number[];
  /** Human PRs with no ticket in the candidate's scope (the notes' "Untracked changes"). */
  untrackedPrIds: number[];
  /** Bot PRs with no ticket in the candidate's scope — "Dependency and bot changes". */
  botPrIds: number[];
  /** Commits with no PR in the candidate's scope — a note. */
  directCommits: number;
  /** Tickets in the candidate's scope the tracker could not give (to check by hand). */
  unverifiedCount: number;
}

/** A ticket in one repository: in that repository's candidate scope, only in a newer tag, or only in
 *  an older tag listed for checking. */
export type ReleaseTicketRepoState = 'in_candidate' | 'after_candidate' | 'before_candidate';

/** One pull request for a ticket in the workspace's releasable repos (the ticket detail). */
export interface ReleaseTicketPr {
  /** The light record's id (matches a tag's `prIds`); null = a stored PR with no light record. */
  id: number | null;
  /** The stored `pull_requests` id (the PR tab); null = GitHub link only. */
  prId: number | null;
  repoId: number;
  repoName: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string | null;
  mergedAt: string | null;
  open: boolean;
  /** The version tag that contains it (merged); null = not known. */
  tagName: string | null;
  /** That tag's commit date (ISO; null = no tag or not known): the tickets list's order. */
  tagAt: string | null;
  /** Merged after the repository's newest tag: "not in a tag yet". */
  untagged: boolean;
}

export interface ReleaseTicketCheck {
  ident: string;
  key: string;
  title: string | null;
  url: string | null;
  statusName: string | null;
  done: boolean;
  readState: ReleaseTicketReadState;
  /** Complete, read, and no open pull request. */
  ready: boolean;
  /** In the workspace's Cancelled stage ("Won't Do"): never stops a tag, never commented on. */
  cancelled?: boolean;
  /** In at least one repository's candidate scope. */
  inRelease: boolean;
  /** Not read yet (the tracker will answer): checking. */
  pending: boolean;
  /** Its own state when it stops a tag (not Complete, an open PR) or is not read yet. */
  blocker: ReleaseBlocker | null;
  /** The tracker could not give it: listed for the reader, never a block. */
  unverified: Exclude<ReleaseTicketReadState, 'ok'> | null;
  /** Its open PRs in the releasable repos. */
  openPrs: ReleaseOpenPr[];
  /** Per releasable repository it appears in (in a tag read). */
  repos: Array<{ repoId: number; state: ReleaseTicketRepoState; prIds: number[] }>;
  /** The workspace's bucket for its status; null = not read. */
  stage: SprintStage | null;
  typeName: string | null;
  assigneeName: string | null;
  /** The last successful read (ISO); null = never. */
  readAt: string | null;
  /** Every PR for it in the releasable repos — merged (with the tag holding it) and open. */
  pullRequests: ReleaseTicketPr[];
  /** The tracker's "is blocked by" links (null = none stored). */
  blockedBy?: TicketLinkBlocker[] | null;
}

export interface ReleaseCheckPr {
  /** The PR's record id (unique in the check). */
  id: number;
  /** The stored `pull_requests` id (the PR tab), or null (link to `url`). */
  prId: number | null;
  repoId: number;
  number: number;
  title: string;
  url: string;
  isBot: boolean;
  mergedAt: string | null;
  ticketIdents: string[];
  authorLogin: string | null;
  /** The version tag holding it; null = not known. */
  tagName: string | null;
  /** That tag's commit date (ISO; null = not known): the tickets list's order. */
  tagAt: string | null;
}

export interface ReleaseCheckResult {
  repos: ReleaseRepoCheck[];
  /** The tickets of the tags listed (every band). */
  tickets: ReleaseTicketCheck[];
  /** The PRs of the tags listed (every band). */
  prs: ReleaseCheckPr[];
  /** The workspace's tracker ("Jira"); null = none. */
  trackerName: string | null;
}

// ── The fold ────────────────────────────────────────────────────────────────────────────────────

const iso = (d: Date | null): string | null => (d == null ? null : d.toISOString());
const ref = (t: ReleaseCheckTagInput): ReleaseTagRef => ({ name: t.name, sha: t.sha, committedAt: iso(t.committedAt) });
/** A ticket title as a reason's field: present only when known. */
const named = (title: string | null): { title?: string } => (title != null ? { title } : {});

/** One version tag after the baseline and its own increment. */
interface Span {
  tagIdx: number;
  /** PRs it added (each PR counted in the first increment holding it). */
  prIds: number[];
  /** Every increment it spans is stored, fresh, and has a record for each PR. */
  complete: boolean;
  unmatched: number;
}

type TicketVerdict =
  | { kind: 'ok' }
  | { kind: 'cancelled' }
  | { kind: 'not_done'; statusName: string | null }
  | { kind: 'open_pr'; prs: ReleaseOpenPr[] }
  | { kind: 'checking' }
  | { kind: 'unverified'; reason: Exclude<ReleaseTicketReadState, 'ok'> }
  | { kind: 'split'; repoName: string; number: number; url: string; tagName: string | null; root: ReleaseSplitRoot | null };

interface TagEval {
  span: number;
  state: ReleaseTagState;
  blockers: ReleaseBlocker[];
  unverified: ReleaseUnverified[];
  /** Ticket idents in its scope, with the PRs naming each. Its OWN increment's only, unless `full`. */
  scopeIdents: string[];
  scopePrIds: number[];
  /** `scopeIdents` / `scopePrIds` hold the whole scope (the candidate, the tag the walk stopped at, the
   *  oldest tag read). A newer tag's reasons are always whole; only these two lists are cut, so a long
   *  history (a repository released from merged PRs: one point per PR) never builds n² lists. */
  full: boolean;
}

/** Fold ONE releasable repository. Pure. */
function foldRepo(
  repo: ReleaseCheckRepoInput,
  input: ReleaseCheckInput,
  prById: ReadonlyMap<number, ReleaseCheckPrInput>,
  verdictOf: (ident: string, repoId: number) => TicketVerdict,
  keyOf: (ident: string) => string,
  readOf: (ident: string) => boolean,
  titleOf: (ident: string) => string | null = () => null,
): {
  out: ReleaseRepoCheck;
  evals: TagEval[];
  olderEvals: TagEval[];
  spans: Span[];
  candidate: TagEval | null;
  /** PR record id → the version tag whose increment holds it. */
  prTag: Map<number, string>;
  /** PR record id → the span (version tag after the baseline) that added it; absent = released already. */
  spanOfPr: Map<number, number>;
  /** The newest tag on the default branch's commit date (ms; null = none): a PR merged after it is in no
   *  tag yet. */
  newestTagAtMs: number | null;
} {
  const settings = input.settings;
  const kindOf = (name: string): TagKind | null => tagKind(name, settings);
  const dated = repo.tags.filter((t) => t.committedAt != null);
  const ordered = dated.filter((t) => t.onDefaultBranch === true).sort(compareTagOrder);
  const rangeByName = new Map(repo.ranges.map((r) => [r.tagName, r]));
  const valid = (i: number): ReleaseCheckRangeInput | null => {
    const t = ordered[i]!;
    const prev = i > 0 ? ordered[i - 1]! : null;
    const r = rangeByName.get(t.name);
    if (r == null || r.sha !== t.sha) return null;
    if (r.baseTagName !== (prev?.name ?? null) || r.baseSha !== (prev?.sha ?? null)) return null;
    return r;
  };
  const baselineIdx = releaseBaselineOf(ordered, settings);
  const baselineTag = baselineIdx >= 0 ? ordered[baselineIdx]! : null;
  const hasBaseline = baselineTag != null;
  const afterBaseline = (t: ReleaseCheckTagInput): boolean => baselineTag == null || compareTagOrder(baselineTag, t) < 0;

  // Tags whose place on the default branch is not known yet. A RELEASE tag among them (after the
  // known baseline) may be a newer baseline: until it is known, a tag's scope is not known either. A
  // VERSION tag among them (after the baseline) may be a newer tag to read first.
  const unknown = dated.filter((t) => t.onDefaultBranch == null && afterBaseline(t)).sort(compareTagOrder);
  const baselinePending = unknown.some((t) => kindOf(t.name) === 'release');
  const unknownVersions = unknown.filter((t) => kindOf(t.name) === 'version');

  // A PR is counted in the FIRST increment that holds it.
  const pos = new Map<number, number>();
  for (let i = baselineIdx + 1; i < ordered.length; i += 1) {
    const r = valid(i);
    if (r != null) for (const id of r.prIds) if (!pos.has(id)) pos.set(id, i);
  }
  const spans: Span[] = [];
  let from = baselineIdx + 1;
  for (let i = baselineIdx + 1; i < ordered.length; i += 1) {
    const t = ordered[i]!;
    if (kindOf(t.name) !== 'version' || t.sha === baselineTag?.sha) continue;
    const span: Span = { tagIdx: i, prIds: [], complete: true, unmatched: 0 };
    for (let j = from; j <= i; j += 1) {
      const r = valid(j);
      if (r == null) {
        span.complete = false;
        continue;
      }
      if (r.unresolvedPrNumbers.length > 0) span.complete = false;
      for (const id of r.prIds) if (pos.get(id) === j && !span.prIds.includes(id)) span.prIds.push(id);
      span.unmatched += r.unmatchedCommits;
    }
    spans.push(span);
    from = i + 1;
  }

  const identsCache = new Map<Span, string[]>();
  const identsOf = (span: Span): string[] => {
    const hit = identsCache.get(span);
    if (hit != null) return hit;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of span.prIds) {
      for (const ident of prById.get(id)?.ticketIdents ?? []) {
        if (seen.has(ident)) continue;
        seen.add(ident);
        out.push(ident);
      }
    }
    identsCache.set(span, out);
    return out;
  };
  /** A span's tickets that say something (not Complete-and-clear, not Cancelled), in order — a ticket's
   *  verdict is the same in every span, so a scope's reasons need only these. Cached per span. */
  const notableCache = new Map<number, Array<{ ident: string; v: TicketVerdict }>>();
  const notableOf = (s: number): Array<{ ident: string; v: TicketVerdict }> => {
    const hit = notableCache.get(s);
    if (hit != null) return hit;
    const out: Array<{ ident: string; v: TicketVerdict }> = [];
    for (const ident of identsOf(spans[s]!)) {
      const v = verdictOf(ident, repo.repoId);
      if (v.kind !== 'ok' && v.kind !== 'cancelled') out.push({ ident, v });
    }
    notableCache.set(s, out);
    return out;
  };
  /** incompleteUpTo[s]: some span at or below s is not read whole yet. */
  const incompleteUpTo: boolean[] = [];
  spans.forEach((sp, i) => incompleteUpTo.push(!sp.complete || (i > 0 && incompleteUpTo[i - 1]!)));

  /** THE RULE for one tag: its scope, then each ticket's verdict. `ownOnly` = the older band's view (a
   *  tag below the candidate lists only what it added). `full` = also list the whole scope's tickets and
   *  PRs (`TagEval.full`); the reasons are whole either way. */
  const evaluate = (s: number, ownOnly = false, full = false): TagEval => {
    const own = spans[s]!;
    // The tag's own increment first, then every earlier tag after the baseline, newest first. While a
    // newer baseline may still turn up the earlier tags are not known to be in the scope: own only.
    const single = ownOnly || baselinePending;
    const blockers: ReleaseBlocker[] = [];
    const checking: ReleaseBlocker[] = [];
    const unverified: ReleaseUnverified[] = [];
    const seen = new Set<string>();
    for (let idx = s; idx >= (single ? s : 0); idx -= 1) {
      const fromTag = idx === s ? null : ordered[spans[idx]!.tagIdx]!.name;
      for (const { ident, v } of notableOf(idx)) {
        if (seen.has(ident)) continue;
        seen.add(ident);
        const key = keyOf(ident);
        const title = titleOf(ident);
        if (v.kind === 'split') {
          blockers.push({ kind: 'split', ident, key, ...named(title), repoName: v.repoName, number: v.number, url: v.url, tagName: v.tagName, root: v.root, fromTag });
          continue;
        }
        if (v.kind === 'not_done') blockers.push({ kind: 'not_done', ident, key, ...named(title), statusName: v.statusName, fromTag });
        else if (v.kind === 'open_pr') blockers.push({ kind: 'open_pr', ident, key, ...named(title), prs: v.prs, fromTag });
        else if (v.kind === 'checking') checking.push({ kind: 'checking', ident, key, ...named(title), fromTag });
        else if (v.kind === 'unverified') unverified.push({ ident, key, ...named(title), reason: v.reason, fromTag });
      }
    }
    // The scope's tickets and PRs, newest span first (only when asked: see `TagEval.full`).
    const whole = full || single || s === 0;
    const scopeIdents: string[] = [];
    const scopePrIds: number[] = [];
    if (whole) {
      const all = new Set<string>();
      for (let idx = s; idx >= (single ? s : 0); idx -= 1) {
        const sp = spans[idx]!;
        for (const id of sp.prIds) scopePrIds.push(id);
        for (const ident of identsOf(sp)) {
          if (all.has(ident)) continue;
          all.add(ident);
          scopeIdents.push(ident);
        }
      }
    } else {
      scopeIdents.push(...identsOf(own));
      scopePrIds.push(...own.prIds);
    }
    // Not decided by its history yet: a scope not read, a baseline not known yet, or a version tag
    // whose place is unknown (newer, or inside the scope). The older band's own view waits only for its
    // own increment.
    const historyWait = ownOnly ? !own.complete : (single ? !own.complete : incompleteUpTo[s]!) || baselinePending || unknownVersions.length > 0;
    if (historyWait) checking.unshift({ kind: 'checking', ident: null, key: null, fromTag: null });
    const state: ReleaseTagState = blockers.length > 0 ? 'does_not_qualify' : checking.length > 0 ? 'checking' : 'qualifies';
    return { span: s, state, blockers: [...blockers, ...(state === 'checking' ? checking : [])], unverified, scopeIdents, scopePrIds, full: whole };
  };

  // THE WALK, newest first: the first tag that qualifies is the candidate; a tag not decided yet stops
  // it (it may yet qualify).
  const evals: TagEval[] = [];
  let candidate: TagEval | null = null;
  let stopped: TagEval | null = null;
  for (let s = spans.length - 1; s >= 0; s -= 1) {
    const ev = evaluate(s);
    evals.push(ev);
    if (ev.state === 'qualifies') {
      candidate = ev;
      break;
    }
    if (ev.state === 'checking') {
      stopped = ev;
      break;
    }
  }
  // The tag the walk ended on (the candidate, the one it stopped at, or the oldest read) lists its WHOLE
  // scope: with the newer tags' own lists that is every ticket and PR the walk read.
  const lastAt = evals.length - 1;
  if (lastAt >= 0 && !evals[lastAt]!.full) {
    const whole = evaluate(evals[lastAt]!.span, false, true);
    if (candidate === evals[lastAt]) candidate = whole;
    if (stopped === evals[lastAt]) stopped = whole;
    evals[lastAt] = whole;
  }
  // Every tag read is ruled out: an older tag (or a newer baseline) may still turn up while the
  // history is read — a tag whose place on the default branch is not known yet.
  const olderMayTurnUp = baselinePending || unknownVersions.length > 0;
  const status: ReleaseRepoStatus =
    candidate != null
      ? 'candidate'
      : stopped != null
        ? 'checking'
        : olderMayTurnUp
          ? 'checking'
          : spans.length === 0
            ? 'nothing_new'
            : 'none';

  const candTag = candidate != null ? ordered[spans[candidate.span]!.tagIdx]! : null;

  // THE OLDER BAND — for the reader to check, AFTER the walk (it never changes the candidate). The
  // tags below the candidate, newest first, each judged by the same test on its own scope (with no
  // baseline its own increment); at most `wanted`. Spans exist only after the baseline, so after a
  // release the band stops there.
  const wanted = clampOlderTagsWanted(repo.olderWanted);
  const olderEvals: TagEval[] = [];
  if (candidate != null) for (let s = candidate.span - 1; s >= 0 && olderEvals.length < wanted; s -= 1) olderEvals.push(evaluate(s, true));
  const knownLeft = candidate == null ? 0 : candidate.span - olderEvals.length;
  // Older version tags whose place on the default branch is not known yet: the history pass stopped
  // once the candidate was proven, so they may still join the band.
  const unknownOlder = candTag == null ? 0 : unknownVersions.filter((u) => compareTagOrder(u, candTag) < 0).length;
  const olderHistoryNeeded =
    candidate != null && ((olderEvals.length < wanted && knownLeft === 0 && unknownOlder > 0) || olderEvals.some((ev) => !spans[ev.span]!.complete));
  const olderLoading = olderHistoryNeeded || olderEvals.some((ev) => ev.state === 'checking');
  const suffix = settings.releaseSuffix ?? '';
  const byPoints = repo.basis === 'prs';
  const candidateTagName = (name: string): string =>
    byPoints ? (repo.pointReleaseTagName ?? releaseTagName(name, suffix)) : releaseTagName(name, suffix);
  const pointOf = (name: string): NonNullable<ReleaseRepoCheck['candidate']>['point'] => {
    const n = releasePointNumber(name);
    const p = n == null ? undefined : [...prById.values()].find((x) => x.repoId === repo.repoId && x.number === n);
    return p == null ? null : { number: p.number, title: p.title, url: p.url, prId: p.prId ?? null };
  };
  const candidateOut =
    candTag == null
      ? null
      : {
          ...ref(candTag),
          releaseTagName: candidateTagName(candTag.name),
          releaseTagExists: repo.tags.some((t) => t.name === candidateTagName(candTag.name)),
          ...(byPoints ? { point: pointOf(candTag.name) } : {}),
        };

  const untrackedPrIds: number[] = [];
  const botPrIds: number[] = [];
  let directCommits = 0;
  if (candidate != null) {
    for (const id of candidate.scopePrIds) {
      const p = prById.get(id);
      if (p != null && p.ticketIdents.length === 0) (p.isBot ? botPrIds : untrackedPrIds).push(id);
    }
    for (const sp of spans.slice(0, candidate.span + 1)) directCommits += sp.unmatched;
  }

  const versions = ordered.filter((t) => kindOf(t.name) === 'version');
  const latestVersion = versions.length > 0 ? ref(versions[versions.length - 1]!) : null;
  const latestHit = latestReleaseTag(repo.tags, settings);
  const newest = evals[0] ?? null;
  const newestBlocker = newest != null && newest !== candidate ? (newest.blockers[0] ?? null) : null;

  // PROGRESS: what a checking repository waits for — the history, else its tickets.
  let progress: ReleaseScanProgress | null = null;
  if (status === 'checking') {
    const waitsForHistory = stopped == null || stopped.blockers.some((b) => b.kind === 'checking' && b.ident == null);
    const h = repo.history;
    if (waitsForHistory && h != null) {
      const total = h.total <= 0 ? 0 : Math.max(h.total, h.done + (h.complete ? 0 : 1));
      const p = { step: 'history' as const, done: h.done, total, branch: repo.defaultBranch ?? null };
      progress = { step: p.step, done: p.done, total: p.total, line: releaseScanLine(p) };
    } else if (!waitsForHistory) {
      const idents = new Set<string>();
      for (const ev of evals) for (const ident of ev.scopeIdents) idents.add(ident);
      let read = 0;
      for (const ident of idents) if (readOf(ident)) read += 1;
      const p = { step: 'tickets' as const, done: read, total: idents.size, tracker: input.trackerName ?? null };
      progress = { step: p.step, done: p.done, total: p.total, line: releaseScanLine(p) };
    }
  }

  let olderProgress: ReleaseScanProgress | null = null;
  if (olderLoading) {
    const h = repo.history;
    if (olderHistoryNeeded && h != null) {
      const total = h.total <= 0 ? 0 : Math.max(h.total, h.done + (h.complete ? 0 : 1));
      const p = { step: 'history' as const, done: h.done, total, branch: repo.defaultBranch ?? null };
      olderProgress = { step: p.step, done: p.done, total: p.total, line: releaseScanLine(p) };
    } else if (!olderHistoryNeeded) {
      const idents = new Set<string>();
      for (const ev of olderEvals) for (const ident of ev.scopeIdents) idents.add(ident);
      let read = 0;
      for (const ident of idents) if (readOf(ident)) read += 1;
      const p = { step: 'tickets' as const, done: read, total: idents.size, tracker: input.trackerName ?? null };
      olderProgress = { step: p.step, done: p.done, total: p.total, line: releaseScanLine(p) };
    }
  }

  const tagOut = (ev: TagEval, band: ReleaseTagBand): ReleaseTagCheck => {
    const span = spans[ev.span]!;
    const t = ordered[span.tagIdx]!;
    const isCandidate = ev === candidate;
    // The candidate lists its whole scope only after a release (the release's content). With none its
    // scope is the whole history: it lists its own changes, and the tags below it are the older band.
    const listsScope = isCandidate && hasBaseline;
    const listed = listsScope ? ev.scopePrIds : span.prIds;
    return {
      ...ref(t),
      url: releaseCommitUrl(repo.fullName, t.sha),
      band,
      moved: t.moved,
      isCandidate,
      state: ev.state,
      blockers: ev.blockers,
      unverified: ev.unverified,
      prIds: [...span.prIds],
      ticketIdents: identsOf(span),
      scopePrIds: [...ev.scopePrIds],
      historyRead: span.complete,
      unmatchedCommits: span.unmatched,
      listsScope,
      noTicketPrIds: listed.filter((id) => (prById.get(id)?.ticketIdents.length ?? 0) === 0),
    };
  };
  const tagsOut: ReleaseTagCheck[] = evals.map((ev) => tagOut(ev, ev === candidate ? 'candidate' : 'newer'));
  const olderOut: ReleaseTagCheck[] = olderEvals.map((ev) => tagOut(ev, 'older'));

  // Which version tag holds each PR (the ticket detail's "in 0.390.0"): the first increment holding it,
  // named by the version tag on that commit.
  const prTag = new Map<number, string>();
  for (let i = 0; i < ordered.length; i += 1) {
    const r = valid(i);
    if (r == null) continue;
    const t = ordered[i]!;
    const name = kindOf(t.name) === 'version' ? t.name : (ordered.find((o) => o.sha === t.sha && kindOf(o.name) === 'version')?.name ?? t.name);
    for (const id of r.prIds) if (!prTag.has(id)) prTag.set(id, name);
  }
  const newestTagAtMs = ordered.length > 0 ? (ordered[ordered.length - 1]!.committedAt?.getTime() ?? null) : null;

  const out: ReleaseRepoCheck = {
    repoId: repo.repoId,
    fullName: repo.fullName,
    name: repo.name,
    writable: repo.writable,
    basis: repo.basis ?? 'tags',
    status,
    nothingNewReason: status !== 'nothing_new' ? null : latestVersion == null ? 'no_tags' : 'no_new_tags',
    latestVersion,
    baseline: baselineTag != null ? ref(baselineTag) : null,
    scope: hasBaseline ? 'since_release' : 'since_start',
    latestRelease: latestHit != null ? { ...ref(latestHit.tag), kind: latestHit.kind } : null,
    candidate: candidateOut,
    newestReason: newest != null && newestBlocker != null ? { tagName: ordered[spans[newest.span]!.tagIdx]!.name, blocker: newestBlocker } : null,
    checking: status === 'checking',
    progress,
    tags: tagsOut,
    olderTags: olderOut,
    older: {
      wanted,
      moreAvailable: knownLeft > 0 || unknownOlder > 0,
      loading: olderLoading,
      needsHistory: olderHistoryNeeded,
      progress: olderProgress,
      lastRelease: candidate != null && baselineTag != null && knownLeft === 0 ? ref(baselineTag) : null,
    },
    ticketIdents: candidate != null ? [...candidate.scopeIdents] : [],
    candidatePrIds: candidate != null ? [...candidate.scopePrIds] : [],
    untrackedPrIds,
    botPrIds,
    directCommits,
    unverifiedCount: candidate?.unverified.length ?? 0,
  };
  const spanOfPr = new Map<number, number>();
  spans.forEach((sp, i) => {
    for (const id of sp.prIds) spanOfPr.set(id, i);
  });
  return { out, evals, olderEvals, spans, candidate, prTag, spanOfPr, newestTagAtMs };
}

/** Run the release check. Pure. */
export function foldReleaseCheck(input: ReleaseCheckInput): ReleaseCheckResult {
  const prById = new Map(input.prs.map((p) => [p.id, p]));
  const ticketByIdent = new Map(input.tickets.map((t) => [t.ident, t]));
  const readable = input.ticketsReadable !== false;
  const ticketOf = (ident: string): ReleaseCheckTicketInput =>
    ticketByIdent.get(ident) ?? { ident, key: ident, title: null, url: null, statusName: null, done: false, readState: 'not_read' };
  const openByIdent = new Map<string, ReleaseOpenPr[]>();
  for (const p of input.openPrs ?? []) {
    for (const ident of p.ticketIdents) {
      const list = openByIdent.get(ident) ?? [];
      if (!list.some((x) => x.repoId === p.repoId && x.number === p.number)) {
        list.push({ repoId: p.repoId, repoName: p.repoName, number: p.number, url: p.url, prId: p.prId });
      }
      openByIdent.set(ident, list);
    }
  }
  const openOf = (ident: string): ReleaseOpenPr[] =>
    [...(openByIdent.get(ident) ?? [])].sort((a, b) => a.repoName.localeCompare(b.repoName) || a.number - b.number);
  const verdictOf = (ident: string): TicketVerdict => {
    const t = ticketOf(ident);
    if (t.readState === 'not_read') return readable ? { kind: 'checking' } : { kind: 'unverified', reason: 'not_read' };
    if (t.readState !== 'ok') return { kind: 'unverified', reason: t.readState };
    // A Cancelled ticket ("Won't Do") never stops a tag (owner, 2026-11-16): its code shipped long ago or
    // was dropped. It is listed, but not commented on (not READY).
    if (!t.done && t.stage === 'cancelled') return { kind: 'cancelled' };
    if (!t.done) return { kind: 'not_done', statusName: t.statusName };
    const open = openOf(ident);
    if (open.length > 0) return { kind: 'open_pr', prs: open };
    return { kind: 'ok' };
  };
  const keyOf = (ident: string): string => ticketOf(ident).key;
  const titleOf = (ident: string): string | null => {
    const t = ticketOf(ident).title;
    return t != null && t.trim() !== '' ? t.trim() : null;
  };
  const readOf = (ident: string): boolean => ticketOf(ident).readState !== 'not_read';

  // PICKED TOGETHER: `splitBy` = (repo, ticket) pairs that block, with the merged PR left out. Only grows.
  const splitBy = new Map<string, Extract<TicketVerdict, { kind: 'split' }>>();
  const verdictIn = (ident: string, repoId: number): TicketVerdict => {
    const v = verdictOf(ident);
    return v.kind === 'ok' ? (splitBy.get(`${repoId}|${ident}`) ?? v) : v;
  };
  const repoNameOf = new Map(input.repos.map((r) => [r.repoId, r.name]));
  const foldAll = () => input.repos.map((repo) => ({ repo, f: foldRepo(repo, input, prById, verdictIn, keyOf, readOf, titleOf) }));
  let folded = foldAll();
  for (let round = 0; round < 10_000; round += 1) {
    // Where each merged PR sits against its repository's candidate. Decided repositories only.
    type Place = { repoId: number; below: boolean; number: number; url: string; tagName: string | null; at: number };
    const places = new Map<string, Place[]>();
    const put = (ident: string, p: Place): void => {
      const list = places.get(ident) ?? [];
      if (!list.some((x) => x.repoId === p.repoId && x.number === p.number)) list.push(p);
      places.set(ident, list);
    };
    const decided = new Map<number, { cand: number; newestAt: number | null }>();
    for (const { repo, f } of folded) {
      if (f.out.status !== 'candidate' && f.out.status !== 'none') continue;
      decided.set(repo.repoId, { cand: f.candidate?.span ?? -1, newestAt: f.newestTagAtMs });
    }
    for (const { repo, f } of folded) {
      const d = decided.get(repo.repoId);
      if (d == null) continue;
      for (const [id, span] of f.spanOfPr) {
        const p = prById.get(id);
        if (p == null) continue;
        for (const ident of p.ticketIdents) {
          put(ident, { repoId: repo.repoId, below: span <= d.cand, number: p.number, url: p.url, tagName: f.prTag.get(id) ?? null, at: span });
        }
      }
    }
    // Merged after the repository's newest tag: in no tag yet — always above.
    for (const p of input.mergedPrs ?? []) {
      const d = decided.get(p.repoId);
      if (d == null || d.newestAt == null || p.mergedAt == null || p.mergedAt.getTime() <= d.newestAt) continue;
      for (const ident of p.ticketIdents) put(ident, { repoId: p.repoId, below: false, number: p.number, url: p.url, tagName: null, at: Number.MAX_SAFE_INTEGER });
    }
    // THE ROOT CAUSE of a PR sitting above its repository's candidate: what stops the tag just above that
    // candidate (with none, the oldest tag read) — its own ticket, else the older tag it inherits from; a
    // split there is followed through the split recorded before it (earlier rounds), so it never loops.
    const rootOf = (repoId: number): ReleaseSplitRoot | null => {
      const f = folded.find((x) => x.repo.repoId === repoId)?.f;
      if (f == null) return null;
      const tags = f.out.tags;
      const above = tags[tags.length - (f.candidate != null ? 2 : 1)];
      if (above == null) return null;
      const hard = (b: ReleaseBlocker): b is Extract<ReleaseBlocker, { kind: 'not_done' } | { kind: 'open_pr' }> =>
        b.kind === 'not_done' || b.kind === 'open_pr';
      const own = above.blockers.find((b) => hard(b) && b.fromTag == null);
      if (own != null && hard(own)) return { repoName: f.out.name, tagName: above.name, blocker: own };
      const inherited = above.blockers.filter((b) => hard(b) && b.fromTag != null);
      const oldest = inherited[inherited.length - 1];
      if (oldest != null && hard(oldest)) return { repoName: f.out.name, tagName: oldest.fromTag!, blocker: { ...oldest, fromTag: null } };
      for (const b of above.blockers) {
        if (b.kind !== 'split') continue;
        const earlier = splitBy.get(`${repoId}|${b.ident}`);
        if (earlier?.root != null) return earlier.root;
      }
      return null;
    };
    let grew = false;
    for (const [ident, list] of places) {
      if (verdictOf(ident).kind !== 'ok') continue;
      const above = list.filter((p) => !p.below).sort((a, b) => a.at - b.at || a.number - b.number);
      if (above.length === 0) continue;
      for (const repoId of new Set(list.filter((p) => p.below).map((p) => p.repoId))) {
        const k = `${repoId}|${ident}`;
        if (splitBy.has(k)) continue;
        // CROSS-REPOSITORY ONLY: later work in the SAME repository is the next increment, never a split.
        const miss = above.find((p) => p.repoId !== repoId);
        if (miss == null) continue;
        splitBy.set(k, {
          kind: 'split',
          repoName: repoNameOf.get(miss.repoId) ?? '',
          number: miss.number,
          url: miss.url,
          tagName: miss.tagName,
          root: miss.tagName != null ? rootOf(miss.repoId) : null,
        });
        grew = true;
      }
    }
    if (!grew) break;
    folded = foldAll();
  }

  const repos: ReleaseRepoCheck[] = [];
  /** ident → per repo: state and PRs. */
  const ticketRepos = new Map<string, Map<number, { state: ReleaseTicketRepoState; prIds: number[] }>>();
  const population: string[] = [];
  const inScope = new Set<string>();
  /** Every PR a listed tag holds (the result's `prs` is bounded to these). */
  const listedPrIds = new Set<number>();
  const prTagByRepo = new Map<number, Map<number, string>>();
  const newestTagAtByRepo = new Map<number, number | null>();
  /** repo → tag name → its commit date (ISO). */
  const tagAtByRepo = new Map<number, Map<string, string | null>>();
  for (const { repo, f } of folded) {
    tagAtByRepo.set(repo.repoId, new Map(repo.tags.map((t) => [t.name, iso(t.committedAt)])));
    const { out, evals, olderEvals, candidate, prTag, newestTagAtMs } = f;
    prTagByRepo.set(repo.repoId, prTag);
    newestTagAtByRepo.set(repo.repoId, newestTagAtMs);
    const candidateScope = new Set(candidate?.scopeIdents ?? []);
    for (const ident of candidateScope) inScope.add(ident);
    const note = (ev: TagEval, after: ReleaseTicketRepoState): void => {
      for (const id of ev.scopePrIds) {
        listedPrIds.add(id);
        for (const ident of prById.get(id)?.ticketIdents ?? []) {
          if (!ticketRepos.has(ident)) {
            ticketRepos.set(ident, new Map());
            population.push(ident);
          }
          const per = ticketRepos.get(ident)!;
          const state: ReleaseTicketRepoState = candidateScope.has(ident) ? 'in_candidate' : after;
          const cur = per.get(repo.repoId);
          if (cur == null) per.set(repo.repoId, { state, prIds: [id] });
          else if (!cur.prIds.includes(id)) cur.prIds.push(id);
        }
      }
    };
    for (const ev of evals) note(ev, 'after_candidate');
    for (const ev of olderEvals) note(ev, 'before_candidate');
    for (const t of [...out.tags, ...out.olderTags]) for (const id of t.prIds) listedPrIds.add(id);
    repos.push(out);
  }
  // A ticket whose ONLY work is an open PR is listed too, with no repository (the tab's "Not in a tag
  // yet"): it never changes a candidate.
  for (const p of input.openPrs ?? []) {
    for (const ident of p.ticketIdents) {
      if (ticketRepos.has(ident)) continue;
      ticketRepos.set(ident, new Map());
      population.push(ident);
    }
  }
  const tagAtOf = (repoId: number, tagName: string | null): string | null =>
    tagName == null ? null : (tagAtByRepo.get(repoId)?.get(tagName) ?? null);

  // Every PR for each listed ticket in the releasable repos (the ticket detail): the light records
  // (with the tag holding each), the stored merged PRs with no light record, and the open PRs.
  const listed = new Set(population);
  const ticketPrs = new Map<string, ReleaseTicketPr[]>();
  const addTicketPr = (ident: string, p: ReleaseTicketPr): void => {
    if (!listed.has(ident)) return;
    const list = ticketPrs.get(ident) ?? [];
    if (list.some((x) => x.repoId === p.repoId && x.number === p.number)) return;
    list.push(p);
    ticketPrs.set(ident, list);
  };
  const untaggedAt = (repoId: number, mergedAt: Date | null): boolean => {
    const newest = newestTagAtByRepo.get(repoId);
    return mergedAt != null && newest != null && mergedAt.getTime() > newest;
  };
  for (const p of input.prs) {
    const tagName = prTagByRepo.get(p.repoId)?.get(p.id) ?? null;
    for (const ident of p.ticketIdents) {
      addTicketPr(ident, {
        id: p.id,
        prId: p.prId ?? null,
        repoId: p.repoId,
        repoName: repoNameOf.get(p.repoId) ?? '',
        number: p.number,
        title: p.title,
        url: p.url,
        authorLogin: p.authorLogin ?? null,
        mergedAt: iso(p.mergedAt),
        open: false,
        tagName,
        tagAt: tagAtOf(p.repoId, tagName),
        untagged: tagName == null && untaggedAt(p.repoId, p.mergedAt),
      });
    }
  }
  for (const p of input.mergedPrs ?? []) {
    for (const ident of p.ticketIdents) {
      addTicketPr(ident, {
        id: null,
        prId: p.prId,
        repoId: p.repoId,
        repoName: p.repoName,
        number: p.number,
        title: p.title,
        url: p.url,
        authorLogin: p.authorLogin,
        mergedAt: iso(p.mergedAt),
        open: false,
        tagName: null,
        tagAt: null,
        untagged: untaggedAt(p.repoId, p.mergedAt),
      });
    }
  }
  for (const p of input.openPrs ?? []) {
    for (const ident of p.ticketIdents) {
      addTicketPr(ident, {
        id: null,
        prId: p.prId,
        repoId: p.repoId,
        repoName: p.repoName,
        number: p.number,
        title: p.title ?? '',
        url: p.url,
        authorLogin: p.authorLogin ?? null,
        mergedAt: null,
        open: true,
        tagName: null,
        tagAt: null,
        untagged: false,
      });
    }
  }

  const tickets: ReleaseTicketCheck[] = population.map((ident) => {
    const t = ticketOf(ident);
    const base = verdictOf(ident);
    // Picked together: a Complete ticket split across a candidate carries the first split reason found.
    const split = base.kind === 'ok' ? [...splitBy.entries()].find(([k]) => k.endsWith(`|${ident}`))?.[1] : undefined;
    const v: TicketVerdict = split ?? base;
    const per = [...(ticketRepos.get(ident) ?? new Map()).entries()]
      .sort((a, z) => a[0] - z[0])
      .map(([repoId, x]) => ({ repoId, state: x.state, prIds: [...x.prIds].sort((p, q) => p - q) }));
    const blocker: ReleaseBlocker | null =
      v.kind === 'not_done'
        ? { kind: 'not_done', ident, key: t.key, ...named(titleOf(ident)), statusName: v.statusName, fromTag: null }
        : v.kind === 'open_pr'
          ? { kind: 'open_pr', ident, key: t.key, ...named(titleOf(ident)), prs: v.prs, fromTag: null }
          : v.kind === 'checking'
            ? { kind: 'checking', ident, key: t.key, ...named(titleOf(ident)), fromTag: null }
            : v.kind === 'split'
              ? { kind: 'split', ident, key: t.key, ...named(titleOf(ident)), repoName: v.repoName, number: v.number, url: v.url, tagName: v.tagName, root: v.root, fromTag: null }
              : null;
    return {
      ident,
      key: t.key,
      title: t.title,
      url: t.url,
      statusName: t.statusName,
      done: t.done,
      readState: t.readState,
      ready: v.kind === 'ok',
      cancelled: v.kind === 'cancelled',
      inRelease: inScope.has(ident),
      pending: v.kind === 'checking',
      blocker,
      unverified: v.kind === 'unverified' ? v.reason : null,
      openPrs: openOf(ident),
      repos: per,
      stage: t.readState === 'ok' ? (t.stage ?? null) : null,
      typeName: t.typeName ?? null,
      assigneeName: t.assigneeName ?? null,
      readAt: iso(t.readAt ?? null),
      blockedBy: t.blockedBy ?? null,
      pullRequests: [...(ticketPrs.get(ident) ?? [])].sort(
        (a, b) => a.repoName.localeCompare(b.repoName) || a.number - b.number,
      ),
    };
  });

  const prs: ReleaseCheckPr[] = input.prs
    .filter((p) => listedPrIds.has(p.id))
    .map((p) => ({
      id: p.id,
      prId: p.prId ?? null,
      repoId: p.repoId,
      number: p.number,
      title: p.title,
      url: p.url,
      isBot: p.isBot,
      mergedAt: iso(p.mergedAt),
      ticketIdents: [...p.ticketIdents],
      authorLogin: p.authorLogin ?? null,
      tagName: prTagByRepo.get(p.repoId)?.get(p.id) ?? null,
      tagAt: tagAtOf(p.repoId, prTagByRepo.get(p.repoId)?.get(p.id) ?? null),
    }));
  return { repos, tickets, prs, trackerName: input.trackerName ?? null };
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────────

const READ_WORDS: Record<Exclude<ReleaseTicketReadState, 'ok' | 'not_found'>, string> = {
  no_access: 'there is no access to it',
  failed: 'the tracker did not answer',
  not_read: 'the tracker cannot read it',
};

/** The longest title a reason quotes before it is cut ("…"). */
const REASON_TITLE_MAX = 60;

/** A ticket title for a sentence: one line, cut at REASON_TITLE_MAX on a word with "…". Pure. */
export function releaseTitleShort(title: string | null | undefined): string | null {
  const t = (title ?? '').replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  if (t.length <= REASON_TITLE_MAX) return t;
  const cut = t.slice(0, REASON_TITLE_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > REASON_TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

/** "BMD-1048 “Edit an AREA”", "BMD-1040 “Hedgerow validation” (from 0.391.0)". Pure. */
const who = (key: string, fromTag: string | null, title?: string | null): string => {
  const t = releaseTitleShort(title);
  const named = t == null ? key : `${key} “${t}”`;
  return fromTag == null ? named : `${named} (from ${fromTag})`;
};

/** "in api (#812)", "in api (#812, #815) and web (#90)". Pure. */
function openPrWhere(prs: readonly ReleaseOpenPr[]): string {
  const byRepo = new Map<string, number[]>();
  for (const p of prs) byRepo.set(p.repoName, [...(byRepo.get(p.repoName) ?? []), p.number]);
  const parts = [...byRepo.entries()].map(([repo, ns]) => `${repo} (${ns.map((n) => `#${n}`).join(', ')})`);
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The PR a split ticket would ship without: "bng-metric-backend #539 (in 0.326.0)", "… (not in a tag yet)". Pure. */
export function releaseSplitWhere(b: { repoName: string; number: number; tagName: string | null }): string {
  // A release point named by this very PR (a repository released from merged pull requests) says nothing more.
  if (b.tagName != null && releasePointNumber(b.tagName) === b.number) return `${b.repoName} #${b.number}`;
  return `${b.repoName} #${b.number} (${b.tagName != null ? `in ${b.tagName}` : 'not in a tag yet'})`;
}

/** The end of a split reason — what that tag waits on: ", which waits on bng-metric-frontend 0.341.0:
 *  BMD-1061 “…” is In Code Review"; empty when not known. Pure. */
export function releaseSplitRootText(root: ReleaseSplitRoot | null | undefined): string {
  if (root == null) return '';
  return `, which waits on ${root.repoName} ${root.tagName}: ${releaseBlockerShort({ ...root.blocker, fromTag: null })}`;
}

/** A reason in a few words, no full stop, the ticket's title beside its key: "BMD-1048 “Edit an AREA”
 *  is In PO Review", "BMD-1050 “Habitat export” has an open pull request in web (#812)", "BMD-1040
 *  “Hedgerow validation” (from 0.391.0) is In Progress", "BMD-12 is not read yet". Pure. */
export function releaseBlockerShort(b: ReleaseBlocker): string {
  switch (b.kind) {
    case 'not_done':
      return `${who(b.key, b.fromTag, b.title)} is ${b.statusName ?? 'not Complete'}`;
    case 'open_pr':
      return `${who(b.key, b.fromTag, b.title)} has ${b.prs.length === 1 ? 'an open pull request' : 'open pull requests'} in ${openPrWhere(b.prs)}`;
    case 'checking':
      return b.key == null ? 'the history is still being read' : `${who(b.key, b.fromTag, b.title)} is not read yet`;
    case 'split':
      return `${who(b.key, b.fromTag, b.title)} would ship without ${releaseSplitWhere(b)}${releaseSplitRootText(b.root)}`;
  }
}

/** One plain sentence for a reason. Pure. */
export function releaseBlockerText(b: ReleaseBlocker): string {
  const s = releaseBlockerShort(b);
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

/** A ticket the tracker could not give, no full stop: "BMD-123 not found", "BMD-9 could not be read:
 *  the tracker did not answer". Pure. */
export function releaseUnverifiedText(u: Pick<ReleaseUnverified, 'key' | 'reason' | 'fromTag' | 'title'>): string {
  if (u.reason === 'not_found') return `${who(u.key, u.fromTag, u.title)} not found`;
  return `${who(u.key, u.fromTag, u.title)} could not be read: ${READ_WORDS[u.reason]}`;
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
  /** "Explain what's blocking" (release-blockers.ts): the last report and whether the button shows.
   *  Absent / null = AI is off here. */
  blockers?: ReleaseBlockersState | null;
}

/** POST /api/releases/refresh?workspace=<id> — Refresh: the tickets not Complete, not read yet or not
 *  given read again from the tracker (the reader's press), then the check. `unread` = tickets the tracker
 *  did not answer for. */
export interface ReleasesRefreshResponse extends ReleasesResponse {
  reread: number;
  unread: string[];
}

/** POST /api/releases/older-tags?workspace=<id> — "Show 50 more": the older band of one releasable
 *  repository should list `wanted` tags (kept as the larger of this and the current number; in memory,
 *  per account, workspace and repository). Starts the scan when more history or tickets are needed. */
export interface ReleaseOlderTagsBody {
  repoId: number;
  wanted: number;
}

export interface ReleaseOlderTagsResponse {
  workspaceId: number;
  repoId: number;
  wanted: number;
}

/** Any releasable repository still being checked, or its older band still read: the tab polls GET
 *  /api/releases while true. Pure. */
export function releasesChecking(r: Pick<ReleasesResponse, 'check'> | null | undefined): boolean {
  return r?.check?.repos.some((x) => x.checking || x.older?.loading === true) === true;
}
