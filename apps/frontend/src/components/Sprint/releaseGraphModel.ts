import { releasePointWords, type ReleaseCheckResult, type ReleaseGraph, type ReleaseLadder, type ReleasePointRef, type ReleaseWork } from '@pierre-review/shared';

// THE PATH TO NEWER RELEASES — the pure display half (docs/RELEASES.md § Releases tab, "Do these first" and
// "Path to newer releases"). Everything here reads the shared `releaseGraph(check)` fold, which the
// Releases tab folds ON READ from the check it already has: nothing here fetches.
//
//   • `planCards`    — the "Do these first" strip: the plan's moves, the first one THE best next move.
//   • `ladderRows`   — one row per repository: the candidate (★) → each stop → "Still checking".
//   • `workChip`     — one work item as a chip: a ticket (the story), a tracker-only ticket (its link), a new tag.
//   • `ticketGraphBadges` — the ticket list's one-line badge: "Unlocks api 0.330.0" / "Holds back api 0.330.0".
//
// ⚠ UNKNOWN IS NEVER ZERO: a repository with no stops and nothing being checked gets NO row (never "nothing
// needed"); a partial stop says its needs are still being read; a ladder past a checking tag ends in
// "Still checking".

/** How many moves the strip shows before "Show all n". */
export const PLAN_CARDS_SHOWN = 3;

/** A release point's key, for matching a stop to a move or a picked-together marker. */
export const pointKey = (p: { repoId: number; tagName: string }): string => `${p.repoId}:${p.tagName}`;

/** "api 0.330.0 · web w1.1.0". */
export function pointsWords(points: ReleasePointRef[]): string {
  return points.map(releasePointWords).join(' · ');
}

/** "Unlocks api 0.330.0 · web w1.1.0"; null when nothing. */
export function unlocksWords(points: ReleasePointRef[]): string | null {
  return points.length === 0 ? null : `Unlocks ${pointsWords(points)}`;
}

export interface WorkPrChip {
  key: string;
  /** "api #50". */
  label: string;
  /** The stored PR (the PR tab), else null → `url` on GitHub. */
  prId: number | null;
  repoId: number;
  /** "acme/api" for the PR tab ('' when not known). */
  repoFullName: string;
  number: number;
  url: string;
}

export interface WorkChipModel {
  id: string;
  /** `story` opens the in-app story; `tracker` links to the tracker (not in the app); `tag` is words only. */
  kind: 'story' | 'tracker' | 'tag';
  /** "BMD-1061", or "New version tag in web for #40". */
  label: string;
  /** The hover title: key, title, status, assignee. */
  title: string;
  /** For the story. */
  ident: string | null;
  key: string | null;
  ticketTitle: string | null;
  /** For a tracker-only ticket (→ `safeExternalUrl`). */
  url: string | null;
  /** Complete but a PR is still open: the PRs to finish. */
  prs: WorkPrChip[];
  /** Part of a loop of tracker links. */
  inCycle: boolean;
  /** Only in the way through a tracker link. */
  viaLink: boolean;
}

/** "New version tag in web for #40". */
export function newTagWords(w: Pick<ReleaseWork, 'repoName' | 'number'>): string {
  return `New version tag in ${w.repoName ?? 'its repository'}${w.number != null ? ` for #${w.number}` : ''}`;
}

/** Repository id → full name ("acme/api"), for a PR tab's header. */
export type RepoFullNames = ReadonlyMap<number, string>;

export function workChip(w: ReleaseWork, fullNames: RepoFullNames = new Map()): WorkChipModel {
  const prs: WorkPrChip[] = w.openPrs.map((p) => ({
    key: `${p.repoId}#${p.number}`,
    label: `${p.repoName} #${p.number}`,
    prId: p.prId,
    repoId: p.repoId,
    repoFullName: fullNames.get(p.repoId) ?? '',
    number: p.number,
    url: p.url,
  }));
  if (w.kind === 'new_tag') {
    const label = newTagWords(w);
    return { id: w.id, kind: 'tag', label, title: `${label}: merged work no version tag holds yet`, ident: null, key: null, ticketTitle: null, url: null, prs: [], inCycle: false, viaLink: false };
  }
  const key = w.key ?? w.ident ?? w.id;
  const parts = [w.title != null ? `${key} “${w.title}”` : key];
  if (w.state === 'open_pr') parts.push(`${w.statusName ?? 'Complete'}, pull request still open`);
  else if (w.statusName != null) parts.push(w.statusName);
  if (w.assigneeName != null) parts.push(w.assigneeName);
  if (w.state === 'tracker_link') parts.push('in the way through a tracker link');
  return {
    id: w.id,
    kind: w.id.startsWith('t:') && w.ident != null ? 'story' : 'tracker',
    label: key,
    title: parts.join(' · '),
    ident: w.ident,
    key,
    ticketTitle: w.title,
    url: w.url,
    prs,
    inCycle: w.inCycle,
    viaLink: w.state === 'tracker_link',
  };
}

const chipsOf = (ids: string[], byId: Map<string, ReleaseWork>, fullNames: RepoFullNames): WorkChipModel[] =>
  ids.map((id) => byId.get(id)).filter((w): w is ReleaseWork => w != null).map((w) => workChip(w, fullNames));

export interface PlanCard {
  /** 1-based step. */
  step: number;
  /** THE best next move. */
  best: boolean;
  work: WorkChipModel[];
  unlocks: string | null;
}

/** The "Do these first" strip: the moves in plan order; the first is the best next move. */
export function planCards(g: ReleaseGraph, fullNames: RepoFullNames = new Map()): PlanCard[] {
  const byId = new Map(g.work.map((w) => [w.id, w]));
  return g.moves.map((m, i) => ({ step: i + 1, best: i === 0, work: chipsOf(m.work, byId, fullNames), unlocks: unlocksWords(m.unlocks) }));
}

