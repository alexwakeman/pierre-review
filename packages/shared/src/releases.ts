// RELEASES (docs/RELEASES.md) — the shared half: the per-workspace suffix settings, their ONE
// validator (the backend route and the Settings form run the same function, so the 400's sentence
// is the one the reader would have seen inline), and the tag classifier every release surface uses.

/** Every stored suffix starts with this, FIXED: the reader types `rc`, the stored suffix is `-rc`
 *  (the Settings form shows the hyphen beside the box, not in it). */
export const RELEASE_SUFFIX_PREFIX = '-';

/** Longest suffix a reader may TYPE (the part after the fixed hyphen). */
export const RELEASE_SUFFIX_MAX = 32;

/** A workspace's release settings, RAW: null = not set. There is NO default. Each set suffix is the
 *  STORED form, starting with the fixed hyphen (`-rc`). */
export interface ReleaseSettings {
  releaseSuffix: string | null;
  hotfixSuffix: string | null;
}

/** One repository of the workspace (home or External) in Settings → Releases. */
export interface ReleaseSettingsRepo {
  repoId: number;
  /** `owner/name`. */
  fullName: string;
  /** External in this workspace (its home is elsewhere, or it is External at home). */
  external: boolean;
  /** "Released from this workspace" is ticked: only these are checked, tagged and offered as hotfix bases. */
  releasable: boolean;
  /** "Release from": the stored choice (`auto` until the reader picks). */
  basis: ReleaseBasisSetting;
  /** What `auto` means for it now (`releaseBasisOf` over its stored tags). */
  effectiveBasis: ReleaseBasis;
}

/** GET / PUT /api/workspaces/:id/release-settings (and PUT …/release-repos). */
export interface ReleaseSettingsResponse extends ReleaseSettings {
  workspaceId: number;
  /** Both suffixes are set: the Releases tab and the hotfix option work. */
  configured: boolean;
  /**
   * A release already exists in this workspace (a release Ensemble made, or a stored tag that ends in
   * the current release suffix). The form warns before a suffix change: older tags stop counting.
   */
  hasReleases: boolean;
  /** Every repository of the workspace (home and External), by name, with its tick. */
  repos: ReleaseSettingsRepo[];
}

/** PUT body: the WHOLE setting; a null (or empty) suffix clears it. A suffix without the leading
 *  hyphen gets one (`rc` → `-rc`); the Settings form sends `suffixFromTyped(typed)`. */
export interface SetReleaseSettingsBody {
  releaseSuffix: string | null;
  hotfixSuffix: string | null;
}

/** PUT /api/workspaces/:id/release-repos — the WHOLE set of ticked repositories (an empty list
 *  unticks every one). Ids outside the workspace are refused. */
export interface SetReleaseReposBody {
  repoIds: number[];
  /** "Release from" per ticked repository; a repository left out keeps its stored choice (a newly
   *  ticked one starts at `auto`). */
  bases?: Array<{ repoId: number; basis: ReleaseBasisSetting }>;
}

