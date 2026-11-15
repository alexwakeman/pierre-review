import type { ReleaseSettings, ReleaseSettingsResponse } from '@pierre-review/shared';

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
