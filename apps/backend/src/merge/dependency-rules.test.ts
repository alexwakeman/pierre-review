import { describe, expect, it } from 'vitest';
import type { ConflictAiChoice, DependencyAutomationPolicy } from '@pierre-review/shared';
import {
  REBASE_WAIT_MS,
  aiResolutionCommit,
  classifyDependencyUpdate,
  conflictStep,
  isTrustedDependencyBot,
  policyVerdict,
  rebaseRequestFor,
  semverLevel,
} from './dependency-rules.js';

const input = (over: Partial<Parameters<typeof classifyDependencyUpdate>[0]> = {}) => ({
  title: '',
  body: null,
  headRefName: null,
  labels: [],
  filePaths: [],
  ...over,
});

describe('semverLevel', () => {
  it('reads patch, minor and major', () => {
    expect(semverLevel('4.17.20', '4.17.21')).toBe('patch');
    expect(semverLevel('1.2.3', '1.3.0')).toBe('minor');
    expect(semverLevel('1.9.9', '2.0.0')).toBe('major');
    expect(semverLevel('v3', 'v4')).toBe('major');
    expect(semverLevel('1.2', '1.2.1')).toBe('patch');
  });
  it('treats a 0.x minor change as major', () => {
    expect(semverLevel('0.3.1', '0.4.0')).toBe('major');
    expect(semverLevel('0.3.1', '0.3.2')).toBe('patch');
  });
  it('refuses what is not a version', () => {
    expect(semverLevel('abc123', 'def456')).toBeNull();
    expect(semverLevel('latest', '1.0.0')).toBeNull();
  });
});

describe('classifyDependencyUpdate', () => {
  it('reads a Dependabot title and its ecosystem from the branch', () => {
    expect(
      classifyDependencyUpdate(
        input({ title: 'Bump lodash from 4.17.20 to 4.17.21', headRefName: 'dependabot/npm_and_yarn/lodash-4.17.21' }),
      ),
    ).toEqual({ level: 'patch', ecosystems: ['javascript'] });
  });
  it('takes the LARGEST change in a grouped PR', () => {
    const body = 'Updates `react` from 18.2.0 to 18.3.1\nUpdates `vite` from 5.4.0 to 6.0.1\n';
    const c = classifyDependencyUpdate(
      input({ title: 'Bump the frontend group with 2 updates', body, headRefName: 'dependabot/npm_and_yarn/frontend-abc' }),
    );
    expect(c.level).toBe('major');
  });
  it('reads Renovate’s table arrows and its title topic', () => {
    const body = '| Package | Change |\n|---|---|\n| [serde](https://x) | `1.0.199` -> `1.0.200` |';
    expect(classifyDependencyUpdate(input({ title: 'Update rust crate serde to v1.0.200', body }))).toEqual({
      level: 'patch',
      ecosystems: ['rust'],
    });
  });
  it('falls back to Renovate’s Update column', () => {
    const body = '| Package | Update | Change |\n| foo | minor | `^1.0` -> `^1.1` |';
    // `^1.0` does not parse as a bare version after the arrow match strips nothing — the column wins.
    expect(classifyDependencyUpdate(input({ title: 'Update dependency foo', body })).level).toBe('minor');
  });
  it('folds ecosystems from the changed files, all of them', () => {
    const c = classifyDependencyUpdate(
      input({ title: 'Update deps', filePaths: ['go.mod', 'go.sum', '.github/workflows/ci.yml', 'README.md'] }),
    );
    expect(c).toEqual({ level: null, ecosystems: ['github_actions', 'go'] });
  });
  it('leaves an unreadable size null — never small', () => {
    expect(classifyDependencyUpdate(input({ title: 'Update dependency foo to v2' })).level).toBeNull();
  });
});

const policy = (over: Partial<DependencyAutomationPolicy> = {}): DependencyAutomationPolicy => ({
  maxLevel: 'major',
  securityOnly: false,
  ecosystems: null,
  ...over,
});

describe('policyVerdict', () => {
  const patchJs = { level: 'patch' as const, ecosystems: ['javascript' as const] };
  it('the default admits everything, an unknown size included', () => {
    expect(policyVerdict(policy(), { level: null, ecosystems: [] }, false)).toEqual({ ok: true });
  });
  it('a size cap refuses larger and unknown sizes', () => {
    expect(policyVerdict(policy({ maxLevel: 'minor' }), patchJs, false)).toEqual({ ok: true });
    expect(policyVerdict(policy({ maxLevel: 'patch' }), { ...patchJs, level: 'minor' }, false)).toEqual({
      ok: false,
      refusal: 'too_big',
    });
    expect(policyVerdict(policy({ maxLevel: 'minor' }), { ...patchJs, level: null }, false)).toEqual({
      ok: false,
      refusal: 'size_unknown',
    });
  });
  it('security-only refuses a version update, first', () => {
    expect(policyVerdict(policy({ securityOnly: true, maxLevel: 'patch' }), { ...patchJs, level: 'major' }, false)).toEqual({
      ok: false,
      refusal: 'not_security',
    });
    expect(policyVerdict(policy({ securityOnly: true }), patchJs, true)).toEqual({ ok: true });
  });
  it('an ecosystem list needs every touched ecosystem listed, and at least one', () => {
    const p = policy({ ecosystems: ['javascript'] });
    expect(policyVerdict(p, patchJs, false)).toEqual({ ok: true });
    expect(policyVerdict(p, { level: 'patch', ecosystems: ['javascript', 'docker'] }, false)).toEqual({
      ok: false,
      refusal: 'ecosystem',
    });
    expect(policyVerdict(p, { level: 'patch', ecosystems: [] }, false)).toEqual({ ok: false, refusal: 'ecosystem' });
  });
});

