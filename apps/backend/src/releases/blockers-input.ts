import { createHash } from 'node:crypto';
import {
  releaseGraph,
  type ReleaseBlockersPointRef,
  type ReleaseBlockersPrRef,
  type ReleaseBlockersRef,
  type ReleaseBlockersTicketRef,
  type ReleaseCheckResult,
  type ReleaseGraph,
  type ReleaseRepoCheck,
  type ReleaseWork,
} from '@pierre-review/shared';

// "EXPLAIN WHAT'S BLOCKING" — THE INPUT (docs/RELEASES.md § Explain what's blocking). PURE: the release
// GRAPH (shared `releaseGraph` over the check the server already folded) becomes a COMPACT text for ONE
// model completion, plus the ids the answer may cite. No GitHub, tracker or clock read.
//
//   • THE CODE DOES THE STRUCTURE; the model only explains it. Every piece of work and every release point
//     is DEFINED ONCE with a short id — tickets `T1…` (key, why it holds, assignee, title), pull requests
//     `P1…` ("repo #n", open / merged in no tag yet, title), release points `R1…` ("repo tag") — and every
//     later line names ids only: the LADDERS (each stop: what it ADDS, `via` tracker links, the points in
//     other repositories it is picked together with, `partial`), then the code's PLAN (moves in order:
//     work → the points it unlocks). Nothing is repeated (the old input listed each tag's cumulative needs).
//   • Ids are numbered in the graph's own order (plan order for work), so the same graph is the same text.
//   • ⚠ UNTRUSTED TEXT: titles, statuses, names, repository and tag names come from the tracker and GitHub.
//     The whole text sits inside ONE nonce fence (review/release-blockers/prompt.ts); here every value is
//     one line and capped.
//   • THE HASH (stale): sha256 over RELEASE_BLOCKERS_VERSION + the text. No `Date.now()`-derived field.

/** Bump with any change to the text or the prompt: every stored report reads stale. */
export const RELEASE_BLOCKERS_VERSION = 2;

const PRS_PER_TICKET = 4;

export interface ReleaseBlockersInput {
  /** The check is decided and some repository has newer tags it cannot release. */
  explainable: boolean;
  /** The lines that go inside the fence. */
  text: string;
  hash: string;
  /** Every id the text defines → what it names (what the answer may cite). */
  refs: Map<string, ReleaseBlockersRef>;
  /** The names of the repositories with newer tags it cannot release (a repository note must name one). */
  blockedRepoNames: Set<string>;
  /** Every ticket key the text gives (a bare key in the answer must be one of these). */
  keys: Set<string>;
  /** Every `#n` the text gives (pull requests, and release points named by one). */
  numbers: Set<number>;
  graph: ReleaseGraph;
}

const one = (s: string | null | undefined, max = 100): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const pk = (repoName: string, n: number | string): string => `${repoName}\u0000${n}`;

/** A repository with something to explain: decided, and newer tags it cannot release. */
function explainableRepo(repo: ReleaseRepoCheck): boolean {
  return !repo.checking && (repo.status === 'candidate' || repo.status === 'none') && repo.tags.some((t) => !t.isCandidate && t.state === 'does_not_qualify');
}

