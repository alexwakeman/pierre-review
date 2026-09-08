import { afterEach, describe, expect, it, vi } from 'vitest';
import { splitDiffByFile } from '../review/post-review.js';
import { filesToUnifiedDiff, reopenPullRequest } from './mutations.js';

// filesToUnifiedDiff is the fallback that rebuilds a unified diff from GitHub's per-file
// /files endpoint when the whole-PR .diff media type 406s (>20,000 lines). The output must
// stay splittable by the same per-file logic capDiff uses, so a huge PR still yields a
// grounded (non-empty) AI summary instead of "the diff is empty".

describe('filesToUnifiedDiff', () => {
  it('emits a diff --git header + hunks for a file WITH a patch', () => {
    const out = filesToUnifiedDiff([
      {
        filename: 'app/routes.js',
        status: 'modified',
        additions: 2,
        deletions: 0,
        patch: "@@ -1,3 +1,5 @@\n a\n+b\n+c\n d",
      },
    ]);
    expect(out).toContain('diff --git a/app/routes.js b/app/routes.js');
    expect(out).toContain('--- a/app/routes.js');
    expect(out).toContain('+++ b/app/routes.js');
    expect(out).toContain('+b');
  });

  it('NAMES a file whose patch is omitted (binary / too large) with its churn', () => {
    const out = filesToUnifiedDiff([
      {
        filename: 'tools/styles/Habitats.qml',
        status: 'added',
        additions: 8431,
        deletions: 0,
        // no patch — GitHub omits it for a single file that is itself too large
      },
    ]);
    expect(out).toContain('diff --git a/tools/styles/Habitats.qml b/tools/styles/Habitats.qml');
    expect(out).toContain('diff not shown');
    expect(out).toContain('+8431/-0');
  });

  it('uses previous_filename for the a/ side of a rename', () => {
    const out = filesToUnifiedDiff([
      {
        filename: 'app/routes/ukhab.js',
        previous_filename: 'app/routes/old.js',
        status: 'renamed',
        additions: 1,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
    ]);
    expect(out).toContain('diff --git a/app/routes/old.js b/app/routes/ukhab.js');
  });

  it('produces output splittable per-file (capDiff can attribute/omit whole files)', () => {
    const out = filesToUnifiedDiff([
      { filename: 'a.js', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n x\n+y' },
      { filename: 'data/big.json', status: 'added', additions: 90000, deletions: 0 },
      { filename: 'b.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n p\n+q' },
    ]);
    const files = splitDiffByFile(out);
    expect(files.map((f) => f.path)).toEqual(['a.js', 'data/big.json', 'b.ts']);
  });

  it('is empty for no files (a genuinely empty change)', () => {
    expect(filesToUnifiedDiff([])).toBe('');
  });
});

// ── reopenPullRequest ────────────────────────────────────────────────────────────────────────
// The REST PATCH `{ state: 'open' }` behind `POST /api/prs/:id/reopen`. Only the ERROR MAPPING
// earns a test, and one case earns it outright: GitHub refuses to reopen a PR whose head branch
// was deleted — the ORDINARY aftermath of closing one — and the top-level `message` on that
// refusal is the useless "Validation Failed" while the actual sentence is nested in `errors[]`.
// The route prints whichever string arrives here verbatim (4xx bodies stay verbatim in cloud), so
// taking the wrong one puts "Validation Failed" on the user's screen and nothing fails anywhere.
//
// `ghRestPatchStatus` goes straight to global `fetch`, so stubbing that is the whole harness.
function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status,
      ok: status >= 200 && status < 300,
      text: async () => (body == null ? '' : JSON.stringify(body)),
    })),
  );
}

describe('reopenPullRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PATCHes the pull request to state open', async () => {
    stubFetch(200, { number: 7, state: 'open' });
    await expect(reopenPullRequest('tok', 'acme', 'api', 7)).resolves.toEqual({ ok: true });
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('https://api.github.com/repos/acme/api/pulls/7');
    expect(JSON.parse((call[1] as { body: string }).body)).toEqual({ state: 'open' });
  });

  it('⚠ takes GitHub’s NESTED sentence on a 422, not "Validation Failed"', async () => {
    stubFetch(422, {
      message: 'Validation Failed',
      errors: [{ message: 'state cannot be changed. The foo branch was deleted.' }],
    });
    await expect(reopenPullRequest('tok', 'acme', 'api', 7)).resolves.toEqual({
      ok: false,
      // A 409 at the route: nothing is broken and no retry helps.
      reason: 'not_reopenable',
      message: 'state cannot be changed. The foo branch was deleted.',
    });
  });

  it('reports a 403 as not_reopenable too (an archived repo), and a 404 as not_found', async () => {
    stubFetch(403, { message: 'Repository was archived so is read-only.' });
    await expect(reopenPullRequest('tok', 'acme', 'api', 7)).resolves.toMatchObject({
      reason: 'not_reopenable',
      message: 'Repository was archived so is read-only.',
    });
    vi.unstubAllGlobals();
    stubFetch(404, { message: 'Not Found' });
    await expect(reopenPullRequest('tok', 'acme', 'api', 7)).resolves.toMatchObject({
      reason: 'not_found',
    });
  });

  it('anything else is a plain error (the 502 arm)', async () => {
    stubFetch(500, { message: 'Server Error' });
    await expect(reopenPullRequest('tok', 'acme', 'api', 7)).resolves.toMatchObject({
      reason: 'error',
      message: 'Server Error',
    });
  });

  it('falls back to the raw body when GitHub sends no JSON at all', async () => {
    stubFetch(502, null);
    const out = await reopenPullRequest('tok', 'acme', 'api', 7);
    expect(out).toEqual({ ok: false, reason: 'error', message: '' });
  });
});
