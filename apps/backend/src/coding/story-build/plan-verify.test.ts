// THE HOST'S PLAN CHECK (plan-verify.ts) over fake seams: every evidence kind, drops, corrections,
// storySays, fingerprints and the decision carry-forward (plan-persist.ts `carryDecisions`).
import { describe, expect, it } from 'vitest';
import type { LibrarySnapshot } from '../../reference-docs/review-refs.js';
import type { ServiceRunRecord } from '../../sandbox/services/run-log.js';
import { CTX, goodPlan } from '../../sandbox/workspace/plan.test-support.js';
import { carryDecisions } from './plan-persist.js';
import { cleanRepoPath, contentionFingerprint, dataLabelFor, verifyBuildPlan, type PlanVerifyInput } from './plan-verify.js';

const API = { repoId: 11, fullName: 'acme/api', baseSha: 'a'.repeat(40) };
const WEB = { repoId: 12, fullName: 'acme/web', baseSha: 'b'.repeat(40) };
const FILES: Record<string, string> = {
  'acme/api:src/export.ts': ['import { db } from "./db";', '', 'export const MAX_ROWS = 1000;', '', 'export function rows() {', '  return db.take(MAX_ROWS);', '}'].join('\n'),
  'acme/api:db/migrations/001.sql': 'CREATE TABLE rows (id int, refund_days int DEFAULT 14);\n',
  'acme/api:bin.dat': 'a\0b',
};

const SECTION = '<!-- limn:section -->\n# Refunds\n\nRefunds are allowed for 14 days after the order.\n';
const lib: LibrarySnapshot = {
  workspaceId: 3,
  dir: '/lib',
  docs: [{ slug: 'billing', title: 'Billing handbook', sections: [{ path: 'billing/sections/01-refunds.md', title: 'Refunds', summary: '', trail: [], headings: [] } as never] }],
  read: (p) => (p === 'billing/sections/01-refunds.md' ? SECTION : null),
};

const run = (over: Partial<ServiceRunRecord> = {}): ServiceRunRecord => ({
  id: 'svc-1',
  stack: 'api',
  service: 'postgres',
  command: ['psql', '-c', 'select refund_days from rows'],
  startedAt: '2026-11-07T10:00:00.000Z',
  exitCode: 0,
  output: ' refund_days\n-------------\n          14\n(1 row)\n',
  truncated: false,
  egress: false,
  ...over,
});

function input(plan: unknown, over: Partial<PlanVerifyInput> = {}, runs: ServiceRunRecord[] = [run()]): PlanVerifyInput {
  return {
    body: JSON.stringify(plan),
    check: { ...CTX, docs: true },
    repos: [API, WEB],
    ticketText: '# ACME-300\n\n## Acceptance criteria\n\n1. Stream every row\n2. A Download CSV button\n',
    criteriaText: new Map([
      ['AC1', 'Stream every row'],
      ['AC2', 'A Download CSV button'],
    ]),
    branch: 'limn/acme-300',
    seams: {
      readBlob: async (repo, path) => (FILES[`${repo.fullName}:${path}`] != null ? Buffer.from(FILES[`${repo.fullName}:${path}`]!) : null),
      library: lib,
      run: (id) => runs.find((r) => r.id === id) ?? null,
    },
    ...over,
  };
}

const withEvidence = (...evidence: unknown[]): unknown => {
  const p = goodPlan();
  p.contentions[0].evidence = evidence;
  return p;
};