/** The strip's window: the first `PLAN_CARDS_SHOWN`, or all; `hidden` = how many "Show all n" would add. */
export function planWindow(cards: PlanCard[], all: boolean): { shown: PlanCard[]; hidden: number } {
  if (all || cards.length <= PLAN_CARDS_SHOWN) return { shown: cards, hidden: 0 };
  return { shown: cards.slice(0, PLAN_CARDS_SHOWN), hidden: cards.length - PLAN_CARDS_SHOWN };
}

export interface LadderStopModel {
  key: string;
  tagName: string;
  /** "3 tags" when the stop covers more than one; else null. */
  tagsWords: string | null;
  adds: WorkChipModel[];
  /** Work the tracker's links add (not the release rule). */
  via: WorkChipModel[];
  /** Picked together: the points first needed at THIS stop (the ones below are on the stops below). */
  withPoints: Array<{ key: string; words: string; /** The stop (in the other row) that holds that tag. */ target: string }>;
  partial: boolean;
  /** The plan's step that makes it releasable (1 = the best next move); null = past the plan. */
  step: number | null;
}

export interface LadderRowModel {
  repoId: number;
  repoName: string;
  /** The candidate's tag, or null: nothing can be released yet. */
  candidate: string | null;
  stops: LadderStopModel[];
  /** "Still checking from v6": the ladder ends there. */
  checkingFrom: string | null;
}

/** One row per repository with something above its candidate. A repository with no stops and nothing still
 *  checking gets NO row (its state is the repository line above the list, never "nothing needed"). */
export function ladderRows(g: ReleaseGraph, check: ReleaseCheckResult | null = null): LadderRowModel[] {
  const fullNames: RepoFullNames = new Map((check?.repos ?? []).map((r) => [r.repoId, r.fullName]));
  const stopOf = stopKeysByTag(g, check);
  const byId = new Map(g.work.map((w) => [w.id, w]));
  const steps = new Map<string, number>();
  g.moves.forEach((m, i) => {
    for (const p of m.unlocks) if (!steps.has(pointKey(p))) steps.set(pointKey(p), i + 1);
  });
  return g.ladders.filter((l) => l.stops.length > 0 || l.checkingFrom != null).map((l) => ladderRow(l, byId, steps, fullNames, stopOf));
}

/** Every newer tag → the key of the stop that holds it (a stop covers a run of `tags` tags, named by the
 *  highest). Without the check, only the stops' own tags are known. */
function stopKeysByTag(g: ReleaseGraph, check: ReleaseCheckResult | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of g.ladders) {
    // The same order the fold reads: the newer tags (not the candidate, not the older band), oldest first.
    const repo = check?.repos.find((r) => r.repoId === l.repoId);
    const tags = (repo?.tags ?? []).filter((t) => !t.isCandidate && t.band !== 'older').reverse().map((t) => t.name);
    let i = 0;
    for (const st of l.stops) {
      const key = pointKey({ repoId: l.repoId, tagName: st.tagName });
      out.set(key, key);
      for (const name of tags.slice(i, i + st.tags)) out.set(pointKey({ repoId: l.repoId, tagName: name }), key);
      i += st.tags;
    }
  }
  return out;
}

function ladderRow(l: ReleaseLadder, byId: Map<string, ReleaseWork>, steps: Map<string, number>, fullNames: RepoFullNames, stopOf: Map<string, string>): LadderRowModel {
  const seen = new Set<string>();
  const stops = l.stops.map((st): LadderStopModel => {
    const withPoints = st.withPoints
      .filter((p) => !seen.has(pointKey(p)))
      .map((p) => {
        seen.add(pointKey(p));
        return { key: pointKey(p), words: releasePointWords(p), target: stopOf.get(pointKey(p)) ?? pointKey(p) };
      });
    const key = pointKey({ repoId: l.repoId, tagName: st.tagName });
    return {
      key,
      tagName: st.tagName,
      tagsWords: st.tags > 1 ? `${st.tags} tags` : null,
      adds: chipsOf(st.adds, byId, fullNames),
      via: chipsOf(st.via, byId, fullNames),
      withPoints,
      partial: st.partial,
      step: steps.get(key) ?? null,
    };
  });
  // A move names only the HIGHEST point it unlocks per repository; the stops below it come free with it.
  let min: number | null = null;
  for (let i = stops.length - 1; i >= 0; i -= 1) {
    const s = stops[i]!;
    if (s.step != null && (min == null || s.step < min)) min = s.step;
    s.step = min;
  }
  return { repoId: l.repoId, repoName: l.repoName, candidate: l.candidate, stops, checkingFrom: l.checkingFrom };
}

export interface TicketGraphBadge {
  tone: 'unlocks' | 'holds';
  text: string;
}

/** Per ticket ident: "Unlocks api 0.330.0" (finishing it alone makes these releasable) else "Holds back
 *  api 0.330.0" (the first point it holds back). Only tickets that are work items get one. */
export function ticketGraphBadges(g: ReleaseGraph): Map<string, TicketGraphBadge> {
  const out = new Map<string, TicketGraphBadge>();
  for (const w of g.work) {
    if (!w.id.startsWith('t:') || w.ident == null) continue;
    const unlocks = unlocksWords(w.unlocksAlone);
    if (unlocks != null) out.set(w.ident, { tone: 'unlocks', text: unlocks });
    else if (w.holds[0] != null) out.set(w.ident, { tone: 'holds', text: `Holds back ${releasePointWords(w.holds[0])}` });
  }
  return out;
}
