import {
  type ReleaseBlocker,
  type ReleaseCheckPr,
  type ReleaseCheckResult,
  type ReleaseRepoCheck,
  type ReleaseTicketCheck,
  type ReleaseTicketPr,
  type ReleaseTicketReadState,
} from '@pierre-review/shared';
import { releaseDayWords, ticketStatusWords, type ReleasePrLine } from './releasesModel.js';

// THIS SPRINT → RELEASES, THE TICKET LIST (owner, 2026-11-16) — the PURE half; ReleasesView.tsx draws it.
// ONE list for the whole workspace: a card per TICKET, not per tag or repository. A ticket sits where
// its LATEST tag sits (the newest tag, in any releasable repository, that holds its merged work; tags
// of different repositories ordered by commit date), newest at the top. Pull requests with no ticket
// sit between the cards as narrow rows. The list opens on THE CANDIDATE TICKET — the newest ticket all of
// whose work is in the release candidates — with one ticket either side; "Show 3 …" grows each way. The
// tickets HOLDING the release stay visible above the list; tickets whose only work is an open pull
// request sit at the top, apart ("Not in a tag yet"). A card is simple: its mark, key, title, status, the
// latest tag per repository, and ONE line — what it waits on, or what was done. Everything else (each
// PR, each tag) is behind the arrow.
// ⚠ The check is the SHARED fold, run on the server — this only orders and words it.

/** Tickets added at a time, either way. */
export const TICKET_WINDOW_STEP = 3;
/** Tickets shown either side of the candidate ticket at first. */
export const TICKET_WINDOW_START = 1;

/** A card's mark: ✓ in the candidates · ✗ not Complete or an open PR · ⊘ (amber) Complete but held back ·
 *  ? the tracker could not give it · ◔ not read yet. */
export type TicketMark = 'ok' | 'blocked' | 'held' | 'missing' | 'checking';

export const TICKET_MARK_WORDS: Record<TicketMark, string> = {
  ok: 'In the release candidate',
  blocked: 'Not ready: not Complete, or a pull request is still open',
  held: 'Complete, but held back',
  missing: 'Not in the tracker’s data',
  checking: 'Not read yet',
};

/** The latest tag holding the ticket's merged work in one repository ("bng-metric-backend 0.420.0"), or
 *  an open pull request when that is all it has there. */
export interface TicketRepoTag {
  repoId: number;
  repoName: string;
  tagName: string | null;
  /** Only open work in this repository. */
  open: boolean;
}

export interface TicketCardModel {
  kind: 'ticket';
  ticket: ReleaseTicketCheck;
  mark: TicketMark;
  /** The candidate ticket (★). */
  isAnchor: boolean;
  latest: TicketRepoTag[];
  /** The latest tag's commit date (ISO); null = no tagged work. */
  at: string | null;
}

export interface NoTicketGroup {
  kind: 'no_ticket';
  key: string;
  prs: ReleaseCheckPr[];
}

export type TicketListItem = TicketCardModel | NoTicketGroup;

/** Who holds the release back in one repository: the ticket that stops the tag just above its
 *  candidate (with no candidate: the oldest tag read), followed to its root for a split. */
export interface ReleaseHolder {
  ident: string;
  key: string;
  title: string | null;
  /** "In Code Review", "has an open pull request in bng-metric-frontend (#482)". */
  text: string;
  /** The repositories it holds back. */
  repoNames: string[];
}

const UNVERIFIED_WORDS: Record<Exclude<ReleaseTicketReadState, 'ok'>, (tracker: string) => string> = {
  not_found: (tr) => `Not found in ${tr}`,
  no_access: (tr) => `No access in ${tr}`,
  failed: (tr) => `${tr} did not answer`,
  not_read: (tr) => `${tr} can’t be read`,
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Newest first: a later date first; no date last. */
function byAtDesc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? 1 : -1;
}

