import type { ReleaseBlocker, ReleaseCheckResult, ReleaseOpenPr, ReleaseRepoCheck, ReleaseTagCheck, ReleaseTicketCheck } from './release-check.js';

// THE RELEASE GRAPH (docs/RELEASES.md § The path to newer releases). ONE pure fold over the release check
// (`foldReleaseCheck`'s result): no fetch, no clock, no AI. The SPA folds it on read; the backend folds
// the same thing for "Explain what's blocking" (releases/blockers-input.ts).
//
// THE SHAPE. At or below a repository's candidate everything can be released: a straight line, nothing to
// plan. Above it, the version tags of ONE repository are a LADDER: releasing a tag ships everything below
// it, so a newer tag needs everything an older one needs plus its own (the needs only grow). What makes it
// a graph is the edges BETWEEN ladders and work:
//
//   tag → ticket            the tag holds a ticket not Complete (`not_done`) or with an open PR (`open_pr`)
//   ticket → pull request   the open PRs the ticket waits on
//   tag → tag (other repo)  a `split`: releasing the tag would ship a ticket without its work in another
//                           repository, so that repository's tag must be releasable too (its needs join)
//   tag → "new version tag" a split whose other half is merged but in no tag yet
//   ticket → ticket         the TRACKER's own "is blocked by" links (`blockedBy`) to a ticket not Complete:
//                           not the release rule, so kept APART (`via`), but a ticket cannot really be
//                           finished first, so the plan counts them
//
// THE LADDER of a repository: its newer tags OLDEST first, each with its CUMULATIVE needs; consecutive tags
// with the same needs fold into ONE STOP (the highest of them — the furthest the candidate can move for
// that work). A tag still CHECKING ends the ladder (what lies above is not known yet).
//
// THE PLAN (`moves`): which work to finish first. Within ONE ladder the needs are nested, so the cheapest
// next stop is exact. Across ladders (picked-together splits, shared tickets) choosing the fewest tickets
// for the most releases is a set-cover problem, so the plan is GREEDY: each move takes the next stop (in
// any ladder) that needs the FEWEST unfinished items, ties broken by how many release points it unlocks.
// Each work item carries `unlocksAlone` (finish only this, and what it waits on: these become
// releasable) and `holds` (the first point it holds back in each repository).
//
// ⚠ UNKNOWN IS NEVER ZERO: a stop whose tag also has `checking` reasons is `partial` (its needs are a floor),
// and a ladder past a checking tag stops (`checkingFrom`), never "nothing needed".

/** A release point: a version tag (or, on a `prs` basis, a merged PR's point `#539`) of one repository. */
export interface ReleasePointRef {
  repoId: number;
  repoName: string;
  tagName: string;
}

/** What has to happen: a ticket, or a new version tag holding work merged after the newest tag. */
export type ReleaseWorkKind = 'ticket' | 'new_tag';

/** Why a work item stands in the way. */
export type ReleaseWorkState =
  /** The ticket is not Complete. */
  | 'not_done'
  /** Complete, but a pull request for it is still open. */
  | 'open_pr'
  /** Only through the tracker's "is blocked by" link from a ticket that holds a release. */
  | 'tracker_link'
  /** Merged work that no version tag holds yet. */
  | 'new_tag';

export interface ReleaseWork {
  /** `t:<ident>` (a ticket in the check), `k:<key>` (a ticket only a tracker link names), `n:<repo>#<n>`. */
  id: string;
  kind: ReleaseWorkKind;
  state: ReleaseWorkState;
  /** Ticket key, or null for a new tag. */
  key: string | null;
  ident: string | null;
  title: string | null;
  statusName: string | null;
  assigneeName: string | null;
  /** The tracker link (→ `safeExternalUrl`). */
  url: string | null;
  openPrs: ReleaseOpenPr[];
  /** `new_tag`: the repository and the pull request that no tag holds yet. */
  repoName: string | null;
  number: number | null;
  /** Work ids this one waits on through the tracker's "is blocked by" links (not Complete). */
  waitsOn: string[];
  /** Part of a loop of tracker links (A waits on B waits on A). */
  inCycle: boolean;
  /** Per repository, the FIRST release point it holds back. */
  holds: ReleasePointRef[];
  /** Finishing ONLY this (and what it waits on) makes these releasable: the highest per repository. */
  unlocksAlone: ReleasePointRef[];
}

