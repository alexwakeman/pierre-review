// "IMPLEMENT WITH DOCS" — WHICH SECTIONS GO IN (docs.ts header: check · whole · search). DB and disk only,
// never a model call. The gate is the library's own: a built document (`docsContextFor().hasDocs`, the
// `available` Check against docs reads) and agentic features on here. Everything is imported lazily: the
// docs code opens the library store, and a session without docs never needs it.
import type { AgentContext } from '../../review/agent-context.js';
import type { LibrarySnapshot } from '../../reference-docs/review-refs.js';
import type { DocsChoice } from './docs.js';

export const NO_DOCS_LINE = 'No reference documents are built for this workspace.';

export type DocsPick = { ok: true; choice: DocsChoice; lib: LibrarySnapshot; index: string; libraryHash: string } | { ok: false; reason: string };

export async function chooseSessionDocs(ctx: AgentContext, accountId: number, workspaceId: number, ident: string): Promise<DocsPick> {
  const { config } = await import('../../config.js');
  const { docsContextFor, loadLibrarySnapshot } = await import('../../reference-docs/context.js');
  const docs = await docsContextFor(accountId, workspaceId);
  if (!docs.hasDocs || !config.aiEnabled) return { ok: false, reason: NO_DOCS_LINE };
  const { readIndex } = await import('../../reference-docs/library.js');
  const sd = await import('../../review/story-docs/manager.js');
  const { latestSucceededStoryDocsRun } = await import('../../review/story-docs/persist.js');
  const { wholeLibraryShortlist } = await import('../../review/story-docs/shortlist.js');
  const { storyDocsCandidates } = await import('../../review/story-docs/candidates.js');
  // The library is about to be read: refresh its wiki documents in the background (never waits).
  void import('../../reference-docs/wiki/refresh.js').then((m) => m.kickWikiRefresh(accountId, workspaceId)).catch(() => {});
  const [lib, index, live] = await Promise.all([
    loadLibrarySnapshot(accountId, workspaceId),
    readIndex(accountId, workspaceId),
    sd.liveStoryDocs(ctx, accountId, workspaceId, ident),
  ]);
  const base = { lib, index, libraryHash: live.libraryHash };
  if (live.inputs != null) {
    const good = await latestSucceededStoryDocsRun(ctx, accountId, workspaceId, ident).catch(() => null);
    const current = good != null && good.resultJson != null && good.fingerprint === sd.currentStoryDocsFingerprint(workspaceId, live.inputs, live.libraryHash);
    if (current && good?.resultJson) {
      const r = good.resultJson;
      const cited = [...r.criteria.flatMap((c) => c.refs), ...r.storyParts.flatMap((p) => p.refs)].map((x) => x.path);
      const sections = [...r.shortlist.map((s) => s.path), ...cited];
      const reasons = Object.fromEntries(r.shortlist.filter((s) => s.reason).map((s) => [s.path, s.reason]));
      return { ok: true, ...base, choice: { source: 'check', sections, reasons, check: r } };
    }
  }
  const whole = wholeLibraryShortlist(lib);
  if (whole != null) return { ok: true, ...base, choice: { source: 'whole', sections: whole.map((s) => s.path) } };
  if (live.inputs == null) return { ok: true, ...base, choice: { source: 'search', sections: [] } };
  const found = await storyDocsCandidates({ accountId, workspaceId }, { story: live.inputs.story, criteria: live.inputs.criteria }, sd.shortlistDocsOf(lib)).catch(() => []);
  return { ok: true, ...base, choice: { source: 'search', sections: found.map((c) => c.path) } };
}

/** What `chooseFixDocs` knows about the pull request (DB and the fix's own diff; no GitHub call). */
export interface FixDocsSubject {
  /** The PR's first ticket ident, when it has one: the ticket's own choice is used. */
  ticketIdent: string | null;
  title: string;
  body: string | null;
  /** The PR's changed paths (from its diff). */
  paths: readonly string[];
}

/** How many changed paths the full-text query names (a big PR's tail adds nothing but noise). */
export const FIX_DOCS_QUERY_PATHS_MAX = 200;

/**
 * AN AI FIX'S DOCS (docs/SANDBOX.md § AI Fix sessions → What the agent finds): the PR-shaped chooser. The PR
 * has a ticket ⇒ the ticket's choice (`chooseSessionDocs`); else the whole library when it is small; else the
 * top full-text hits on the PR's title, description and changed paths. DB and disk only, never a model call.
 */
export async function chooseFixDocs(ctx: AgentContext, accountId: number, workspaceId: number, pr: FixDocsSubject): Promise<DocsPick> {
  if (pr.ticketIdent != null) {
    const viaTicket = await chooseSessionDocs(ctx, accountId, workspaceId, pr.ticketIdent).catch(() => null);
    if (viaTicket != null) return viaTicket;
  }
  const { config } = await import('../../config.js');
  const { docsContextFor, loadLibrarySnapshot } = await import('../../reference-docs/context.js');
  const docs = await docsContextFor(accountId, workspaceId);
  if (!docs.hasDocs || !config.aiEnabled) return { ok: false, reason: NO_DOCS_LINE };
  const { readIndex } = await import('../../reference-docs/library.js');
  const { listDocRows } = await import('../../reference-docs/store.js');
  const { libraryHashOf } = await import('../../review/story-docs/fingerprint.js');
  const { wholeLibraryShortlist } = await import('../../review/story-docs/shortlist.js');
  const { storyDocsCandidates } = await import('../../review/story-docs/candidates.js');
  const { shortlistDocsOf } = await import('../../review/story-docs/manager.js');
  void import('../../reference-docs/wiki/refresh.js').then((m) => m.kickWikiRefresh(accountId, workspaceId)).catch(() => {});
  const [lib, index, rows] = await Promise.all([loadLibrarySnapshot(accountId, workspaceId), readIndex(accountId, workspaceId), listDocRows(accountId, workspaceId)]);
  const base = { lib, index, libraryHash: libraryHashOf(rows.filter((r) => r.builtAt != null)) };
  const whole = wholeLibraryShortlist(lib);
  if (whole != null) return { ok: true, ...base, choice: { source: 'whole', sections: whole.map((s) => s.path), about: 'pull request' } };
  const query = fixDocsQuery(pr);
  const found = await storyDocsCandidates({ accountId, workspaceId }, { story: query, criteria: [] }, shortlistDocsOf(lib)).catch(() => []);
  return { ok: true, ...base, choice: { source: 'search', sections: found.map((c) => c.path), about: 'pull request' } };
}

/** The full-text query of a PR with no ticket: its title, description and changed paths. Pure. */
export function fixDocsQuery(pr: Pick<FixDocsSubject, 'title' | 'body' | 'paths'>): { title: string | null; description: string; acceptanceCriteria: string } {
  return {
    title: pr.title.trim() || null,
    description: [pr.body ?? '', pr.paths.slice(0, FIX_DOCS_QUERY_PATHS_MAX).join('\n')].filter((x) => x.trim() !== '').join('\n\n'),
    acceptanceCriteria: '',
  };
}

/** The changed paths of a unified diff (`diff --git a/x b/y` → y), in order, once each. Pure. */
export function diffPaths(diff: string): string[] {
  const out = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/(?:.*) b\/(.*)$/gm)) {
    const p = m[1]?.trim();
    if (p) out.add(p);
  }
  return [...out];
}
