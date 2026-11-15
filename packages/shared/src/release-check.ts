// THE RELEASE CHECK (docs/RELEASES.md § The release check) — ONE pure fold, DB-only inputs.
//
// Per repo the CANDIDATE is the newest version tag after the BASELINE (the newest release tag on the
// default branch) whose range holds no pull request linked to a ticket that is not ready. A ticket is
// not ready when it is:
//   • not Done (the workspace's Complete stage — the caller resolves that through the This Sprint
//     stage resolver and hands `done` in);
//   • unreadable (`not_found` / `no_access` / `failed`, or never read on the workspace's site);
//   • on an OPEN pull request into the default branch;
//   • NOT SHIPPING WHOLE: the candidates would ship some of its merged pull requests into the default
//     branch while another one, in any of its repos, is not inside that repo's candidate. Holding it
//     moves candidates back, which can make more tickets ship in part, so the check REPEATS until
//     nothing changes (a held ticket stays held, candidates only move back: it ends). A ticket wholly
//     past every candidate ships nothing and holds nothing (it is ready, just not in this release).
// Authorship never changes a block (a bot PR on a not-done ticket blocks). A human PR with no ticket is
// a WARNING; a bot PR with no ticket is listed under "Dependency and bot changes". A linked repo with
// no pull request for the ticket is a warning. A pull request into any other branch (a hotfix branch)
// never counts — the caller marks it `intoDefaultBranch: false` and the stored ranges never hold it.
//
// RANGES are the stored per-tag INCREMENTS (previous default-branch tag, tag] (backend
// sync/tag-ranges.ts). A version tag's range from the baseline is the sum of the increments after the
// baseline, in `compareTagOrder` order. An increment that is missing or stale (its tag moved, or its
// base is no longer the previous tag) is PENDING: that tag cannot be a candidate yet.
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

// ── Input ───────────────────────────────────────────────────────────────────────────────────────

export interface ReleaseCheckTagInput extends TagOrderKey {
  sha: string;
  /** null = not known yet (the tag is left out until it is). */
  onDefaultBranch: boolean | null;
  /** The tag was moved to another commit since Limn first saw it. */
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
  repos: ReleaseCheckRepoInput[];
  /** Every PR in a stored range, plus every open / merged PR on a ticket any of them names. */
  prs: ReleaseCheckPrInput[];
  tickets: ReleaseCheckTicketInput[];
  /** The reader's accepted repos per ticket (`sprint_ticket_repos`). */
  acceptedRepos: Array<{ ident: string; repoId: number }>;
}

// ── Output ──────────────────────────────────────────────────────────────────────────────────────

/** Why a version tag (or a ticket) is held back. */
export type ReleaseBlocker =
  | { kind: 'not_done'; ident: string; key: string; statusName: string | null }
  | { kind: 'unreadable'; ident: string; key: string; reason: Exclude<ReleaseTicketReadState, 'ok'> }
  | { kind: 'open_pr'; ident: string; key: string; repoId: number; prId: number }
  | {
      kind: 'not_whole';
      ident: string;
      key: string;
      /** Each merged PR into the default branch that is not inside its repo's candidate. `tagName`
       *  null = merged but in no version tag yet. */
      missing: Array<{ repoId: number; prId: number; tagName: string | null }>;
    }
  | { kind: 'range_pending'; tagName: string };

export type ReleaseWarning =
  | { kind: 'untracked_pr'; repoId: number; prId: number }
  | { kind: 'linked_no_pr'; ident: string; key: string; repoId: number }
  | { kind: 'unsynced_prs'; repoId: number; count: number };

export interface ReleaseTagRef {
  name: string;
  sha: string;
  committedAt: string | null;
}

export interface ReleaseTagCheck extends ReleaseTagRef {
  moved: boolean;
  isCandidate: boolean;
  /** Held back: by its own blockers, or by an earlier version tag's. */
  blocked: boolean;
  /** What this tag ADDS (since the previous version tag or the baseline) that holds it back. */
  blockers: ReleaseBlocker[];
  /** This tag's increment's PRs (since the previous version tag or the baseline). */
  prIds: number[];
  /** Ticket idents on those PRs. */
  ticketIdents: string[];
  pending: boolean;
  unmatchedCommits: number;
  truncated: boolean;
  unresolvedPrCount: number;
}

