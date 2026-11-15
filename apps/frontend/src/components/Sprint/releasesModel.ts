import {
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
// ⚠ "released" is never said of a ticket or PR: only a release tag is a release. PRs before the
// checked history are simply not listed.

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

/** A blocker in a few words, for a repo row: "PLAT-301 (In review)". */
export function shortBlocker(b: ReleaseBlocker): string {
  switch (b.kind) {
    case 'not_done':
      return b.statusName != null ? `${b.key} (${b.statusName})` : `${b.key} (not done)`;
    case 'unreadable':
      return `${b.key} (could not be read)`;
    case 'too_large':
      return 'too many commits to check';
  }
}

/** The first blocker that holds a repo back: the first held tag's own. */
export function repoFirstBlocker(repo: ReleaseRepoCheck): ReleaseBlocker | null {
  const tag = repo.tags.find((t) => t.name === repo.firstBlocked) ?? repo.tags.find((t) => t.blockers.length > 0);
  return tag?.blockers[0] ?? null;
}

/**
 * A repo row's line after its name — the PAIR (the latest version tag on main, and the candidate):
 *   candidate  "Latest 0.394.0 is the candidate → 0.394.0-rc"
 *              "Latest 0.394.0 · candidate 0.390.0 → 0.390.0-rc"
 *   blocked    "No candidate: 0.391.0 held by BMD-1048 (In PO Review)"
 *   reading    "Latest 0.394.0 · Reading changes…"
 *   nothing    "Nothing new since 0.390.0-rc" / "No version tags on main yet"
 */
export function repoRowText(repo: ReleaseRepoCheck): string {
  const latest = repo.latestVersion?.name ?? null;
  if (repo.status === 'candidate' && repo.candidate != null) {
    const c = repo.candidate;
    if (latest == null || latest === c.name) return `Latest ${c.name} is the candidate → ${c.releaseTagName}`;
    return `Latest ${latest} · candidate ${c.name} → ${c.releaseTagName}`;
  }
  if (repo.status === 'nothing_new') {
    if (repo.nothingNewReason === 'no_tags') return 'No version tags on main yet';
    return repo.baseline != null ? `Nothing new since ${repo.baseline.name}` : 'Nothing new';
  }
  if (repo.status === 'reading') return latest != null ? `Latest ${latest} · Reading changes…` : 'Reading changes…';
  const b = repoFirstBlocker(repo);
  const at = repo.firstBlocked ?? repo.tags[repo.tags.length - 1]?.name ?? null;
  if (at == null) return 'No candidate';
  return b != null ? `No candidate: ${at} held by ${shortBlocker(b)}` : `No candidate: ${at} is held back`;
}

/** The counts beside a candidate row: "6 tickets · 1 warning"; null otherwise. */
export function repoRowCounts(repo: ReleaseRepoCheck): string | null {
  if (repo.status !== 'candidate') return null;
  const parts = [plural(repo.ticketIdents.length, 'ticket')];
  if (repo.warningCount > 0) parts.push(plural(repo.warningCount, 'warning'));
  return parts.join(' · ');
}

/** "Reading changes…" beside a row whose later tags are still being read (null when not, or when the
 *  row line already says it). */
export function repoReadingNote(repo: ReleaseRepoCheck): string | null {
  return repo.reading && repo.status !== 'reading' ? 'Reading changes…' : null;
}

/**
 * The start-tag line in an expanded row (null = no start tag):
 *   "Starts from 0.380.0" · "Starts from 0.390.0-rc, the last release" (a newer release wins)
 *   "Start tag 0.380.0 moved to another commit, so it is not used."
 *   "Start tag 0.380.0 is no longer a version tag on main, so it is not used."
 */
export function startTagLine(repo: Pick<ReleaseRepoCheck, 'startTag' | 'baseline'>): string | null {
  const st = repo.startTag;
  if (st == null) return null;
  if (st.problem === 'moved') return `Start tag ${st.name} moved to another commit, so it is not used.`;
  if (st.problem === 'missing') return `Start tag ${st.name} is no longer a version tag on main, so it is not used.`;
  if (repo.baseline != null && repo.baseline.kind === 'release') return `Starts from ${repo.baseline.name}, the last release`;
  return `Starts from ${st.name}`;
}

/** The ONE line for repos with no release and no start tag: only the window is checked. */
export function noBaselineLine(repos: readonly Pick<ReleaseRepoCheck, 'name' | 'noBaseline' | 'status'>[], window: number): string | null {
  const names = repos.filter((r) => r.noBaseline && r.status !== 'nothing_new').map((r) => r.name);
  if (names.length === 0) return null;
  return `No release or start tag yet in ${joinWords(names)}: only the newest ${window} tags are checked. Pick a start tag to check fewer.`;
}

export type MarkTone = 'ok' | 'bad' | 'warn';

/** A ticket's mark in a tag: Done, or not (its status), or unreadable. */
export function ticketMark(t: Pick<ReleaseTicketCheck, 'done' | 'readState' | 'statusName'>): { tone: MarkTone; text: string } {
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
    case 'unsynced_prs':
      return `${ctx.repoName(w.repoId)}: ${plural(w.count, 'pull request')} in these tags ${w.count === 1 ? 'is' : 'are'} not synced yet.`;
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

function joinWords(xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
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
