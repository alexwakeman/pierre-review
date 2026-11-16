import {
  RELEASE_OLDER_TAGS_MAX,
  RELEASE_OLDER_TAGS_STEP,
  SPRINT_STAGE_LABEL,
  releaseBlockerShort,
  releaseBlockerText,
  releaseSplitWhere,
  releaseTitleShort,
  releaseUnverifiedText,
  releasesChecking,
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

// ── The expanded row: THREE BANDS, newest at the top ──────────────────────────────────────────

/** The band headings (11px labels). */
export const BAND_WORDS = {
  newer: 'Newer than the candidate — can’t be released',
  newerNoCandidate: 'Can’t be released',
  newerChecking: 'Checked so far',
  candidate: 'Candidate',
  older: 'Older tags — for checking',
} as const;

export interface RowBands {
  /** The heading over `newer`; null when there is no newer tag. */
  newerHeading: string | null;
  /** Every tag newer than the candidate (or every tag read, with no candidate), newest first. */
  newer: ReleaseTagCheck[];
  candidate: ReleaseTagCheck | null;
  /** Older tags for checking, newest first (as many as the server sent). */
  older: ReleaseTagCheck[];
}

/** The three bands of an expanded row. Pure. */
export function rowBands(repo: Pick<ReleaseRepoCheck, 'tags' | 'olderTags' | 'status'>): RowBands {
  const candidate = repo.tags.find((t) => t.isCandidate) ?? null;
  const newer = repo.tags.filter((t) => !t.isCandidate);
  const heading =
    newer.length === 0 ? null : candidate != null ? BAND_WORDS.newer : repo.status === 'checking' ? BAND_WORDS.newerChecking : BAND_WORDS.newerNoCandidate;
  return { newerHeading: heading, newer, candidate, older: candidate != null ? repo.olderTags : [] };
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

/** The reasons a tag does not qualify that its own ticket lines do not show. Its own tickets speak on
 *  their own lines, and each older tag is listed below it, so an older tag's reasons are not repeated:
 *  a tag held back ONLY by older tags gets ONE line naming the oldest of them ("Held back by an older
 *  tag: 0.324.0 — BMD-1061 “…” is In Code Review."). The history still read is a line; on the candidate
 *  (its scope listed) tickets from an earlier tag the tracker could not give are lines too. Pure. */
export function tagExplainer(
  t: Pick<ReleaseTagCheck, 'blockers' | 'unverified' | 'state' | 'isCandidate'>,
): Array<{ tone: MarkTone; text: string }> {
  const out: Array<{ tone: MarkTone; text: string }> = [];
  for (const b of t.blockers) if (b.kind === 'checking' && b.key == null) out.push({ tone: 'warn', text: releaseBlockerText(b) });
  const own = t.blockers.some((b) => b.fromTag == null && b.key != null && b.kind !== 'checking');
  const inherited = t.blockers.filter((b) => b.fromTag != null && b.kind !== 'checking');
  if (!own && inherited.length > 0) {
    // Blockers come own first, then the earlier tags newest first: the last one is the oldest tag's.
    const oldest = inherited[inherited.length - 1]!;
    out.push({ tone: 'bad', text: `Held back by an older tag: ${oldest.fromTag} — ${releaseBlockerShort({ ...oldest, fromTag: null })}.` });
  }
  if (t.isCandidate) for (const u of t.unverified) if (u.fromTag != null) out.push({ tone: 'unknown', text: `${releaseUnverifiedText(u)}. Check it by hand.` });
  return out;
}

/** An older tag's ONE summary line (collapsed): "all 2 tickets Complete", its first reason, or
 *  "checking…". Pure. */
export function olderTagSummary(
  check: Pick<ReleaseCheckResult, 'tickets' | 'prs' | 'trackerName'>,
  tag: Pick<ReleaseTagCheck, 'state' | 'blockers' | 'isCandidate' | 'prIds' | 'scopePrIds' | 'listsScope'>,
): { tone: MarkTone; text: string } {
  if (tag.state === 'checking') return { tone: 'warn', text: 'checking…' };
  const listed = tagTickets(check, tag).tickets.map((x) => x.ticket);
  if (tag.state === 'does_not_qualify') {
    const first = listed.find((t) => ticketRank(t) === 0);
    if (first != null) {
      const title = releaseTitleShort(first.title);
      return { tone: 'bad', text: `${first.key}${title != null ? ` “${title}”` : ''} ${ticketLine(first, check.trackerName).text}` };
    }
    const b = tag.blockers[0];
    return { tone: 'bad', text: b != null ? releaseBlockerShort(b) : 'can’t be released' };
  }
  const complete = listed.filter((t) => t.ready).length;
  const cancelled = listed.filter((t) => t.cancelled === true).length;
  const toCheck = listed.length - complete - cancelled;
  const done =
    complete === 0
      ? cancelled > 0
        ? null
        : 'no tickets'
      : complete === 1
        ? '1 ticket Complete'
        : toCheck === 0 && cancelled === 0
          ? `all ${complete} tickets Complete`
          : `${complete} tickets Complete`;
  const parts = [done, cancelled > 0 ? `${cancelled} cancelled` : null, toCheck > 0 ? `${toCheck} to check` : null].filter((x): x is string => x != null);
  return { tone: 'ok', text: parts.join(' · ') };
}

/** "… 10 tags shown" under the older band. */
export function olderShownLine(n: number): string {
  return `… ${plural(n, 'tag')} shown`;
}

/** The older band as the tab draws it, for `shown` (the reader's count: 10, then +50 a press): the tags,
 *  the last line ("0.380.0-rc — last release"), the progress while it reads, and whether "Show 50 more"
 *  is offered (HIDDEN while reading or when nothing more exists). Pure. */
export function olderBandView(
  repo: Pick<ReleaseRepoCheck, 'olderTags' | 'older'>,
  shown: number,
): {
  tags: ReleaseTagCheck[];
  lastReleaseLine: string | null;
  progress: { share: number; line: string | null } | null;
  shownLine: string | null;
  showMore: boolean;
} {
  const tags = repo.olderTags.slice(0, shown);
  const all = tags.length === repo.olderTags.length;
  const reading = repo.older.loading && repo.older.progress != null;
  const p = repo.older.progress;
  const progress = reading ? { share: p == null || p.total <= 0 ? 0 : Math.max(0, Math.min(1, p.done / p.total)), line: p?.line ?? null } : null;
  const more = repo.olderTags.length > shown || (all && repo.older.moreAvailable);
  return {
    tags,
    lastReleaseLine: all && repo.older.lastRelease != null ? `${repo.older.lastRelease.name} — last release` : null,
    progress,
    shownLine: tags.length > 0 && more ? olderShownLine(tags.length) : null,
    showMore: more && !(repo.older.loading && repo.older.needsHistory),
  };
}

/** What "Show 50 more" asks for: the reader's new count, and whether the server must be told (its band
 *  is smaller). Pure. */
export function olderShowMore(shown: number, serverWanted: number): { shown: number; ask: number | null } {
  const next = Math.min(RELEASE_OLDER_TAGS_MAX, shown + RELEASE_OLDER_TAGS_STEP);
  return { shown: next, ask: next > serverWanted ? next : null };
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
