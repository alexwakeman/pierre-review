import {
  RELEASE_OLDER_TAGS_MAX,
  SPRINT_STAGE_LABEL,
  releaseBlockerShort,
  releaseBlockerText,
  releaseSplitWhere,
  releaseTitleShort,
  releaseUnverifiedText,
  releasesChecking,
  type ReleaseBlocker,
  type ReleaseCheckPr,
  type ReleaseCheckResult,
  type ReleaseRepoCheck,
  type ReleasesResponse,
  type ReleaseTagCheck,
  type ReleaseTicketCheck,
  type ReleaseTicketPr,
  type ReleaseTicketReadState,
  type ReleasePreviewResponse,
} from '@pierre-review/shared';

// THIS SPRINT → RELEASES, the PURE half (docs/RELEASES.md § Releases tab). The words and the
// dialog's rules; ReleasesView.tsx / ReleaseDialog.tsx only draw them. Pinned by
// test/releasesModel.test.ts. ⚠ The check itself is the SHARED fold (`foldReleaseCheck`, run on the
// server) — never a second fold here. Each repository is judged on its own: unticking one in the
// dialog changes nothing about another.
// ⚠ "released" is never said of a ticket or PR: only a release tag is a release. THE CUMULATIVE RULE
// (2026-11-16): releasing a tag ships everything below it, so the candidate is the tag just below the
// OLDEST tag that holds a ticket not Complete or with a pull request still open. What the tab shows is for the reader to check: tickets the tracker could not give and
// pull requests with no ticket are LISTED under their tag, never a block and never a warning.
// THE ROW (2026-11-16, owner-approved layout): one list, newest at the top, in three bands — every tag
// NEWER than the candidate (each with all its tickets and reasons), the CANDIDATE, and OLDER tags for
// checking (10, "Show 50 more"; they never change the candidate). A ticket line opens in place to its
// detail (type, assignee, last read, its PRs in this tag and elsewhere) — all from the check, DB only.

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "12 Nov" — the day and short month, in the reader's local time. Null for no date. */
export function releaseDayWords(iso: string | null | undefined): string | null {
  if (iso == null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** The header line: "Latest release: none" / "Latest release: 12 Nov". */
export function latestReleaseLine(r: Pick<ReleasesResponse, 'latestReleaseTagAt' | 'latestRelease'>): string {
  const day = releaseDayWords(r.latestReleaseTagAt ?? r.latestRelease?.createdAt ?? null);
  return `Latest release: ${day ?? 'none'}`;
}

/**
 * A repo row's line after its name:
 *   candidate  "Release 0.392.0 → 0.392.0-rc"
 *   none       "No tag can be released — 0.394.0: BMD-1048 is In PO Review"
 *              "No tag since 0.380.0-rc can be released — 0.394.0: BMD-1050 has an open pull request in web (#812)"
 *   checking   "Checking…" (the progress line and bar sit under it)
 *   nothing    "Nothing new since 0.390.0-rc" / "No version tags on main yet"
 */
export function repoRowText(repo: ReleaseRepoCheck): string {
  if (repo.status === 'candidate' && repo.candidate != null) {
    return `Release ${repo.candidate.name} → ${repo.candidate.releaseTagName}`;
  }
  if (repo.status === 'nothing_new') {
    if (repo.nothingNewReason === 'no_tags') return 'No version tags on main yet';
    return repo.baseline != null ? `Nothing new since ${repo.baseline.name}` : 'Nothing new';
  }
  if (repo.status === 'checking') return 'Checking…';
  const head = repo.baseline != null ? `No tag since ${repo.baseline.name} can be released` : 'No tag can be released';
  const r = repo.newestReason;
  return r == null ? head : `${head} — ${r.tagName}: ${releaseBlockerShort(r.blocker)}`;
}

/** "Latest 0.394.0" beside a candidate that is not the latest version tag; null otherwise. */
export function repoLatestNote(repo: Pick<ReleaseRepoCheck, 'status' | 'candidate' | 'latestVersion'>): string | null {
  if (repo.status !== 'candidate' || repo.candidate == null || repo.latestVersion == null) return null;
  return repo.latestVersion.name === repo.candidate.name ? null : `Latest ${repo.latestVersion.name}`;
}

/** The counts beside a candidate row: "6 tickets · 1 to check" (tickets the tracker could not give);
 *  null otherwise. */
export function repoRowCounts(repo: ReleaseRepoCheck): string | null {
  if (repo.status !== 'candidate') return null;
  const parts = [plural(repo.ticketIdents.length, 'ticket')];
  if (repo.unverifiedCount > 0) parts.push(`${repo.unverifiedCount} to check`);
  return parts.join(' · ');
}

/** The scan's progress for a CHECKING row: the bar's share (0–1) and its ONE line. Null when the row
 *  is decided. Pure. */
export function repoProgress(repo: Pick<ReleaseRepoCheck, 'checking' | 'progress'>): { share: number; line: string | null } | null {
  if (!repo.checking) return null;
  const p = repo.progress;
  const share = p == null || p.total <= 0 ? 0 : Math.max(0, Math.min(1, p.done / p.total));
  return { share, line: p?.line ?? null };
}

// ── The expanded row: ONE list of identical rows around the candidate ─────────────────────────
// (owner, 2026-11-16): 5 later tags, the candidate, 5 earlier tags; "Show 5 later tags" / "Show 5 earlier
// tags" at each end. No band labels and no reason text until a row is opened: a row is its MARK, its
// header and an expand arrow. The candidate row is highlighted and names the other repositories'
// candidates it is paired with.

/** Tags added at a time, either way. */
export const RELEASE_WINDOW_STEP = 5;

/** A row's mark: the candidate (★), its own tickets stop it (✗ red), held back by something else — an
 *  older tag, or a ticket that would ship half (⊘ amber), not decided yet, or it can be released (✓). */
export type TagMark = 'candidate' | 'blocked' | 'held' | 'checking' | 'ok';

/** The mark's words (its tooltip and accessible name). */
export const TAG_MARK_WORDS: Record<TagMark, string> = {
  candidate: 'Release candidate',
  blocked: 'Can’t be released: its own tickets stop it',
  held: 'Held back by another tag',
  checking: 'Still checking',
  ok: 'Can be released',
};

/** A tag's mark. ✗ only when ITS OWN tickets stop it (not Complete, an open PR); a tag stopped only by an
 *  older tag or by a ticket whose other half is above a candidate is ⊘ "held back". Pure. */
export function tagMark(tag: Pick<ReleaseTagCheck, 'isCandidate' | 'state' | 'blockers'>): TagMark {
  if (tag.isCandidate) return 'candidate';
  if (tag.state === 'qualifies') return 'ok';
  if (tag.state === 'checking') return 'checking';
  const own = tag.blockers.some((b) => b.fromTag == null && (b.kind === 'not_done' || b.kind === 'open_pr'));
  return own ? 'blocked' : 'held';
}

/** The rows shown for the reader's counts: `later` newest first, ending with the tag just above the
 *  candidate (with no candidate: the oldest tags read, where the answer is decided); `earlier` newest first.
 *  `moreLater` = later tags not shown; `moreEarlier` = earlier ones not shown (or not sent yet). Pure. */
export interface TagWindow {
  later: ReleaseTagCheck[];
  candidate: ReleaseTagCheck | null;
  earlier: ReleaseTagCheck[];
  moreLater: number;
  moreEarlier: boolean;
  /** After a release, once every earlier tag is shown: "0.380.0-rc — last release". */
  lastReleaseLine: string | null;
}

export function tagWindow(
  repo: Pick<ReleaseRepoCheck, 'tags' | 'olderTags' | 'older'>,
  laterShown: number,
  earlierShown: number,
): TagWindow {
  const candidate = repo.tags.find((t) => t.isCandidate) ?? null;
  const newer = repo.tags.filter((t) => !t.isCandidate);
  const later = newer.slice(Math.max(0, newer.length - laterShown));
  const older = candidate != null ? repo.olderTags : [];
  const earlier = older.slice(0, earlierShown);
  const allEarlier = earlier.length === older.length;
  return {
    later,
    candidate,
    earlier,
    moreLater: newer.length - later.length,
    moreEarlier: candidate != null && (older.length > earlierShown || repo.older.moreAvailable),
    lastReleaseLine: candidate != null && allEarlier && repo.older.lastRelease != null ? `${repo.older.lastRelease.name} — last release` : null,
  };
}

/** "Show 5 later tags" / "Show 3 later tags" (fewer left). Pure. */
export function showLaterWords(left: number): string {
  return `Show ${Math.min(RELEASE_WINDOW_STEP, left)} later ${Math.min(RELEASE_WINDOW_STEP, left) === 1 ? 'tag' : 'tags'}`;
}

/** "Show 5 earlier tags". */
export const SHOW_EARLIER_WORDS = `Show ${RELEASE_WINDOW_STEP} earlier tags`;

/** What "Show 5 earlier tags" asks for: the reader's new count, and whether the server must send more (its
 *  older band is smaller). Pure. */
export function showEarlier(shown: number, serverWanted: number): { shown: number; ask: number | null } {
  const next = Math.min(RELEASE_OLDER_TAGS_MAX, shown + RELEASE_WINDOW_STEP);
  return { shown: next, ask: next > serverWanted ? next : null };
}

/** The later count that shows `tagName` (a link to it), at least `current`. Pure. */
export function laterShownFor(repo: Pick<ReleaseRepoCheck, 'tags'>, tagName: string, current: number): number {
  const newer = repo.tags.filter((t) => !t.isCandidate);
  const i = newer.findIndex((t) => t.name === tagName);
  return i < 0 ? current : Math.max(current, newer.length - i);
}

/** A link to one tag of one repository (the row opens there). */
export interface TagLink {
  repoId: number;
  tagName: string;
}

/** The other repositories' candidates the candidate is released with: "paired with bng-metric-frontend
 *  0.328.0". Pure. */
export function candidatePairs(check: Pick<ReleaseCheckResult, 'repos'>, repo: Pick<ReleaseRepoCheck, 'repoId'>): Array<TagLink & { repoName: string }> {
  return check.repos
    .filter((r) => r.repoId !== repo.repoId && r.candidate != null)
    .map((r) => ({ repoId: r.repoId, repoName: r.name, tagName: r.candidate!.name }));
}

/** The repository a blocker points into, for a link: a split names the repository of the work left out;
 *  an inherited reason the older tag in this repository. */
function blockerLink(check: Pick<ReleaseCheckResult, 'repos'>, repoId: number, b: ReleaseBlocker): TagLink | null {
  if (b.kind === 'split') {
    const other = check.repos.find((r) => r.name === b.repoName);
    return other != null && b.tagName != null ? { repoId: other.repoId, tagName: b.tagName } : null;
  }
  return b.fromTag != null ? { repoId, tagName: b.fromTag } : null;
}

/** WHY this is the candidate (the opened candidate row): what stops the tag just above it, with a link to
 *  the tag (this repository or another) that holds it back. "The latest tag." when none is above. Pure. */
export function candidateWhy(
  check: Pick<ReleaseCheckResult, 'repos'>,
  repo: Pick<ReleaseRepoCheck, 'repoId' | 'tags'>,
): { text: string; link: TagLink | null } {
  const newer = repo.tags.filter((t) => !t.isCandidate);
  const above = newer[newer.length - 1];
  if (above == null) return { text: 'It is the latest tag.', link: null };
  const ranked = [
    ...above.blockers.filter((b) => b.fromTag == null && (b.kind === 'not_done' || b.kind === 'open_pr')),
    ...above.blockers.filter((b) => b.kind === 'split'),
    ...above.blockers.filter((b) => b.fromTag != null),
  ];
  const b = ranked[0] ?? above.blockers[0];
  if (b == null) return { text: `${above.name}, the tag above it, can’t be released.`, link: null };
  return { text: `${above.name}, the tag above it, can’t be released: ${releaseBlockerShort(b)}.`, link: blockerLink(check, repo.repoId, b) };
}

/** The candidate's label after its header: "checked: everything since 0.380.0-rc" / "checked:
 *  everything up to this tag". */
export function candidateScopeLabel(repo: Pick<ReleaseRepoCheck, 'baseline'>): string {
  return repo.baseline != null ? `checked: everything since ${repo.baseline.name}` : 'checked: everything up to this tag';
}

/** The PRs listed under a tag: its whole scope when the fold says so (the candidate after a release),
 *  else its own increment. */
export function tagListedPrIds(tag: Pick<ReleaseTagCheck, 'isCandidate' | 'prIds' | 'scopePrIds' | 'listsScope'>): number[] {
  return (tag.listsScope ?? tag.isCandidate) ? tag.scopePrIds : tag.prIds;
}

/** A tag's header: "0.394.0 · 15 Nov · a1b2c3d · 4 PRs · 3 tickets" — the parts, so the sha can be a
 *  link (`url` through `safeExternalUrl`). Pure. */
export function tagHeader(
  check: Pick<ReleaseCheckResult, 'tickets' | 'prs'>,
  tag: Pick<ReleaseTagCheck, 'name' | 'sha' | 'url' | 'committedAt' | 'isCandidate' | 'prIds' | 'scopePrIds'>,
): { name: string; day: string | null; shortSha: string; url: string; counts: string; text: string } {
  const day = releaseDayWords(tag.committedAt);
  const shortSha = tag.sha.slice(0, 7);
  const tickets = tagTickets(check, tag).tickets.length;
  const counts = `${plural(tagListedPrIds(tag).length, 'PR')} · ${plural(tickets, 'ticket')}`;
  const text = [tag.name, day, shortSha, counts].filter((x): x is string => x != null).join(' · ');
  return { name: tag.name, day, shortSha, url: tag.url, counts, text };
}

/** The lines an OPENED row shows above its tickets: the history still read; a tag held back ONLY by older
 *  tags gets ONE line naming the oldest ("Held back by 0.324.0: BMD-1061 “…” is In Code Review.") with a
 *  link; each ticket whose other half is above a candidate a line naming that tag, with a link ("Held back
 *  by bng-metric-frontend 0.357.0: BMD-1083 “…” would ship without bng-metric-frontend #458 (in
 *  0.357.0)."); on the candidate (its scope listed) tickets from an earlier tag the tracker could not
 *  give. Its own not-Complete tickets speak on their own lines. Pure. */
export function tagExplainer(
  t: Pick<ReleaseTagCheck, 'blockers' | 'unverified' | 'state' | 'isCandidate'>,
  ctx?: { check: Pick<ReleaseCheckResult, 'repos'>; repoId: number },
): Array<{ tone: MarkTone; text: string; link?: TagLink | null }> {
  const out: Array<{ tone: MarkTone; text: string; link?: TagLink | null }> = [];
  for (const b of t.blockers) if (b.kind === 'checking' && b.key == null) out.push({ tone: 'warn', text: releaseBlockerText(b) });
  const own = t.blockers.some((b) => b.fromTag == null && b.key != null && b.kind !== 'checking');
  const inherited = t.blockers.filter((b) => b.fromTag != null && b.kind !== 'checking');
  if (!own && inherited.length > 0) {
    // Blockers come own first, then the earlier tags newest first: the last one is the oldest tag's.
    const oldest = inherited[inherited.length - 1]!;
    out.push({
      tone: 'warn',
      text: `Held back by ${oldest.fromTag}: ${releaseBlockerShort({ ...oldest, fromTag: null })}.`,
      ...(ctx != null ? { link: blockerLink(ctx.check, ctx.repoId, oldest) } : {}),
    });
  }
  for (const b of t.blockers) {
    if (b.kind !== 'split' || b.fromTag != null) continue;
    out.push({
      tone: 'warn',
      text: `Held back by ${b.repoName}${b.tagName != null ? ` ${b.tagName}` : ''}: ${releaseBlockerShort(b)}.`,
      ...(ctx != null ? { link: blockerLink(ctx.check, ctx.repoId, b) } : {}),
    });
  }
  if (t.isCandidate) for (const u of t.unverified) if (u.fromTag != null) out.push({ tone: 'unknown', text: `${releaseUnverifiedText(u)}. Check it by hand.` });
  return out;
}

/** The older band's progress while it reads (bar share and line); null when it is not reading. Pure. */
export function olderProgress(repo: Pick<ReleaseRepoCheck, 'older'>): { share: number; line: string | null } | null {
  if (!(repo.older.loading && repo.older.progress != null)) return null;
  const p = repo.older.progress;
  return { share: p.total <= 0 ? 0 : Math.max(0, Math.min(1, p.done / p.total)), line: p.line };
}

/** The line beside the bar while Refresh runs: "Reading tickets from Jira again". Pure. */
export function refreshingLine(check: Pick<ReleaseCheckResult, 'trackerName'> | null | undefined): string {
  return `Reading tickets from ${check?.trackerName ?? 'the tracker'} again`;
}

/** How often the tab re-reads GET /api/releases while a repo is being checked (or its older band read). */
export const RELEASES_POLL_MS = 3_000;

/** The tab's poll interval for this answer: RELEASES_POLL_MS while any repo is checking, else off. Pure. */
export function releasesPollInterval(data: Pick<ReleasesResponse, 'check'> | null | undefined): number | false {
  return releasesChecking(data) ? RELEASES_POLL_MS : false;
}

export type MarkTone = 'ok' | 'bad' | 'warn' | 'unknown';

/** A ticket's place in a tag's list: 0 stops the tag (not Complete, an open PR), 1 to check (not found,
 *  could not be read, not read yet), 2 Complete or Cancelled (neither stops it). */
export function ticketRank(t: Pick<ReleaseTicketCheck, 'ready' | 'blocker' | 'cancelled'>): 0 | 1 | 2 {
  if (t.blocker != null && t.blocker.kind !== 'checking') return 0;
  return t.ready || t.cancelled === true ? 2 : 1;
}

/** The ticket's status as the tracker names it, with the workspace's bucket in brackets only when it
 *  differs ("Won't Do (Cancelled)", "In PO Review (Product review)"). */
export function ticketStatusWords(t: Pick<ReleaseTicketCheck, 'statusName' | 'stage' | 'done'>): string {
  const name = t.statusName ?? (t.done ? 'Complete' : 'not Complete');
  const bucket = t.stage != null ? SPRINT_STAGE_LABEL[t.stage] : null;
  return bucket != null && bucket.toLowerCase() !== name.toLowerCase() ? `${name} (${bucket})` : name;
}

const UNVERIFIED_WORDS: Record<Exclude<ReleaseTicketReadState, 'ok'>, (tracker: string) => string> = {
  not_found: (tr) => `not found in ${tr}`,
  no_access: (tr) => `no access in ${tr}`,
  failed: (tr) => `${tr} did not answer`,
  not_read: (tr) => `${tr} can’t be read`,
};

/** "frontend #812", "frontend #812 and web #90". */
function openPrList(prs: ReadonlyArray<{ repoName: string; number: number }>): string {
  const parts = prs.map((p) => `${p.repoName} #${p.number}`);
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** A ticket line's mark and words after its key and title:
 *    ✗ "In PO Review" · "Complete, but has an open PR: frontend #812"
 *    ? "not found in Jira — check by hand" · "not read yet"
 *    ✓ "Complete" */
export function ticketLine(
  t: Pick<ReleaseTicketCheck, 'statusName' | 'stage' | 'done' | 'readState' | 'blocker' | 'unverified' | 'pending' | 'openPrs' | 'cancelled'>,
  trackerName: string | null,
): { tone: MarkTone; text: string } {
  const tracker = trackerName ?? 'the tracker';
  // Cancelled never stops a tag: a tick, and the status says why.
  if (t.cancelled === true) return { tone: 'ok', text: `${ticketStatusWords(t)} — doesn’t stop a release` };
  if (t.blocker?.kind === 'not_done') return { tone: 'bad', text: ticketStatusWords(t) };
  if (t.blocker?.kind === 'open_pr') {
    const n = t.openPrs.length;
    return { tone: 'bad', text: `${ticketStatusWords(t)}, but has ${n === 1 ? 'an open PR' : 'open PRs'}: ${openPrList(t.openPrs)}` };
  }
  // Picked together: its other half sits above a candidate.
  if (t.blocker?.kind === 'split') return { tone: 'bad', text: `${ticketStatusWords(t)}, but would ship without ${releaseSplitWhere(t.blocker)}` };
  if (t.unverified != null) return { tone: 'unknown', text: `${UNVERIFIED_WORDS[t.unverified](tracker)} — check by hand` };
  if (t.pending) return { tone: 'warn', text: 'not read yet' };
  return { tone: 'ok', text: ticketStatusWords(t) };
}

/** One tag's tickets (with their PRs in it) in the order the row lists them — those that stop the tag,
 *  then those to check, then Complete; ties by key — and its PRs with no ticket. The candidate lists its
 *  whole scope; any other tag its own increment. Pure. */
export function tagTickets(
  check: Pick<ReleaseCheckResult, 'tickets' | 'prs'>,
  tag: Pick<ReleaseTagCheck, 'prIds' | 'scopePrIds' | 'isCandidate'>,
): { tickets: Array<{ ticket: ReleaseTicketCheck; prs: ReleaseCheckPr[] }>; noTicket: ReleaseCheckPr[] } {
  const prById = new Map(check.prs.map((p) => [p.id, p]));
  const prs = tagListedPrIds(tag)
    .map((id) => prById.get(id))
    .filter((p): p is ReleaseCheckPr => p != null);
  const idents: string[] = [];
  for (const p of prs) for (const i of p.ticketIdents) if (!idents.includes(i)) idents.push(i);
  const ticketByIdent = new Map(check.tickets.map((t) => [t.ident, t]));
  const tickets = idents
    .map((ident) => ticketByIdent.get(ident))
    .filter((t): t is ReleaseTicketCheck => t != null)
    .sort((a, b) => ticketRank(a) - ticketRank(b) || a.key.localeCompare(b.key))
    .map((ticket) => ({ ticket, prs: prs.filter((p) => p.ticketIdents.includes(ticket.ident)) }));
  return { tickets, noTicket: prs.filter((p) => p.ticketIdents.length === 0) };
}

/** "· 3 pull requests with no ticket" (the dot is drawn); null for none. */
export function noTicketLine(n: number): string | null {
  return n <= 0 ? null : n === 1 ? '1 pull request with no ticket' : `${n} pull requests with no ticket`;
}

/** "4 min ago", "3 hours ago", "2 days ago", else the day ("12 Nov"). Pure (`now` given). */
export function readAgoWords(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${plural(days, 'day')} ago`;
  return releaseDayWords(iso) ?? 'a while ago';
}

/** One PR line of the ticket detail or the no-ticket list: "backend #431", its title in quotes, and
 *  "merged 14 Nov · alex" (+ "in 0.390.0" / "not in a tag yet" elsewhere) or "OPEN". */
export interface ReleasePrLine {
  key: string;
  label: string;
  title: string;
  tail: string;
  open: boolean;
  url: string;
  prId: number | null;
  repoId: number;
  number: number;
}

function prTail(p: { open: boolean; mergedAt: string | null; authorLogin: string | null; tagName: string | null; untagged: boolean }, where: boolean): string {
  if (p.open) return 'OPEN';
  const parts: string[] = [];
  const day = releaseDayWords(p.mergedAt);
  parts.push(day != null ? `merged ${day}` : 'merged');
  if (!where && p.authorLogin != null) parts.push(p.authorLogin);
  if (where) {
    if (p.tagName != null) parts.push(`in ${p.tagName}`);
    else if (p.untagged) parts.push('not in a tag yet');
  }
  return parts.join(' · ');
}

const lineOf = (p: ReleaseTicketPr, where: boolean): ReleasePrLine => ({
  key: `${p.repoId}#${p.number}`,
  label: `${p.repoName} #${p.number}`,
  title: `“${p.title}”`,
  tail: prTail(p, where),
  open: p.open,
  url: p.url,
  prId: p.prId,
  repoId: p.repoId,
  number: p.number,
});

/** A PR with no ticket, listed under its tag: "api #431", its title, "merged 14 Nov · alex". */
export function noTicketPrLine(check: Pick<ReleaseCheckResult, 'repos'>, p: ReleaseCheckPr): ReleasePrLine {
  const repoName = check.repos.find((r) => r.repoId === p.repoId)?.name ?? '';
  return lineOf(
    { id: p.id, prId: p.prId, repoId: p.repoId, repoName, number: p.number, title: p.title, url: p.url, authorLogin: p.authorLogin, mergedAt: p.mergedAt, open: false, tagName: p.tagName, untagged: false },
    false,
  );
}

/**
 * A ticket line opened in place (DB only — the check already carries it):
 *   facts      "Type: Story", "Assignee: Robin Lee", "Jira status read 4 min ago"
 *   inThisTag  the tag's PRs naming the ticket: "backend #431 “BMD-1050: export endpoint” merged 14 Nov · alex"
 *   elsewhere  every OTHER PR for it in the releasable repos: OPEN, or merged "in 0.390.0" / "not in a tag yet"
 * Pure.
 */
export function ticketDetail(
  check: Pick<ReleaseCheckResult, 'trackerName'>,
  tag: Pick<ReleaseTagCheck, 'prIds' | 'scopePrIds' | 'isCandidate'>,
  ticket: Pick<ReleaseTicketCheck, 'typeName' | 'assigneeName' | 'readAt' | 'pullRequests'>,
  now: number,
): { facts: string[]; inThisTag: ReleasePrLine[]; elsewhere: ReleasePrLine[] } {
  const tracker = check.trackerName ?? 'Tracker';
  const facts: string[] = [];
  if (ticket.typeName != null) facts.push(`Type: ${ticket.typeName}`);
  if (ticket.assigneeName != null) facts.push(`Assignee: ${ticket.assigneeName}`);
  facts.push(ticket.readAt != null ? `${tracker} status read ${readAgoWords(ticket.readAt, now)}` : `${tracker} status not read yet`);
  const listed = new Set(tagListedPrIds(tag));
  const inTag = (p: ReleaseTicketPr): boolean => p.id != null && listed.has(p.id);
  // Open first, then merged; each by repo and number (the server's order).
  const others = ticket.pullRequests.filter((p) => !inTag(p)).sort((a, b) => Number(b.open) - Number(a.open));
  return {
    facts,
    inThisTag: ticket.pullRequests.filter(inTag).map((p) => lineOf(p, false)),
    elsewhere: others.map((p) => lineOf(p, true)),
  };
}

/** "Open in Jira" (the ticket link's words). */
export function openInTrackerWords(trackerName: string | null): string {
  return `Open in ${trackerName ?? 'the tracker'}`;
}

/** Repos the reader can release now: a candidate, and push access. */
export function releasableRepos(check: Pick<ReleaseCheckResult, 'repos'>): ReleaseRepoCheck[] {
  return check.repos.filter((r) => r.candidate != null && r.writable);
}

/** "Create release…" is SHOWN (never disabled) only with ≥ 1 candidate in a writable repo. */
export function showCreateRelease(check: Pick<ReleaseCheckResult, 'repos'> | null | undefined): boolean {
  return check != null && releasableRepos(check).length > 0;
}

/** The dialog's first ticks: every releasable repo whose release tag does not exist yet. */
export function defaultTickedRepoIds(check: Pick<ReleaseCheckResult, 'repos'>): number[] {
  return releasableRepos(check)
    .filter((r) => r.candidate?.releaseTagExists !== true)
    .map((r) => r.repoId);
}

/** What stops Confirm for these ticks. Each repository is judged on its own, so only an empty
 *  selection stops it. Empty = Confirm may be pressed. */
export function confirmStops(ticked: readonly number[]): string[] {
  return ticked.length === 0 ? ['Tick at least one repository.'] : [];
}

/**
 * The notes sections Confirm sends: only ticked repos, and only the ones the reader EDITED (a repo
 * left out gets the code-built section on the server). Pure.
 */
export function editedSections(
  preview: Pick<ReleasePreviewResponse, 'sections'>,
  ticked: readonly number[],
  edits: ReadonlyMap<number, string>,
): Array<{ repoId: number; markdown: string }> {
  const inc = new Set(ticked);
  const out: Array<{ repoId: number; markdown: string }> = [];
  for (const s of preview.sections) {
    if (!inc.has(s.repoId)) continue;
    const e = edits.get(s.repoId);
    if (e != null && e !== s.markdown) out.push({ repoId: s.repoId, markdown: e });
  }
  return out;
}

/** The comment preview's middle line for these ticks: "api v2.4.0-rc · web v1.8.2-rc". */
export function releaseTagsLine(check: Pick<ReleaseCheckResult, 'repos'>, ticked: readonly number[]): string {
  const inc = new Set(ticked);
  return check.repos
    .filter((r) => inc.has(r.repoId) && r.candidate != null)
    .map((r) => `${r.name} ${r.candidate!.releaseTagName}`)
    .join(' · ');
}