/** The latest tag per repository for a ticket, and its order date. Pure. */
export function ticketLatest(
  ticket: Pick<ReleaseTicketCheck, 'pullRequests'>,
): { latest: TicketRepoTag[]; at: string | null; mergedAt: string | null } {
  const per = new Map<number, TicketRepoTag & { at: string | null }>();
  let at: string | null = null;
  let mergedAt: string | null = null;
  for (const p of ticket.pullRequests) {
    if (!p.open && p.mergedAt != null && (mergedAt == null || p.mergedAt > mergedAt)) mergedAt = p.mergedAt;
    const cur = per.get(p.repoId);
    if (p.open || p.tagName == null) {
      if (cur == null && p.open) per.set(p.repoId, { repoId: p.repoId, repoName: p.repoName, tagName: null, open: true, at: null });
      continue;
    }
    if (p.tagAt != null && (at == null || p.tagAt > at)) at = p.tagAt;
    if (cur == null || cur.tagName == null || byAtDesc(p.tagAt, cur.at) < 0) {
      per.set(p.repoId, { repoId: p.repoId, repoName: p.repoName, tagName: p.tagName, open: false, at: p.tagAt });
    }
  }
  const latest = [...per.values()]
    .sort((a, b) => a.repoName.localeCompare(b.repoName))
    .map(({ repoId, repoName, tagName, open }) => ({ repoId, repoName, tagName, open }));
  return { latest, at, mergedAt };
}

/** Every piece of its work is in a release candidate: in a candidate's scope in each repository, no open
 *  pull request, nothing outside a tag. Pure. */
export function ticketInCandidates(t: Pick<ReleaseTicketCheck, 'repos' | 'openPrs' | 'pullRequests'>): boolean {
  if (t.repos.length === 0 || t.openPrs.length > 0) return false;
  if (t.pullRequests.some((p) => !p.open && p.tagName == null && p.untagged)) return false;
  return t.repos.every((r) => r.state === 'in_candidate' || r.state === 'before_candidate');
}

/** A card's mark. Pure. */
export function ticketMark(t: ReleaseTicketCheck): TicketMark {
  if (t.unverified != null) return 'missing';
  if (t.pending) return 'checking';
  if (t.cancelled === true) return 'ok';
  if (t.blocker?.kind === 'not_done' || t.blocker?.kind === 'open_pr') return 'blocked';
  if (ticketInCandidates(t)) return 'ok';
  return 'held';
}

/** The blocker that stops the tag just above a repository's candidate (no candidate: the oldest tag
 *  read) — its own tickets first, then a split, then an inherited one. Pure. */
function holdingBlocker(repo: Pick<ReleaseRepoCheck, 'tags'>): ReleaseBlocker | null {
  const newer = repo.tags.filter((t) => !t.isCandidate);
  const above = newer[newer.length - 1];
  if (above == null) return null;
  const ranked = [
    ...above.blockers.filter((b) => b.fromTag == null && (b.kind === 'not_done' || b.kind === 'open_pr')),
    ...above.blockers.filter((b) => b.kind === 'split'),
    ...above.blockers.filter((b) => b.fromTag != null && (b.kind === 'not_done' || b.kind === 'open_pr')),
  ];
  return ranked[0] ?? null;
}

/** The tickets holding the release back, one per root ticket, with the repositories each holds. A split
 *  is followed to its root (the ticket not Complete or with an open PR). Pure. */