describe('verifyBuildPlan', () => {
  it('a good plan: host excerpt, repo ids, criteria texts, host branches', async () => {
    const r = await verifyBuildPlan(input(goodPlan()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.plan.contentions[0]!;
    expect(c.storySays).toBe('Stream every row');
    expect(c.evidence[0]).toEqual({
      kind: 'code',
      repoId: 11,
      fullName: 'acme/api',
      path: 'src/export.ts',
      startLine: 3,
      endLine: 4,
      baseSha: API.baseSha,
      excerpt: 'export const MAX_ROWS = 1000;\n',
      linesCorrected: false,
    });
    expect(r.plan.repos.map((x) => x.repoId)).toEqual([11, 12]);
    expect(r.plan.criteria.map((x) => [x.ref, x.text])).toEqual([
      ['AC1', 'Stream every row'],
      ['AC2', 'A Download CSV button'],
    ]);
    expect(r.plan.stack.map((p) => [p.key, p.repoId, p.stackIndex, p.branch])).toEqual([
      ['P1', 11, 1, 'limn/acme-300'],
      ['P2', 12, 1, 'limn/acme-300'],
    ]);
    expect(r.plan.dropped).toEqual({ contentions: 0, evidence: 0, reasons: [] });
    expect(r.rawSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a 2-PR stack in one repository gets -2 on its second branch', async () => {
    const p = goodPlan();
    p.stack.splice(1, 0, { id: 'P3', repo: 'acme/api', title: 'Second', contains: 'x', criteria: ['AC1'], dependsOn: ['P1'] });
    p.stackReason = 'The migration is reviewed apart.';
    const r = await verifyBuildPlan(input(p));
    expect(r.ok && r.plan.stack.map((x) => [x.key, x.stackIndex, x.branch])).toEqual([
      ['P1', 1, 'limn/acme-300'],
      ['P3', 2, 'limn/acme-300-2'],
      ['P2', 1, 'limn/acme-300'],
    ]);
  });

  it('code: corrects lines when the quote is unique elsewhere; drops a quote not there, a binary file, a missing file', async () => {
    const moved = await verifyBuildPlan(input(withEvidence({ kind: 'code', repo: 'acme/api', path: 'src/export.ts', lines: [40, 41], quote: 'return db.take(MAX_ROWS);' })));
    expect(moved.ok && moved.plan.contentions[0]!.evidence[0]).toMatchObject({ startLine: 6, endLine: 6, linesCorrected: true, excerpt: '  return db.take(MAX_ROWS);' });
    for (const e of [
      { kind: 'code', repo: 'acme/api', path: 'src/export.ts', lines: [3, 3], quote: 'export const MAX_ROWS = 5000;' },
      { kind: 'code', repo: 'acme/api', path: 'bin.dat', lines: [1, 1], quote: 'some binary data here' },
      { kind: 'code', repo: 'acme/api', path: 'src/none.ts', lines: [1, 1], quote: 'export const MAX_ROWS = 1000;' },
    ]) {
      const r = await verifyBuildPlan(input(withEvidence(e)));
      expect(r.ok && r.plan.contentions).toEqual([]);
      expect(r.ok && r.plan.dropped.contentions).toBe(1);
      expect(r.ok && r.plan.dropped.evidence).toBe(1);
    }
  });

  it('data_file: the label is kept on a data path and re-labelled elsewhere', async () => {
    const r = await verifyBuildPlan(input(withEvidence({ kind: 'data_file', what: 'migration', repo: 'acme/api', path: 'db/migrations/001.sql', lines: [1, 1], quote: 'refund_days int DEFAULT 14' })));
    expect(r.ok && r.plan.contentions[0]!.evidence[0]).toMatchObject({ kind: 'data_file', what: 'migration', path: 'db/migrations/001.sql' });
    expect(dataLabelFor('src/export.ts', 'fixture')).toBe('other');
    expect(dataLabelFor('test/fixtures/a.json', 'fixture')).toBe('fixture');
    expect(dataLabelFor('prisma/schema.prisma', 'schema')).toBe('schema');
  });

  it('data_run: from Limn\'s log only, never an egress service, the quote in the recorded output', async () => {
    const ok = await verifyBuildPlan(input(withEvidence({ kind: 'data_run', run: 'svc-1', quote: 'refund_days ------------- 14' })));
    expect(ok.ok && ok.plan.contentions[0]!.evidence[0]).toMatchObject({ kind: 'data_run', run: 'svc-1', service: 'postgres', stack: 'api', exitCode: 0 });
    expect(ok.ok && (ok.plan.contentions[0]!.evidence[0] as { excerpt: string }).excerpt).toContain('14');
    const egress = await verifyBuildPlan(input(withEvidence({ kind: 'data_run', run: 'svc-1', quote: 'refund_days ------------- 14' }), {}, [run({ egress: true })]));
    expect(egress.ok && egress.plan.dropped.reasons).toEqual(['cited a service that can reach the internet']);
    const wrong = await verifyBuildPlan(input(withEvidence({ kind: 'data_run', run: 'svc-1', quote: 'refund_days 30 days' })));
    expect(wrong.ok && wrong.plan.contentions).toEqual([]);
    // An id the agent made up is dropped by the validator (not in ctx.runs).
    const unknown = await verifyBuildPlan(input(withEvidence({ kind: 'data_run', run: 'svc-7', quote: 'refund_days ------------- 14' })));
    expect(unknown.ok && unknown.plan.dropped).toMatchObject({ contentions: 1, evidence: 1 });
  });

  it('docs: one candidate, the quote in that section; a document-relative link resolves', async () => {
    const r = await verifyBuildPlan(input(withEvidence({ kind: 'docs', link: 'sections/01-refunds.md', quote: 'Refunds are allowed for 14 days after the order.' })));
    expect(r.ok && r.plan.contentions[0]!.evidence[0]).toMatchObject({ kind: 'docs', path: 'billing/sections/01-refunds.md', docTitle: 'Billing handbook', verdict: 'contradicts' });
    const bad = await verifyBuildPlan(input(withEvidence({ kind: 'docs', link: 'billing/sections/01-refunds.md', quote: 'Refunds are allowed for 30 days after the order.' })));
    expect(bad.ok && bad.plan.contentions).toEqual([]);
    const noLib = await verifyBuildPlan(input(withEvidence({ kind: 'docs', link: 'billing/sections/01-refunds.md', quote: 'Refunds are allowed for 14 days after the order.' }), { seams: { ...input({}).seams, library: null } }));
    expect(noLib.ok && noLib.plan.contentions).toEqual([]);
  });

  it('keeps a contention with one good item of two; clears storySays not in the ticket', async () => {
    const p = withEvidence(
      { kind: 'code', repo: 'acme/api', path: 'src/export.ts', lines: [3, 3], quote: 'export const MAX_ROWS = 1000;' },
      { kind: 'code', repo: 'acme/api', path: 'src/export.ts', lines: [3, 3], quote: 'something that is not there' },
    ) as ReturnType<typeof goodPlan>;
    p.contentions[0].storySays = 'Export at most 10 rows';
    const r = await verifyBuildPlan(input(p));
    expect(r.ok && r.plan.contentions[0]!.evidence).toHaveLength(1);
    expect(r.ok && r.plan.contentions[0]!.storySays).toBeNull();
    expect(r.ok && r.plan.dropped.evidence).toBe(1);
  });

  it('shape problems and bad JSON make no revision', async () => {
    expect(await verifyBuildPlan({ ...input(goodPlan()), body: '{oops' })).toMatchObject({ ok: false });
    const r = await verifyBuildPlan(input(goodPlan({ repos: [] })));
    expect(r.ok).toBe(false);
  });

  it('fingerprints: stable for the same point, different when the evidence changes; decisions carry by id + fingerprint', async () => {
    const a = await verifyBuildPlan(input(goodPlan()));
    const b = await verifyBuildPlan(input(goodPlan({ summary: 'Reworded summary of the approach.' })));
    const fa = a.ok ? a.plan.contentions[0]!.fingerprint : '';
    expect(b.ok && b.plan.contentions[0]!.fingerprint).toBe(fa);
    const c = await verifyBuildPlan(input(withEvidence({ kind: 'code', repo: 'acme/api', path: 'src/export.ts', lines: [6, 6], quote: 'return db.take(MAX_ROWS);' })));
    const fc = c.ok ? c.plan.contentions[0]!.fingerprint : '';
    expect(fc).not.toBe(fa);
    const prev = { C1: { decision: 'agree' as const, fingerprint: fa, at: 'x' }, C2: { decision: 'keep_story' as const, fingerprint: 'f2', at: 'y' } };
    expect(carryDecisions(prev, { contentions: [{ id: 'C1', fingerprint: fa }, { id: 'C2', fingerprint: 'changed' }] as never })).toEqual({ C1: prev.C1 });
    expect(contentionFingerprint('The  Problem', [])).toBe(contentionFingerprint('the problem', []));
  });

  it('cleanRepoPath refuses absolute paths, .. and .git', () => {
    expect(cleanRepoPath('./src/a.ts')).toBe('src/a.ts');
    expect(cleanRepoPath('/etc/passwd')).toBeNull();
    expect(cleanRepoPath('a/../../b')).toBeNull();
    expect(cleanRepoPath('.git/config')).toBeNull();
    expect(cleanRepoPath('sub/.GIT/x')).toBeNull();
  });
});
