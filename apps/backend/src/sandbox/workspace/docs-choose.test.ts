// AN AI FIX'S DOCS — THE PR-SHAPED CHOOSER (docs-choose.ts `chooseFixDocs`; docs/SANDBOX.md § AI Fix sessions →
// What the agent finds): the PR's ticket's own choice when it has one, else the whole small library, else the
// full-text hits on the PR's title, description and changed paths. DB and disk only (every edge faked here).
import { beforeEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
const S = vi.hoisted(() => ({
  hasDocs: true,
  aiEnabled: true,
  whole: null as Array<{ path: string }> | null,
  found: [] as Array<{ path: string }>,
  queries: [] as any[],
  ticketInputs: null as any,
}));

vi.mock('../../config.js', () => ({ config: { get aiEnabled() { return S.aiEnabled; } } }));
vi.mock('../../reference-docs/context.js', () => ({
  docsContextFor: async () => ({ hasDocs: S.hasDocs }),
  loadLibrarySnapshot: async () => ({ workspaceId: 1, dir: '/lib', docs: [], read: () => null }),
}));
vi.mock('../../reference-docs/library.js', () => ({ readIndex: async () => '# Index' }));
vi.mock('../../reference-docs/store.js', () => ({ listDocRows: async () => [{ slug: 'a', builtAt: new Date(1000), sectionCount: 2 }] }));
vi.mock('../../reference-docs/wiki/refresh.js', () => ({ kickWikiRefresh: () => {} }));
vi.mock('../../review/story-docs/shortlist.js', () => ({ wholeLibraryShortlist: () => S.whole }));
vi.mock('../../review/story-docs/candidates.js', () => ({
  storyDocsCandidates: async (_scope: unknown, q: unknown) => {
    S.queries.push(q);
    return S.found;
  },
}));
vi.mock('../../review/story-docs/manager.js', () => ({
  shortlistDocsOf: () => [],
  liveStoryDocs: async () => ({ inputs: S.ticketInputs, docCount: 1, libraryHash: 'lh' }),
  currentStoryDocsFingerprint: () => 'fp',
}));
vi.mock('../../review/story-docs/persist.js', () => ({ latestSucceededStoryDocsRun: async () => null }));

const { chooseFixDocs, diffPaths, fixDocsQuery, NO_DOCS_LINE } = await import('./docs-choose.js');
const ctx = {} as any;

beforeEach(() => {
  S.hasDocs = true;
  S.aiEnabled = true;
  S.whole = null;
  S.found = [];
  S.queries = [];
  S.ticketInputs = null;
});

describe('chooseFixDocs', () => {
  const pr = { ticketIdent: null, title: 'Fix the CSV export', body: 'Commas, not tabs.', paths: ['src/export.ts', 'docs/csv.md'] };

  it('no built library (or agentic features off): no documents, one line', async () => {
    S.hasDocs = false;
    expect(await chooseFixDocs(ctx, 1, 1, pr)).toEqual({ ok: false, reason: NO_DOCS_LINE });
    S.hasDocs = true;
    S.aiEnabled = false;
    expect(await chooseFixDocs(ctx, 1, 1, pr)).toEqual({ ok: false, reason: NO_DOCS_LINE });
  });

  it('a small library goes in whole, chosen for the pull request', async () => {
    S.whole = [{ path: 'a/sections/01-x.md' }, { path: 'a/sections/02-y.md' }];
    const r = await chooseFixDocs(ctx, 1, 1, pr);
    expect(r.ok && r.choice).toEqual({ source: 'whole', sections: ['a/sections/01-x.md', 'a/sections/02-y.md'], about: 'pull request' });
    expect(S.queries).toEqual([]);
  });

  it('else the full-text hits on the title, description and changed paths (no model call)', async () => {
    S.found = [{ path: 'a/sections/03-csv.md' }];
    const r = await chooseFixDocs(ctx, 1, 1, pr);
    expect(r.ok && r.choice).toEqual({ source: 'search', sections: ['a/sections/03-csv.md'], about: 'pull request' });
    expect(S.queries).toEqual([{ story: { title: 'Fix the CSV export', description: 'Commas, not tabs.\n\nsrc/export.ts\ndocs/csv.md', acceptanceCriteria: '' }, criteria: [] }]);
    expect(r.ok && r.libraryHash).toMatch(/^[0-9a-f]+$/);
  });

  it('a PR with a ticket: the ticket chooser (here: its story words, searched)', async () => {
    S.ticketInputs = { story: { title: 'ACME-9', description: 'Export reports.', acceptanceCriteria: '' }, criteria: [] };
    S.found = [{ path: 'a/sections/04-reports.md' }];
    const r = await chooseFixDocs(ctx, 1, 1, { ...pr, ticketIdent: 'jira:x#ACME-9' });
    expect(r.ok && r.choice).toEqual({ source: 'search', sections: ['a/sections/04-reports.md'] });
    expect(S.queries.at(-1)).toEqual({ story: { title: 'ACME-9', description: 'Export reports.', acceptanceCriteria: '' }, criteria: [] });
  });
});

describe('the query helpers (pure)', () => {
  it('diffPaths: the new path of each file, once, in order', () => {
    expect(diffPaths('diff --git a/x.ts b/x.ts\n+1\ndiff --git a/old.ts b/new.ts\n+2\ndiff --git a/x.ts b/x.ts\n')).toEqual(['x.ts', 'new.ts']);
    expect(diffPaths('')).toEqual([]);
  });
  it('fixDocsQuery: no title ⇒ null; an empty body is left out; at most 200 paths', () => {
    const q = fixDocsQuery({ title: '  ', body: null, paths: Array.from({ length: 250 }, (_, i) => `f${i}`) });
    expect(q.title).toBeNull();
    expect(q.description.split('\n')).toHaveLength(200);
  });
});
