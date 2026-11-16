import {
  SPRINT_STAGE_LABEL,
  releasesChecking,
  type ReleaseCheckResult,
  type ReleaseRepoCheck,
  type ReleasesResponse,
  type ReleaseTicketCheck,
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
// THE LIST (2026-11-16, owner): one list of TICKET cards for the whole workspace — the ordering and the
// card words live in releaseTicketsModel.ts; this file keeps the header, the repository strip's notes
// and the dialog's rules.

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

/** "Latest 0.394.0" beside a candidate that is not the latest version tag; null otherwise. */
export function repoLatestNote(repo: Pick<ReleaseRepoCheck, 'status' | 'candidate' | 'latestVersion'>): string | null {
  if (repo.status !== 'candidate' || repo.candidate == null || repo.latestVersion == null) return null;
  return repo.latestVersion.name === repo.candidate.name ? null : `Latest ${repo.latestVersion.name}`;
}

/** The scan's progress for a CHECKING row: the bar's share (0–1) and its ONE line. Null when the row
 *  is decided. Pure. */
export function repoProgress(repo: Pick<ReleaseRepoCheck, 'checking' | 'progress'>): { share: number; line: string | null } | null {
  if (!repo.checking) return null;
  const p = repo.progress;
  const share = p == null || p.total <= 0 ? 0 : Math.max(0, Math.min(1, p.done / p.total));
  return { share, line: p?.line ?? null };
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

/** The ticket's status as the tracker names it, with the workspace's bucket in brackets only when it
 *  differs ("Won't Do (Cancelled)", "In PO Review (Product review)"). */
export function ticketStatusWords(t: Pick<ReleaseTicketCheck, 'statusName' | 'stage' | 'done'>): string {
  const name = t.statusName ?? (t.done ? 'Complete' : 'not Complete');
  const bucket = t.stage != null ? SPRINT_STAGE_LABEL[t.stage] : null;
  return bucket != null && bucket.toLowerCase() !== name.toLowerCase() ? `${name} (${bucket})` : name;
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

/** "Open in Jira" (the ticket link's words). */
export function openInTrackerWords(trackerName: string | null): string {
  return `Open in ${trackerName ?? 'the tracker'}`;
}

/** Repos the reader can release now: a candidate, and push access. */
export function releasableRepos(check: Pick<ReleaseCheckResult, 'repos'>): ReleaseRepoCheck[] {
  return check.repos.filter((r) => r.candidate != null && r.writable);
}

/** "Release…" is SHOWN (never disabled) only with ≥ 1 candidate in a writable repo. */
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

