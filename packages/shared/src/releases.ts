// RELEASES (docs/RELEASES.md) — the shared half: the per-workspace suffix settings, their ONE
// validator (the backend route and the Settings form run the same function, so the 400's sentence
// is the one the reader would have seen inline), and the tag classifier every release surface uses.

/** Longest suffix a workspace may set. */
export const RELEASE_SUFFIX_MAX = 32;

/** A workspace's release settings, RAW: null = not set. There is NO default. */
export interface ReleaseSettings {
  releaseSuffix: string | null;
  hotfixSuffix: string | null;
}

/** GET / PUT /api/workspaces/:id/release-settings. */
export interface ReleaseSettingsResponse extends ReleaseSettings {
  workspaceId: number;
  /** Both suffixes are set: the Releases tab and the hotfix option work. */
  configured: boolean;
  /**
   * A release already exists in this workspace (a release Limn made, or a stored tag that ends in
   * the current release suffix). The form warns before a suffix change: older tags stop counting.
   */
  hasReleases: boolean;
}

/** PUT body: the WHOLE setting; a null (or empty) suffix clears it. */
export interface SetReleaseSettingsBody {
  releaseSuffix: string | null;
  hotfixSuffix: string | null;
}

// Characters git refuses anywhere in a ref name, plus space.
const FORBIDDEN_CHARS = /[\s~^:?*[\\\u0000-\u001f\u007f]/;

/**
 * Why one suffix cannot be used, or null when it can. `label` names the field in the sentence.
 * A valid git ref fragment: 1–32 characters, no spaces or `~^:?*[\`, no `..`, `@{`, `//` or `/.`,
 * and not ending in `.lock`, `/` or `.`.
 */
export function validateReleaseSuffix(value: string, label = 'The suffix'): string | null {
  if (value.length === 0) return `${label} is empty.`;
  if (value.length > RELEASE_SUFFIX_MAX) return `${label} is longer than ${RELEASE_SUFFIX_MAX} characters.`;
  if (FORBIDDEN_CHARS.test(value)) return `${label} cannot contain spaces, a backslash or any of these: ~ ^ : ? * [.`;
  if (value.includes('..')) return `${label} cannot contain "..".`;
  if (value.includes('@{')) return `${label} cannot contain "@{".`;
  if (value.includes('//') || value.includes('/.')) return `${label} cannot contain "//" or "/.".`;
  if (value.endsWith('.lock')) return `${label} cannot end in ".lock".`;
  if (value.endsWith('/') || value.endsWith('.')) return `${label} cannot end in "/" or ".".`;
  return null;
}

/** An empty or whitespace-only input means "not set". Everything else is kept as typed. */
export function normaliseReleaseSuffix(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.trim().length === 0 ? null : value;
}

/**
 * Why these settings cannot be saved, or null when they can. Either suffix may be unset (null).
 * When both are set they must differ, and neither may END WITH the other — a tag must read as a
 * release or a hotfix, never both.
 */
export function validateReleaseSettings(settings: ReleaseSettings): string | null {
  const release = normaliseReleaseSuffix(settings.releaseSuffix);
  const hotfix = normaliseReleaseSuffix(settings.hotfixSuffix);
  if (release != null) {
    const p = validateReleaseSuffix(release, 'The release suffix');
    if (p) return p;
  }
  if (hotfix != null) {
    const p = validateReleaseSuffix(hotfix, 'The hotfix suffix');
    if (p) return p;
  }
  if (release != null && hotfix != null) {
    if (release === hotfix) return 'The release and hotfix suffixes must be different.';
    if (release.endsWith(hotfix) || hotfix.endsWith(release)) {
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
