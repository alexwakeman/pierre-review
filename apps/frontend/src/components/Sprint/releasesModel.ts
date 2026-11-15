import {
  releaseBlockerShort,
  releaseBlockerText,
  releaseProgressPercent,
  releasesChecking,
  type ReleaseBlocker,
  type ReleaseCheckPr,
  type ReleaseCheckResult,
  type ReleaseRepoCheck,
  type ReleasesResponse,
  type ReleaseTagCheck,
  type ReleaseTicketCheck,
  type ReleaseWarning,
  type ReleaseWordsContext,
  type ReleasePreviewResponse,
} from '@pierre-review/shared';

// THIS SPRINT → RELEASES, the PURE half (docs/RELEASES.md § Releases tab). The words and the
// dialog's rules; ReleasesView.tsx / ReleaseDialog.tsx only draw them. Pinned by
// test/releasesModel.test.ts. ⚠ The check itself is the SHARED fold (`foldReleaseCheck`, run on the
// server) — never a second fold here. Each repository is judged on its own: unticking one in the
// dialog changes nothing about another.
// ⚠ "released" is never said of a ticket or PR: only a release tag is a release. The check is
// AUTOMATIC: it walks every version tag on main after the last release (or from the oldest), and a row
// still being read says "Checking…" with ONE line of what the scan is doing.

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

/** Names and numbers for the shared sentences. */
export function releaseWordsContext(check: Pick<ReleaseCheckResult, 'repos' | 'prs'>): ReleaseWordsContext {
  const repoById = new Map(check.repos.map((r) => [r.repoId, r.name]));
  const prById = new Map(check.prs.map((p) => [p.id, p.number]));
  return {
    repoName: (id) => repoById.get(id) ?? 'another repository',
    prNumber: (id) => prById.get(id) ?? null,
  };
}

/** A blocker in a few words, after "contains": "PLAT-301 (In review)". The shared words. */
export function shortBlocker(b: ReleaseBlocker): string {
  return releaseBlockerShort(b);
}

/** The first blocker that holds a repo back: the first held tag's own. */
export function repoFirstBlocker(repo: Pick<ReleaseRepoCheck, 'firstBlocker'>): ReleaseBlocker | null {
  return repo.firstBlocker;
}

/**
 * A repo row's line after its name:
 *   candidate  "Release 0.388.0 → 0.388.0-rc"
 *   blocked    "No tag can be released: the oldest tag, 0.12.0, already contains BMD-127 (In Progress)"
 *              "No tag can be released since 0.380.0-rc: the next tag, 0.381.0, contains BMD-127 (In Progress)"
 *   checking   "Candidate at most 0.388.0 — checking older history (40%)" (NEWEST FIRST: the tag just
 *              before the oldest held tag found so far, or the latest), "Checking — 0.390.0 and later
 *              cannot be released" (the tag before it is not read yet), or "Checking…" (the progress
 *              line and bar sit under it)
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
  if (repo.status === 'checking') {
    if (repo.upperLimit != null) {
      const p = repo.progress;
      const doing = p == null ? 'checking' : p.step === 'history' ? 'checking older history' : 'reading tickets';
      const pct = p != null && p.total > 0 ? ` (${releaseProgressPercent(p)}%)` : '';
      return `Candidate at most ${repo.upperLimit.name} — ${doing}${pct}`;
    }
    if (repo.heldFrom != null) return `Checking — ${repo.heldFrom} and later cannot be released`;
    return 'Checking…';
  }
  const at = repo.firstBlocked ?? repo.firstVersion?.name ?? null;
  const b = repo.firstBlocker;
  if (at == null) return 'No tag can be released';
  const what = b == null ? 'is held back' : b.kind === 'too_large' ? 'has more commits than can be read' : null;
  if (repo.baseline == null) {
    return `No tag can be released: the oldest tag, ${at}, ${what ?? `already contains ${releaseBlockerShort(b!)}`}`;
  }
  return `No tag can be released since ${repo.baseline.name}: the next tag, ${at}, ${what ?? `contains ${releaseBlockerShort(b!)}`}`;
}

/** "Latest 0.394.0" beside a candidate that is not the latest version tag; null otherwise. */
export function repoLatestNote(repo: Pick<ReleaseRepoCheck, 'status' | 'candidate' | 'latestVersion'>): string | null {
  if (repo.status !== 'candidate' || repo.candidate == null || repo.latestVersion == null) return null;
  return repo.latestVersion.name === repo.candidate.name ? null : `Latest ${repo.latestVersion.name}`;
}

/** The counts beside a candidate row: "6 tickets · 1 warning"; null otherwise. */
export function repoRowCounts(repo: ReleaseRepoCheck): string | null {
  if (repo.status !== 'candidate') return null;
  const parts = [plural(repo.ticketIdents.length, 'ticket')];
  if (repo.warningCount > 0) parts.push(plural(repo.warningCount, 'warning'));
  return parts.join(' · ');
}

/** The scan's progress for a row: the bar's share (0–1) and its ONE line. `small` = a candidate (or a
 *  held row) already stands and later tags are still being read ("Still reading later tags"). Null when
 *  nothing is left. Pure. */
