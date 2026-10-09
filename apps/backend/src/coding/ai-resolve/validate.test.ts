// "Resolve with Claude": the gate between the agent's `submit_resolution` payload and the resolver.
//
// Every failure here is silent on screen — a choice for a region the agent was never shown, a
// choice pinned to bytes that have since moved, or an `'edited'` region carrying a conflict marker
// would all render as "Claude decided this" and land on the next commit.
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = '/tmp/pierre-ai-resolve-validate-test.sqlite';
process.env.DEPLOYMENT_MODE = 'local';
process.env.DISABLE_SCHEDULER = 'true';

import type { ConflictAiChoice } from '@pierre-review/shared';
import { claimSession, settleReady, __testing, type ConflictSessionRecord } from '../../conflict/session.js';
import type { ConflictModel, ConflictModelFile } from '../../conflict/model-types.js';
import { acceptAiChoices, choiceKey, type AiChoiceInput } from './validate.js';
import { buildAiResolvePrompt } from './prompt.js';

function file(): ConflictModelFile {
  return {
    index: 0,
    path: 'src/a.ts',
    relatedPaths: [],
    unsupported: null,
    unsupportedLabel: null,
    regions: [
      { id: 0, kind: 'unchanged', base: ['import x;'], ours: [], theirs: [], fingerprint: 'fp0', wand: null, mergedLines: null },
      { id: 1, kind: 'conflict', base: ['a'], ours: ['b'], theirs: ['c'], fingerprint: 'fp1', wand: null, mergedLines: null },
      { id: 2, kind: 'ours_only', base: ['d'], ours: ['e'], theirs: ['d'], fingerprint: 'fp2', wand: { decision: 'ours', reason: 'only_ours' }, mergedLines: null },
    ],
    terminators: { base: true, ours: true, theirs: true },
    maxSideBytes: 8,
    stage2Mode: '100644',
  };
}

function model(files: ConflictModelFile[] = [file()]): ConflictModel {
  return {
    accountId: 1,
    prId: 9,
    owner: 'acme',
    name: 'web',
    number: 7,
    headSha: 'head1234',
    baseSha: 'base1234',
    headRef: 'feature/x',
    baseRef: 'main',
    mergeBaseSha: 'mb',
    mergeBaseIsVirtual: false,
    mergedTreeSha: 'tree',
    files,
    totalConflictedPaths: files.length,
    truncated: false,
    renameDetection: 'on',
    commitsAboveBase: 1,
    strategies: ['merge'],
    rebaseUnavailableReason: null,
    reservedBranchNames: ['main'],
    prBranchPushable: true,
    prBranchUnavailableReason: null,
  };
}

function readySession(m: ConflictModel = model()): ConflictSessionRecord {
  const claim = claimSession(1, 9, { restart: false, autoApply: false });
  if (claim.kind !== 'created') throw new Error('expected a fresh session');
  settleReady(claim.session, m, 'hash', false);
  return claim.session;
}

const ALL = new Set([choiceKey(0, 1), choiceKey(0, 2)]);
const choice = (over: Partial<AiChoiceInput> = {}): AiChoiceInput => ({
  file: 0,
  region: 1,
  fingerprint: 'fp1',
  decision: 'ours',
  rationale: 'Kept the PR’s version.',
  confidence: 'high',
  ...over,
});

beforeEach(() => __testing.reset());

