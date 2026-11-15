// HOTFIX BUILDS — the pure half (docs/RELEASES.md § Hotfix, docs/STORY-BUILD.md § Hotfix builds).
//
// "Treat as a hotfix" is an Implement option. Each RELEASABLE workspace repository ("Released from this
// workspace", Settings → Releases) with a LATEST RELEASE (the newest release OR hotfix tag,
// `latestReleaseTag`) gets a RELEASE checkout at that tag's commit and a MAIN checkout
// at the default branch's head, in the same sandbox; any other repository (not released from this workspace,
// or no release yet) is READ ONLY for the build.
// Push opens two pull requests per changed repository:
//
//   PR 1  `<KEY>`       → `hotfix/<latest release tag>` (made at the release commit when it is missing)
//   PR 2  `<KEY>-main`  → the default branch
//
// Both titled `<KEY>: <title>`, each body linking the other. The review loop and "Build end to end" are
// off for a hotfix build (v1). Nothing here reads the clock or fetches.
import { latestReleaseTag, type TagOrderKey } from './release-check.js';
import { releaseSettingsConfigured, type ReleaseSettings } from './releases.js';

/** The prefix of the branch a release's hotfixes target. */
export const HOTFIX_BRANCH_PREFIX = 'hotfix/';

/** `hotfix/<tag>` — the branch PR 1 targets. */
export function hotfixBranchName(tagName: string): string {
  return `${HOTFIX_BRANCH_PREFIX}${tagName}`;
}

/** PR 2's head branch: the build's branch (the ticket key) plus `-main`. */
export function hotfixMainBranchName(branch: string): string {
  return `${branch}-main`;
}

/** The one sentence a refused review loop / end-to-end start on a hotfix build answers. */
export const HOTFIX_NO_LOOP_LINE = 'A hotfix build opens its pull requests when you press Push. The review loop and Build end to end are off for it.';
/** The one sentence a hotfix start answers when the option is not offered. */
export const HOTFIX_NOT_OFFERED_LINE =
  'A hotfix needs the release and hotfix suffixes in Settings → Releases and at least one repository released from this workspace with a release.';
/** The line a read-only repository's refused change gets (the session goes on). */
export const hotfixReadOnlyLine = (fullName: string): string =>
  `${fullName} has no release here, so it is read only in this hotfix build. Its changes were not kept.`;

// ── The bases ──────────────────────────────────────────────────────────────────────────────────────

export interface HotfixBaseTagInput extends TagOrderKey {
  sha: string;
}

export interface HotfixBaseRepoInput {
  repoId: number;
  /** `owner/name`. */
  fullName: string;
  defaultBranch: string | null;
  /** Ticked "Released from this workspace". An unticked repository is read only (its tags are ignored). */
  releasable: boolean;
  tags: readonly HotfixBaseTagInput[];
}

/** One repository's hotfix base (`GET /api/story-builds/hotfix-bases`). */
export interface StoryBuildHotfixBase {
  repoId: number;
  fullName: string;
  defaultBranch: string | null;
  /** Ticked "Released from this workspace" (Settings → Releases). False ⇒ READ ONLY, whatever its tags. */
  releasable: boolean;
  /** The latest release; null ⇒ not releasable or no release yet: the repository is READ ONLY for the build. */
  release: { tagName: string; sha: string; kind: 'release' | 'hotfix'; committedAt: string | null } | null;
  /** `hotfix/<tag>`; null on a read-only repository. */
  hotfixBranch: string | null;
}

export interface StoryBuildHotfixBasesResponse {
  workspaceId: number;
  /** Both suffixes are set (Settings → Releases). */
  configured: boolean;
  /** "Treat as a hotfix" is offered: configured, and at least one repository has a release. */
  offered: boolean;
  /** Every workspace repository, by name. */
  repos: StoryBuildHotfixBase[];
}

/**
 * THE BASES of a hotfix build (pure): per RELEASABLE repository its latest release (release checkout at that
 * commit); every other repository read only. `offered` only when both suffixes are set and at least one repository has a release.
 * Repositories are ordered by name.
 */
