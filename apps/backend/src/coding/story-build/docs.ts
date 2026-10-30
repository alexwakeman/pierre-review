import type { DocsBlocksFn, RunBuildDocsFn } from './seams.js';

// DOCS CONSIDERATION — WORK PACKAGE 3 (docs/STORY-BUILD.md § Docs consideration; the story wins). STUB from
// the contract commit: WP3 replaces both bodies (the review/story-docs `build` mode → `docs_json`; the two
// fenced blocks from the decisions in force or frozen at Accept) and keeps THESE signatures (seams.ts).

/** Until WP3: no docs points reach a prompt. */
export const docsBlocksFor: DocsBlocksFn = () => ({ included: '', superseded: '', pending: 0 });

/** Until WP3: the run is refused (the caller records `docs_status = 'refused'`). */
export const runBuildDocs: RunBuildDocsFn = async () => {
  throw new Error('Checking a story build against the docs is not available in this version of Limn yet.');
};
