// THE PR REVIEW WITH THE REFERENCE LIBRARY — end to end through the review manager's pipeline, over
// the REAL core client and migrations, a scratch docs folder, a fake prepare and a fake model
// (docs/REFERENCE-DOCS.md § Use in reviews). Pinned:
//   1. Switch ON + a built document: the run is handed the library folder (a read-only path-guard
//      root), the system prompt gains the library block, and only the references that CHECK OUT are
//      stored — a quote not in its section and a link outside the library are dropped; a finding keeps
//      only its real citations.
//   2. Switch OFF (or nothing built): no folder, the system prompt is byte-identical to the base one,
//      and the run stores NO references (null, not []).
//
//   ./node_modules/.bin/vitest run src/review/claude-review/docs-pipeline.test.ts   (from apps/backend)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeReview } from '@pierre-review/shared';
import type { RunReviewArgs, RunReviewResult } from '../../pro/contract.js';
import type { AgentContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-claude-review-docs-pipeline.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';
delete process.env.LIMN_AI_DISABLED;

const HEAD = 'a'.repeat(40);
const DIFF = ['diff --git a/src/refund.ts b/src/refund.ts', '--- a/src/refund.ts', '+++ b/src/refund.ts', '@@ -0,0 +1,2 @@', '+a', '+b'].join('\n');
const SECTION = 'refund-policy/sections/01-refunds.md';

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let manager: typeof import('./manager.js');
let persist: typeof import('./persist.js');
let store: typeof import('../../reference-docs/store.js');
let prompts: typeof import('./prompts.js');
let docsRoot = '';
let ws = 0;
let prId = 0;
let lastArgs: RunReviewArgs | null = null;

const reply = (): RunReviewResult =>
  ({
    submitted: true,
    scope: 'diff_only',
    summary: 'ok',
    verdict: 'COMMENT',
    findings: [
      {
        path: 'src/refund.ts', line: 1, side: 'RIGHT', severity: 'warning', title: 'No manager approval', body: 'b',
        suggestion: null, diffHunk: null, anchored: true, fileInDiff: true,
        docRefs: [`${SECTION}#partial-refunds`, '../../../etc/passwd', 'refund-policy/sections/99-made-up.md'],
      },
    ],
    docReferences: [
      { link: `${SECTION}#partial-refunds`, quote: 'A partial refund needs a manager approval', verdict: 'contradicts', note: 'No approval step.' },
      { link: SECTION, quote: 'Refunds are paid within thirty days', verdict: 'supports', note: 'Made up.' },
      { link: '/etc/passwd', quote: 'Refunds are paid within fourteen days', verdict: 'context', note: 'Outside.' },
    ],
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 1,
  }) as unknown as RunReviewResult;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  docsRoot = mkdtempSync(join(tmpdir(), 'limn-docs-pipeline-'));
  (await import('../../reference-docs/paths.js')).setDocsRootForTest(docsRoot);
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U1', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  ws = await (await import('../../db/queries.js')).ensureDefaultWorkspace(1);
  ctx = {
    db,
    schema,
    isPg: false,
    runTransaction: client.runTransaction,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    recordAiUsage: async () => {},
    aiCredits: { check: async () => ({ agentBlocked: false }) },
    review: {
      prepareReview: async () => ({
        strippedDiff: DIFF,
        promptDiff: DIFF,
        changedFiles: ['src/refund.ts'],
        excludedFiles: [],
        omittedFiles: [],
        fileMetrics: [{ path: 'src/refund.ts', additions: 2, deletions: 0, isNew: true, apiTouch: false }],
        diffBytes: DIFF.length,
        diffCapped: false,
      }),
      runReview: async (args: RunReviewArgs) => {
        lastArgs = args;
        return reply();
      },
    },
    github: { fetchCompareDiff: async () => ({ ok: false }) },
    queries: {},
  } as any as AgentContext;
  manager = await import('./manager.js');
  persist = await import('./persist.js');
  prompts = await import('./prompts.js');
  store = await import('../../reference-docs/store.js');

  const repo = (await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api' }).returning().execute())[0];
  await db.insert(schema.workspaceRepos).values({ accountId: 1, workspaceId: ws, repoId: repo.id }).execute();
  prId = (
    await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: 'PR_7', accountId: 1, repoId: repo.id, number: 7, title: 'Partial refunds', state: 'open',
        isDraft: false, openedAt: new Date(), updatedAt: new Date(), headSha: HEAD,
      })
      .returning()
      .execute()
  )[0].id;

  // One BUILT document: the row, its section file (as the server renders it) and INDEX.md.
  const { renderSection } = await import('../../reference-docs/render.js');
  const { libraryDir } = await import('../../reference-docs/paths.js');
  const { writeIndex } = await import('../../reference-docs/library.js');
  const doc = await store.insertDocRow({
    accountId: 1, workspaceId: ws, slug: 'refund-policy', title: 'Refund policy', sourceKind: 'markdown',
    sourceName: 'refunds.md', sourceUrl: null, byteSize: 100, pageCount: null,
  });
  await store.saveDocBuilt(
    1,
    doc.id,
    {
      title: 'Refund policy',
      summary: 'How refunds work.',
      topics: ['refunds'],
      sections: [{ path: SECTION, title: 'Refunds', summary: 'Fourteen days; partials need approval.', depth: 1, trail: [], headings: [], words: 30 }],
    },
    {},
  );
  const lib = libraryDir(1, ws);
  mkdirSync(join(lib, 'refund-policy', 'sections'), { recursive: true });
  writeFileSync(join(lib, 'refund-policy', 'CONTENTS.md'), '# Refund policy\n');
  writeFileSync(
    join(lib, SECTION),
    renderSection({
      docTitle: 'Refund policy',
      index: 0,
      total: 1,
      section: {
        title: 'Refunds',
        trail: [],
        body: '## Refunds\n\nRefunds are paid within fourteen days.\n\n### Partial refunds\n\nA partial refund needs a manager approval.',
      },
      prevFile: null,
      nextFile: null,
    }),
  );
  await writeIndex(1, ws);
});

