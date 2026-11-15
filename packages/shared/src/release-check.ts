// THE RELEASE CHECK (docs/RELEASES.md § The release check) — ONE pure fold, DB-only inputs.
//
// ONLY THE WORKSPACE'S RELEASABLE REPOSITORIES are folded ("Released from this workspace", Settings →
// Releases); the caller hands in no other. EACH REPOSITORY IS JUDGED ON ITS OWN: its CANDIDATE is the
// newest version tag on the default branch after its BASELINE whose range holds no pull request linked
// to a ticket that is not Done. A ticket holds a tag when it is:
//   • not Done (the workspace's Complete stage — the caller resolves that through the This Sprint stage
//     resolver and hands `done` in);
//   • unreadable (`not_found` / `no_access` / `failed`, or never read on the workspace's site): Done is
//     unknown.
// Nothing else about pull requests across repositories counts (no "ships whole", no "open work"). A tag
// whose changes are not all read yet (`pending`) cannot be the candidate, and is said as "Reading
// changes…", never as a ticket blocker; a tag with more commits than are read (`too_large`) holds.
// Authorship never changes a block (a bot PR on a not-done ticket blocks). A human PR with no ticket is
// a WARNING; a bot PR with no ticket is listed under "Dependency and bot changes". A pull request into
// any other branch (a hotfix branch) is never in a stored range.
//
// THE BASELINE is the newer of: the newest RELEASE tag on the default branch, and the reader's START TAG
// ("Start from this tag": a version tag on the default branch; everything up to and including it is
// treated as accepted). A start tag that moved to another commit or is gone is not used (said on the
// row). With no baseline, only the newest TAG_RANGE_WINDOW tags are checked.
//
// RANGES are the stored per-tag INCREMENTS (previous default-branch tag, tag] (backend
// sync/tag-ranges.ts). A version tag's range from the baseline is the sum of the increments after the
// baseline, in `compareTagOrder` order. An increment that is missing or stale (its tag moved, or its
// base is no longer the previous tag) is PENDING.
//
// The fold never reads the clock and never fetches. Timestamps come in as Date and go out as ISO-8601.
import { tagKind, releaseTagName, type ReleaseSettings, type TagKind } from './releases.js';

/** A ticket's read state, as `tracker_tickets.state` stores it; `not_read` = no row on the site. */
export type ReleaseTicketReadState = 'ok' | 'not_found' | 'no_access' | 'failed' | 'not_read';

/** With NO baseline, the newest tags on the default branch that are checked (and get a stored range,
 *  sync/tag-ranges.ts). Older tags are treated like PRs older than the synced history: not listed. */
export const TAG_RANGE_WINDOW = 40;

export interface TagOrderKey {
  name: string;
  committedAt: Date | null;
  taggedAt: Date | null;
}

/** Oldest first: commit date, then tag date (a lightweight tag sorts first), then name. Pure. THE ONE
 *  tag order — the range planner (backend sync/tag-ranges.ts) and the release check share it. */
