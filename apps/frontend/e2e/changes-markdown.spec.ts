import { test, expect, type Page } from '@playwright/test';
import type { PrDetail, PrFileContentResponse, PrFileDiff, PrFilesResponse, ThreadDetail } from '@pierre-review/shared';
import { installMockApi, prDetailFor } from './mock-api.js';

// THE CHANGES TAB RENDERS A MARKDOWN FILE (`FileDiffView`'s `MarkdownFileView`, lib/markdownFile.ts).
// A `.md` / `.mdx` / `.markdown` file shows its NEW side as Markdown by default, with a header
// toggle to the diff ("Plain text") and back; the choice is remembered. Before the whole file is
// read (click-gated, never on mount) the rendered view is the patch's new side and says so when
// that is not the whole file. A deleted Markdown file and a non-Markdown file get no toggle. The
// PR's Markdown is untrusted: no script, relative links print as text.

const PR_ID = 101;

// README.md: one hunk at line 10 of a 14-line file — a partial patch.
const README_HEAD = [
  '# Acme',
  '',
  'Intro line one.',
  'Intro line two.',
  '',
  '## Old section',
  '',
  'Some text.',
  '',
  '## Install',
  '',
  'Run `pnpm install` and read [the guide](https://example.com/guide).',
  'See [setup](./setup.md).',
  '<script>window.__pwned = true</script>',
];
const README_PATCH = [
  '@@ -10,4 +10,5 @@ Some text.',
  ' ## Install',
  ' ',
  '-Run `npm install`.',
  '+Run `pnpm install` and read [the guide](https://example.com/guide).',
  '+See [setup](./setup.md).',
  '+<script>window.__pwned = true</script>',
].join('\n');

const NEW_DOC_PATCH = ['@@ -0,0 +1,3 @@', '+# Brand new', '+', '+- one item'].join('\n');
const GONE_PATCH = ['@@ -1,2 +0,0 @@', '-# Gone', '-bye'].join('\n');
const TS_PATCH = ['@@ -1,1 +1,1 @@', '-export const a = 1;', '+export const a = 2;'].join('\n');

function files(base: PrDetail): PrFileDiff[] {
  const f = (path: string, status: PrFileDiff['status'], patch: string, additions: number, deletions: number): PrFileDiff => ({
    path,
    status,
    additions,
    deletions,
    patch,
    githubUrl: `${base.githubUrl}/files#diff-${path}`,
    blobUrl: `https://github.com/acme/web/blob/deadbeef/${path}`,
  });
  return [
    f('README.md', 'modified', README_PATCH, 3, 1),
    f('docs/new.mdx', 'added', NEW_DOC_PATCH, 3, 0),
    f('docs/gone.md', 'removed', GONE_PATCH, 0, 2),
    f('src/a.ts', 'modified', TS_PATCH, 1, 1),
  ];
}

const THREAD_ID = 4242;

function readmeThread(): ThreadDetail {
  return {
    id: THREAD_ID,
    prId: PR_ID,
    path: 'README.md',
    line: 12,
    isResolved: false,
    isOutdated: false,
    derivedState: 'untouched',
    addressedConfidence: 'low',
    addressedReason: null,
    originalCommenterId: 3,
    createdAt: new Date().toISOString(),
    comments: [{ id: 42420, authorId: 3, body: 'Say which pnpm version.', diffHunk: null, createdAt: new Date().toISOString(), url: null }],
    url: null,
    limnSeverity: null,
  };
}

async function openPr(page: Page, query = '', threads: ThreadDetail[] = []): Promise<{ contentReads: string[] }> {
  const base = prDetailFor(PR_ID);
  const list = files(base);
  const detail: PrDetail = {
    ...base,
    changedFilesCount: list.length,
    files: list.map((x) => ({ path: x.path, additions: x.additions, deletions: x.deletions, githubUrl: x.githubUrl })),
    threads,
  };
  const body: PrFilesResponse = { files: list, truncated: false, nextPage: null, headSha: base.headSha };
  const contentReads: string[] = [];
  await installMockApi(page);
  await page.route(
    (url) => url.pathname === `/api/prs/${PR_ID}`,
    (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) }),
  );
  await page.route(
    (url) => url.pathname === `/api/prs/${PR_ID}/files`,
    (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
  );
  await page.route(
    (url) => url.pathname === `/api/prs/${PR_ID}/files/content`,
    (route) => {
      const path = new URL(route.request().url()).searchParams.get('path') ?? '';
      contentReads.push(path);
      const res: PrFileContentResponse = {
        path,
        side: 'head',
        sha: 'deadbeef',
        lines: path === 'README.md' ? README_HEAD : null,
        refused: path === 'README.md' ? null : 'missing',
      };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
    },
  );
  await page.goto(`/app/?view=pr-detail:${PR_ID}&prTab=changes${query}`);
  return { contentReads };
}

