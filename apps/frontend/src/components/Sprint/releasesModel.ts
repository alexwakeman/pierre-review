import {
  releaseBlockerShort,
  releaseBlockerText,
  releaseUnverifiedText,
  releasesChecking,
  type ReleaseCheckPr,
  type ReleaseCheckResult,
  type ReleaseRepoCheck,
  type ReleasesResponse,
  type ReleaseTagCheck,
  type ReleaseTicketCheck,
  type ReleasePreviewResponse,
} from '@pierre-review/shared';

// THIS SPRINT → RELEASES, the PURE half (docs/RELEASES.md § Releases tab). The words and the
// dialog's rules; ReleasesView.tsx / ReleaseDialog.tsx only draw them. Pinned by
// test/releasesModel.test.ts. ⚠ The check itself is the SHARED fold (`foldReleaseCheck`, run on the
// server) — never a second fold here. Each repository is judged on its own: unticking one in the
// dialog changes nothing about another.
// ⚠ "released" is never said of a ticket or PR: only a release tag is a release. THE RULE is simple
// (2026-11-16): the candidate is the NEWEST version tag whose tickets are Complete with no pull request
// still open. What the tab shows is for the reader to check: tickets the tracker could not give and
// pull requests with no ticket are LISTED under their tag, never a block and never a warning.

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

/** The tags an expanded row lists: every tag read, newest first — those newer than the candidate, then
 *  the candidate (or the tag still being checked). Older tags are not read. */
export function expandedTags(repo: Pick<ReleaseRepoCheck, 'tags'>): ReleaseTagCheck[] {
  return repo.tags;
}

/** What the expanded row says about one tag, in lines: why it does not qualify (or what it waits for),
 *  then the tickets the tracker could not give, for the reader to check. */
export function tagExplainer(t: Pick<ReleaseTagCheck, 'blockers' | 'unverified' | 'state'>): Array<{ tone: MarkTone; text: string }> {
  const out: Array<{ tone: MarkTone; text: string }> = t.blockers.map((b) => ({ tone: b.kind === 'checking' ? 'warn' : 'bad', text: releaseBlockerText(b) }));
  for (const u of t.unverified) out.push({ tone: 'warn', text: `${releaseUnverifiedText(u)}. Check it by hand.` });
  return out;
}

/** How often the tab re-reads GET /api/releases while a repo is being checked. */
export const RELEASES_POLL_MS = 3_000;

/** The tab's poll interval for this answer: RELEASES_POLL_MS while any repo is checking, else off. Pure. */
export function releasesPollInterval(data: Pick<ReleasesResponse, 'check'> | null | undefined): number | false {
  return releasesChecking(data) ? RELEASES_POLL_MS : false;
}

export type MarkTone = 'ok' | 'bad' | 'warn';

/** A ticket's mark in a tag: Complete (or with an open pull request), not Complete (its status), not
 *  read yet, or not given by the tracker. */
export function ticketMark(t: Pick<ReleaseTicketCheck, 'done' | 'readState' | 'statusName' | 'openPrs'>): { tone: MarkTone; text: string } {
  if (t.readState === 'not_read') return { tone: 'warn', text: 'not read yet' };
  if (t.readState === 'not_found') return { tone: 'warn', text: 'not found' };
  if (t.readState !== 'ok') return { tone: 'warn', text: 'could not be read' };
  if (!t.done) return { tone: 'bad', text: t.statusName ?? 'not Complete' };
  if (t.openPrs.length > 0) return { tone: 'bad', text: `${t.statusName ?? 'Complete'}, ${plural(t.openPrs.length, 'open pull request')}` };
  return { tone: 'ok', text: t.statusName ?? 'Complete' };
}

/** One tag's contents for the expanded row: its tickets (with their PRs) — for the candidate, every
 *  ticket in its scope — then the PRs with no ticket, human or bot ("Also includes 3 pull requests with
 *  no ticket"). */
export function tagContents(
  check: Pick<ReleaseCheckResult, 'tickets' | 'prs'>,
  tag: Pick<ReleaseTagCheck, 'prIds' | 'scopePrIds' | 'isCandidate'>,
): { tickets: Array<{ ticket: ReleaseTicketCheck; prs: ReleaseCheckPr[] }>; noTicket: ReleaseCheckPr[] } {
  const prById = new Map(check.prs.map((p) => [p.id, p]));
  const ids = tag.isCandidate ? tag.scopePrIds : tag.prIds;
  const prs = ids.map((id) => prById.get(id)).filter((p): p is ReleaseCheckPr => p != null);
  const idents: string[] = [];
  for (const p of prs) for (const i of p.ticketIdents) if (!idents.includes(i)) idents.push(i);
  const ticketByIdent = new Map(check.tickets.map((t) => [t.ident, t]));
  const tickets = idents
    .map((ident) => ticketByIdent.get(ident))
    .filter((t): t is ReleaseTicketCheck => t != null)
    .sort((a, b) => Number(a.ready) - Number(b.ready) || a.key.localeCompare(b.key))
    .map((ticket) => ({ ticket, prs: prs.filter((p) => p.ticketIdents.includes(ticket.ident)) }));
  return { tickets, noTicket: prs.filter((p) => p.ticketIdents.length === 0) };
}

/** "Also includes 3 pull requests with no ticket"; null for none. */
export function noTicketLine(n: number): string | null {
  return n <= 0 ? null : `Also includes ${n === 1 ? 'a pull request' : `${n} pull requests`} with no ticket`;
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
