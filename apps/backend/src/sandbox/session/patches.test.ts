// The patch extraction's output parser and commit-message fold (pure), and the extraction over the
// FAKE runtime: the argv it runs, the cap, a failure.
import { describe, expect, it } from 'vitest';
import { createFakeRuntime } from '../runtime/fake.js';
import { EXTRACT_SCRIPT, extractRepoPatch, foldCommitMessages, parseExtractOutput, PatchTooLargeError, restoreRepoPatch } from './patches.js';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1,2 @@',
  ' export const a = 1;',
  '+export const b = 2;',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1 @@',
  '+@@LIMN-PATCH@@ patch',
  '',
].join('\n');

const OUT = [
  '@@LIMN-PATCH@@ commits',
  '2',
  '@@LIMN-PATCH@@ numstat',
  '1\t0\tsrc/a.ts',
  '1\t0\tnew.txt',
  '-\t-\tlogo.png',
  '1\t1\t"we\\tird.txt"',
  '@@LIMN-PATCH@@ messages',
  'feat: add b\n\nBody line.\n\x1e',
  'test: cover b\n\x1e',
  '@@LIMN-PATCH@@ patch',
  PATCH,
].join('\n');

describe('parseExtractOutput', () => {
  it('reads the numbers, the files, the messages and the patch (a marker-looking line inside it is the patch’s own)', () => {
    const got = parseExtractOutput(OUT);
    expect(got.patch).toBe(PATCH);
    expect(got.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(got.filesChanged).toEqual(['src/a.ts', 'new.txt', 'logo.png', 'we\tird.txt']);
    expect(got.stat).toEqual({ files: 4, insertions: 3, deletions: 1, commits: 2 });
    expect(got.commitMessage).toBe('feat: add b\n\n- feat: add b\n- test: cover b');
  });

  it('an untouched repository is an empty patch with no sha', () => {
    const got = parseExtractOutput('@@LIMN-PATCH@@ commits\n0\n@@LIMN-PATCH@@ numstat\n@@LIMN-PATCH@@ messages\n@@LIMN-PATCH@@ patch\n');
    expect(got).toMatchObject({ patch: '', sha: null, filesChanged: [], commitMessage: null, stat: { files: 0, commits: 0 } });
  });

  it('refuses output with no patch section', () => {
    expect(() => parseExtractOutput('nothing here')).toThrow(/could not be read/);
  });

  it('folds one message as written, several as a subject list', () => {
    expect(foldCommitMessages('fix: one\n\nwhy\n\x1e')).toBe('fix: one\n\nwhy');
    expect(foldCommitMessages('')).toBeNull();
    expect(foldCommitMessages('a\x1eb\x1e')).toBe('a\n\n- a\n- b');
  });
});

describe('extractRepoPatch / restoreRepoPatch over the fake runtime', () => {
  it('runs the script as the agent in the repository, and refuses a patch past the cap', async () => {
    const fake = createFakeRuntime();
    fake.onExec((argv) => argv[2] === EXTRACT_SCRIPT, { stdout: OUT });
    const got = await extractRepoPatch(fake, 'box', '/work/api', { maxBytes: 1_000_000 });
    expect(got.filesChanged).toHaveLength(4);
    const call = fake.calls.find((c) => c.method === 'exec')!;
    expect(call.args[1]).toEqual(['sh', '-c', EXTRACT_SCRIPT, 'sh', '/work/api']);
    await expect(extractRepoPatch(fake, 'box', '/work/api', { maxBytes: 10 })).rejects.toBeInstanceOf(PatchTooLargeError);
    // The script never touches the agent's own index, and reads against the session's base ref.
    expect(EXTRACT_SCRIPT).toContain('GIT_INDEX_FILE');
    expect(EXTRACT_SCRIPT).toContain('git diff --cached --binary refs/limn/base');
  });

  it('a failed read is one plain line', async () => {
    const fake = createFakeRuntime();
    fake.onExec((argv) => argv[2] === EXTRACT_SCRIPT, { code: 3, stderr: 'no base ref' });
    await expect(extractRepoPatch(fake, 'box', '/work/api', { maxBytes: 100 })).rejects.toThrow(/Reading the changes in \/work\/api failed: no base ref/);
  });

  it('restore copies the patch and its message in, then applies and commits it', async () => {
    const fake = createFakeRuntime();
    fake.onExec((argv) => argv[0] === 'sh' && /git apply --index --binary/.test(argv[2] ?? ''), { code: 0 });
    await restoreRepoPatch(fake, 'box', '/work/api', PATCH, 'feat: add b', 1);
    expect(fake.files('box').get('/tmp/limn-restore-1.patch')?.toString()).toBe(PATCH);
    expect(fake.files('box').get('/tmp/limn-restore-1.msg')?.toString()).toBe('feat: add b');
  });
});