const block = (page: Page, path: string) => page.locator(`[data-file-block="${path}"]`);

test.describe('Changes tab: Markdown files', () => {
  test('render by default, toggle to plain text and back, and remember the choice', async ({ page }) => {
    const { contentReads } = await openPr(page);
    const readme = block(page, 'README.md');
    await expect(readme).toBeVisible();

    // Rendered: real headings and links, the removed line gone, the partial patch disclosed.
    const rendered = readme.getByTestId('markdown-rendered');
    await expect(rendered.getByRole('heading', { name: 'Install' })).toBeVisible();
    await expect(rendered.getByRole('link', { name: 'the guide' })).toHaveAttribute('href', 'https://example.com/guide');
    await expect(rendered.locator('code', { hasText: /^npm install$/ })).toHaveCount(0);
    await expect(rendered.locator('code', { hasText: /^pnpm install$/ })).toBeVisible();
    await expect(rendered.getByText('Only the changed parts are shown.')).toBeVisible();
    await expect(rendered.getByText('9 unchanged lines')).toBeVisible();
    // Untrusted: the relative link is text, the script never ran and is not in the DOM.
    await expect(rendered.getByText('setup', { exact: true })).toBeVisible();
    await expect(rendered.getByRole('link', { name: 'setup' })).toHaveCount(0);
    await expect(rendered.locator('script')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();

    // An added file is the whole file: rendered, no partial note.
    const added = block(page, 'docs/new.mdx').getByTestId('markdown-rendered');
    await expect(added.getByRole('heading', { name: 'Brand new' })).toBeVisible();
    await expect(added.getByText('Only the changed parts are shown.')).toHaveCount(0);

    // Only the two Markdown files with a new side get the toggle.
    await expect(page.getByTestId('markdown-view-toggle')).toHaveCount(2);
    await expect(block(page, 'docs/gone.md').getByTestId('markdown-view-toggle')).toHaveCount(0);
    await expect(block(page, 'src/a.ts').getByTestId('markdown-view-toggle')).toHaveCount(0);

    // Nothing fetched the whole file on mount.
    expect(contentReads).toEqual([]);

    // Plain text: the diff, for every Markdown file at once.
    await readme.getByRole('button', { name: 'Show as plain text' }).click();
    await expect(readme.getByTestId('markdown-rendered')).toHaveCount(0);
    await expect(readme.locator('table')).toContainText('Run `pnpm install`');
    await expect(readme.locator('table')).toContainText('Run `npm install`.');
    await expect(block(page, 'docs/new.mdx').getByTestId('markdown-rendered')).toHaveCount(0);

    // Remembered across a reload.
    await page.reload();
    await expect(block(page, 'README.md').locator('table')).toContainText('Run `pnpm install`');
    await expect(page.getByTestId('markdown-rendered')).toHaveCount(0);

    // And back.
    await block(page, 'README.md').getByRole('button', { name: 'Show rendered' }).click();
    await expect(block(page, 'README.md').getByTestId('markdown-rendered')).toBeVisible();
  });

  test('"Show whole file" reads the file once and renders all of it', async ({ page }) => {
    const { contentReads } = await openPr(page);
    const rendered = block(page, 'README.md').getByTestId('markdown-rendered');
    await expect(rendered.getByRole('heading', { name: 'Old section' })).toHaveCount(0);
    await rendered.getByRole('button', { name: 'Show whole file' }).click();
    await expect(rendered.getByRole('heading', { name: 'Acme', level: 1 })).toBeVisible();
    await expect(rendered.getByRole('heading', { name: 'Old section' })).toBeVisible();
    await expect(rendered.getByText('Only the changed parts are shown.')).toHaveCount(0);
    await expect(rendered.locator('script')).toHaveCount(0);
    expect(contentReads).toEqual(['README.md']);
  });

  test('a thread deep link into a Markdown file lands on the diff, and the toggle still works', async ({ page }) => {
    await openPr(page, `&pr=${PR_ID}&thread=${THREAD_ID}`, [readmeThread()]);
    const readme = block(page, 'README.md');
    await expect(page.locator(`[data-thread-id="${THREAD_ID}"]`)).toBeVisible();
    await expect(readme.getByTestId('markdown-rendered')).toHaveCount(0);
    // The reveal does not change the preference: the other Markdown file still renders.
    await expect(block(page, 'docs/new.mdx').getByTestId('markdown-rendered')).toBeVisible();
    await readme.getByRole('button', { name: 'Show rendered' }).click();
    const rendered = readme.getByTestId('markdown-rendered');
    await expect(rendered).toBeVisible();
    await expect(rendered.getByText('Its review thread is in Plain text.')).toBeVisible();
  });
});
