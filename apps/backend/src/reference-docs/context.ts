import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { readIndex } from './library.js';
import { libraryDir } from './paths.js';
import { docsNavigationPrompt } from './prompts.js';
import { countBuiltDocs, readDocsInReview } from './store.js';

// THE LIBRARY, FOR OTHER AGENTS (Claude Review, the ticket review, This Sprint's checks —
// docs/REFERENCE-DOCS.md § For other agents). A run that should consult the workspace's reference
// documents asks `docsContextFor`, and when `usable` is true:
//
//   • adds `dir` to its `additionalDirectories` AND to its path guard's roots (read-only: Read, Glob,
//     Grep — never a write tool);
//   • appends `docsNavigationPrompt(dir)` to its system prompt: the three levels (INDEX.md →
//     CONTENTS.md → section), and the rule — read only the relevant sections, and cite them.
//
// ⚠ `usable` folds in the per-workspace switch (`workspaces.docs_in_review`, OFF by default) and the
// agentic gate, so a caller cannot forget either; `hasDocs` alone says only that something is built.

export interface DocsContext {
  /** The library folder (absolute). Read-only for every agent but the build. */
  dir: string;
  indexPath: string;
  /** At least one document is built (listed in INDEX.md). */
  hasDocs: boolean;
  docCount: number;
  /** Settings → use the library in Claude Review. */
  enabledInReview: boolean;
  /** hasDocs AND enabledInReview AND agentic features are on here: the review should read it. */
  usable: boolean;
}

export async function docsContextFor(accountId: number, workspaceId: number): Promise<DocsContext> {
  const dir = libraryDir(accountId, workspaceId);
  const indexPath = join(dir, 'INDEX.md');
  const [docCount, enabledInReview] = await Promise.all([
    countBuiltDocs(accountId, workspaceId),
    readDocsInReview(accountId, workspaceId),
  ]);
  if (docCount > 0 && !existsSync(indexPath)) await readIndex(accountId, workspaceId);
  const hasDocs = docCount > 0 && existsSync(indexPath);
  return {
    dir,
    indexPath,
    hasDocs,
    docCount,
    enabledInReview,
    usable: hasDocs && enabledInReview && config.aiEnabled && !config.isCloud,
  };
}

export { docsNavigationPrompt };