export function releaseHolders(check: Pick<ReleaseCheckResult, 'repos' | 'tickets'>): ReleaseHolder[] {
  const byIdent = new Map(check.tickets.map((t) => [t.ident, t]));
  const out = new Map<string, ReleaseHolder>();
  for (const repo of check.repos) {
    if (repo.status === 'nothing_new' || repo.status === 'checking') continue;
    const b = holdingBlocker(repo);
    if (b == null) continue;
    const root = b.kind === 'split' ? (b.root?.blocker ?? null) : b.kind === 'not_done' || b.kind === 'open_pr' ? b : null;
    if (root == null) continue;
    const cur = out.get(root.ident);
    if (cur != null) {
      if (!cur.repoNames.includes(repo.name)) cur.repoNames.push(repo.name);
      continue;
    }
    const t = byIdent.get(root.ident);
    const text = root.kind === 'not_done' ? (root.statusName ?? 'not Complete') : `open PR: ${prList(root.prs)}`;
    out.set(root.ident, { ident: root.ident, key: root.key, title: t?.title ?? root.title ?? null, text, repoNames: [repo.name] });
  }
  return [...out.values()];
}

/** The whole list, newest first: ticket cards and the no-ticket rows between them; and the tickets with
 *  only open work, apart. `anchor` = the candidate ticket's index in `tickets` (null = none in the
 *  candidates: the oldest ticket is shown). Pure. */
export interface TicketList {
  items: TicketListItem[];
  /** The ticket cards in `items`, in order. */
  tickets: TicketCardModel[];
  anchor: number | null;
  /** Tickets with only open pull requests (no work in a tag). */
  notTagged: TicketCardModel[];
}

export function ticketList(check: Pick<ReleaseCheckResult, 'tickets' | 'prs'>): TicketList {
  type Row = { at: string | null; mergedAt: string | null; key: string; item: TicketCardModel | ReleaseCheckPr };
  const rows: Row[] = [];
  const notTagged: TicketCardModel[] = [];
  for (const t of check.tickets) {
    const l = ticketLatest(t);
    const card: TicketCardModel = { kind: 'ticket', ticket: t, mark: ticketMark(t), isAnchor: false, latest: l.latest, at: l.at };
    if (!t.pullRequests.some((p) => !p.open)) notTagged.push(card);
    else rows.push({ at: l.at, mergedAt: l.mergedAt, key: t.key, item: card });
  }
  for (const p of check.prs) if (p.ticketIdents.length === 0) rows.push({ at: p.tagAt, mergedAt: p.mergedAt, key: `${p.repoId}#${p.number}`, item: p });
  rows.sort((a, b) => byAtDesc(a.at, b.at) || byAtDesc(a.mergedAt, b.mergedAt) || b.key.localeCompare(a.key, undefined, { numeric: true }));

  const items: TicketListItem[] = [];
  for (const r of rows) {
    if ('kind' in r.item) {
      items.push(r.item);
      continue;
    }
    const last = items[items.length - 1];
    if (last?.kind === 'no_ticket') last.prs.push(r.item);
    else items.push({ kind: 'no_ticket', key: `nt-${r.key}`, prs: [r.item] });
  }
  const tickets = items.filter((i): i is TicketCardModel => i.kind === 'ticket');
  const a = tickets.findIndex((c) => c.mark === 'ok' && c.ticket.cancelled !== true && ticketInCandidates(c.ticket));
  if (a >= 0) tickets[a]!.isAnchor = true;
  notTagged.sort((x, y) => x.ticket.key.localeCompare(y.ticket.key, undefined, { numeric: true }));
  return { items, tickets, anchor: a >= 0 ? a : null, notTagged };
}

/** The items shown for the reader's counts: tickets [anchor − up, anchor + down] and the no-ticket rows
 *  between them. `moreUp` / `moreDown` = tickets not shown that way. Pure. */
export function ticketWindow(
  list: Pick<TicketList, 'items' | 'tickets' | 'anchor'>,
  up: number,
  down: number,
): { items: TicketListItem[]; moreUp: number; moreDown: number } {
  const n = list.tickets.length;
  if (n === 0) return { items: list.items.filter((i) => i.kind === 'no_ticket').slice(0, 1), moreUp: 0, moreDown: 0 };
  const a = list.anchor ?? n - 1;
  const lo = Math.max(0, a - up);
  const hi = Math.min(n - 1, a + down);
  const first = list.items.indexOf(list.tickets[lo]!);
  const last = list.items.indexOf(list.tickets[hi]!);
  return { items: list.items.slice(first, last + 1), moreUp: lo, moreDown: n - 1 - hi };
}

