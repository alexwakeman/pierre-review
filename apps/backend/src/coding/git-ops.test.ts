// commitFilesAndOpenPr guard branches — validation happens BEFORE any token/network/git
// side effect, so these run with no mocks. The happy path (worktree → push → PR → sync
// tail) is exercised against a scratch GitHub repo manually (see the PR description);
// only the refusals are unit-testable hermetically.
//
// DATABASE_URL is set BEFORE importing anything that touches db/client (module-load open).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-git-ops-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let commitFilesAndOpenPr: any;
let closeDb: (() => void) | undefined;

const argsWith = (over: Record<string, unknown>) => ({
  accountId: 1,
  owner: 'acme',
  name: 'api',
  files: [{ path: 'docs/x.md', content: 'x' }],
  branch: 'limn/advisor/test-20260809',
  title: 't',
  body: 'b',
  ...over,
});

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  ({ commitFilesAndOpenPr } = await import('./git-ops.js'));
  ({ closeDb } = await import('../db/client.js'));
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('commitFilesAndOpenPr refusals (pre-side-effect)', () => {
  it('refuses an empty file list', async () => {
    expect(await codeOf(commitFilesAndOpenPr(argsWith({ files: [] })))).toBe('APPLY_FAILED');
  });

  it('refuses workflow files outright (no `workflow` OAuth scope)', async () => {
    expect(
      await codeOf(
        commitFilesAndOpenPr(
          argsWith({ files: [{ path: '.github/workflows/ci.yml', content: '' }] }),
        ),
      ),
    ).toBe('PUSH_DENIED');
    expect(
      await codeOf(
        commitFilesAndOpenPr(argsWith({ files: [{ path: '.github/workflows', content: '' }] })),
      ),
    ).toBe('PUSH_DENIED');
  });

  it('refuses traversal, absolute, and .git-internal paths', async () => {
    for (const path of ['../evil.txt', '/etc/passwd', 'a/../../b', '.git/config', 'a//b', 'C:whatever']) {
      expect(
        await codeOf(commitFilesAndOpenPr(argsWith({ files: [{ path, content: '' }] }))),
        path,
      ).toBe('APPLY_FAILED');
    }
  });

  it('refuses malformed branch names', async () => {
    for (const branch of ['', '-lead', 'evil..branch', 'sp ace']) {
      expect(await codeOf(commitFilesAndOpenPr(argsWith({ branch }))), branch).toBe(
        'APPLY_FAILED',
      );
    }
  });
});