export function repoProgress(
  repo: Pick<ReleaseRepoCheck, 'status' | 'checking' | 'progress'>,
): { share: number; line: string | null; small: boolean } | null {
  if (!repo.checking) return null;
  const p = repo.progress;
  const share = p == null || p.total <= 0 ? 0 : Math.max(0, Math.min(1, p.done / p.total));
  if (repo.status === 'checking') return { share, line: p?.line ?? null, small: false };
  return { share, line: 'Still reading later tags', small: true };
}

/** The tags an expanded row lists: every tag after the candidate (newest first), then the candidate
 *  itself; with no candidate, every tag after the baseline. */
export function expandedTags(repo: Pick<ReleaseRepoCheck, 'tags'>): ReleaseTagCheck[] {
  return repo.tags.filter((t) => t.blocked || t.isCandidate);
}

const ALSO_MAX = 3;

/** What the expanded row says about one tag, in lines: its own blockers (sentences), what it carries
 *  from earlier held tags ("Also contains BMD-127 (from 0.312.0)."), or that it is still being read. */
export function tagExplainer(t: Pick<ReleaseTagCheck, 'blockers' | 'alsoHeldBy' | 'state' | 'blocked' | 'isCandidate'>): string[] {
  const out = t.blockers.map((b) => releaseBlockerText(b));
  const also = t.alsoHeldBy.map((h) => `${alsoWhat(h.blocker)} (from ${h.fromTag})`);
  if (also.length > 0) {
    const shown = also.slice(0, ALSO_MAX).join(', ');
    out.push(`Also contains ${shown}${also.length > ALSO_MAX ? ` and ${also.length - ALSO_MAX} more` : ''}.`);
  }
  if (t.state === 'checking') out.push('Still being read.');
  else if (t.blocked && out.length === 0) out.push('Waits for the tags before it to be read.');
  return out;
}

function alsoWhat(b: ReleaseBlocker): string {
  switch (b.kind) {
    case 'not_done':
    case 'unreadable':
      return b.key;
    case 'pr_unreadable':
      return `#${b.number}`;
    case 'too_large':
      return 'more commits than can be read';
  }
}

/** How often the tab re-reads GET /api/releases while a repo is being checked. */
export const RELEASES_POLL_MS = 3_000;

/** The tab's poll interval for this answer: RELEASES_POLL_MS while any repo is checking, else off. Pure. */
export function releasesPollInterval(data: Pick<ReleasesResponse, 'check'> | null | undefined): number | false {
  return releasesChecking(data) ? RELEASES_POLL_MS : false;
}

export type MarkTone = 'ok' | 'bad' | 'warn';

/** A ticket's mark in a tag: Done, or not (its status), not read yet, or unreadable. */
export function ticketMark(t: Pick<ReleaseTicketCheck, 'done' | 'readState' | 'statusName'>): { tone: MarkTone; text: string } {
  if (t.readState === 'not_read') return { tone: 'warn', text: 'not read yet' };
  if (t.readState !== 'ok') return { tone: 'warn', text: 'could not be read' };
  if (t.done) return { tone: 'ok', text: t.statusName ?? 'Done' };
  return { tone: 'bad', text: t.statusName ?? 'not done' };
}

/** One tag's contents for the expanded row: its tickets (with their PRs in this tag), then the PRs with
 *  no ticket — human ones (untracked) and bot ones. */
export function tagContents(
  check: Pick<ReleaseCheckResult, 'tickets' | 'prs'>,
  tag: Pick<ReleaseTagCheck, 'prIds' | 'ticketIdents'>,
): { tickets: Array<{ ticket: ReleaseTicketCheck; prs: ReleaseCheckPr[] }>; untracked: ReleaseCheckPr[]; bot: ReleaseCheckPr[] } {
  const prById = new Map(check.prs.map((p) => [p.id, p]));
  const prs = tag.prIds.map((id) => prById.get(id)).filter((p): p is ReleaseCheckPr => p != null);
  const ticketByIdent = new Map(check.tickets.map((t) => [t.ident, t]));
  const tickets = tag.ticketIdents
    .map((ident) => ticketByIdent.get(ident))
    .filter((t): t is ReleaseTicketCheck => t != null)
    .sort((a, b) => Number(a.ready) - Number(b.ready) || a.key.localeCompare(b.key))
    .map((ticket) => ({ ticket, prs: prs.filter((p) => p.ticketIdents.includes(ticket.ident)) }));
  const none = prs.filter((p) => p.ticketIdents.length === 0);
  return { tickets, untracked: none.filter((p) => !p.isBot), bot: none.filter((p) => p.isBot) };
}

/** One warning as a sentence. */
export function releaseWarningText(w: ReleaseWarning, check: Pick<ReleaseCheckResult, 'repos' | 'prs'>): string {
  const ctx = releaseWordsContext(check);
  switch (w.kind) {
    case 'untracked_pr': {
      const pr = check.prs.find((p) => p.id === w.prId);
      const n = pr != null ? `#${pr.number}` : 'a pull request';
      return `${ctx.repoName(w.repoId)} ${n} has no ticket${pr != null ? `: ${pr.title}` : ''}.`;
    }
  }
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