export function hotfixBasesOf(
  repos: readonly HotfixBaseRepoInput[],
  settings: ReleaseSettings,
): Omit<StoryBuildHotfixBasesResponse, 'workspaceId'> {
  const configured = releaseSettingsConfigured(settings);
  const out: StoryBuildHotfixBase[] = [...repos]
    .sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : a.repoId - b.repoId))
    .map((r) => {
      const hit = configured && r.releasable ? latestReleaseTag(r.tags, settings) : null;
      return {
        repoId: r.repoId,
        fullName: r.fullName,
        defaultBranch: r.defaultBranch,
        releasable: r.releasable,
        release: hit ? { tagName: hit.tag.name, sha: hit.tag.sha, kind: hit.kind, committedAt: hit.tag.committedAt?.toISOString() ?? null } : null,
        hotfixBranch: hit ? hotfixBranchName(hit.tag.name) : null,
      };
    });
  return { configured, offered: configured && out.some((r) => r.release != null), repos: out };
}

// ── The patch, at extraction ───────────────────────────────────────────────────────────────────────

/**
 * What extraction does with one checkout's work (pure). A READ-ONLY repository's change is REFUSED (never
 * stored, so never pushed); no change ⇒ `empty`; otherwise `store`.
 */
export function hotfixPatchVerdict(o: { readOnly: boolean; patch: string }): 'store' | 'empty' | 'refused' {
  if (o.patch === '') return 'empty';
  return o.readOnly ? 'refused' : 'store';
}

// ── Push ───────────────────────────────────────────────────────────────────────────────────────────

/** Push's record of `hotfix/<tag>` on one repository row. */
export interface StoryBuildHotfixBranch {
  name: string;
  /** The release commit the branch was made at (or should be at). */
  releaseSha: string;
  /** Push made the branch (false: it was already there). */
  created: boolean;
  /** The branch's tip when it had MOVED past the release commit; null when at the release commit. */
  movedToSha: string | null;
  /** The open PRs already on the branch when it was already there (moved or not), so the tab can name them. */
  prs: Array<{ number: number; title: string; url: string | null }>;
  /** ISO. */
  at: string;
}

/** The two pull requests of one repository (pure). */
export interface HotfixPushTargets {
  release: { head: string; base: string };
  main: { head: string; base: string };
}

/** PR 1 `<branch>` → `hotfix/<tag>`; PR 2 `<branch>-main` → the default branch. */
export function hotfixPushTargets(o: { branch: string; tagName: string; defaultBranch: string }): HotfixPushTargets {
  return {
    release: { head: o.branch, base: hotfixBranchName(o.tagName) },
    main: { head: hotfixMainBranchName(o.branch), base: o.defaultBranch },
  };
}

/** Where `hotfix/<tag>` stands against the release commit (pure): absent, at it, or moved past it. */
export function hotfixBranchState(liveSha: string | null, releaseSha: string): 'missing' | 'at_release' | 'moved' {
  if (liveSha == null) return 'missing';
  return liveSha === releaseSha ? 'at_release' : 'moved';
}

/**
 * The line each PR body ends with, linking its pair (pure). `other` null ⇒ the pair is not open yet (PR 1's
 * body before PR 2 opens: it is edited once PR 2 exists).
 */
export function hotfixPairLine(
  self: 'release' | 'main',
  o: {
    tagName: string;
    defaultBranch: string;
    other: { number: number; url: string | null } | null;
    /** The port report says main needed a different fix ("the fix", not "the same fix"). */
    adapted?: boolean;
  },
): string {
  const where = self === 'release' ? o.defaultBranch : `the release ${o.tagName}`;
  const fix = o.adapted === true ? 'the fix' : 'the same fix';
  if (o.other == null) return `**Hotfix:** ${fix} for ${where} follows in its own pull request.`;
  const link = o.other.url != null && /^https?:\/\/[^\s<>()]+$/i.test(o.other.url) ? `[#${o.other.number}](${o.other.url})` : `#${o.other.number}`;
  return `**Hotfix:** ${fix} for ${where} is ${link}.`;
}