export type ReleaseRepoStatus = 'candidate' | 'blocked' | 'nothing_new';

export interface ReleaseRepoCheck {
  repoId: number;
  fullName: string;
  name: string;
  writable: boolean;
  status: ReleaseRepoStatus;
  /** `nothing_new` only: no tags at all, or none after the baseline. */
  nothingNewReason: 'no_tags' | 'no_new_tags' | null;
  baseline: ReleaseTagRef | null;
  /** The newest release OR hotfix tag (any branch) — the hotfix base. */
  latestRelease: (ReleaseTagRef & { kind: 'release' | 'hotfix' }) | null;
  candidate: (ReleaseTagRef & { releaseTagName: string; releaseTagExists: boolean }) | null;
  /** The first held-back version tag (newest-first order puts it after the candidate). */
  firstBlocked: string | null;
  /** Version tags after the baseline, NEWEST first. */
  tags: ReleaseTagCheck[];
  /** Tickets in (baseline, candidate]. */
  ticketIdents: string[];
  /** Human PRs with no ticket in (baseline, candidate]. */
  untrackedPrIds: number[];
  /** Bot PRs with no ticket in (baseline, candidate] — "Dependency and bot changes". */
  botPrIds: number[];
  warningCount: number;
  /** No baseline: PRs merged before the synced history are not checked (said in ONE line). */
  noBaseline: boolean;
}

export type ReleaseTicketRepoState =
  | 'in_candidate'
  | 'released'
  | 'merged_after_candidate'
  | 'open_pr'
  | 'linked_no_pr';

export interface ReleaseTicketCheck {
  ident: string;
  key: string;
  title: string | null;
  url: string | null;
  statusName: string | null;
  done: boolean;
  readState: ReleaseTicketReadState;
  ready: boolean;
  /** Ready and in at least one candidate. */
  inRelease: boolean;
  blocker: ReleaseBlocker | null;
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
  /** Rounds of the ships-whole rule until nothing changed (≥ 1). */
  rounds: number;
}

// ── The fold ────────────────────────────────────────────────────────────────────────────────────

const iso = (d: Date | null): string | null => (d == null ? null : d.toISOString());
const ref = (t: ReleaseCheckTagInput): ReleaseTagRef => ({ name: t.name, sha: t.sha, committedAt: iso(t.committedAt) });

/** One version tag after the baseline and the ordered indexes its increment spans. */
interface Span {
  tagIdx: number;
  /** Ordered indexes (prevVersionOrBaseline, tagIdx]. */
  from: number;
  pending: boolean;
  prIds: number[];
  unmatched: number;
  truncated: boolean;
  unresolved: number;
}

interface RepoPrep {
  input: ReleaseCheckRepoInput;
  ordered: ReleaseCheckTagInput[];
  baselineIdx: number;
  spans: Span[];
  /** PR id → ordered index of the increment holding it. */
  pos: Map<number, number>;
  /** PRs merged no later than this (ms) and in no range are older than the read history. */
  floorMs: number | null;
  latestRelease: ReleaseRepoCheck['latestRelease'];
}

function prepRepo(repo: ReleaseCheckRepoInput, settings: ReleaseSettings): RepoPrep {
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
  const pos = new Map<number, number>();
  let floorMs: number | null = null;
  for (let i = 0; i < ordered.length; i += 1) {
    const r = valid(i);
    if (r == null) continue;
    if (floorMs == null) {
      const at = r.method === 'history' ? ordered[i]!.committedAt : (ordered[i - 1]?.committedAt ?? null);
      floorMs = at?.getTime() ?? null;
    }
    for (const id of r.prIds) if (!pos.has(id)) pos.set(id, i);
  }
  let baselineIdx = -1;
  for (let i = 0; i < ordered.length; i += 1) if (kindOf(ordered[i]!.name) === 'release') baselineIdx = i;
  const baselineSha = baselineIdx >= 0 ? ordered[baselineIdx]!.sha : null;

  const spans: Span[] = [];
  let from = baselineIdx + 1;
  for (let i = baselineIdx + 1; i < ordered.length; i += 1) {
    const t = ordered[i]!;
    if (kindOf(t.name) !== 'version' || t.sha === baselineSha) continue;
    const span: Span = { tagIdx: i, from, pending: false, prIds: [], unmatched: 0, truncated: false, unresolved: 0 };
    for (let j = from; j <= i; j += 1) {
      const r = valid(j);
      if (r == null) {
        span.pending = true;
        continue;
      }
      for (const id of r.prIds) if (pos.get(id) === j && !span.prIds.includes(id)) span.prIds.push(id);
      span.unmatched += r.unmatchedCommits;
      span.truncated ||= r.truncated;
      span.unresolved += r.unresolvedPrNumbers.length;
    }
    spans.push(span);
    from = i + 1;
  }

  const latestHit = latestReleaseTag(repo.tags, settings);
  const latest = latestHit?.tag ?? null;
  const latestKind = latestHit?.kind ?? null;
  return {
    input: repo,
    ordered,
    baselineIdx,
    spans,
    pos,
    floorMs,
    latestRelease: latest != null && latestKind != null ? { ...ref(latest), kind: latestKind } : null,
  };
}

