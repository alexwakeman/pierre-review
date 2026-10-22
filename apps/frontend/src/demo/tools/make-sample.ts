// Regenerates data/sample-recording.json — the small hand-made recording the demo runtime is
// developed and tested against until the real Acme recording lands at data/recording.json.
//
// It replays the typed e2e fixtures (e2e/mock-api.ts) through a stand-in for Playwright's
// `page.route`, for the list of requests below, and writes them in the recording format
// (../README.md). The reader is renamed Morgan Diaz.
//
//   ./apps/backend/node_modules/.bin/tsx apps/frontend/src/demo/tools/make-sample.ts   (repo root)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installMockApi } from '../../../e2e/mock-api.js';
import { normalisePath } from '../recording.js';
import type { DemoRecording, RecordingEntry } from '../recording.js';
import type { ClaudeReviewResponse } from '@pierre-review/shared';

type Handler = (route: unknown) => Promise<void>;

const REQUESTS: Array<[method: string, path: string]> = [
  ['GET', '/api/me'],
  ['GET', '/api/workspaces'],
  ['GET', '/api/repos'],
  ['GET', '/api/users'],
  ['GET', '/api/mergers'],
  ['GET', '/api/my-turn'],
  ['GET', '/api/auto-merge'],
  ['GET', '/api/open-prs?workspace=1'],
  ['GET', '/api/timeline?workspace=1'],
  ['GET', '/api/attention?workspace=1'],
  ['GET', '/api/daily-brief?workspace=1'],
  ['GET', '/api/branch-status?workspace=1'],
  ['GET', '/api/bot-reviewers?workspace=1'],
  ['GET', '/api/activity?workspace=1'],
  ['GET', '/api/activity/feed?authors=humans&limit=25&offset=0&workspace=1'],
  ['GET', '/api/merged-prs?workspace=1'],
  ['GET', '/api/sprint-graph?workspace=1'],
  ['GET', '/api/sprint-graph/token?workspace=1'],
  ['GET', '/api/workspaces/1/tracker'],
  ['GET', '/api/workspaces/1/sonar'],
  ['GET', '/api/workspaces/1/docs-settings'],
  ['GET', '/api/pro/settings/workspace?workspace=1'],
  ['GET', '/api/pro/slack/target?workspace=1'],
  ['GET', '/api/docs?workspace=1'],
  ['GET', '/api/docs/chats?workspace=1'],
  ['GET', '/api/docs/tree?workspace=1'],
  ['GET', '/api/ticket-merged-prs?keys=&workspace=1'],
  ['POST', '/api/claude-review/states'],
  ['POST', '/api/claude-review/thread-judgements'],
  ['POST', '/api/ticket-reviews/states'],
  ['POST', '/api/ci-reviews/states'],
  ['POST', '/api/ticket-links'],
  ['GET', '/api/threads/5001'],
];

// One PR opened in the sample: its detail and the reads its tabs make.
for (const id of [101, 102, 103, 104, 105]) {
  REQUESTS.push(['GET', `/api/prs/${id}`]);
  REQUESTS.push(['GET', `/api/prs/${id}/ci-review`]);
  REQUESTS.push(['GET', `/api/prs/${id}/ticket-reviews`]);
  REQUESTS.push(['GET', `/api/prs/${id}/sequence-diagrams`]);
  REQUESTS.push(['GET', `/api/prs/${id}/claude-review/thread-check`]);
}