describe('isTrustedDependencyBot', () => {
  it('needs the stored row: automated, role dependency, and the reader’s mark', () => {
    expect(isTrustedDependencyBot({ automated: true, role: 'dependency', trusted: true })).toBe(true);
    expect(isTrustedDependencyBot({ automated: true, role: 'dependency', trusted: null })).toBe(false);
    expect(isTrustedDependencyBot({ automated: true, role: 'review', trusted: true })).toBe(false);
    expect(isTrustedDependencyBot({ automated: false, role: 'dependency', trusted: true })).toBe(false);
    expect(isTrustedDependencyBot(null)).toBe(false);
  });
});

describe('rebaseRequestFor', () => {
  it('Dependabot gets the comment', () => {
    expect(rebaseRequestFor('dependabot', null)).toEqual({ method: 'comment', body: '@dependabot rebase' });
  });
  it('Renovate gets its checkbox ticked, and only when unticked', () => {
    const body = 'Stuff\n - [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check this box\n';
    const req = rebaseRequestFor('renovate', body);
    expect(req?.method).toBe('tick_checkbox');
    expect(req?.body).toContain('- [x] <!-- rebase-check -->If you want');
    expect(rebaseRequestFor('renovate', req!.body)).toBeNull();
    expect(rebaseRequestFor('renovate', 'no checkbox here')).toBeNull();
  });
  it('another bot cannot be asked', () => {
    expect(rebaseRequestFor('snyk', 'x')).toBeNull();
    expect(rebaseRequestFor(null, 'x')).toBeNull();
  });
});

describe('conflictStep', () => {
  const now = 1_000_000_000;
  it('asks the bot first, once per head', () => {
    expect(conflictStep({ rebase: null, ai: null }, true, now)).toBe('ask_bot');
  });
  it('waits for the rebase, then falls back to AI', () => {
    expect(conflictStep({ rebase: { state: 'done', at: now - 60_000 }, ai: null }, true, now)).toBe('wait');
    expect(conflictStep({ rebase: { state: 'done', at: now - REBASE_WAIT_MS }, ai: null }, true, now)).toBe('ai');
  });
  it('a failed request goes straight to AI; a bot that cannot be asked too', () => {
    expect(conflictStep({ rebase: { state: 'failed', at: now }, ai: null }, true, now)).toBe('ai');
    expect(conflictStep({ rebase: null, ai: null }, false, now)).toBe('ai');
  });
  it('never runs AI twice at one head, whatever the last run did', () => {
    for (const state of ['running', 'done', 'failed'] as const) {
      expect(conflictStep({ rebase: null, ai: { state } }, true, now)).toBe('none');
    }
  });
});

describe('aiResolutionCommit', () => {
  const choice = (fileIndex: number, regionId: number, over: Partial<ConflictAiChoice> = {}): ConflictAiChoice => ({
    fileIndex,
    regionId,
    decision: 'theirs',
    editId: null,
    lines: null,
    rationale: '',
    confidence: 'high',
    ...over,
  });
  const file = {
    index: 0,
    path: 'package.json',
    unsupported: null,
    regions: [
      { id: 0, kind: 'unchanged' as const },
      { id: 1, kind: 'conflict' as const },
      { id: 2, kind: 'theirs_only' as const },
    ],
  };
  it('builds every decidable region’s decision', () => {
    const out = aiResolutionCommit([file], [choice(0, 1), choice(0, 2, { decision: 'edited', editId: 'e1' })]);
    expect(out).toEqual({
      ok: true,
      files: [{ index: 0, decisions: [{ id: 1, decision: 'theirs' }, { id: 2, decision: 'edited', editId: 'e1' }] }],
    });
  });
  it('refuses an undecided region, a low-confidence one, and an unsupported file', () => {
    expect(aiResolutionCommit([file], [choice(0, 1)])).toEqual({ ok: false, refusal: 'undecided' });
    expect(aiResolutionCommit([file], [choice(0, 1), choice(0, 2, { confidence: 'low' })])).toEqual({
      ok: false,
      refusal: 'unsure',
    });
    expect(aiResolutionCommit([{ ...file, unsupported: 'binary' }], [])).toEqual({
      ok: false,
      refusal: 'unsupported_files',
    });
    expect(aiResolutionCommit([], [])).toEqual({ ok: false, refusal: 'nothing' });
  });
});