/** Run the release check. Pure. */
export function foldReleaseCheck(input: ReleaseCheckInput): ReleaseCheckResult {
  const preps = input.repos.map((r) => prepRepo(r, input.settings));
  const prepById = new Map(preps.map((p) => [p.input.repoId, p]));
  const prById = new Map(input.prs.map((p) => [p.id, p]));
  const ticketByIdent = new Map(input.tickets.map((t) => [t.ident, t]));
  const ticketOf = (ident: string): ReleaseCheckTicketInput =>
    ticketByIdent.get(ident) ?? {
      ident,
      key: ident,
      title: null,
      url: null,
      statusName: null,
      done: false,
      readState: 'not_read',
    };

  // Every PR per ticket (any repo of the workspace), merged / open into the default branch only.
  const mergedByTicket = new Map<string, ReleaseCheckPrInput[]>();
  const openByTicket = new Map<string, ReleaseCheckPrInput[]>();
  for (const p of input.prs) {
    if (!p.intoDefaultBranch || !prepById.has(p.repoId)) continue;
    const into = p.state === 'merged' ? mergedByTicket : p.state === 'open' ? openByTicket : null;
    if (into == null) continue;
    for (const ident of new Set(p.ticketIdents)) into.set(ident, [...(into.get(ident) ?? []), p]);
  }

  // THE POPULATION: tickets on a PR in any repo's range after its baseline.
  const population: string[] = [];
  const seen = new Set<string>();
  for (const prep of preps) {
    for (const span of prep.spans) {
      for (const id of span.prIds) {
        for (const ident of prById.get(id)?.ticketIdents ?? []) {
          if (!seen.has(ident)) {
            seen.add(ident);
            population.push(ident);
          }
        }
      }
    }
  }

  // Ticket-level blocks that do not depend on candidates.
  const blocked = new Map<string, ReleaseBlocker>();
  for (const ident of population) {
    const t = ticketOf(ident);
    if (t.readState !== 'ok') blocked.set(ident, { kind: 'unreadable', ident, key: t.key, reason: t.readState });
    else if (!t.done) blocked.set(ident, { kind: 'not_done', ident, key: t.key, statusName: t.statusName });
    else {
      const open = (openByTicket.get(ident) ?? []).sort((a, b) => a.repoId - b.repoId || a.number - b.number)[0];
      if (open != null) blocked.set(ident, { kind: 'open_pr', ident, key: t.key, repoId: open.repoId, prId: open.id });
    }
  }

  const posOf = (prep: RepoPrep, p: ReleaseCheckPrInput): number => {
    const at = prep.pos.get(p.id);
    if (at != null) return at;
    const merged = p.mergedAt?.getTime() ?? null;
    if (merged != null && prep.floorMs != null && merged <= prep.floorMs) return Number.NEGATIVE_INFINITY;
    return Number.POSITIVE_INFINITY;
  };

  /** Per repo: the candidate's span index (−1 = none) and the cover index (what is released or in the candidate). */
  const candidates = (): Map<number, { spanIdx: number; coverIdx: number }> => {
    const out = new Map<number, { spanIdx: number; coverIdx: number }>();
    for (const prep of preps) {
      let spanIdx = -1;
      for (let s = 0; s < prep.spans.length; s += 1) {
        const span = prep.spans[s]!;
        const held =
          span.pending ||
          span.prIds.some((id) => (prById.get(id)?.ticketIdents ?? []).some((ident) => blocked.has(ident)));
        if (held) break;
        spanIdx = s;
      }
      const coverIdx = spanIdx >= 0 ? prep.spans[spanIdx]!.tagIdx : prep.baselineIdx;
      out.set(prep.input.repoId, { spanIdx, coverIdx });
    }
    return out;
  };

  // THE SHIPS-WHOLE RULE, to a fixpoint.
  let cands = candidates();
  let rounds = 0;
  for (;;) {
    rounds += 1;
    const added: Array<[string, ReleaseBlocker]> = [];
    for (const ident of population) {
      if (blocked.has(ident)) continue;
      const missing: Array<{ repoId: number; prId: number; tagName: string | null }> = [];
      let shipping = false;
      for (const p of mergedByTicket.get(ident) ?? []) {
        const prep = prepById.get(p.repoId)!;
        const at = posOf(prep, p);
        if (at <= cands.get(p.repoId)!.coverIdx) {
          if (at > prep.baselineIdx) shipping = true;
          continue;
        }
        missing.push({ repoId: p.repoId, prId: p.id, tagName: Number.isFinite(at) ? taggedIn(prep, at) : null });
      }
      // Only a ticket the candidates would ship IN PART is held: one wholly past every candidate ships
      // nothing and holds nothing. Once held it stays held (that is what keeps the rounds monotone).
      if (shipping && missing.length > 0) added.push([ident, { kind: 'not_whole', ident, key: ticketOf(ident).key, missing }]);
    }
    if (added.length === 0) break;
    for (const [ident, b] of added) blocked.set(ident, b);
    cands = candidates();
  }

  // ── Build the output ──
  const accepted = new Map<string, Set<number>>();
  for (const a of input.acceptedRepos) {
    if (!prepById.has(a.repoId)) continue;
    const s = accepted.get(a.ident) ?? new Set<number>();
    s.add(a.repoId);
    accepted.set(a.ident, s);
  }

  const warnings: ReleaseWarning[] = [];
  const repoWarnings = new Map<number, number>();
  const bump = (repoId: number): void => void repoWarnings.set(repoId, (repoWarnings.get(repoId) ?? 0) + 1);
  const shippedTickets = new Map<number, string[]>();
  const repoOut: ReleaseRepoCheck[] = [];

  for (const prep of preps) {
    const { input: repo, ordered, baselineIdx, spans } = prep;
    const c = cands.get(repo.repoId)!;
    const tags: ReleaseTagCheck[] = spans.map((span, s) => {
      const t = ordered[span.tagIdx]!;
      const blockers: ReleaseBlocker[] = [];
      if (span.pending) blockers.push({ kind: 'range_pending', tagName: t.name });
      const named = new Set<string>();
      const idents: string[] = [];
      for (const id of span.prIds) {
        for (const ident of prById.get(id)?.ticketIdents ?? []) {
          if (!idents.includes(ident)) idents.push(ident);
          const b = blocked.get(ident);
          if (b != null && !named.has(ident)) {
            named.add(ident);
            blockers.push(b);
          }
        }
      }
      return {
        ...ref(t),
        moved: t.moved,
        isCandidate: s === c.spanIdx,
        blocked: s > c.spanIdx,
        blockers,
        prIds: [...span.prIds],
        ticketIdents: idents,
        pending: span.pending,
        unmatchedCommits: span.unmatched,
        truncated: span.truncated,
        unresolvedPrCount: span.unresolved,
      };
    });

    const inCandidate = c.spanIdx >= 0 ? spans.slice(0, c.spanIdx + 1) : [];
    const ticketIdents: string[] = [];
    const untrackedPrIds: number[] = [];
    const botPrIds: number[] = [];
    let unresolved = 0;
    for (const span of inCandidate) {
      unresolved += span.unresolved;
      for (const id of span.prIds) {
        const p = prById.get(id);
        if (p == null) continue;
        if (p.ticketIdents.length === 0) (p.isBot ? botPrIds : untrackedPrIds).push(id);
        for (const ident of p.ticketIdents) if (!ticketIdents.includes(ident)) ticketIdents.push(ident);
      }
    }
    for (const prId of untrackedPrIds) {
      warnings.push({ kind: 'untracked_pr', repoId: repo.repoId, prId });
      bump(repo.repoId);
    }
    if (unresolved > 0) {
      warnings.push({ kind: 'unsynced_prs', repoId: repo.repoId, count: unresolved });
      bump(repo.repoId);
    }
    shippedTickets.set(repo.repoId, ticketIdents);

    const candTag = c.spanIdx >= 0 ? ordered[spans[c.spanIdx]!.tagIdx]! : null;
    const suffix = input.settings.releaseSuffix ?? '';
    const candidate =
      candTag == null
        ? null
        : {
            ...ref(candTag),
            releaseTagName: releaseTagName(candTag.name, suffix),
            releaseTagExists: repo.tags.some((t) => t.name === releaseTagName(candTag.name, suffix)),
          };
    const firstBlockedSpan = spans[c.spanIdx + 1];
    repoOut.push({
      repoId: repo.repoId,
      fullName: repo.fullName,
      name: repo.name,
      writable: repo.writable,
      status: spans.length === 0 ? 'nothing_new' : candidate != null ? 'candidate' : 'blocked',
      nothingNewReason: spans.length > 0 ? null : ordered.length === 0 ? 'no_tags' : 'no_new_tags',
      baseline: baselineIdx >= 0 ? ref(ordered[baselineIdx]!) : null,
      latestRelease: prep.latestRelease,
      candidate,
      firstBlocked: firstBlockedSpan != null ? ordered[firstBlockedSpan.tagIdx]!.name : null,
      tags: tags.reverse(),
      ticketIdents,
      untrackedPrIds,
      botPrIds,
      warningCount: 0,
      noBaseline: baselineIdx < 0,
    });
  }

  // Tickets: per repo state.
  const tickets: ReleaseTicketCheck[] = population.map((ident) => {
    const t = ticketOf(ident);
    const merged = mergedByTicket.get(ident) ?? [];
    const open = openByTicket.get(ident) ?? [];
    const repoIds = new Set<number>([...(accepted.get(ident) ?? []), ...merged.map((p) => p.repoId), ...open.map((p) => p.repoId)]);
    const repos = [...repoIds]
      .sort((a, b) => a - b)
      .map((repoId) => {
        const prep = prepById.get(repoId)!;
        const c = cands.get(repoId)!;
        const m = merged.filter((p) => p.repoId === repoId);
        const o = open.filter((p) => p.repoId === repoId);
        const prIds = [...o, ...m].map((p) => p.id);
        let state: ReleaseTicketRepoState;
        if (o.length > 0) state = 'open_pr';
        else if (m.length === 0) state = 'linked_no_pr';
        else {
          const at = m.map((p) => posOf(prep, p));
          if (at.some((x) => x > c.coverIdx)) state = 'merged_after_candidate';
          else state = at.some((x) => x > prep.baselineIdx) ? 'in_candidate' : 'released';
        }
        return { repoId, state, prIds };
      });
    const b = blocked.get(ident) ?? null;
    return {
      ident,
      key: t.key,
      title: t.title,
      url: t.url,
      statusName: t.statusName,
      done: t.done,
      readState: t.readState,
      ready: b == null,
      inRelease: b == null && repos.some((r) => r.state === 'in_candidate'),
      blocker: b,
      repos,
    };
  });

  // Linked repos with no PR, for tickets the release ships.
  for (const tk of tickets) {
    if (!tk.inRelease) continue;
    for (const r of tk.repos) {
      if (r.state !== 'linked_no_pr') continue;
      warnings.push({ kind: 'linked_no_pr', ident: tk.ident, key: tk.key, repoId: r.repoId });
      for (const out of repoOut) if (shippedTickets.get(out.repoId)?.includes(tk.ident)) bump(out.repoId);
    }
  }
  for (const out of repoOut) out.warningCount = repoWarnings.get(out.repoId) ?? 0;

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
  return { repos: repoOut, tickets, warnings, prs, rounds };
}