describe('acceptAiChoices', () => {
  it('accepts an allowed enum choice and clips the rationale to one line', () => {
    const rec = readySession();
    const accepted = new Map<string, ConflictAiChoice>();
    const rejected = acceptAiChoices(rec, [choice({ rationale: '  two\nlines  ' })], ALL, accepted);
    expect(rejected).toEqual([]);
    expect(accepted.get('0:1')).toMatchObject({ decision: 'ours', editId: null, rationale: 'two lines', confidence: 'high' });
  });

  it('refuses an unknown file or region, and unchanged context', () => {
    const rec = readySession();
    const accepted = new Map<string, ConflictAiChoice>();
    const rejected = acceptAiChoices(
      rec,
      [choice({ file: 3 }), choice({ region: 99 }), choice({ region: 0, fingerprint: 'fp0', decision: 'base' })],
      ALL,
      accepted,
    );
    expect(rejected.map((r) => r.refusal)).toEqual(['unknown_region', 'unknown_region', 'not_decidable']);
    expect(accepted.size).toBe(0);
  });

  it('refuses a stale fingerprint — the content pin beside the id', () => {
    const rec = readySession();
    const accepted = new Map<string, ConflictAiChoice>();
    const rejected = acceptAiChoices(rec, [choice({ fingerprint: 'fp-old' })], ALL, accepted);
    expect(rejected).toEqual([{ file: 0, region: 1, refusal: 'moved' }]);
    expect(accepted.size).toBe(0);
  });

  it('refuses a region the run was not shown', () => {
    const rec = readySession();
    const accepted = new Map<string, ConflictAiChoice>();
    const rejected = acceptAiChoices(rec, [choice()], new Set([choiceKey(0, 2)]), accepted);
    expect(rejected[0]?.refusal).toBe('not_offered');
  });

  it('refuses a decision the region does not allow, and never takes `suggestion`', () => {
    const rec = readySession();
    const accepted = new Map<string, ConflictAiChoice>();
    const rejected = acceptAiChoices(
      rec,
      [
        choice({ region: 2, fingerprint: 'fp2', decision: 'theirs' }),
        choice({ decision: 'disjoint_merge' }),
        choice({ decision: 'suggestion' }),
        choice({ decision: 'custom' }),
      ],
      ALL,
      accepted,
    );
    expect(rejected.map((r) => r.refusal)).toEqual(['not_allowed', 'not_allowed', 'not_allowed', 'not_allowed']);
  });

  it('mints an edit handle for valid edited lines, through the edit route’s validator', () => {
    const rec = readySession();
    const accepted = new Map<string, ConflictAiChoice>();
    const rejected = acceptAiChoices(rec, [choice({ decision: 'edited', lines: ['b', 'c'] })], ALL, accepted);
    expect(rejected).toEqual([]);
    const got = accepted.get('0:1');
    expect(got?.decision).toBe('edited');
    expect(got?.lines).toEqual(['b', 'c']);
    expect(got?.editId).toBeTruthy();
    // The SAME store the reader's own edits use, so the commit path redeems it like any edit.
    expect(rec.edits.get(got!.editId!)).toMatchObject({ fileIndex: 0, regionId: 1, lines: ['b', 'c'] });
  });

  it('⚠ one blank line stays ONE blank line; an empty array is zero lines', () => {
    const rec = readySession();
    const accepted = new Map<string, ConflictAiChoice>();
    expect(acceptAiChoices(rec, [choice({ decision: 'edited', lines: [''] })], ALL, accepted)).toEqual([]);
    expect(accepted.get('0:1')?.lines).toEqual(['']);
    expect(acceptAiChoices(rec, [choice({ decision: 'edited', lines: [] })], ALL, accepted)).toEqual([]);
    expect(accepted.get('0:1')?.lines).toEqual([]);
  });

  it('refuses invalid edited lines and mints nothing', () => {
    const rec = readySession();
    const accepted = new Map<string, ConflictAiChoice>();
    const rejected = acceptAiChoices(
      rec,
      [
        choice({ decision: 'edited', lines: ['<<<<<<< HEAD', 'b', '=======', 'c', '>>>>>>> main'] }),
        choice({ decision: 'edited', lines: ['nul\u0000here'] }),
        choice({ decision: 'edited', lines: ['x'.repeat(100_000)] }),
        choice({ decision: 'edited' }),
      ],
      ALL,
      accepted,
    );
    expect(rejected.map((r) => r.refusal)).toEqual(['markers', 'not_text', 'too_long', 'no_lines']);
    expect(accepted.size).toBe(0);
    expect(rec.edits.size).toBe(0);
  });

  it('lets a later choice for the same region replace an earlier one', () => {
    const rec = readySession();
    const accepted = new Map<string, ConflictAiChoice>();
    acceptAiChoices(rec, [choice()], ALL, accepted);
    acceptAiChoices(rec, [choice({ decision: 'theirs' })], ALL, accepted);
    expect(accepted.size).toBe(1);
    expect(accepted.get('0:1')?.decision).toBe('theirs');
  });
});

describe('buildAiResolvePrompt', () => {
  it('offers every decidable region of a supported file and fences the text with a nonce', () => {
    const built = buildAiResolvePrompt(model(), 'abc123');
    expect([...built.offered].sort()).toEqual(['0:1', '0:2']);
    expect(built.decidableTotal).toBe(2);
    expect(built.prompt).toContain('---BEGIN OURS (the pull request branch) abc123---');
    expect(built.prompt).toContain('fingerprint=fp1');
    // The unchanged region is CONTEXT, never a region to decide.
    expect(built.prompt).not.toContain('region=0 ');
  });

  it('offers nothing in an unsupported file', () => {
    const f = { ...file(), unsupported: 'binary' as const, unsupportedLabel: 'a binary file' };
    const built = buildAiResolvePrompt(model([f]), 'abc123');
    expect(built.offered.size).toBe(0);
    expect(built.decidableTotal).toBe(0);
  });
});