// ── The port report ────────────────────────────────────────────────────────────────────────────────
//
// At the end of a hotfix build the AGENT says, per repository, what the port to the default branch came to
// (the sandbox's `.limn/port-report.json`, checked by the host: sandbox/workspace/port-report.ts):
//
//   same        Applied to both: the same fix on the release and on main.
//   adapted     Applied to both, adapted for main: main needed a materially different fix (the reason says how).
//   not_needed  Not applied to main: main no longer needs it (the reason says why, e.g. the code was removed).
//
// ⚠ A SELF-REPORT. The host never infers an outcome: no report ⇒ "No report from the agent" (unknown is not
// zero). It checks the claim against the FACTS it has — the two stored patches — and flags a contradiction;
// the reader decides (Push stays allowed). Test results are not the measure: tests may not apply to both.

export type HotfixPortOutcome = 'same' | 'adapted' | 'not_needed';
export const HOTFIX_PORT_OUTCOMES: readonly HotfixPortOutcome[] = ['same', 'adapted', 'not_needed'];
/** A reason is clipped to this many characters (one plain sentence or two). */
export const HOTFIX_PORT_REASON_MAX = 600;
/** At most this many evidence entries (paths or commits the agent looked at), each at most `…_ITEM_MAX`. */
export const HOTFIX_PORT_EVIDENCE_MAX = 10;
export const HOTFIX_PORT_EVIDENCE_ITEM_MAX = 200;

/** The agent's claim for one repository, as the host stored it (`story_build_repos.port_report_json`). */
export interface HotfixPortClaim {
  outcome: HotfixPortOutcome;
  /** One line; required for `adapted` / `not_needed`, optional for `same`. Untrusted model text. */
  reason: string | null;
  /** Paths or commits the agent looked at. Untrusted model text. */
  evidence: string[];
}

/** A claim the stored patches contradict. */
export type HotfixPortFlag = 'not_needed_but_changed' | 'ported_but_unchanged';
/** The files the two fixes change: the same set, some differ, or none in common. */
export type HotfixPortFiles = 'same' | 'some_differ' | 'none_in_common';

/** One repository's port report on the wire (`StoryBuildRepoHotfix.port`). Derived on read, never stored. */
export interface StoryBuildHotfixPort {
  /** null ⇒ no report from the agent for this repository. */
  claim: HotfixPortClaim | null;
  flag: HotfixPortFlag | null;
  /** null when either fix changes nothing (nothing to compare). */
  files: HotfixPortFiles | null;
}