/** The version tag whose increment holds ordered index `at` (or the tag at `at` itself). */
function taggedIn(prep: RepoPrep, at: number): string | null {
  for (const span of prep.spans) if (at >= span.from && at <= span.tagIdx) return prep.ordered[span.tagIdx]!.name;
  return prep.ordered[at]?.name ?? null;
}

// ── The dialog's re-check ───────────────────────────────────────────────────────────────────────

export interface ReleaseSelectionProblem {
  ident: string;
  key: string;
  /** Unticked repos the ticket needs. */
  missingRepoIds: number[];
}

/**
 * Unticking repos in "Create release…": every ticket the release would ship that ALSO needs an
 * unticked repo would ship in part — Confirm is blocked, naming it. Empty = the selection may be
 * released. Pure; reads the fold's result (unticking moves no candidate, it blocks Confirm).
 */
export function releaseSelectionProblems(
  result: Pick<ReleaseCheckResult, 'tickets'>,
  includedRepoIds: readonly number[],
): ReleaseSelectionProblem[] {
  const included = new Set(includedRepoIds);
  const out: ReleaseSelectionProblem[] = [];
  for (const t of result.tickets) {
    if (!t.inRelease) continue;
    const shipping = t.repos.filter((r) => r.state === 'in_candidate');
    if (!shipping.some((r) => included.has(r.repoId))) continue;
    const missing = shipping.filter((r) => !included.has(r.repoId)).map((r) => r.repoId);
    if (missing.length > 0) out.push({ ident: t.ident, key: t.key, missingRepoIds: missing });
  }
  return out;
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────────

export interface ReleaseWordsContext {
  repoName: (repoId: number) => string;
  prNumber: (prId: number) => number | null;
  /** Where the sentence is shown: a repo and its held tag ("PLAT-290 holds api at v2.4.0"). */
  shownRepoId?: number;
  shownTagName?: string;
}

const READ_WORDS: Record<Exclude<ReleaseTicketReadState, 'ok'>, string> = {
  not_found: 'it was not found',
  no_access: 'there is no access to it',
  failed: 'the tracker did not answer',
  not_read: 'it has not been read yet',
};

/** One plain sentence for a blocker. Pure. */
export function releaseBlockerText(b: ReleaseBlocker, ctx: ReleaseWordsContext): string {
  const pr = (id: number): string => {
    const n = ctx.prNumber(id);
    return n == null ? 'PR' : `PR #${n}`;
  };
  switch (b.kind) {
    case 'range_pending':
      return `The changes in ${b.tagName} are not read yet.`;
    case 'not_done':
      return b.statusName != null ? `${b.key} is not done (${b.statusName}).` : `${b.key} is not done.`;
    case 'unreadable':
      return `${b.key} could not be read: ${READ_WORDS[b.reason]}.`;
    case 'open_pr':
      return `${b.key} has an open ${ctx.repoName(b.repoId)} ${pr(b.prId)}.`;
    case 'not_whole': {
      const m = b.missing.find((x) => x.repoId !== ctx.shownRepoId) ?? b.missing[0];
      const lead =
        ctx.shownRepoId != null && ctx.shownTagName != null
          ? `${b.key} holds ${ctx.repoName(ctx.shownRepoId)} at ${ctx.shownTagName}`
          : `${b.key} is not ready`;
      if (m == null) return `${lead}.`;
      const repo = ctx.repoName(m.repoId);
      return m.tagName == null
        ? `${lead}: its ${repo} ${pr(m.prId)} is merged but not in a version tag yet. Cut a tag in ${repo}.`
        : `${lead}: its ${repo} ${pr(m.prId)} is in ${m.tagName}, which is held back.`;
    }
  }
}

// ── The wire ────────────────────────────────────────────────────────────────────────────────────

/** GET /api/releases?workspace=<id> — DB only, never fetches GitHub or the tracker. */
export interface ReleasesResponse {
  workspaceId: number;
  /** Both suffixes are set. False → `check` is null and the tab shows its ONE setup line. */
  configured: boolean;
  releaseSuffix: string | null;
  hotfixSuffix: string | null;
  /** The newest release made from this workspace (null = none yet). */
  latestRelease: { id: number; createdAt: string; state: 'writing' | 'done' | 'partial' | 'failed' | 'stopped' } | null;
  /** The newest release or hotfix tag across the workspace's repos, by its commit date. */
  latestReleaseTagAt: string | null;
  check: ReleaseCheckResult | null;
}
