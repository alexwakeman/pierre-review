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
