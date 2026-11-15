import {
  releaseBlockerText,
  releaseSelectionProblems,
  type ReleaseBlocker,
  type ReleaseCheckResult,
  type ReleaseRepoCheck,
  type ReleasesResponse,
  type ReleaseTicketCheck,
  type ReleaseTicketRepoState,
  type ReleaseWarning,
  type ReleaseWordsContext,
  type ReleasePreviewResponse,
} from '@pierre-review/shared';

// THIS SPRINT → RELEASES, the PURE half (docs/RELEASES.md § Releases tab). The words and the
// dialog's rules; ReleasesView.tsx / ReleaseDialog.tsx only draw them. Pinned by
// test/releasesModel.test.ts. ⚠ The check itself is the SHARED fold (`foldReleaseCheck`, run on the
// server); unticking a repo re-checks through the shared `releaseSelectionProblems` — never a
// second fold here.

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
export function shortBlocker(b: ReleaseBlocker, ctx: ReleaseWordsContext): string {
  switch (b.kind) {
    case 'not_done':
      return b.statusName != null ? `${b.key} (${b.statusName})` : `${b.key} (not done)`;
    case 'unreadable':
      return `${b.key} (could not be read)`;
    case 'open_pr':
      return `${b.key} (open PR in ${ctx.repoName(b.repoId)})`;
    case 'not_whole':
      return `${b.key} (not in every repository yet)`;
    case 'range_pending':
      return 'changes not read yet';
  }
}

/** The first blocker that holds a repo back: the first held tag's own. */
export function repoFirstBlocker(repo: ReleaseRepoCheck): ReleaseBlocker | null {
  const tag = repo.tags.find((t) => t.name === repo.firstBlocked) ?? repo.tags.find((t) => t.blockers.length > 0);
  return tag?.blockers[0] ?? null;
}

/**
 * A repo row's line after its name:
 *   candidate  "v2.4.0 → v2.4.0-rc · 6 tickets · 1 warning"
 *   nothing    "Nothing new since v2.3.0-rc" / "No version tags yet"
 *   blocked    "No candidate: v0.3.0 held by PLAT-301 (In review)"
 */
export function repoRowText(repo: ReleaseRepoCheck, ctx: ReleaseWordsContext): string {
  if (repo.status === 'candidate' && repo.candidate != null) {
    const parts = [`${repo.candidate.name} → ${repo.candidate.releaseTagName}`, plural(repo.ticketIdents.length, 'ticket')];
    if (repo.warningCount > 0) parts.push(plural(repo.warningCount, 'warning'));
    return parts.join(' · ');
  }
  if (repo.status === 'nothing_new') {
    if (repo.nothingNewReason === 'no_tags') return 'No version tags yet';
    return repo.baseline != null ? `Nothing new since ${repo.baseline.name}` : 'Nothing new';
  }
  const b = repoFirstBlocker(repo);
  const at = repo.firstBlocked ?? repo.tags[repo.tags.length - 1]?.name ?? null;
  if (at == null) return 'No candidate';
  return b != null ? `No candidate: ${at} held by ${shortBlocker(b, ctx)}` : `No candidate: ${at} is held back`;
}

export type MarkTone = 'ok' | 'bad' | 'warn';

/** A ticket's state in one repo: the mark and its words. */
export function ticketRepoMark(state: ReleaseTicketRepoState): { tone: MarkTone; text: string } {
  switch (state) {
    case 'in_candidate':
      return { tone: 'ok', text: 'in candidate' };
    case 'released':
      return { tone: 'ok', text: 'released' };
    case 'merged_after_candidate':
      return { tone: 'bad', text: 'merged after candidate' };
    case 'open_pr':
      return { tone: 'bad', text: 'open PR' };
    case 'linked_no_pr':
      return { tone: 'warn', text: 'linked, no PR' };
  }
}

/** The tickets panel: every ticket the release ships or holds, held ones first, then by key. */
export function ticketsPanelRows(check: Pick<ReleaseCheckResult, 'tickets'>): ReleaseTicketCheck[] {
  return check.tickets
    .filter((t) => t.inRelease || t.blocker != null)
    .sort((a, b) => Number(a.blocker == null) - Number(b.blocker == null) || a.key.localeCompare(b.key));
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
    case 'linked_no_pr':
      return `${w.key} is linked to ${ctx.repoName(w.repoId)}, which has no pull request for it.`;
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

/**
 * What stops Confirm for these ticks, as sentences naming the ticket ("PLAT-290 needs web too: it
 * would ship in part."). Empty = Confirm may be pressed. Re-checked on every tick through the shared
 * `releaseSelectionProblems`; no repo ticked is a stop too.
 */
export function confirmStops(check: Pick<ReleaseCheckResult, 'tickets' | 'repos' | 'prs'>, ticked: readonly number[]): string[] {
  if (ticked.length === 0) return ['Tick at least one repository.'];
  const ctx = releaseWordsContext(check);
  return releaseSelectionProblems(check, ticked).map((p) => {
    const names = p.missingRepoIds.map((id) => ctx.repoName(id));
    return `${p.key} needs ${joinWords(names)} too: it would ship in part.`;
  });
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