export function compareTagOrder(a: TagOrderKey, b: TagOrderKey): number {
  const ca = a.committedAt?.getTime() ?? 0;
  const cb = b.committedAt?.getTime() ?? 0;
  if (ca !== cb) return ca - cb;
  const ta = a.taggedAt?.getTime() ?? 0;
  const tb = b.taggedAt?.getTime() ?? 0;
  if (ta !== tb) return ta - tb;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The reader's "Start from this tag" for one repository, as stored (name + the commit it was at). */
export interface ReleaseStartTag {
  name: string;
  sha: string;
}

/** Why a stored start tag is not used: it now points at another commit, or it is no longer a version
 *  tag on the default branch (deleted, or the suffixes changed). */
export type ReleaseStartProblem = 'moved' | 'missing';

export interface BaselineTag extends TagOrderKey {
  sha: string;
  onDefaultBranch: boolean | null;
}

/**
 * THE BASELINE of one repository (pure; the fold and the range planner share it). `ordered` = the tags on
 * the default branch with a commit date, oldest first (`compareTagOrder`); `all` = every stored tag (to
 * tell a MOVED start tag from a missing one). `idx` = the ordered index of the baseline (−1 = none); the
 * newer of the newest release tag and the start tag wins.
 */
export function releaseBaselineOf<T extends BaselineTag>(
  ordered: readonly T[],
  all: readonly BaselineTag[],
  settings: ReleaseSettings,
  startTag: ReleaseStartTag | null,
): { idx: number; kind: 'release' | 'start' | null; releaseIdx: number; startIdx: number; startProblem: ReleaseStartProblem | null } {
  let releaseIdx = -1;
  for (let i = 0; i < ordered.length; i += 1) if (tagKind(ordered[i]!.name, settings) === 'release') releaseIdx = i;
  let startIdx = -1;
  let startProblem: ReleaseStartProblem | null = null;
  if (startTag != null) {
    const stored = all.find((t) => t.name === startTag.name);
    if (stored == null) startProblem = 'missing';
    else if (stored.sha !== startTag.sha) startProblem = 'moved';
    else {
      startIdx = ordered.findIndex((t) => t.name === startTag.name);
      const kind = tagKind(startTag.name, settings);
      if (startIdx < 0 || (kind != null && kind !== 'version')) {
        startIdx = -1;
        startProblem = 'missing';
      }
    }
  }
  const idx = Math.max(releaseIdx, startIdx);
  return { idx, kind: idx < 0 ? null : idx === releaseIdx ? 'release' : 'start', releaseIdx, startIdx, startProblem };
}

/** One workspace's view of a repository the range planner serves: its suffixes and its start tag. */
export interface ReleaseRangeView {
  settings: ReleaseSettings;
  startTag: ReleaseStartTag | null;
}

/**
 * The oldest index of `ordered` (default-branch tags, oldest first by `compareTagOrder`) that must have a
 * stored range, given every workspace that RELEASES this repository: just after the OLDEST baseline any
 * of them gives, or the window's start for one with no baseline. No such workspace ⇒ `ordered.length`
 * (no range is needed at all). Pure.
 */
export function tagRangeKeepFrom(
  ordered: readonly BaselineTag[],
  all: readonly BaselineTag[],
  views: readonly ReleaseRangeView[],
  window: number = TAG_RANGE_WINDOW,
): number {
  let from = ordered.length;
  for (const v of views) {
    const b = releaseBaselineOf(ordered, all, v.settings, v.startTag);
    from = Math.min(from, b.idx >= 0 ? b.idx + 1 : Math.max(0, ordered.length - window));
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

// ── Input ──────────────────────────────────────────────────────────────────────────────────────

export interface ReleaseCheckTagInput extends TagOrderKey {
  sha: string;
  /** null = not known yet (the tag is left out until it is). */
  onDefaultBranch: boolean | null;
  /** The tag was moved to another commit since Ensemble first saw it. */
  moved: boolean;
}

export interface ReleaseCheckRangeInput {
  tagName: string;
  sha: string;
  baseTagName: string | null;
  baseSha: string | null;
  method: 'compare' | 'history';
  prIds: number[];
  /** PR numbers in the range that are not stored yet (their tickets are unknown). */
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
  /** The reader can push here (the synced permission): "Create release…" shows only then. */
  writable: boolean;
  tags: ReleaseCheckTagInput[];
  ranges: ReleaseCheckRangeInput[];
  /** The reader's "Start from this tag" (null = none), with who set it and when. */
  startTag?: (ReleaseStartTag & { setBy: string | null; setAt: Date | null }) | null;
}

export interface ReleaseCheckPrInput {
  id: number;
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
  /** In the workspace's Complete stage ("Won't do" included). */
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
}

// ── Output ──────────────────────────────────────────────────────────────────────────────────────

/** Why a version tag is held back: a ticket by its own state, or a tag too large to read. */
export type ReleaseBlocker =
  | { kind: 'not_done'; ident: string; key: string; statusName: string | null }
  | { kind: 'unreadable'; ident: string; key: string; reason: Exclude<ReleaseTicketReadState, 'ok'> }
  /** The tag's compare has more commits than are read (`truncated`): its changes cannot be checked. */
  | { kind: 'too_large'; tagName: string };

export type ReleaseWarning =
  | { kind: 'untracked_pr'; repoId: number; prId: number }
  | { kind: 'unsynced_prs'; repoId: number; count: number };

export interface ReleaseTagRef {
  name: string;
  sha: string;
  committedAt: string | null;
}

export interface ReleaseTagCheck extends ReleaseTagRef {
  moved: boolean;
  isCandidate: boolean;
  /** Held back: by its own blockers or pending changes, or by an earlier version tag's. */
  blocked: boolean;
  /** What this tag ADDS (since the previous version tag or the baseline) that holds it back. */
  blockers: ReleaseBlocker[];
  /** This tag's increment's PRs (since the previous version tag or the baseline). */
  prIds: number[];
  /** Ticket idents on those PRs. */
  ticketIdents: string[];
  /** Its changes are not all read yet ("Reading changes…"): it cannot be the candidate yet. */
  pending: boolean;
  unmatchedCommits: number;
  truncated: boolean;
  unresolvedPrCount: number;
}

/** candidate · blocked (a ticket or a too-large tag holds the first tag) · reading (the first tag's
 *  changes are not read yet) · nothing_new (no version tag after the baseline). */
export type ReleaseRepoStatus = 'candidate' | 'blocked' | 'reading' | 'nothing_new';

export interface ReleaseRepoStartTag extends ReleaseStartTag {
  setBy: string | null;
  setAt: string | null;
  /** Not used, and why; null = it is the start (or a newer release tag is the baseline). */
  problem: ReleaseStartProblem | null;
}

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
  /** The newer of the newest release tag on the default branch and the start tag. */
  baseline: (ReleaseTagRef & { kind: 'release' | 'start' }) | null;
  /** The reader's start tag, as stored (null = none). */
  startTag: ReleaseRepoStartTag | null;
  /** The newest release OR hotfix tag (any branch) — the hotfix base. */
  latestRelease: (ReleaseTagRef & { kind: 'release' | 'hotfix' }) | null;
  candidate: (ReleaseTagRef & { releaseTagName: string; releaseTagExists: boolean }) | null;
  /** The first held-back version tag (newest-first order puts it after the candidate). */
  firstBlocked: string | null;
  /** Some tag after the baseline has changes not read yet. */
  reading: boolean;
  /** Version tags after the baseline, NEWEST first. */
  tags: ReleaseTagCheck[];
  /** Every version tag on the default branch, NEWEST first (the start-tag picker), at most 100. */
  versionTags: ReleaseTagRef[];
  /** Tickets in (baseline, candidate]. */
  ticketIdents: string[];
  /** Human PRs with no ticket in (baseline, candidate]. */
  untrackedPrIds: number[];
  /** Bot PRs with no ticket in (baseline, candidate] — "Dependency and bot changes". */
  botPrIds: number[];
  warningCount: number;
  /** No baseline: only the newest TAG_RANGE_WINDOW tags are checked (said in ONE line). */
  noBaseline: boolean;
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
  /** Its own state when not ready (not Done, unreadable). */
  blocker: Extract<ReleaseBlocker, { kind: 'not_done' | 'unreadable' }> | null;
  /** Per releasable repository it appears in (after the baseline). */
  repos: Array<{ repoId: number; state: ReleaseTicketRepoState; prIds: number[] }>;
}

export interface ReleaseCheckPr {
  id: number;
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

/** The version tags listed for the start-tag picker. */
export const RELEASE_VERSION_TAGS_MAX = 100;

// ── The fold ────────────────────────────────────────────────────────────────────────────────────

const iso = (d: Date | null): string | null => (d == null ? null : d.toISOString());
const ref = (t: ReleaseCheckTagInput): ReleaseTagRef => ({ name: t.name, sha: t.sha, committedAt: iso(t.committedAt) });

/** One version tag after the baseline and the ordered indexes its increment spans. */
interface Span {
  tagIdx: number;
  /** A compare in the span was truncated: its PRs cannot all be known (holds). */
  tooLarge: boolean;
  /** Ordered indexes (prevVersionOrBaseline, tagIdx]. */
  from: number;
  pending: boolean;
  prIds: number[];
  unmatched: number;
  truncated: boolean;
  unresolved: number;
}

type TicketBlocker = Extract<ReleaseBlocker, { kind: 'not_done' | 'unreadable' }>;

/** Fold ONE releasable repository. Pure. */
function foldRepo(
  repo: ReleaseCheckRepoInput,
  settings: ReleaseSettings,
  prById: ReadonlyMap<number, ReleaseCheckPrInput>,
  blockerOf: (ident: string) => TicketBlocker | null,
): { out: ReleaseRepoCheck; spans: Span[]; candidateSpan: number; ordered: ReleaseCheckTagInput[] } {
  const kindOf = (name: string): TagKind | null => tagKind(name, settings);
  const ordered = repo.tags.filter((t) => t.onDefaultBranch === true && t.committedAt != null).sort(compareTagOrder);
  const rangeByName = new Map(repo.ranges.map((r) => [r.tagName, r]));
  const valid = (i: number): ReleaseCheckRangeInput | null => {
    const t = ordered[i]!;
    const prev = i > 0 ? ordered[i - 1]! : null;
    const r = rangeByName.get(t.name);
    if (r == null || r.sha !== t.sha) return null;
    if (r.baseTagName !== (prev?.name ?? null) || r.baseSha !== (prev?.sha ?? null)) return null;
    return r;
  };
  const start = repo.startTag ?? null;
  const base = releaseBaselineOf(ordered, repo.tags, settings, start);
  const baselineIdx = base.idx;
  const baselineSha = baselineIdx >= 0 ? ordered[baselineIdx]!.sha : null;
  // With no baseline only the window is checked: older tags are not listed (like PRs older than the
  // synced history).
  const firstIdx = baselineIdx >= 0 ? baselineIdx + 1 : Math.max(0, ordered.length - TAG_RANGE_WINDOW);

  // A PR is counted in the FIRST increment that holds it.
  const pos = new Map<number, number>();
  for (let i = firstIdx; i < ordered.length; i += 1) {
    const r = valid(i);
    if (r != null) for (const id of r.prIds) if (!pos.has(id)) pos.set(id, i);
  }

  const spans: Span[] = [];
  let from = firstIdx;
  for (let i = firstIdx; i < ordered.length; i += 1) {
    const t = ordered[i]!;
    if (kindOf(t.name) !== 'version' || t.sha === baselineSha) continue;
    const span: Span = { tagIdx: i, from, tooLarge: false, pending: false, prIds: [], unmatched: 0, truncated: false, unresolved: 0 };
    for (let j = from; j <= i; j += 1) {
      const r = valid(j);
      if (r == null) {
        span.pending = true;
        continue;
      }
      if (r.truncated) span.tooLarge = true;
      for (const id of r.prIds) if (pos.get(id) === j && !span.prIds.includes(id)) span.prIds.push(id);
      span.unmatched += r.unmatchedCommits;
      span.truncated ||= r.truncated;
      span.unresolved += r.unresolvedPrNumbers.length;
    }
    spans.push(span);
    from = i + 1;
  }

  const ticketBlockers = (span: Span): TicketBlocker[] => {
    const out: TicketBlocker[] = [];
    const named = new Set<string>();
    for (const id of span.prIds) {
      for (const ident of prById.get(id)?.ticketIdents ?? []) {
        const b = blockerOf(ident);
        if (b != null && !named.has(ident)) {
          named.add(ident);
          out.push(b);
        }
      }
    }
    return out;
  };

  // The candidate: the newest span with nothing held at or before it.
  let candidateSpan = -1;
  for (let s = 0; s < spans.length; s += 1) {
    const span = spans[s]!;
    if (span.pending || span.tooLarge || ticketBlockers(span).length > 0) break;
    candidateSpan = s;
  }

  const tags: ReleaseTagCheck[] = spans.map((span, s) => {
    const t = ordered[span.tagIdx]!;
    const blockers: ReleaseBlocker[] = [];
    if (span.tooLarge) blockers.push({ kind: 'too_large', tagName: t.name });
    blockers.push(...ticketBlockers(span));
    const idents: string[] = [];
    for (const id of span.prIds) for (const ident of prById.get(id)?.ticketIdents ?? []) if (!idents.includes(ident)) idents.push(ident);
    return {
      ...ref(t),
      moved: t.moved,
      isCandidate: s === candidateSpan,
      blocked: s > candidateSpan,
      blockers,
      prIds: [...span.prIds],
      ticketIdents: idents,
      pending: span.pending,
      unmatchedCommits: span.unmatched,
      truncated: span.truncated,
      unresolvedPrCount: span.unresolved,
    };
  });

  const ticketIdents: string[] = [];
  const untrackedPrIds: number[] = [];
  const botPrIds: number[] = [];
  for (const span of candidateSpan >= 0 ? spans.slice(0, candidateSpan + 1) : []) {
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
  const firstHeld = spans[candidateSpan + 1] ?? null;
  const versions = ordered.filter((t) => kindOf(t.name) === 'version');
  const latestVersion = versions.length > 0 ? ref(versions[versions.length - 1]!) : null;
  const status: ReleaseRepoStatus =
    spans.length === 0 ? 'nothing_new' : candidate != null ? 'candidate' : firstHeld?.pending === true && !firstHeld.tooLarge ? 'reading' : 'blocked';
  const latestHit = latestReleaseTag(repo.tags, settings);
  const out: ReleaseRepoCheck = {
    repoId: repo.repoId,
    fullName: repo.fullName,
    name: repo.name,
    writable: repo.writable,
    status,
    nothingNewReason: spans.length > 0 ? null : latestVersion == null ? 'no_tags' : 'no_new_tags',
    latestVersion,
    baseline: baselineIdx >= 0 && base.kind != null ? { ...ref(ordered[baselineIdx]!), kind: base.kind } : null,
    startTag:
      start == null
        ? null
        : { name: start.name, sha: start.sha, setBy: start.setBy, setAt: iso(start.setAt), problem: base.startProblem },
    latestRelease: latestHit != null ? { ...ref(latestHit.tag), kind: latestHit.kind } : null,
    candidate,
    firstBlocked: firstHeld != null ? ordered[firstHeld.tagIdx]!.name : null,
    reading: spans.some((sp) => sp.pending),
    tags: tags.reverse(),
    versionTags: versions.slice(-RELEASE_VERSION_TAGS_MAX).reverse().map(ref),
    ticketIdents,
    untrackedPrIds,
    botPrIds,
    warningCount: 0,
    noBaseline: baselineIdx < 0,
  };
  return { out, spans, candidateSpan, ordered };
}

/** Run the release check. Pure. */
export function foldReleaseCheck(input: ReleaseCheckInput): ReleaseCheckResult {
  const prById = new Map(input.prs.map((p) => [p.id, p]));
  const ticketByIdent = new Map(input.tickets.map((t) => [t.ident, t]));
  const ticketOf = (ident: string): ReleaseCheckTicketInput =>
    ticketByIdent.get(ident) ?? { ident, key: ident, title: null, url: null, statusName: null, done: false, readState: 'not_read' };
  const blockerOf = (ident: string): TicketBlocker | null => {
    const t = ticketOf(ident);
    if (t.readState !== 'ok') return { kind: 'unreadable', ident, key: t.key, reason: t.readState };
    if (!t.done) return { kind: 'not_done', ident, key: t.key, statusName: t.statusName };
    return null;
  };

  const warnings: ReleaseWarning[] = [];
  const repos: ReleaseRepoCheck[] = [];
  /** ident → per repo: state and PRs. */
  const ticketRepos = new Map<string, Map<number, { state: ReleaseTicketRepoState; prIds: number[] }>>();
  const population: string[] = [];
  for (const repo of input.repos) {
    const { out, spans, candidateSpan } = foldRepo(repo, input.settings, prById, blockerOf);
    let unresolved = 0;
    spans.forEach((span, s) => {
      if (s <= candidateSpan) unresolved += span.unresolved;
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
    if (unresolved > 0) warnings.push({ kind: 'unsynced_prs', repoId: repo.repoId, count: unresolved });
    out.warningCount = out.untrackedPrIds.length + (unresolved > 0 ? 1 : 0);
    repos.push(out);
  }

  const tickets: ReleaseTicketCheck[] = population.map((ident) => {
    const t = ticketOf(ident);
    const b = blockerOf(ident);
    const per = [...(ticketRepos.get(ident) ?? new Map()).entries()]
      .sort((a, z) => a[0] - z[0])
      .map(([repoId, v]) => ({ repoId, state: v.state, prIds: [...v.prIds].sort((x, y) => x - y) }));
    return {
      ident,
      key: t.key,
      title: t.title,
      url: t.url,
      statusName: t.statusName,
      done: t.done,
      readState: t.readState,
      ready: b == null,
      inRelease: b == null && per.some((r) => r.state === 'in_candidate'),
      blocker: b,
      repos: per,
    };
  });

  const prs: ReleaseCheckPr[] = input.prs.map((p) => ({
    id: p.id,
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
  not_read: 'it has not been read yet',
};

/** One plain sentence for a blocker. Pure. */
export function releaseBlockerText(b: ReleaseBlocker, _ctx?: ReleaseWordsContext): string {
  switch (b.kind) {
    case 'too_large':
      return `${b.tagName} has more commits than can be read, so its changes cannot be checked.`;
    case 'not_done':
      return b.statusName != null ? `${b.key} is not done (${b.statusName}).` : `${b.key} is not done.`;
    case 'unreadable':
      return `${b.key} could not be read: ${READ_WORDS[b.reason]}.`;
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

/** PUT /api/releases/start-tag?workspace=<id> — "Start from this tag" for one releasable repository
 *  (`tagName` null clears it). DB only; nothing is written to GitHub. Answers the check again. */
export interface SetReleaseStartTagBody {
  repoId: number;
  tagName: string | null;
}
