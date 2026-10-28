import { createHash } from 'node:crypto';
import { STORY_DOCS_ALIGNMENT_VERSION, type StoryDocsStaleReason } from '@pierre-review/shared';

// A STORY DOCS CHECK'S CURRENCY — pure and clock-free. A run is current while the story's text, its
// criteria list, the workspace's BUILT library and STORY_DOCS_ALIGNMENT_VERSION are all what they were
// when it was queued. Nothing `Date.now()`-derived enters any hash (a document's `builtAt` is a stored
// fact: a rebuild moves it, so a rebuilt document makes every check "Out of date").

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface LibraryDocStamp {
  slug: string;
  builtAt: Date | number | null;
  sectionCount: number;
}

/** The built library as a hash: every built document's slug, build time and section count. */
export function libraryHashOf(docs: readonly LibraryDocStamp[]): string {
  const ms = (v: Date | number): number => (v instanceof Date ? v.getTime() : v);
  const lines = docs
    .filter((d) => d.builtAt != null)
    .map((d) => `${d.slug}:${ms(d.builtAt!)}:${d.sectionCount}`)
    .sort();
  return sha(lines.join('\n'));
}

export interface StoryDocsHashes {
  storyHash: string;
  criteriaHash: string;
  libraryHash: string;
}

/**
 * THE RUN'S FINGERPRINT — everything that changes the answer: the version (prompts, validator, result
 * shape), the subject, the story text, the criteria list, the built library (every built document's
 * slug, build time and section count: a rebuild moves `builtAt`, so changed section text always moves
 * it), the models and the provider that runs the read. A click whose fingerprint equals the newest
 * SUCCEEDED run's REUSES that run (routes.ts) — so a field that changes the answer and is missing here
 * would serve a stale answer as current.
 */
export function storyDocsFingerprint(
  a: StoryDocsHashes & { workspaceId: number; ident: string; version?: number; models?: readonly string[]; provider?: string },
): string {
  return sha(
    [
      `v${a.version ?? STORY_DOCS_ALIGNMENT_VERSION}`,
      String(a.workspaceId),
      a.ident,
      a.storyHash,
      a.criteriaHash,
      a.libraryHash,
      ...(a.models != null ? [`models:${a.models.join(',')}`] : []),
      ...(a.provider != null ? [`provider:${a.provider}`] : []),
    ].join('\n'),
  );
}

/** What moved since a run was queued ([] ⇒ current). */
export function storyDocsStaleReasons(
  stored: StoryDocsHashes & { version: number },
  live: StoryDocsHashes,
  version: number = STORY_DOCS_ALIGNMENT_VERSION,
): StoryDocsStaleReason[] {
  const out: StoryDocsStaleReason[] = [];
  if (stored.storyHash !== live.storyHash) out.push('story');
  if (stored.criteriaHash !== live.criteriaHash) out.push('criteria');
  if (stored.libraryHash !== live.libraryHash) out.push('library');
  if (stored.version !== version) out.push('version');
  return out;
}
