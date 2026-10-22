// THE RECORDER'S GITHUB STAND-IN. A handful of the SPA's reads are LIVE GitHub calls in the product
// (the Changes tab's file list, a failed job's log, the merge control's live options, reactions) and
// the demo stack has no GitHub. The recorder routes exactly those requests here, in the browser
// context, and answers them from the same fictional data the seeder used (./demo-diffs.mjs), so
// the recording holds what a real session against the Acme repositories would have shown.
// Everything else goes to the demo backend untouched.
import { DEMO_DIFFS, TERRAFORM_PLAN_JOB_ID, TERRAFORM_PLAN_LOG, filePatch, fileStats } from './demo-diffs.mjs';

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });

/** Install the stand-in on a Playwright BrowserContext. `backend` is the demo backend's origin. */
export async function installGithubStandIn(context, { backend }) {
  const fromBackend = async (path) => {
    const res = await fetch(`${backend}${path}`);
    return res.ok ? res.json() : null;
  };

  // The Changes tab: one page of files with their patches.
  await context.route(/\/api\/prs\/\d+\/files(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const id = Number(url.pathname.split('/')[3]);
    const pr = await fromBackend(`/api/prs/${id}`);
    const files = DEMO_DIFFS[id];
    if (!pr) return route.continue();
    if (!files) {
      // A PR the demo has no code for: its stored file list, without patches.
      return json(route, {
        files: (pr.files ?? []).map((f) => ({
          path: f.path,
          previousPath: null,
          status: 'modified',
          additions: f.additions,
          deletions: f.deletions,
          patch: null,
          githubUrl: `${pr.githubUrl}/files`,
          blobUrl: `https://github.com/${pr.repoFullName}/blob/${pr.headSha}/${f.path}`,
        })),
        truncated: false,
        nextPage: null,
        ceilingReached: false,
        headSha: pr.headSha,
      });
    }
    return json(route, {
      files: files.map((f) => ({
        path: f.path,
        previousPath: null,
        status: f.status,
        ...fileStats(f),
        patch: filePatch(f),
        githubUrl: `${pr.githubUrl}/files`,
        blobUrl: `https://github.com/${pr.repoFullName}/blob/${pr.headSha}/${f.path}`,
      })),
      truncated: false,
      nextPage: null,
      ceilingReached: false,
      headSha: pr.headSha,
    });
  });

  // "View log" on #114's failing `terraform plan`.
  await context.route(/\/api\/prs\/\d+\/checks\/\d+\/logs(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const jobId = Number(url.pathname.split('/')[5]);
    if (jobId !== TERRAFORM_PLAN_JOB_ID) {
      return json(route, { available: false, reason: 'The log for this job has expired.', text: '', totalLines: 0, returnedLines: 0, totalBytes: null, startByte: null, endByte: null, hasMore: false, truncated: false });
    }
    const lines = TERRAFORM_PLAN_LOG.split('\n').length;
    return json(route, {
      available: true,
      text: TERRAFORM_PLAN_LOG,
      totalLines: lines,
      returnedLines: lines,
      totalBytes: TERRAFORM_PLAN_LOG.length,
      startByte: 0,
      endByte: TERRAFORM_PLAN_LOG.length,
      hasMore: false,
      truncated: false,
    });
  });

  // The merge control's live options, from the PR's synced merge state and any armed intent.
  await context.route(/\/api\/prs\/\d+\/merge-options(\?.*)?$/, async (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    const pr = await fromBackend(`/api/prs/${id}`);
    if (!pr) return route.continue();
    const armed = ((await fromBackend('/api/auto-merge'))?.requests ?? []).find((r) => r.prId === id) ?? null;
    const state = pr.mergeStateStatus ?? 'unknown';
    const conflicts = pr.mergeable === 'conflicting' || state === 'dirty';
    const behind = state === 'behind';
    return json(route, {
      allowedMethods: ['squash', 'merge', 'rebase'],
      defaultMethod: 'squash',
      mergeable: pr.mergeable === 'mergeable' ? true : pr.mergeable === 'conflicting' ? false : null,
      mergeStateStatus: state,
      conflicts,
      behind,
      blocked: state === 'blocked',
      behindBy: behind ? 3 : 0,
      baseRef: pr.baseRefName ?? 'main',
      canUpdateBranch: behind && !conflicts,
      canRebaseUpdate: behind && !conflicts,
      mergeQueue: pr.inMergeQueue
        ? { enabled: true, inQueue: true, position: 2, state: 'AWAITING_CHECKS', entryState: pr.mergeQueueEntryState ?? 'awaiting_checks', estimatedTimeToMergeMs: 14 * 60_000 }
        : null,
      autoMerge: { allowedByRepo: true, armed },
      reviewDecision: pr.reviewDecision ?? null,
    });
  });

  // Reactions on comments: a few thumbs-up and rockets, the reader's own on some.
  await context.route(/\/api\/reactions\/lookup$/, async (route) => {
    let targets = [];
    try {
      targets = JSON.parse(route.request().postData() ?? '{}').targets ?? [];
    } catch {
      /* none */
    }
    const results = targets.map((t) => {
      const n = Number(String(t.id).replace(/\D/g, '').slice(-3)) || 0;
      const groups = [];
      if (n % 3 === 0) groups.push({ content: 'thumbs_up', count: 1 + (n % 4), viewerHasReacted: n % 2 === 0 });
      if (n % 5 === 0) groups.push({ content: 'rocket', count: 1, viewerHasReacted: false });
      if (n % 7 === 0) groups.push({ content: 'eyes', count: 2, viewerHasReacted: false });
      return { kind: t.kind, id: t.id, groups, viewerCanReact: true };
    });
    return json(route, { results, generatedAt: new Date().toISOString() });
  });
}