/** Build the input from the check. Pure. */
export function releaseBlockersInput(check: ReleaseCheckResult): ReleaseBlockersInput {
  const graph = releaseGraph(check);
  const anyChecking = check.repos.some((r) => r.checking);
  const explainable = !anyChecking && check.repos.some(explainableRepo) && graph.ladders.some((l) => l.stops.length > 0);
  const repoByName = new Map(check.repos.map((r) => [r.name, r]));

  // What the check knows about each pull request (title, link, PR tab), by repository name and number.
  const prFacts = new Map<string, { title: string | null; url: string | null; prId: number | null }>();
  const fact = (repoName: string, number: number, f: { title?: string | null; url?: string | null; prId?: number | null }): void => {
    const k = pk(repoName, number);
    const prev = prFacts.get(k) ?? { title: null, url: null, prId: null };
    const title = f.title != null && one(f.title) !== '' ? f.title : null;
    prFacts.set(k, { title: prev.title ?? title, url: prev.url ?? f.url ?? null, prId: prev.prId ?? f.prId ?? null });
  };
  const repoNameById = new Map(check.repos.map((r) => [r.repoId, r.name]));
  for (const p of check.prs) {
    const name = repoNameById.get(p.repoId);
    if (name != null) fact(name, p.number, { title: p.title, url: p.url, prId: p.prId });
  }
  for (const t of check.tickets) {
    for (const p of t.pullRequests) fact(p.repoName, p.number, { title: p.title, url: p.url, prId: p.prId });
    for (const p of t.openPrs) fact(p.repoName, p.number, { url: p.url, prId: p.prId });
  }
  for (const r of check.repos)
    for (const tag of r.tags)
      for (const b of tag.blockers) if (b.kind === 'split') fact(b.repoName, b.number, { url: b.url });

  // ── Ids, defined once ──
  const refs = new Map<string, ReleaseBlockersRef>();
  const keys = new Set<string>();
  const numbers = new Set<number>();
  const workId = new Map<string, string>();
  const prId = new Map<string, string>();
  const pointId = new Map<string, string>();
  let nT = 0;
  let nP = 0;
  let nR = 0;
  const ticketLines: string[] = [];
  const prLines: string[] = [];
  const pointLines: string[] = [];

  const prRef = (repoName: string, number: number, open: boolean, needsNewTag: boolean): string => {
    const k = pk(repoName, number);
    const have = prId.get(k);
    if (have != null) return have;
    nP += 1;
    const id = `P${nP}`;
    prId.set(k, id);
    numbers.add(number);
    const f = prFacts.get(k);
    const ref: ReleaseBlockersPrRef = {
      kind: 'pr', id, repoName, repoFullName: repoByName.get(repoName)?.fullName ?? null, number,
      title: f?.title ?? null, url: f?.url ?? null, prId: f?.prId ?? null, needsNewTag,
    };
    refs.set(id, ref);
    const state = needsNewTag ? 'merged, in no version tag yet: needs a new version tag' : open ? 'open' : 'merged';
    prLines.push(`${id} ${one(repoName, 80)} #${number} · ${state}${ref.title != null ? ` · “${one(ref.title)}”` : ''}`);
    return id;
  };
  const pointRef = (repoName: string, tagName: string): string => {
    const k = pk(repoName, tagName);
    const have = pointId.get(k);
    if (have != null) return have;
    nR += 1;
    const id = `R${nR}`;
    pointId.set(k, id);
    const ref: ReleaseBlockersPointRef = { kind: 'point', id, repoName, tagName };
    refs.set(id, ref);
    const n = /^#(\d+)$/.exec(tagName);
    if (n != null) numbers.add(Number(n[1]));
    pointLines.push(`${id} ${one(repoName, 80)} ${one(tagName, 60)}`);
    return id;
  };

  // Work first, in the graph's (plan) order: tickets get T ids, a new tag's pull request a P id.
  for (const w of graph.work) {
    if (w.kind === 'new_tag') {
      if (w.repoName != null && w.number != null) workId.set(w.id, prRef(w.repoName, w.number, false, true));
      continue;
    }
    nT += 1;
    const id = `T${nT}`;
    workId.set(w.id, id);
    const key = w.key ?? '?';
    keys.add(key);
    const ref: ReleaseBlockersTicketRef = { kind: 'ticket', id, ident: w.id.startsWith('t:') ? w.ident : null, key, title: w.title, url: w.url };
    refs.set(id, ref);
  }
  // Then each ticket's line (its PRs need their P ids, its links the T ids above).
  for (const w of graph.work) {
    if (w.kind !== 'ticket') continue;
    ticketLines.push(ticketLine(w));
  }
  function ticketLine(w: ReleaseWork): string {
    const id = workId.get(w.id)!;
    const status = one(w.statusName, 40);
    const parts = [`${id} ${one(w.key, 60)}`];
    switch (w.state) {
      case 'not_done':
        parts.push(`not done${status !== '' ? ` (${status})` : ''}`);
        break;
      case 'open_pr':
        parts.push(`Complete, but a pull request is still open`);
        break;
      default:
        parts.push(`not done, holds a release only through a tracker link${status !== '' ? ` (${status})` : ''}`);
    }
    if (w.assigneeName != null) parts.push(`assigned to ${one(w.assigneeName, 40)}`);
    const open = w.openPrs.slice(0, PRS_PER_TICKET).map((p) => prRef(p.repoName, p.number, true, false));
    if (open.length > 0) parts.push(`open PRs ${open.join(' ')}`);
    const waits = w.waitsOn.map((x) => workId.get(x)).filter((x): x is string => x != null);
    if (waits.length > 0) parts.push(`waits on ${waits.join(' ')}`);
    if (w.inCycle) parts.push('in a loop of tracker links');
    if (w.title != null) parts.push(`“${one(w.title)}”`);
    return parts.join(' · ');
  }
  const ids = (xs: string[]): string => xs.map((x) => workId.get(x) ?? '?').join(' ');

  // ── The ladders ──
  const ladderLines: string[] = [];
  const blockedRepoNames = new Set<string>();
  for (const l of graph.ladders) {
    if (l.stops.length === 0 && l.checkingFrom == null) continue;
    if (l.stops.length > 0) blockedRepoNames.add(l.repoName);
    const now = l.candidate != null ? pointRef(l.repoName, l.candidate) : 'nothing';
    const newest = l.newest != null ? pointRef(l.repoName, l.newest) : 'none';
    ladderLines.push(`${one(l.repoName, 80)} · can be released now: ${now} · newest: ${newest}`);
    // A stop's picked-together points carry upward (a newer stop needs them too): name each ONCE, on the
    // first stop that needs it, like `adds`.
    const named = new Set<string>();
    for (const st of l.stops) {
      const newPoints = st.withPoints.filter((p) => !named.has(pointRef(p.repoName, p.tagName)));
      for (const p of newPoints) named.add(pointRef(p.repoName, p.tagName));
      const parts = [`${pointRef(l.repoName, st.tagName)}${st.tags > 1 ? ` (${st.tags} tags)` : ''} adds ${st.adds.length > 0 ? ids(st.adds) : 'nothing new'}`];
      if (st.via.length > 0) parts.push(`via ${ids(st.via)}`);
      if (newPoints.length > 0) parts.push(`with ${newPoints.map((p) => pointRef(p.repoName, p.tagName)).join(' ')}`);
      if (st.partial) parts.push('partial: some tickets not read yet');
      ladderLines.push(`  ${parts.join('; ')}`);
    }
    if (l.checkingFrom != null) ladderLines.push(`  from ${pointRef(l.repoName, l.checkingFrom)} up: still being checked`);
  }

  // ── The code's plan ──
  const planLines = graph.moves.map(
    (m, i) => `${i + 1}. ${ids(m.work)} → ${m.unlocks.length > 0 ? m.unlocks.map((p) => pointRef(p.repoName, p.tagName)).join(' ') : 'nothing new yet'}`,
  );

  const lines: string[] = [];
  lines.push(`Tracker: ${one(check.trackerName, 40) || 'none'}`);
  if (ticketLines.length > 0) lines.push('', 'Tickets:', ...ticketLines);
  if (prLines.length > 0) lines.push('', 'Pull requests:', ...prLines);
  if (pointLines.length > 0) lines.push('', 'Release points:', ...pointLines);
  lines.push('', 'Ladders (per repository, newer stops oldest first):', ...ladderLines);
  lines.push('', 'Plan (in order):', ...(planLines.length > 0 ? planLines : ['none: every next stop is partial']));
  const text = lines.join('\n');
  const hash = createHash('sha256').update(`v${RELEASE_BLOCKERS_VERSION}\n${text}`).digest('hex');
  return { explainable, text, hash, refs, blockedRepoNames, keys, numbers, graph };
}