/** One line of untrusted text: whitespace collapsed, control characters dropped, clipped. Pure. */
export function hotfixPortText(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- dropping control characters is the point.
  const one = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

/** The host's form of a claim (pure): reason and evidence as one-line, clipped text; empty ⇒ null / dropped. */
export function hotfixPortClaimOf(o: { outcome: HotfixPortOutcome; reason?: string | null; evidence?: readonly string[] | null }): HotfixPortClaim {
  const reason = o.reason != null ? hotfixPortText(o.reason, HOTFIX_PORT_REASON_MAX) : '';
  const evidence = (o.evidence ?? [])
    .map((e) => hotfixPortText(e, HOTFIX_PORT_EVIDENCE_ITEM_MAX))
    .filter((e) => e !== '')
    .slice(0, HOTFIX_PORT_EVIDENCE_MAX);
  return { outcome: o.outcome, reason: reason === '' ? null : reason, evidence };
}

/** Which files the two fixes change, compared (pure). null when either changes nothing. */
export function hotfixPortFilesOf(releaseFiles: readonly string[], mainFiles: readonly string[]): HotfixPortFiles | null {
  if (releaseFiles.length === 0 || mainFiles.length === 0) return null;
  const rel = new Set(releaseFiles);
  const main = new Set(mainFiles);
  const common = [...rel].filter((f) => main.has(f)).length;
  if (common === 0) return 'none_in_common';
  return common === rel.size && common === main.size ? 'same' : 'some_differ';
}

/**
 * THE PORT REPORT of one repository (pure): the agent's claim, checked against the stored patches.
 * `not_needed` with a main change, or `same` / `adapted` with none, is FLAGGED. No claim ⇒ no flag (nothing
 * is inferred). `mainChanged` = the main fix's patch is not empty.
 */
export function hotfixPortOf(o: {
  claim: HotfixPortClaim | null;
  releaseFiles: readonly string[];
  mainFiles: readonly string[];
  mainChanged: boolean;
}): StoryBuildHotfixPort {
  const c = o.claim;
  const flag: HotfixPortFlag | null =
    c == null ? null : c.outcome === 'not_needed' ? (o.mainChanged ? 'not_needed_but_changed' : null) : o.mainChanged ? null : 'ported_but_unchanged';
  return { claim: c, flag, files: hotfixPortFilesOf(o.releaseFiles, o.mainFiles) };
}

/** The outcome in words. */
export const HOTFIX_PORT_OUTCOME_WORDS: Readonly<Record<HotfixPortOutcome, string>> = {
  same: 'Applied to both',
  adapted: 'Applied to both, adapted for main',
  not_needed: 'Not applied to main',
};
/** The line when the agent gave no report for a repository. */
export const HOTFIX_PORT_NO_REPORT = 'No report from the agent';

/** The tab's line (pure): "Applied to both", "Applied to both, adapted for main — <reason>", … */
export function hotfixPortLine(claim: HotfixPortClaim | null): string {
  if (claim == null) return HOTFIX_PORT_NO_REPORT;
  const words = HOTFIX_PORT_OUTCOME_WORDS[claim.outcome];
  return claim.reason != null && claim.outcome !== 'same' ? `${words} — ${claim.reason}` : words;
}

/** A contradiction in words. */
export const HOTFIX_PORT_FLAG_WORDS: Readonly<Record<HotfixPortFlag, string>> = {
  not_needed_but_changed: 'Says main does not need it, but changed main.',
  ported_but_unchanged: 'Says it was ported, but main is unchanged.',
};

/** The files compared, in words. */
export const HOTFIX_PORT_FILES_WORDS: Readonly<Record<HotfixPortFiles, string>> = {
  same: 'Both fixes change the same files.',
  some_differ: 'Some files differ between the two fixes.',
  none_in_common: 'The two fixes have no file in common.',
};

/**
 * The one line both PR bodies carry (pure; the caller defangs it for GitHub). Null when there is no claim or
 * the claim is FLAGGED: a claim the patches contradict is not sent to GitHub.
 */
export function hotfixPortBodyLine(port: StoryBuildHotfixPort | null): string | null {
  if (port?.claim == null || port.flag != null) return null;
  const c = port.claim;
  const words = HOTFIX_PORT_OUTCOME_WORDS[c.outcome];
  return `**Port:** ${c.reason != null && c.outcome !== 'same' ? `${words}: ${c.reason}` : `${words}.`}`;
}

// ── The wire ───────────────────────────────────────────────────────────────────────────────────────

/** A hotfix build's per-repository facts on `StoryBuildRepo.hotfix` (null on an ordinary build). */
export interface StoryBuildRepoHotfix {
  /** The latest release the release checkout started at; null on a read-only repository. */
  tagName: string | null;
  readOnly: boolean;
  /** `hotfix/<tag>`; null on a read-only repository. */
  hotfixBranch: string | null;
  /** The main checkout's base (the default branch at the build's start). */
  mainBaseRef: string | null;
  mainBaseSha: string | null;
  /** The MAIN FIX: null (not built yet) | ready | skipped (no change) | failed | pushed. */
  mainStatus: 'ready' | 'skipped' | 'failed' | 'pushed' | null;
  mainHasPatch: boolean;
  mainFilesChanged: string[];
  mainInsertions: number | null;
  mainDeletions: number | null;
  mainError: string | null;
  mainPushedBranch: string | null;
  mainPushedPrNumber: number | null;
  mainPushedPrUrl: string | null;
  mainPushError: string | null;
  mainPushErrorCode: string | null;
  /** Push's record of `hotfix/<tag>`; null before the first push. */
  branch: StoryBuildHotfixBranch | null;
  /** The port report (the agent's claim, checked against the two patches); null on a read-only repository. */
  port: StoryBuildHotfixPort | null;
}

/** "Release fix" / "Main fix" — the two diffs of one repository. */
export type StoryBuildDiffTarget = 'release' | 'main';
