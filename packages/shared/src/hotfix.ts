// HOTFIX BUILDS — the pure half (docs/RELEASES.md § Hotfix, docs/STORY-BUILD.md § Hotfix builds).
//
// "Treat as a hotfix" is an Implement option. Each workspace repository with a LATEST RELEASE (the newest
// release OR hotfix tag, `latestReleaseTag`) gets a RELEASE checkout at that tag's commit and a MAIN checkout
// at the default branch's head, in the same sandbox; a repository without one is READ ONLY for the build.
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
export const HOTFIX_NOT_OFFERED_LINE = 'A hotfix needs the release and hotfix suffixes in Settings → Releases and at least one repository with a release.';
/** The line a read-only repository's refused change gets (the session goes on). */
export const hotfixReadOnlyLine = (fullName: string): string =>
  `${fullName} has no release yet, so it is read only in this hotfix build. Its changes were not kept.`;

// ── The bases ──────────────────────────────────────────────────────────────────────────────────────

export interface HotfixBaseTagInput extends TagOrderKey {
  sha: string;
}

export interface HotfixBaseRepoInput {
  repoId: number;
  /** `owner/name`. */
  fullName: string;
  defaultBranch: string | null;
  tags: readonly HotfixBaseTagInput[];
}

/** One repository's hotfix base (`GET /api/story-builds/hotfix-bases`). */
export interface StoryBuildHotfixBase {
  repoId: number;
  fullName: string;
  defaultBranch: string | null;
  /** The latest release; null ⇒ no release yet, the repository is READ ONLY for the build. */
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
 * THE BASES of a hotfix build (pure): per repository its latest release (release checkout at that commit),
 * else read only. `offered` only when both suffixes are set and at least one repository has a release.
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
      const hit = configured ? latestReleaseTag(r.tags, settings) : null;
      return {
        repoId: r.repoId,
        fullName: r.fullName,
        defaultBranch: r.defaultBranch,
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
  o: { tagName: string; defaultBranch: string; other: { number: number; url: string | null } | null },
): string {
  const where = self === 'release' ? o.defaultBranch : `the release ${o.tagName}`;
  if (o.other == null) return `**Hotfix:** the same fix for ${where} follows in its own pull request.`;
  const link = o.other.url != null && /^https?:\/\/[^\s<>()]+$/i.test(o.other.url) ? `[#${o.other.number}](${o.other.url})` : `#${o.other.number}`;
  return `**Hotfix:** the same fix for ${where} is ${link}.`;
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
}

/** "Release fix" / "Main fix" — the two diffs of one repository. */
export type StoryBuildDiffTarget = 'release' | 'main';