afterAll(async () => {
  closeDb?.();
  rmSync(docsRoot, { recursive: true, force: true });
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

async function runToEnd(): Promise<ClaudeReview> {
  const started = await manager.startReview(ctx, 1, prId, 'claude-opus-5-5');
  if (!started.ok) throw new Error(`not started: ${started.reason}`);
  for (let i = 0; i < 300; i++) {
    const r = await persist.getClaudeReviewById(ctx, started.reviewId, 1);
    if (r && r.status !== 'queued' && r.status !== 'running') {
      await new Promise((res) => setTimeout(res, 20));
      return r;
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('review did not finish');
}

describe('Claude Review and the reference library', () => {
  it('switch OFF: no folder, the base system prompt byte for byte, no references stored', async () => {
    await store.writeDocsInReview(1, ws, false);
    const r = await runToEnd();
    expect(r.status).toBe('succeeded');
    expect(lastArgs?.docsDir).toBeUndefined();
    expect(lastArgs?.systemPrompt).toBe(prompts.REVIEW_SYSTEM_PROMPT_DIFF_ONLY);
    expect(r.docReferences).toBeNull();
    expect(r.findings[0]?.docCitations).toBeUndefined();
  });

  it('switch ON: the folder and the block are handed over, and only references that check out are stored', async () => {
    await store.writeDocsInReview(1, ws, true);
    const r = await runToEnd();
    expect(r.status).toBe('succeeded');
    expect(lastArgs?.docsDir).toBe(join(docsRoot, '1', String(ws), 'library'));
    expect(lastArgs?.systemPrompt.startsWith(`${prompts.REVIEW_SYSTEM_PROMPT_DIFF_ONLY}\n\n# The reference library`)).toBe(true);
    expect(lastArgs?.systemPrompt).toContain(lastArgs!.docsDir!);
    expect(r.docReferences).toEqual([
      {
        path: SECTION,
        anchor: 'partial-refunds',
        docSlug: 'refund-policy',
        docTitle: 'Refund policy',
        sectionTitle: 'Refunds',
        quote: 'A partial refund needs a manager approval',
        verdict: 'contradicts',
        note: 'No approval step.',
        about: null,
      },
    ]);
    expect(r.findings[0]?.docCitations).toEqual([
      { path: SECTION, anchor: 'partial-refunds', docSlug: 'refund-policy', docTitle: 'Refund policy', sectionTitle: 'Refunds' },
    ]);
  });
});
