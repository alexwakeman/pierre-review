// WITHDRAW APPROVAL's GitHub half: the viewer's LATEST decisive review (a COMMENTED one never
// decides; another person's never counts; pages are followed) and GitHub's own refusal words.
import { describe, expect, it, vi } from 'vitest';

const pages: unknown[][] = [];
vi.mock('./client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghRestGetFor: vi.fn(async (_t: string, path: string) => pages[Number(/[?&]page=(\d+)/.exec(path)![1]) - 1] ?? []),
}));
const { fetchViewerLatestDecisiveReview, githubErrorMessage } = await import('./mutations.js');

const review = (id: number, login: string, state: string) => ({
  id,
  node_id: `PRR_${id}`,
  state,
  body: '',
  submitted_at: '2026-10-01T00:00:00Z',
  html_url: '',
  user: { login },
});

describe('fetchViewerLatestDecisiveReview', () => {
  it('takes the viewer\'s latest APPROVED / CHANGES_REQUESTED / DISMISSED review, across pages', async () => {
    pages.length = 0;
    pages.push([
      ...Array.from({ length: 98 }, (_, i) => review(i + 1, 'someone', 'COMMENTED')),
      review(200, 'Me', 'CHANGES_REQUESTED'),
      review(201, 'me', 'APPROVED'),
    ]);
    pages.push([review(300, 'me', 'COMMENTED'), review(301, 'other', 'APPROVED')]);
    expect(await fetchViewerLatestDecisiveReview('t', 'o', 'r', 1, 'ME')).toMatchObject({
      databaseId: 201,
      nodeId: 'PRR_201',
      state: 'APPROVED',
    });
  });

  it('null when the viewer has no decisive review', async () => {
    pages.length = 0;
    pages.push([review(1, 'me', 'COMMENTED')]);
    expect(await fetchViewerLatestDecisiveReview('t', 'o', 'r', 1, 'me')).toBeNull();
  });
});

describe('githubErrorMessage', () => {
  it('joins GitHub\'s message with its errors, else the text', () => {
    expect(githubErrorMessage({ message: 'Validation Failed', errors: [{ message: 'Can not dismiss a commented pull request review' }] }, '')).toBe(
      'Validation Failed Can not dismiss a commented pull request review',
    );
    expect(githubErrorMessage(null, 'plain')).toBe('plain');
  });
});