// Characters git refuses anywhere in a ref name, plus space.
const FORBIDDEN_CHARS = /[\s~^:?*[\\\u0000-\u001f\u007f]/;

/**
 * Why one TYPED suffix (the part after the fixed hyphen) cannot be used, or null when it can. `label`
 * names the field in the sentence. 1–32 characters, no leading hyphen (it is added), and a valid git
 * ref fragment: no spaces or `~^:?*[\`, no `..`, `@{`, `//` or `/.`, not ending in `.lock`, `/` or `.`.
 */
export function validateReleaseSuffix(value: string, label = 'The suffix'): string | null {
  if (value.length === 0) return `${label} is empty.`;
  if (value.startsWith(RELEASE_SUFFIX_PREFIX)) return `${label} cannot start with a hyphen. The hyphen is added for you.`;
  if (value.length > RELEASE_SUFFIX_MAX) return `${label} is longer than ${RELEASE_SUFFIX_MAX} characters.`;
  if (FORBIDDEN_CHARS.test(value)) return `${label} cannot contain spaces, a backslash or any of these: ~ ^ : ? * [.`;
  if (value.includes('..')) return `${label} cannot contain "..".`;
  if (value.includes('@{')) return `${label} cannot contain "@{".`;
  if (value.includes('//') || value.includes('/.')) return `${label} cannot contain "//" or "/.".`;
  if (value.endsWith('.lock')) return `${label} cannot end in ".lock".`;
  if (value.endsWith('/') || value.endsWith('.')) return `${label} cannot end in "/" or ".".`;
  return null;
}

/**
 * A suffix as STORED: an empty or whitespace-only input means "not set" (null); otherwise the fixed
 * hyphen is put in front when it is missing (`rc` → `-rc`, `-rc` stays). Nothing else changes, so the
 * validator still sees what was typed.
 */
export function normaliseReleaseSuffix(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (value.trim().length === 0) return null;
  return value.startsWith(RELEASE_SUFFIX_PREFIX) ? value : `${RELEASE_SUFFIX_PREFIX}${value}`;
}

/** What the reader types for a stored suffix (`-rc` → `rc`); '' for none. Pure. */
export function suffixTypedPart(stored: string | null | undefined): string {
  if (stored == null) return '';
  return stored.startsWith(RELEASE_SUFFIX_PREFIX) ? stored.slice(RELEASE_SUFFIX_PREFIX.length) : stored;
}

/** The stored suffix for what the reader typed: always the fixed hyphen + the text (`rc` → `-rc`,
 *  `-rc` → `--rc`, which the validator refuses); empty → null. Pure. */
export function suffixFromTyped(typed: string | null | undefined): string | null {
  if (typed == null || typed.trim().length === 0) return null;
  return `${RELEASE_SUFFIX_PREFIX}${typed}`;
}

/**
 * Why these settings cannot be saved, or null when they can. Either suffix may be unset (null). Each
 * is checked on its TYPED part (after the fixed hyphen). When both are set the typed parts must
 * differ, and neither may END WITH the other — a tag must read as a release or a hotfix, never both.
 */
export function validateReleaseSettings(settings: ReleaseSettings): string | null {
  const release = normaliseReleaseSuffix(settings.releaseSuffix);
  const hotfix = normaliseReleaseSuffix(settings.hotfixSuffix);
  const r = release == null ? null : suffixTypedPart(release);
  const h = hotfix == null ? null : suffixTypedPart(hotfix);
  if (r != null) {
    const p = validateReleaseSuffix(r, 'The release suffix');
    if (p) return p;
  }
  if (h != null) {
    const p = validateReleaseSuffix(h, 'The hotfix suffix');
    if (p) return p;
  }
  if (r != null && h != null) {
    if (r === h) return 'The release and hotfix suffixes must be different.';
    if (r.endsWith(h) || h.endsWith(r)) {
      return 'One suffix cannot end with the other, or a tag could be read as both.';
    }
  }
  return null;
}

/** Both suffixes are set (the feature works). */
export function releaseSettingsConfigured(settings: ReleaseSettings): boolean {
  return normaliseReleaseSuffix(settings.releaseSuffix) != null && normaliseReleaseSuffix(settings.hotfixSuffix) != null;
}

export type TagKind = 'release' | 'hotfix' | 'version';

/**
 * What a tag NAME is under a workspace's suffixes: a release tag (ends in the release suffix), a
 * hotfix tag (ends in the hotfix suffix) or otherwise a version-tag candidate — a VERSION tag also
 * needs its commit on the default branch, which the name cannot say. Null when the settings are
 * not configured (nothing classifies). A tag that IS only the suffix is not a release of anything.
 */
export function tagKind(name: string, settings: ReleaseSettings): TagKind | null {
  if (!releaseSettingsConfigured(settings)) return null;
  const release = settings.releaseSuffix!;
  const hotfix = settings.hotfixSuffix!;
  if (name.length > release.length && name.endsWith(release)) return 'release';
  if (name.length > hotfix.length && name.endsWith(hotfix)) return 'hotfix';
  return 'version';
}

/** The release tag name for a version tag. */
export function releaseTagName(versionTag: string, releaseSuffix: string): string {
  return `${versionTag}${releaseSuffix}`;
}

// ── What a release is cut from: version tags, or merged pull requests (2026-11-19) ──────────────

/** How a releasable repository finds what can be released (docs/RELEASES.md § Releasing without version
 *  tags): its VERSION TAGS on the default branch, or each MERGED PULL REQUEST's commit on it. */
export type ReleaseBasis = 'tags' | 'prs';

/** The stored choice per (workspace, repository): `auto` = merged pull requests when the repository has
 *  no version tag, else version tags. */
export type ReleaseBasisSetting = 'auto' | ReleaseBasis;

export const RELEASE_BASIS_SETTINGS: readonly ReleaseBasisSetting[] = ['auto', 'tags', 'prs'];

/** THE ONE basis rule. `auto` reads the tag NAMES only (any branch): one tag that is neither a release nor
 *  a hotfix tag ⇒ version tags. The release tags Ensemble creates end in the release suffix, so they never
 *  turn a repository back to version tags. Pure. */
export function releaseBasisOf(
  setting: ReleaseBasisSetting | null | undefined,
  tagNames: readonly string[],
  settings: ReleaseSettings,
): ReleaseBasis {
  if (setting === 'tags' || setting === 'prs') return setting;
  return tagNames.some((n) => tagKind(n, settings) === 'version') ? 'tags' : 'prs';
}

/** A release point's name in a repository released from merged pull requests: the PR number. */
export function releasePointName(prNumber: number): string {
  return `#${prNumber}`;
}

/** The PR number a release point's name carries; null = not a release point name. Pure. */
export function releasePointNumber(name: string): number | null {
  const m = /^#(\d+)$/.exec(name);
  return m == null ? null : Number(m[1]);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * The release tag Ensemble creates in a repository released from merged pull requests (there is no
 * version to name it after): the day, `2026.11.19-rc`, then `2026.11.19.2-rc`, `.3`… when the name is
 * taken (`taken` = the repository's tag names). Local date. Pure.
 */
export function releaseDateTagName(at: Date, releaseSuffix: string, taken: ReadonlySet<string> | readonly string[]): string {
  const has = Array.isArray(taken) ? new Set(taken) : (taken as ReadonlySet<string>);
  const day = `${at.getFullYear()}.${pad2(at.getMonth() + 1)}.${pad2(at.getDate())}`;
  for (let n = 1; n < 10_000; n += 1) {
    const name = `${n === 1 ? day : `${day}.${n}`}${releaseSuffix}`;
    if (!has.has(name)) return name;
  }
  return `${day}.${at.getTime()}${releaseSuffix}`;
}