export interface ReleaseLadderStop {
  /** The highest tag of the run of tags with these needs: where the candidate moves once they are done. */
  tagName: string;
  committedAt: string | null;
  /** How many version tags this stop covers (the run's length). */
  tags: number;
  /** Everything the release rule needs before this point can be released (cumulative, ids). */
  needs: string[];
  /** The needs this stop ADDS to the previous stop (or to the candidate). */
  adds: string[];
  /** Work the tracker says those needs wait on, not in `needs` (ids). */
  via: string[];
  /** Points in OTHER repositories that must be releasable too (picked together). */
  withPoints: ReleasePointRef[];
  /** Some reasons on these tags are still being read: `needs` is a floor. */
  partial: boolean;
}

export interface ReleaseLadder {
  repoId: number;
  repoName: string;
  /** The releasable point now (the candidate); null = none. */
  candidate: string | null;
  /** The newest version tag on the default branch; null = none. */
  newest: string | null;
  /** Newer tags OLDEST first, folded into stops. Empty = the candidate is the newest, or nothing is known. */
  stops: ReleaseLadderStop[];
  /** The ladder ends at this tag: it is still being checked (null = the ladder is whole). */
  checkingFrom: string | null;
}

/** One step of the plan: finish these, and these points become releasable. */
export interface ReleaseMove {
  work: string[];
  /** Newly releasable after this move (and the ones before it): the highest per repository. */
  unlocks: ReleasePointRef[];
}

export interface ReleaseGraph {
  ladders: ReleaseLadder[];
  /** Every work item, in plan order (then by how much it holds back). */
  work: ReleaseWork[];
  /** The plan, in order. At most `RELEASE_PLAN_MOVES_MAX`. */
  moves: ReleaseMove[];
  /** Cross-repository edges (a stop → the point it is picked together with), for drawing. */
  links: Array<{ from: ReleasePointRef; to: ReleasePointRef }>;
}

export const RELEASE_PLAN_MOVES_MAX = 8;

const ticketId = (ident: string): string => `t:${ident}`;
const keyId = (key: string): string => `k:${key}`;
const newTagId = (repoName: string, number: number): string => `n:${repoName}#${number}`;

/** The newer tags of a repository, OLDEST first (the candidate and the older band excluded). */
function newerTagsOldestFirst(repo: ReleaseRepoCheck): ReleaseTagCheck[] {
  return repo.tags.filter((t) => !t.isCandidate && t.band !== 'older').reverse();
}

/**
 * THE FOLD. Pure; the check is never changed. Repositories still checking as a whole, or with nothing
 * new, get a ladder with no stops.
 */
