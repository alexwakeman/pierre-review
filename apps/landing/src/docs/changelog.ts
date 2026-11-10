// The changelog, parsed from CHANGELOG.md at the repository root at BUILD time (Vite inlines the
// file with ?raw; the prerender bakes the result into /docs/changelog). A tiny Keep a Changelog
// reader, no dependency:
//
//   ## [Unreleased]                 the next release (may be empty)
//   ## [1.0.15] - 2026-11-09        a release (a hyphen or a dash between version and date)
//   ### Added | Changed | Fixed | Removed | Deprecated | Security
//   - one item, which may wrap onto indented lines
//
// Anything before the first `## ` is the preamble and is not shown. Inline markup is limited to
// `code` and **bold**.
import raw from '../../../../CHANGELOG.md?raw';

export interface ChangelogGroup {
  heading: string;
  items: string[];
}

export interface ChangelogRelease {
  /** `Unreleased`, or a version such as `1.0.15`. */
  version: string;
  /** ISO date, null for Unreleased. */
  date: string | null;
  groups: ChangelogGroup[];
}

const RELEASE_RE = /^##\s+\[?([^\]\s]+)\]?(?:\s+[-–—]\s+(\d{4}-\d{2}-\d{2}))?\s*$/;

export function parseChangelog(text: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | null = null;
  let group: ChangelogGroup | null = null;
  let item: string[] | null = null;

  const flushItem = (): void => {
    if (item && group) group.items.push(item.join(' ').replace(/\s+/g, ' ').trim());
    item = null;
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      flushItem();
      const m = RELEASE_RE.exec(line);
      if (!m) throw new Error(`CHANGELOG.md: cannot read the heading "${line}"`);
      release = { version: m[1]!, date: m[2] ?? null, groups: [] };
      if (release.version !== 'Unreleased' && release.date == null) {
        throw new Error(`CHANGELOG.md: release ${release.version} has no date ("## [x.y.z] - YYYY-MM-DD")`);
      }
      releases.push(release);
      group = null;
      continue;
    }
    if (!release) continue; // the preamble
    if (line.startsWith('### ')) {
      flushItem();
      group = { heading: line.slice(4).trim(), items: [] };
      release.groups.push(group);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushItem();
      if (!group) throw new Error(`CHANGELOG.md: an item under ${release.version} is not under a ### heading`);
      item = [line.replace(/^[-*]\s+/, '')];
      continue;
    }
    if (item && /^\s+\S/.test(line)) {
      item.push(line.trim());
      continue;
    }
    if (line.trim() === '') flushItem();
  }
  flushItem();
  return releases;
}

export const CHANGELOG: readonly ChangelogRelease[] = parseChangelog(raw);

/** The newest released version in the changelog (not Unreleased). */
export function newestRelease(list: readonly ChangelogRelease[] = CHANGELOG): ChangelogRelease | null {
  return list.find((r) => r.version !== 'Unreleased') ?? null;
}
