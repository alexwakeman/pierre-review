import type { ReleaseBasis, ReleaseBasisSetting, ReleaseSettings, ReleaseSettingsResponse } from '@pierre-review/shared';

/**
 * The disclosure before saving a suffix change (docs/RELEASES.md § Terms and settings, acceptance
 * check 3): only once a release exists, and only for a suffix that was set and changes. Null = no
 * warning. Pure (test/releasesModel.test.ts).
 */
export function releaseSuffixChangeWarning(
  saved: Pick<ReleaseSettingsResponse, 'releaseSuffix' | 'hotfixSuffix' | 'hasReleases'>,
  next: ReleaseSettings,
): string | null {
  if (!saved.hasReleases) return null;
  const parts: string[] = [];
  if (saved.releaseSuffix != null && next.releaseSuffix !== saved.releaseSuffix) {
    parts.push(`Tags ending in ${saved.releaseSuffix} will stop counting as releases.`);
  }
  if (saved.hotfixSuffix != null && next.hotfixSuffix !== saved.hotfixSuffix) {
    parts.push(`Tags ending in ${saved.hotfixSuffix} will stop counting as hotfixes.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/** The ticked "Released from this workspace" set differs from the stored one (order does not count). Pure. */
export function releaseReposDirty(stored: readonly number[], ticked: readonly number[]): boolean {
  const a = new Set(stored);
  const b = new Set(ticked);
  if (a.size !== b.size) return true;
  for (const id of a) if (!b.has(id)) return true;
  return false;
}

/** "Release from" changed for a ticked repository (a missing entry reads as `auto`). Pure. */
export function releaseBasesDirty(
  stored: Readonly<Record<number, ReleaseBasisSetting>>,
  next: Readonly<Record<number, ReleaseBasisSetting>>,
  ticked: readonly number[],
): boolean {
  return ticked.some((id) => (stored[id] ?? 'auto') !== (next[id] ?? 'auto'));
}

const BASIS_WORDS: Record<ReleaseBasis, string> = { tags: 'Version tags', prs: 'Merged pull requests' };

/** The "Release from" choices; Auto names what it means for the repository now. Pure. */
export function releaseBasisOptions(effective: ReleaseBasis): Array<{ value: ReleaseBasisSetting; label: string }> {
  return [
    { value: 'auto', label: `Auto (${BASIS_WORDS[effective].toLowerCase()})` },
    { value: 'tags', label: BASIS_WORDS.tags },
    { value: 'prs', label: BASIS_WORDS.prs },
  ];
}