/** "Show 3 later tickets" / "Show 2 earlier tickets" (fewer left). Pure. */
export function showTicketsWords(dir: 'later' | 'earlier', left: number): string {
  const n = Math.min(TICKET_WINDOW_STEP, left);
  return `Show ${n} ${dir} ${n === 1 ? 'ticket' : 'tickets'}`;
}

/** "bng-metric-backend 0.420.0", "bng-metric-frontend: open PR". */
export function repoTagWords(r: TicketRepoTag): string {
  return r.tagName != null ? `${r.repoName} ${r.tagName}` : `${r.repoName}: open PR`;
}

/** "frontend #812", "frontend #812 and web #90". */
function prList(prs: ReadonlyArray<{ repoName: string; number: number }>): string {
  const parts = prs.map((p) => `${p.repoName} #${p.number}`);
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The card's ONE line — what it waits on, or what was done — and a holder to link to:
 *    ✓ "2 PRs, last merged 22 Oct by alex"
 *    ✗ "Open PR: bng-metric-frontend #482"            (its status sits beside the title)
 *    ⊘ "Waits on BMD-1061 “…”: In Code Review"         (Complete, held back)
 *    ? "Not found in Jira — check it by hand"
 *  Pure. */
export function ticketCardLine(
  card: Pick<TicketCardModel, 'ticket' | 'mark'>,
  ctx: { holders: ReleaseHolder[]; repoNames: Map<number, string>; trackerName: string | null },
): { tone: 'ok' | 'bad' | 'warn' | 'unknown' | 'mute'; text: string; holder: ReleaseHolder | null } {
  const t = card.ticket;
  const tracker = ctx.trackerName ?? 'the tracker';
  if (card.mark === 'missing') return { tone: 'unknown', text: `${UNVERIFIED_WORDS[t.unverified!](tracker)} — check it by hand`, holder: null };
  if (card.mark === 'checking') return { tone: 'mute', text: `Not read from ${tracker} yet`, holder: null };
  const holding = ctx.holders.find((h) => h.ident === t.ident);
  if (holding != null) {
    return { tone: 'bad', text: `Holds back ${holding.repoNames.join(' and ')}${t.openPrs.length > 0 ? ` · open PR: ${prList(t.openPrs)}` : ''}`, holder: null };
  }
  if (card.mark === 'blocked') {
    if (t.openPrs.length > 0) return { tone: 'bad', text: `Open PR: ${prList(t.openPrs)}`, holder: null };
    return { tone: 'bad', text: 'Not Complete yet', holder: null };
  }
  if (card.mark === 'held') {
    // Held by the ticket holding the repository its newest tagged work is in (a split: its own root).
    const b = t.blocker;
    const rootIdent = b?.kind === 'split' ? (b.root?.blocker.ident ?? null) : null;
    const repoIds = t.repos.filter((r) => r.state === 'after_candidate').map((r) => ctx.repoNames.get(r.repoId));
    const h =
      (rootIdent != null ? ctx.holders.find((x) => x.ident === rootIdent) : undefined) ??
      ctx.holders.find((x) => x.repoNames.some((n) => repoIds.includes(n))) ??
      ctx.holders[0] ??
      null;
    return { tone: 'warn', text: h != null ? `Waits on ${h.key}: ${h.text}` : 'Held back', holder: h };
  }
  // In the candidates: what was done.
  const merged = t.pullRequests.filter((p) => !p.open && p.mergedAt != null).sort((a, b) => byAtDesc(a.mergedAt, b.mergedAt));
  const newest = merged[0];
  if (newest == null) return { tone: 'mute', text: ticketStatusWords(t), holder: null };
  const day = releaseDayWords(newest.mergedAt);
  const by = newest.authorLogin != null ? ` by ${newest.authorLogin}` : '';
  return { tone: 'mute', text: `${plural(merged.length, 'PR')}, last merged ${day ?? ''}${by}`.replace(/ {2,}/g, ' '), holder: null };
}

/** The status beside the title: the tracker's own words ("In Code Review"), no bucket — the mark says
 *  the rest; null when not read. Pure. */
export function ticketCardStatus(t: Pick<ReleaseTicketCheck, 'statusName' | 'done' | 'readState'>): string | null {
  if (t.readState !== 'ok') return null;
  return t.statusName ?? (t.done ? 'Complete' : 'not Complete');
}

/** "3 PRs with no ticket · 2 by bots". Pure. */
export function noTicketGroupWords(prs: ReadonlyArray<Pick<ReleaseCheckPr, 'isBot'>>): string {
  const bots = prs.filter((p) => p.isBot).length;
  const head = `${plural(prs.length, 'PR')} with no ticket`;
  return bots === 0 ? head : bots === prs.length ? `${head} · ${bots === 1 ? 'by a bot' : 'all by bots'}` : `${head} · ${bots} by bots`;
}

/** The PR lines of an OPENED card: open first, then merged newest first; each "merged 14 Nov · alex ·
 *  in 0.390.0" / "not in a tag yet" / "OPEN". Pure. */
export function ticketCardPrLines(t: Pick<ReleaseTicketCheck, 'pullRequests'>): ReleasePrLine[] {
  const prs = [...t.pullRequests].sort((a, b) => Number(b.open) - Number(a.open) || byAtDesc(a.mergedAt, b.mergedAt));
  return prs.map((p) => prLineOf(p));
}

function prLineOf(p: ReleaseTicketPr): ReleasePrLine {
  const parts: string[] = [];
  if (!p.open) {
    const day = releaseDayWords(p.mergedAt);
    parts.push(day != null ? `merged ${day}` : 'merged');
    if (p.authorLogin != null) parts.push(p.authorLogin);
    if (p.tagName != null) parts.push(`in ${p.tagName}`);
    else if (p.untagged) parts.push('not in a tag yet');
  }
  return {
    key: `${p.repoId}#${p.number}`,
    label: `${p.repoName} #${p.number}`,
    title: `“${p.title}”`,
    tail: p.open ? 'OPEN' : parts.join(' · '),
    open: p.open,
    url: p.url,
    prId: p.prId,
    repoId: p.repoId,
    number: p.number,
  };
}

/** A PR with no ticket in its narrow row: "bng-metric-backend #431", its title, "merged 14 Nov · alex · in
 *  0.390.0". Pure. */
export function noTicketPrLineOf(check: Pick<ReleaseCheckResult, 'repos'>, p: ReleaseCheckPr): ReleasePrLine {
  const repoName = check.repos.find((r) => r.repoId === p.repoId)?.name ?? '';
  return prLineOf({ id: p.id, prId: p.prId, repoId: p.repoId, repoName, number: p.number, title: p.title, url: p.url, authorLogin: p.authorLogin, mergedAt: p.mergedAt, open: false, tagName: p.tagName, tagAt: p.tagAt, untagged: false });
}

/** The repository strip's line: "0.316.0 → 0.316.0-rc", or why there is none. Pure. */
export function repoStripText(repo: ReleaseRepoCheck): string {
  if (repo.status === 'candidate' && repo.candidate != null) return `${repo.candidate.name} → ${repo.candidate.releaseTagName}`;
  if (repo.status === 'nothing_new') {
    if (repo.nothingNewReason === 'no_tags') return 'No version tags on main yet';
    return repo.baseline != null ? `Nothing new since ${repo.baseline.name}` : 'Nothing new';
  }
  if (repo.status === 'checking') return 'Checking…';
  return repo.baseline != null ? `No tag since ${repo.baseline.name} can be released` : 'No tag can be released';
}
