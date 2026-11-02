import { STORY_DOCS_PREFILTER_MAX, type StoryDocsCriterion } from '@pierre-review/shared';
import { retrieveSections, type RetrievedSection } from '../../reference-docs/retrieve.js';
import type { StoryText } from './inputs.js';
import { prefilterSections, type ShortlistCandidate, type ShortlistDoc } from './shortlist.js';

// THE SHORTLIST'S CANDIDATES — for BOTH Check against the docs (manager.ts) and Implement story's docs
// pass (coding/story-build/docs.ts), so they cannot drift. Full-text search over the sections' TEXT
// (reference-docs/retrieve.ts, FTS5) in plain rank order — no per-document cap: these 30 go to Haiku,
// and a cap measurably lost sections there (docs/DOCS-RAG.md § Crowding). A library with no passages
// yet (built before migration 0152, until the boot backfill reaches it) keeps the old prefilter over
// titles and summaries.

/** What the story-docs fingerprint names as its retrieval: changing how candidates are found changes it. */
export const STORY_DOCS_RETRIEVAL_ID = 'fts-v1';

export type StoryDocsQuery = { story: StoryText; criteria: readonly StoryDocsCriterion[] };

export function storyDocsQueryText(q: StoryDocsQuery): string {
  return [q.story.title ?? '', q.story.description, q.story.acceptanceCriteria, ...q.criteria.map((c) => c.text)].join('\n');
}

/** Retrieved sections → candidates, each named by a stored section of a shortlisted document. Pure. */
export function candidatesFromRetrieval(found: readonly RetrievedSection[], docs: readonly Pick<ShortlistDoc, 'title' | 'sections'>[]): ShortlistCandidate[] {
  const byPath = new Map(docs.flatMap((d) => d.sections.map((s) => [s.path, { doc: d, sec: s }] as const)));
  const out: ShortlistCandidate[] = [];
  for (const f of found) {
    const hit = byPath.get(f.path);
    // A passage of a section no longer listed (a rebuild in between) is not offered.
    if (hit == null) continue;
    out.push({ path: f.path, docTitle: hit.doc.title, title: hit.sec.title, summary: hit.sec.summary ?? '', score: -f.rank });
  }
  return out;
}

export async function storyDocsCandidates(
  scope: { accountId: number; workspaceId: number },
  query: StoryDocsQuery,
  docs: readonly Pick<ShortlistDoc, 'title' | 'sections'>[],
  max: number = STORY_DOCS_PREFILTER_MAX,
): Promise<ShortlistCandidate[]> {
  const found = await retrieveSections({ ...scope, query: storyDocsQueryText(query), k: max });
  if (found == null) return prefilterSections(query, docs, max);
  return candidatesFromRetrieval(found, docs);
}