export function releaseGraph(check: ReleaseCheckResult): ReleaseGraph {
  const ticketByIdent = new Map<string, ReleaseTicketCheck>(check.tickets.map((t) => [t.ident, t]));
  const ticketByKey = new Map<string, ReleaseTicketCheck>(check.tickets.map((t) => [t.key, t]));
  const work = new Map<string, ReleaseWork>();

  const blank = (id: string, kind: ReleaseWorkKind, state: ReleaseWorkState): ReleaseWork => ({
    id, kind, state, key: null, ident: null, title: null, statusName: null, assigneeName: null, url: null,
    openPrs: [], repoName: null, number: null, waitsOn: [], inCycle: false, holds: [], unlocksAlone: [],
  });
  const ticketWork = (ident: string, key: string, state: ReleaseWorkState, fallback: { title?: string | null; statusName?: string | null; prs?: ReleaseOpenPr[] }): string => {
    const id = ticketId(ident);
    const t = ticketByIdent.get(ident);
    const prev = work.get(id);
    // A ticket both not Complete and with an open PR reads as not Complete (the bigger job).
    const st: ReleaseWorkState = prev?.state === 'not_done' || state === 'not_done' ? 'not_done' : state;
    const w = prev ?? blank(id, 'ticket', st);
    w.state = st;
    w.key = t?.key ?? key;
    w.ident = ident;
    w.title = t?.title ?? fallback.title ?? w.title;
    w.statusName = t?.statusName ?? fallback.statusName ?? w.statusName;
    w.assigneeName = t?.assigneeName ?? w.assigneeName;
    w.url = t?.url ?? w.url;
    const prs = t?.openPrs.length ? t.openPrs : (fallback.prs ?? []);
    for (const p of prs) if (!w.openPrs.some((q) => q.repoId === p.repoId && q.number === p.number)) w.openPrs.push(p);
    work.set(id, w);
    return id;
  };

  // ── Per repository: each newer tag's DIRECT needs and its picked-together points ──
  interface TagNode {
    repo: ReleaseRepoCheck;
    tag: ReleaseTagCheck;
    direct: Set<string>;
    points: ReleasePointRef[];
    partial: boolean;
    checking: boolean;
  }
  const nodesByRepo = new Map<number, TagNode[]>();
  const nodeByPoint = new Map<string, TagNode>();
  const pointKey = (repoName: string, tagName: string): string => `${repoName}\u0000${tagName}`;
  for (const repo of check.repos) {
    const list: TagNode[] = [];
    for (const tag of newerTagsOldestFirst(repo)) {
      const n: TagNode = { repo, tag, direct: new Set(), points: [], partial: false, checking: tag.state === 'checking' };
      for (const b of tag.blockers) addNeed(n, b);
      // ⚠ A tag already ruled out lists no reason for a ticket NOT READ yet (more reading only adds
      // reasons), so its own unread tickets make it partial: what it needs is a floor, never "only this".
      if (tag.ticketIdents.some((id) => ticketByIdent.get(id)?.pending === true)) n.partial = true;
      list.push(n);
      nodeByPoint.set(pointKey(repo.name, tag.name), n);
    }
    nodesByRepo.set(repo.repoId, list);
  }
  function addNeed(n: TagNode, b: ReleaseBlocker): void {
    switch (b.kind) {
      case 'not_done':
        n.direct.add(ticketWork(b.ident, b.key, 'not_done', { title: b.title, statusName: b.statusName }));
        return;
      case 'open_pr':
        n.direct.add(ticketWork(b.ident, b.key, 'open_pr', { title: b.title, prs: b.prs }));
        return;
      case 'checking':
        n.partial = true;
        return;
      case 'split': {
        const other = check.repos.find((r) => r.name === b.repoName);
        if (b.tagName == null) {
          const id = newTagId(b.repoName, b.number);
          const w = work.get(id) ?? blank(id, 'new_tag', 'new_tag');
          w.repoName = b.repoName;
          w.number = b.number;
          w.key = null;
          work.set(id, w);
          n.direct.add(id);
          return;
        }
        if (other != null) n.points.push({ repoId: other.repoId, repoName: other.name, tagName: b.tagName });
        // The point's own needs join later (closure); its root is a need now, in case that point is not listed.
        if (b.root != null) {
          const r = b.root.blocker;
          n.direct.add(ticketWork(r.ident, r.key, r.kind, { title: r.title, statusName: r.kind === 'not_done' ? r.statusName : null, prs: r.kind === 'open_pr' ? r.prs : [] }));
        }
        return;
      }
    }
  }

  // ── Tracker links: ticket → ticket (not Complete), followed through the tickets the check holds ──
  const linkedFrom = (w: ReleaseWork): string[] => {
    if (w.ident == null) return [];
    const t = ticketByIdent.get(w.ident);
    const out: string[] = [];
    for (const l of t?.blockedBy ?? []) {
      const inCheck = ticketByKey.get(l.key);
      if (inCheck != null) {
        if (inCheck.done || inCheck.cancelled === true || inCheck.ident === w.ident) continue;
        out.push(ticketWork(inCheck.ident, inCheck.key, 'not_done', {}));
        const lw = work.get(ticketId(inCheck.ident))!;
        if (!heldByRule.has(lw.id)) lw.state = 'tracker_link';
      } else {
        if (l.category === 'done') continue;
        const id = keyId(l.key);
        const lw = work.get(id) ?? blank(id, 'ticket', 'tracker_link');
        lw.key = l.key;
        lw.title = l.title;
        lw.statusName = l.status;
        lw.url = l.url;
        work.set(id, lw);
        out.push(id);
      }
    }
    return [...new Set(out)];
  };
  const heldByRule = new Set<string>();
  for (const list of nodesByRepo.values()) for (const n of list) for (const id of n.direct) heldByRule.add(id);
  const pending = [...heldByRule];
  const seen = new Set<string>(pending);
  while (pending.length > 0) {
    const w = work.get(pending.pop()!)!;
    w.waitsOn = linkedFrom(w);
    for (const id of w.waitsOn) if (!seen.has(id)) { seen.add(id); pending.push(id); }
  }
  markCycles(work);

  // ── Cumulative needs per tag: the tags below it, plus the points it is picked together with ──
  const needs = new Map<TagNode, Set<string>>();
  const allNodes = [...nodesByRepo.values()].flat();
  for (const n of allNodes) needs.set(n, new Set(n.direct));
  for (let changed = true, guard = 0; changed && guard < 50; guard += 1) {
    changed = false;
    for (const list of nodesByRepo.values()) {
      let below = new Set<string>();
      for (const n of list) {
        const s = needs.get(n)!;
        const before = s.size;
        for (const id of below) s.add(id);
        for (const p of n.points) {
          const o = nodeByPoint.get(pointKey(p.repoName, p.tagName));
          if (o != null) for (const id of needs.get(o)!) s.add(id);
        }
        if (s.size !== before) changed = true;
        below = s;
      }
    }
  }
  const closure = (ids: Iterable<string>): Set<string> => {
    const out = new Set<string>();
    const stack = [...ids];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      for (const w of work.get(id)?.waitsOn ?? []) stack.push(w);
    }
    return out;
  };

  // ── Ladders: runs of tags with the same needs fold into one stop; a checking tag ends the ladder ──
  const sortIds = (ids: Iterable<string>): string[] => [...ids].sort();
  const ladders: ReleaseLadder[] = [];
  const stopCost = new Map<ReleaseLadderStop, Set<string>>();
  const links: ReleaseGraph['links'] = [];
  for (const repo of check.repos) {
    const list = nodesByRepo.get(repo.repoId) ?? [];
    const stops: ReleaseLadderStop[] = [];
    let checkingFrom: string | null = null;
    let prev = new Set<string>();
    for (const n of list) {
      if (n.checking) {
        checkingFrom = n.tag.name;
        break;
      }
      const s = needs.get(n)!;
      const last = stops[stops.length - 1];
      // A partial tag never folds into the stop below it (that stop's promise would grow silently).
      const same = last != null && !n.partial && s.size === last.needs.length && last.needs.every((id) => s.has(id));
      const points = n.points.filter((p) => !(last?.withPoints ?? []).some((q) => q.repoId === p.repoId && q.tagName === p.tagName));
      if (same) {
        last.tagName = n.tag.name;
        last.committedAt = n.tag.committedAt;
        last.tags += 1;
        last.partial ||= n.partial;
        last.withPoints.push(...points);
        continue;
      }
      const cost = closure(s);
      const stop: ReleaseLadderStop = {
        tagName: n.tag.name,
        committedAt: n.tag.committedAt,
        tags: 1,
        needs: sortIds(s),
        adds: sortIds([...s].filter((id) => !prev.has(id))),
        via: sortIds([...cost].filter((id) => !s.has(id))),
        withPoints: [...(last?.withPoints ?? []), ...points],
        partial: n.partial || (last?.partial ?? false),
      };
      stopCost.set(stop, cost);
      stops.push(stop);
      prev = s;
    }
    // Each picked-together point drawn ONCE, from the first stop that needs it.
    const drawn = new Set<string>();
    for (const st of stops)
      for (const p of st.withPoints) {
        const k = pointKey(p.repoName, p.tagName);
        if (drawn.has(k)) continue;
        drawn.add(k);
        links.push({ from: { repoId: repo.repoId, repoName: repo.name, tagName: st.tagName }, to: p });
      }
    ladders.push({
      repoId: repo.repoId,
      repoName: repo.name,
      candidate: repo.candidate?.name ?? null,
      newest: repo.latestVersion?.name ?? null,
      stops,
      checkingFrom,
    });
  }

  // ── What a set of finished work makes releasable: the highest stop per ladder ──
  const releasable = (done: Set<string>): Map<number, ReleaseLadderStop> => {
    const out = new Map<number, ReleaseLadderStop>();
    for (const l of ladders) {
      for (const st of l.stops) {
        if (st.partial) break;
        if ([...stopCost.get(st)!].every((id) => done.has(id))) out.set(l.repoId, st);
        else break;
      }
    }
    return out;
  };
  const pointOf = (l: ReleaseLadder, st: ReleaseLadderStop): ReleasePointRef => ({ repoId: l.repoId, repoName: l.repoName, tagName: st.tagName });
  const ladderById = new Map(ladders.map((l) => [l.repoId, l]));

  // ── The plan: greedy over the next stop of every ladder ──
  const moves: ReleaseMove[] = [];
  const done = new Set<string>();
  let reached = releasable(done);
  while (moves.length < RELEASE_PLAN_MOVES_MAX) {
    let chosen: { rest: string[]; gain: number } | null = null;
    for (const l of ladders) {
      const next = l.stops.find((st) => ![...stopCost.get(st)!].every((id) => done.has(id)));
      if (next == null || next.partial) continue;
      const rest = sortIds([...stopCost.get(next)!].filter((id) => !done.has(id)));
      const after = releasable(new Set([...done, ...rest]));
      let gain = 0;
      for (const [repoId, st] of after) if (reached.get(repoId) !== st) gain += 1;
      if (chosen == null || rest.length < chosen.rest.length || (rest.length === chosen.rest.length && gain > chosen.gain)) chosen = { rest, gain };
    }
    if (chosen == null) break;
    for (const id of chosen.rest) done.add(id);
    const now = releasable(done);
    const unlocks: ReleasePointRef[] = [];
    for (const [repoId, st] of now) if (reached.get(repoId) !== st) unlocks.push(pointOf(ladderById.get(repoId)!, st));
    reached = now;
    moves.push({ work: chosen.rest, unlocks });
  }

  // ── Per work item: what it holds, what finishing it alone unlocks ──
  for (const w of work.values()) {
    for (const l of ladders) {
      const first = l.stops.find((st) => stopCost.get(st)!.has(w.id));
      if (first != null) w.holds.push(pointOf(l, first));
    }
    const alone = releasable(closure([w.id]));
    for (const [repoId, st] of alone) w.unlocksAlone.push(pointOf(ladderById.get(repoId)!, st));
  }

  const firstMove = (id: string): number => {
    const i = moves.findIndex((m) => m.work.includes(id));
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const ordered = [...work.values()].sort(
    (a, b) => firstMove(a.id) - firstMove(b.id) || b.unlocksAlone.length - a.unlocksAlone.length || b.holds.length - a.holds.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return { ladders, work: ordered, moves, links };
}

/** Tarjan's strongly connected components over `waitsOn`: a component of two or more (or a self-link) is a loop. */
function markCycles(work: Map<string, ReleaseWork>): void {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const visit = (v: string): void => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    on.add(v);
    for (const u of work.get(v)?.waitsOn ?? []) {
      if (!work.has(u)) continue;
      if (!idx.has(u)) {
        visit(u);
        low.set(v, Math.min(low.get(v)!, low.get(u)!));
      } else if (on.has(u)) low.set(v, Math.min(low.get(v)!, idx.get(u)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let u: string;
      do {
        u = stack.pop()!;
        on.delete(u);
        comp.push(u);
      } while (u !== v);
      if (comp.length > 1 || (work.get(v)?.waitsOn ?? []).includes(v)) for (const c of comp) work.get(c)!.inCycle = true;
    }
  };
  for (const v of work.keys()) if (!idx.has(v)) visit(v);
}

/** "api 0.330.0" / "api #539": one release point in words. */
export function releasePointWords(p: ReleasePointRef): string {
  return `${p.repoName} ${p.tagName}`;
}