// The e2e fixtures run with AI off, so they carry no finished run. One hand-written Claude Review
// of PR 102 gives the run simulator a template to replay when the reader presses Review.
function claudeReviewOf102(capturedAt: string): ClaudeReviewResponse {
  const at = (minutesAgo: number): string => new Date(Date.parse(capturedAt) - minutesAgo * 60_000).toISOString();
  return {
    enabled: true,
    auth: 'ok',
    review: {
      id: 7001,
      prId: 102,
      headSha: 'a'.repeat(40),
      status: 'succeeded',
      model: 'claude-sonnet-5',
      scope: 'diff_only',
      reviewMode: 'diff_only',
      routeReason: null,
      summary: 'The race is fixed by awaiting the token refresh before the retry. One edge case is left: a second 401 during the refresh.',
      verdict: 'COMMENT',
      userBody: null,
      userVerdict: null,
      costUsd: 0.41,
      inputTokens: 18200,
      outputTokens: 1900,
      cacheReadTokens: 52000,
      cacheCreationTokens: 0,
      numTurns: 6,
      diffBytes: 4100,
      diffCapped: false,
      error: null,
      excludedFiles: [],
      postedReviewId: null,
      postedAt: null,
      createdAt: at(30),
      finishedAt: at(28),
      trigger: 'manual',
      findings: [
        {
          id: 7101,
          reviewId: 7001,
          path: 'src/auth/refresh.ts',
          line: 42,
          side: 'RIGHT',
          diffAnchorId: 'src/auth/refresh.ts:R42',
          severity: 'warning',
          title: 'A second 401 during the refresh retries forever',
          body: 'If the refresh call itself answers 401, `retry()` runs again with the same expired token. Stop after one refresh attempt.',
          editedBody: null,
          suggestion: null,
          diffHunk: null,
          anchored: true,
          fileInDiff: true,
          included: true,
          postedAt: null,
          githubCommentId: null,
          postedCommentKind: null,
          createdAt: at(28),
        },
      ],
    },
    history: [
      {
        id: 7001,
        headSha: 'a'.repeat(40),
        status: 'succeeded',
        model: 'claude-sonnet-5',
        scope: 'diff_only',
        reviewMode: 'diff_only',
        verdict: 'COMMENT',
        userVerdict: null,
        costUsd: 0.41,
        postedAt: null,
        createdAt: at(30),
        finishedAt: at(28),
        trigger: 'manual',
      },
    ],
    autoReview: null,
  };
}

async function main(): Promise<void> {
  const handlers: Handler[] = [];
  const page = { route: async (_match: unknown, h: Handler) => void handlers.push(h) };
  await installMockApi(page as never);
  const handler = handlers[0];
  if (!handler) throw new Error('mock-api registered no route');

  const capturedAt = new Date().toISOString();
  const entries: RecordingEntry[] = [];
  for (const [method, path] of REQUESTS) {
    let fulfilled: { status?: number; body?: string; contentType?: string } | null = null;
    await handler({
      request: () => ({ url: () => `http://127.0.0.1${path}`, method: () => method }),
      fulfill: async (r: { status?: number; body?: string; contentType?: string }) => {
        fulfilled = r;
      },
    });
    const r = fulfilled as { status?: number; body?: string; contentType?: string } | null;
    if (!r || r.body == null || r.body === '{}') continue; // the fixtures' catch-all: leave it to the runtime
    entries.push({ method, path: normalisePath(path), status: r.status ?? 200, body: JSON.parse(r.body) as unknown });
  }

  entries.push({ method: 'GET', path: '/api/prs/102/claude-review', status: 200, body: claudeReviewOf102(capturedAt) });

  // The reader is Morgan Diaz, not the fixtures' anonymous "me".
  const json = JSON.stringify({ version: 1, capturedAt, entries } satisfies DemoRecording)
    .replaceAll('"me-user"', '"morgan-diaz"')
    .replaceAll('"displayName":"Me"', '"displayName":"Morgan Diaz"');
  const recording = JSON.parse(json) as DemoRecording;
  const me = recording.entries.find((e) => e.path === '/api/me');
  if (me && me.body && typeof me.body === 'object') {
    (me.body as { user: { displayName: string | null } }).user.displayName = 'Morgan Diaz';
  }

  const out = fileURLToPath(new URL('../data/sample-recording.json', import.meta.url));
  writeFileSync(out, `${JSON.stringify(recording, null, 1)}\n`);
  console.log(`wrote ${recording.entries.length} entries to ${out}`);
}

void main();
