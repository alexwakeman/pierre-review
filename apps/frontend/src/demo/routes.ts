// The demo server's hand-written routes: the account, "nothing changed" answers for every sync
// and freshness call, the batched read POSTs, and the WRITE SIMULATOR — every write the SPA can
// make, answered with a plausible success shaped by the shared types and folded into the
// in-memory overlay so later reads show it.

import { LARGE_PR_CODE_LOC_DEFAULT } from '@pierre-review/shared';
import { normalisePath } from './recording.js';
import type { DemoReply, DemoRequest, DemoRoute, DemoServer } from './server.js';
import { fakeSha, isRecord, notInDemo } from './util.js';

const OK = (body: unknown): DemoReply => ({ status: 200, body });

/** The demo's reader, used when the recording has no account of its own. */
export const DEMO_USER = {
  login: 'morgan-diaz',
  githubId: '1',
  avatarUrl: null,
  displayName: 'Morgan Diaz',
};

const DEMO_ANSWER =
  'This is the demo, so Claude is not connected here. On your own machine Limn answers this with ' +
  'Claude, reading the code and the review.';

function bodyRecord(req: DemoRequest): Record<string, unknown> {
  return isRecord(req.body) ? req.body : {};
}

function numberList(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
}

/** The reader's GitHub user id in the recording (the `users` row whose login is the account's). */
function meUserId(srv: DemoServer): number | null {
  const me = meBody(srv);
  const login = isRecord(me.user) ? me.user.login : null;
  const users = srv.recorded('GET', '/api/users');
  if (Array.isArray(users)) {
    const u = users.find((x) => isRecord(x) && x.githubLogin === login);
    if (isRecord(u) && typeof u.id === 'number') return u.id;
  }
  return null;
}

// ── /api/me ───────────────────────────────────────────────────────────────────────────────────

export function meBody(srv: DemoServer): Record<string, unknown> {
  const rec = srv.recorded('GET', '/api/me');
  const base: Record<string, unknown> = isRecord(rec) ? rec : {};
  const stored = srv.overlay.stored.get('/api/me');
  return {
    largePrCodeLocThreshold: LARGE_PR_CODE_LOC_DEFAULT,
    largePrCodeLocThresholdIsDefault: true,
    blastRadius: null,
    myTurnSettings: null,
    ...base,
    ...(isRecord(stored) ? stored : {}),
    user: isRecord(base.user) ? base.user : DEMO_USER,
    deploymentMode: 'local',
    mlSeverity: true,
    ml: { state: 'ready', message: null },
    conflictResolver: true,
    ai: { enabled: true, runtime: 'ready', runtimeMessage: null, auth: 'ok', authMessage: null },
    authNotices: [],
  };
}

function storeMe(srv: DemoServer, fields: Record<string, unknown>): void {
  const prev = srv.overlay.stored.get('/api/me');
  srv.overlay.stored.set('/api/me', { ...(isRecord(prev) ? prev : {}), ...fields });
}

// ── settings merge ────────────────────────────────────────────────────────────────────────────

/**
 * Fold a settings write into the matching read: each key lands where it already lives — at the
 * top level, or inside the one nested object that carries it (`{ autoReview: { enabled } }`).
 */
export function mergeSettings(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (k in out) {
      out[k] = isRecord(v) && isRecord(out[k]) ? mergeSettings(out[k] as Record<string, unknown>, v) : v;
      continue;
    }
    const holder = Object.keys(out).find((h) => isRecord(out[h]) && k in (out[h] as Record<string, unknown>));
    if (holder) out[holder] = { ...(out[holder] as Record<string, unknown>), [k]: v };
    else out[k] = v;
  }
  return out;
}

/** The current read of a settings path: what this session stored, else the recording. */
function currentRead(srv: DemoServer, url: string): unknown {
  const key = normalisePath(url);
  return srv.overlay.stored.has(key) ? srv.overlay.stored.get(key) : srv.recorded('GET', url);
}

function genericSettingsWrite(req: DemoRequest, srv: DemoServer): DemoReply {
  const current = currentRead(srv, req.url);
  if (!isRecord(current)) return notInDemo();
  const next = mergeSettings(current, bodyRecord(req));
  srv.overlay.stored.set(normalisePath(req.url), next);
  return OK(next);
}

// ── workspaces ────────────────────────────────────────────────────────────────────────────────

function workspaceList(srv: DemoServer): Record<string, unknown>[] {
  const cur = currentRead(srv, '/api/workspaces');
  return isRecord(cur) && Array.isArray(cur.workspaces) ? (cur.workspaces.filter(isRecord) as Record<string, unknown>[]) : [];
}

function saveWorkspaces(srv: DemoServer, list: Record<string, unknown>[]): void {
  srv.overlay.stored.set('/api/workspaces', { workspaces: list });
}

function patchWorkspace(srv: DemoServer, id: number, fields: Record<string, unknown>): DemoReply {
  const list = workspaceList(srv);
  const i = list.findIndex((w) => w.id === id);
  if (i < 0) return notInDemo(404);
  const next = { ...list[i], ...fields };
  if (Array.isArray(next.repoIds)) next.repoCount = next.repoIds.length;
  list[i] = next;
  saveWorkspaces(srv, list);
  return OK({ workspace: next });
}

// ── PR helpers ────────────────────────────────────────────────────────────────────────────────

function prDetail(srv: DemoServer, prId: number): Record<string, unknown> | null {
  const pr = srv.recorded('GET', `/api/prs/${prId}`);
  return isRecord(pr) ? patchPrDetail(srv, prId, pr) : null;
}

function patchPrDetail(srv: DemoServer, prId: number, pr: Record<string, unknown>): Record<string, unknown> {
  const o = srv.overlay;
  const out: Record<string, unknown> = { ...pr, ...(o.prFields.get(prId) ?? {}) };
  if (Array.isArray(out.threads)) out.threads = out.threads.map((t) => (isRecord(t) ? patchThread(srv, t) : t));
  const reviews = o.addedReviews.get(prId);
  if (reviews && Array.isArray(out.reviews)) out.reviews = [...out.reviews, ...reviews];
  const comments = o.addedComments.get(prId);
  if (comments && Array.isArray(out.comments)) out.comments = [...out.comments, ...comments];
  return out;
}

function patchThread(srv: DemoServer, t: Record<string, unknown>): Record<string, unknown> {
  const p = typeof t.id === 'number' ? srv.overlay.threads.get(t.id) : undefined;
  if (!p) return t;
  const out: Record<string, unknown> = { ...t };
  if (p.isResolved != null) out.isResolved = p.isResolved;
  if (p.derivedState != null) out.derivedState = p.derivedState;
  if (p.addedComments.length > 0 && Array.isArray(out.comments)) out.comments = [...out.comments, ...p.addedComments];
  return out;
}

function resolveThreads(srv: DemoServer, ids: number[]): DemoReply {
  for (const id of ids) {
    const t = srv.overlay.thread(id);
    t.isResolved = true;
    t.derivedState = 'resolved';
  }
  return OK({ resolved: ids.length, failed: 0, results: ids.map((threadId) => ({ threadId, ok: true, derivedState: 'resolved' })) });
}

function review(srv: DemoServer, prId: number, state: string, body: unknown): Record<string, unknown> {
  const r = {
    id: srv.nextId(),
    authorId: meUserId(srv),
    state,
    body: typeof body === 'string' && body ? body : null,
    submittedAt: srv.nowIso(),
    url: null,
  };
  srv.overlay.addReview(prId, r as never);
  return r;
}

// ── batched read POSTs ────────────────────────────────────────────────────────────────────────
// The recorder stores ONE response per path covering every id it saw; each request is answered
// with just the rows it asked for, in the order it asked.

function recordedRows(srv: DemoServer, path: string, field: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const e of srv.index.all('POST', path)) {
    const b = srv.bodyOf(e);
    if (isRecord(b) && Array.isArray(b[field])) rows.push(...(b[field] as unknown[]).filter(isRecord));
  }
  return rows;
}

function byPr(rows: Record<string, unknown>[], ids: number[]): Record<string, unknown>[] {
  const want = new Set(ids);
  return rows.filter((r) => typeof r.prId === 'number' && want.has(r.prId));
}

// ── the routes ────────────────────────────────────────────────────────────────────────────────

export const ROUTES: DemoRoute[] = [
  // The account. Always local mode with AI and bot-comment scoring on, so every surface shows.
  { method: 'GET', re: /^\/api\/me$/, run: (_r, _m, srv) => OK(meBody(srv)) },
  {
    method: 'POST',
    re: /^\/api\/me\/large-pr-threshold$/,
    run: (req, _m, srv) => {
      const t = bodyRecord(req).threshold;
      const fields = {
        largePrCodeLocThreshold: typeof t === 'number' ? t : LARGE_PR_CODE_LOC_DEFAULT,
        largePrCodeLocThresholdIsDefault: typeof t !== 'number',
      };
      storeMe(srv, fields);
      return OK({ status: 'ok', ...fields });
    },
  },
  {
    method: 'PUT',
    re: /^\/api\/me\/blast-radius-config$/,
    run: (req, _m, srv) => {
      const blastRadius = bodyRecord(req).config ?? null;
      storeMe(srv, { blastRadius });
      return OK({ status: 'ok', blastRadius });
    },
  },
  {
    method: 'PUT',
    re: /^\/api\/me\/my-turn-settings$/,
    run: (req, _m, srv) => {
      const myTurnSettings = bodyRecord(req).settings ?? null;
      storeMe(srv, { myTurnSettings });
      return OK({ status: 'ok', myTurnSettings });
    },
  },
  { method: 'POST', re: /^\/api\/me\/benchmark-consent$/, run: (req) => OK({ status: 'ok', benchmarkOptIn: Boolean(bodyRecord(req).optIn) }) },
  { method: ['GET', 'DELETE'], re: /^\/api\/me\/(export|account)$/, run: () => notInDemo(400) },
  { method: 'POST', re: /^\/api\/auth\/logout$/, run: () => OK({ status: 'ok' }) },

  // No sync, no freshness work: everything answers "nothing changed".
  {
    method: 'GET',
    re: /^\/api\/sync-activity$/,
    run: (_r, _m, srv) => OK({ backfills: [], catchups: [], generatedAt: srv.nowIso() }),
  },
  {
    method: 'GET',
    re: /^\/api\/ml-status$/,
    run: (req, _m, srv) => {
      const rec = srv.recorded('GET', req.url);
      const base = {
        enabled: true,
        unscorable: 0,
        labelled: 0,
        scoredThisRun: 0,
        batchesThisRun: 0,
        failuresThisRun: 0,
        startedAt: null,
        finishedAt: null,
        serviceHealthy: true,
        markerFallback: false,
        ...(isRecord(rec) ? rec : {}),
      };
      return OK({ ...base, running: false, pending: 0, pausedUntil: null, generatedAt: srv.nowIso() });
    },
  },
  {
    method: 'GET',
    re: /^\/api\/repos\/(\d+)\/sync-status$/,
    run: (req, m, srv) => {
      const rec = srv.recorded('GET', req.url);
      return OK({
        lastFullSyncAt: null,
        lastIncrementalSyncAt: null,
        ...(isRecord(rec) ? rec : {}),
        repoId: Number(m[1]),
        status: 'ok',
        progress: null,
        lastSyncError: null,
      });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/prs\/(\d+)\/refresh$/,
    run: (_req, m, srv) => {
      const pr = prDetail(srv, Number(m[1]));
      return OK({ synced: true, changed: false, updatedAt: isRecord(pr) && typeof pr.updatedAt === 'string' ? pr.updatedAt : srv.nowIso() });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/attention\/liveness$/,
    run: (req) => {
      const ids = numberList(bodyRecord(req).prIds);
      return OK({ workspaceId: Number(req.query.get('workspace')) || 1, checked: ids.length, mergeStateChecked: 0, changed: 0, leftOpenSet: 0, paused: null });
    },
  },
  { method: 'POST', re: /^\/api\/repos\/(\d+)\/(sync|cancel)$/, run: () => notInDemo() },
  { method: 'POST', re: /^\/api\/repos$/, run: () => notInDemo() },
  { method: 'DELETE', re: /^\/api\/repos\/\d+$/, run: () => notInDemo() },
  { method: 'POST', re: /^\/api\/ai\/runtime\/install$/, run: () => ({ stream: [{ event: 'message', data: { type: 'done', runtime: 'ready' }, delayMs: 300 }] }) },
  { method: 'POST', re: /^\/api\/ml\/install$/, run: () => ({ stream: [{ event: 'message', data: { type: 'done' }, delayMs: 300 }] }) },

  // Batched reads over POST.
  {
    method: 'POST',
    re: /^\/api\/claude-review\/states$/,
    run: (req, _m, srv) => {
      const ids = numberList(bodyRecord(req).prIds);
      const rows = byPr(recordedRows(srv, req.pathname, 'states'), ids);
      const map = new Map(rows.map((r) => [r.prId as number, r]));
      for (const id of ids) {
        const run = srv.runs.latestFor('claude-review', id);
        if (run) map.set(id, srv.runs.claudeState(run, map.get(id) ?? null));
      }
      return OK({ states: ids.map((id) => map.get(id)).filter(isRecord) });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/claude-review\/thread-judgements$/,
    run: (req, _m, srv) => OK({ prs: byPr(recordedRows(srv, req.pathname, 'prs'), numberList(bodyRecord(req).prIds)) }),
  },
  {
    method: 'POST',
    re: /^\/api\/ticket-links$/,
    run: (req, _m, srv) => OK({ prs: byPr(recordedRows(srv, req.pathname, 'prs'), numberList(bodyRecord(req).prIds)), titlesComplete: true }),
  },
  {
    method: 'POST',
    re: /^\/api\/ci-reviews\/states$/,
    run: (req, _m, srv) => {
      const ids = numberList(bodyRecord(req).prIds);
      const map = new Map(byPr(recordedRows(srv, req.pathname, 'states'), ids).map((r) => [r.prId as number, r]));
      const states = ids.map((prId) => {
        const run = srv.runs.latestFor('ci-review', prId);
        const base = map.get(prId) ?? { prId, status: 'none', staleBecause: null, latestRunId: null, runningRunId: null, headSha: null, counts: null, refused: null, checkedAt: null };
        return run ? srv.runs.ciState(run, base) : base;
      });
      return OK({ states });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/ticket-reviews\/states$/,
    run: (req, _m, srv) => {
      const b = bodyRecord(req);
      const idents = Array.isArray(b.idents) ? b.idents.filter((x): x is string => typeof x === 'string') : [];
      const map = new Map(recordedRows(srv, req.pathname, 'states').map((r) => [r.ident as string, r]));
      const states = idents.map((ident) => {
        const run = srv.runs.latestFor('ticket-review', ident);
        const base = map.get(ident) ?? {
          ident,
          status: 'none',
          staleBecause: [],
          changedPrIds: [],
          latestRunId: null,
          runningRunId: null,
          alignment: null,
          counts: null,
          memberCount: 0,
          checkedAt: null,
        };
        return run ? srv.runs.ticketState(run, base) : base;
      });
      return OK({ states });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/reactions\/lookup$/,
    run: (req, _m, srv) => {
      const targets = Array.isArray(bodyRecord(req).targets) ? (bodyRecord(req).targets as unknown[]).filter(isRecord) : [];
      const rows = recordedRows(srv, req.pathname, 'results');
      const stored = srv.overlay.stored;
      const results = targets.map((t) => {
        const key = `reaction:${String(t.kind)}:${String(t.id)}`;
        if (stored.has(key)) return stored.get(key);
        return rows.find((r) => r.kind === t.kind && r.id === t.id) ?? { kind: t.kind, id: t.id, groups: [], viewerCanReact: true };
      });
      return OK({ results, generatedAt: srv.nowIso() });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/reactions$/,
    run: (req, _m, srv) => {
      const b = bodyRecord(req);
      const key = `reaction:${String(b.kind)}:${String(b.id)}`;
      const rows = recordedRows(srv, '/api/reactions/lookup', 'results');
      const prev = (srv.overlay.stored.get(key) as Record<string, unknown> | undefined) ??
        rows.find((r) => r.kind === b.kind && r.id === b.id) ?? { kind: b.kind, id: b.id, groups: [], viewerCanReact: true };
      const groups = (Array.isArray(prev.groups) ? prev.groups.filter(isRecord) : []).map((g) => ({ ...g }));
      let g = groups.find((x) => x.content === b.content);
      if (!g) {
        g = { content: b.content, count: 0, viewerHasReacted: false };
        groups.push(g);
      }
      if (b.add && !g.viewerHasReacted) {
        g.count = Number(g.count) + 1;
        g.viewerHasReacted = true;
      } else if (!b.add && g.viewerHasReacted) {
        g.count = Math.max(0, Number(g.count) - 1);
        g.viewerHasReacted = false;
      }
      const next = { ...prev, groups: groups.filter((x) => Number(x.count) > 0) };
      srv.overlay.stored.set(key, next);
      return OK(next);
    },
  },
  {
    method: 'POST',
    re: /^\/api\/prs\/resolve$/,
    run: (req, _m, srv) => {
      const refs = Array.isArray(bodyRecord(req).refs) ? (bodyRecord(req).refs as unknown[]).filter(isRecord) : [];
      const rows = recordedRows(srv, req.pathname, 'refs');
      return OK({
        refs: refs.map(
          (q) => rows.find((r) => r.repo === q.repo && r.number === q.number) ?? { repo: q.repo, number: q.number, prId: null, repoFullName: null, title: null },
        ),
      });
    },
  },

  // Thread and PR writes.
  {
    method: 'POST',
    re: /^\/api\/threads\/(\d+)\/reply$/,
    run: (req, m, srv) => {
      const threadId = Number(m[1]);
      const comment = { id: srv.nextId(), authorId: meUserId(srv), body: String(bodyRecord(req).body ?? ''), diffHunk: null, createdAt: srv.nowIso(), url: null };
      const t = srv.overlay.thread(threadId);
      t.addedComments.push(comment);
      if (!t.isResolved) t.derivedState = 'replied_unresolved';
      return OK(comment);
    },
  },
  {
    method: 'POST',
    re: /^\/api\/threads\/(\d+)\/resolve$/,
    run: (req, m, srv) => {
      const threadId = Number(m[1]);
      const resolved = bodyRecord(req).resolved !== false;
      const t = srv.overlay.thread(threadId);
      t.isResolved = resolved;
      t.derivedState = resolved ? 'resolved' : 'replied_unresolved';
      return OK({ threadId, isResolved: resolved, derivedState: t.derivedState });
    },
  },
  { method: 'POST', re: /^\/api\/prs\/\d+\/resolve-bot-threads$/, run: (req, _m, srv) => resolveThreads(srv, numberList(bodyRecord(req).threadIds)) },
  { method: 'POST', re: /^\/api\/bot-threads\/resolve$/, run: (req, _m, srv) => resolveThreads(srv, numberList(bodyRecord(req).threadIds)) },
  {
    method: 'POST',
    re: /^\/api\/prs\/(\d+)\/comment$/,
    run: (req, m, srv) => {
      const c = { id: srv.nextId(), authorId: meUserId(srv), body: String(bodyRecord(req).body ?? ''), createdAt: srv.nowIso(), url: null };
      srv.overlay.addComment(Number(m[1]), c);
      return OK(c);
    },
  },
  {
    method: 'POST',
    re: /^\/api\/prs\/(\d+)\/review-comment$/,
    run: (req, _m, srv) => {
      const b = bodyRecord(req);
      return OK({ commentId: srv.nextId(), url: null, line: Number(b.line) || 1, side: b.side === 'LEFT' ? 'LEFT' : 'RIGHT', anchored: true, visible: true, threadId: null });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/prs\/(\d+)\/approve$/,
    run: (req, m, srv) => {
      const prId = Number(m[1]);
      srv.overlay.patchPr(prId, { viewerHasApprovedStanding: true, viewerReviewStanding: 'approved', reviewDecision: 'approved' });
      return OK(review(srv, prId, 'approved', bodyRecord(req).body));
    },
  },
  {
    method: 'POST',
    re: /^\/api\/prs\/(\d+)\/request-changes$/,
    run: (req, m, srv) => {
      const prId = Number(m[1]);
      srv.overlay.patchPr(prId, { viewerHasApprovedStanding: false, viewerReviewStanding: 'changes_requested' });
      return OK(review(srv, prId, 'changes_requested', bodyRecord(req).body));
    },
  },
  {
    method: 'POST',
    re: /^\/api\/prs\/(\d+)\/withdraw-approval$/,
    run: (_req, m, srv) => {
      srv.overlay.patchPr(Number(m[1]), { viewerHasApprovedStanding: false, viewerReviewStanding: null });
      return OK({ reviewId: srv.nextId(), state: 'dismissed' });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/prs\/(\d+)\/merge$/,
    run: (_req, m, srv) => {
      const prId = Number(m[1]);
      const now = srv.nowIso();
      srv.overlay.patchPr(prId, { state: 'merged', mergedAt: now, closedAt: now, mergedById: meUserId(srv), updatedAt: now, inMergeQueue: false });
      srv.overlay.armed.set(prId, null);
      return OK({ merged: true, sha: fakeSha(prId), state: 'merged' });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/prs\/(\d+)\/close$/,
    run: (_req, m, srv) => {
      const now = srv.nowIso();
      srv.overlay.patchPr(Number(m[1]), { state: 'closed', closedAt: now, updatedAt: now, viewerCanClose: false, viewerCanReopen: true });
      return OK({ closed: true, state: 'closed' });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/prs\/(\d+)\/reopen$/,
    run: (_req, m, srv) => {
      srv.overlay.patchPr(Number(m[1]), { state: 'open', closedAt: null, updatedAt: srv.nowIso(), viewerCanClose: true, viewerCanReopen: false });
      return OK({ reopened: true, state: 'open' });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/prs\/(\d+)\/update-branch$/,
    run: (req, m, srv) => {
      const prId = Number(m[1]);
      const headSha = fakeSha(srv.nextId());
      srv.overlay.patchPr(prId, { mergeStateStatus: 'clean', headSha, behindBy: 0 });
      return OK({ ok: true, headSha, strategy: bodyRecord(req).strategy === 'rebase' ? 'rebase' : 'merge' });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/prs\/(\d+)\/merge-queue$/,
    run: (_req, m, srv) => {
      srv.overlay.patchPr(Number(m[1]), { inMergeQueue: true, mergeQueueEntryState: 'QUEUED' });
      return OK({ inQueue: true, position: 1, state: 'QUEUED' });
    },
  },
  {
    method: 'DELETE',
    re: /^\/api\/prs\/(\d+)\/merge-queue$/,
    run: (_req, m, srv) => {
      srv.overlay.patchPr(Number(m[1]), { inMergeQueue: false, mergeQueueEntryState: null });
      return OK({ inQueue: false, position: null, state: null });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/prs\/(\d+)\/auto-merge$/,
    run: (req, m, srv) => {
      const prId = Number(m[1]);
      const pr = prDetail(srv, prId);
      if (!pr) return notInDemo(404);
      const b = bodyRecord(req);
      const [owner = '', name = ''] = String(pr.repoFullName ?? '/').split('/');
      const now = srv.now();
      const intent = {
        prId,
        repoOwner: owner,
        repoName: name,
        prNumber: pr.number,
        prTitle: pr.title,
        mergeMethod: typeof b.mergeMethod === 'string' ? b.mergeMethod : 'squash',
        updateStrategy: typeof b.updateStrategy === 'string' ? b.updateStrategy : 'merge',
        viaMergeQueue: false,
        enqueuedAt: null,
        armedAt: new Date(now).toISOString(),
        expectedHeadOid: typeof pr.headSha === 'string' ? pr.headSha : fakeSha(prId),
        state: 'armed',
        lastCheckedAt: null,
        lastReason: null,
        phase: 'pending_first_check',
        expiresAt: new Date(now + 72 * 3_600_000).toISOString(),
        queuePosition: 1,
        queueDepth: 1,
      };
      srv.overlay.armed.set(prId, intent as never);
      return OK(intent);
    },
  },
  {
    method: 'DELETE',
    re: /^\/api\/prs\/(\d+)\/auto-merge$/,
    run: (_req, m, srv) => {
      srv.overlay.armed.set(Number(m[1]), null);
      return { status: 204 };
    },
  },
  { method: 'POST', re: /^\/api\/prs\/\d+\/request-reviewers$/, run: (req) => OK({ status: 'ok', requestedLogins: Array.isArray(bodyRecord(req).logins) ? bodyRecord(req).logins : [] }) },
  {
    method: 'POST',
    re: /^\/api\/prs\/\d+\/ci\/rerun$/,
    run: (req) => {
      const b = bodyRecord(req);
      return OK({ status: 'queued', runId: Number(b.runId) || 0, mode: b.mode === 'all' ? 'all' : 'failed' });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/prs\/(\d+)\/mark-viewed$/,
    run: (_req, m, srv) => {
      srv.overlay.patchPr(Number(m[1]), { lastViewedAt: srv.nowIso(), newSinceLastViewed: null });
      return OK({ status: 'ok' });
    },
  },
  { method: 'POST', re: /^\/api\/prs\/mark-all-viewed$/, run: () => OK({ status: 'ok', count: 0 }) },
  { method: 'POST', re: /^\/api\/prs\/\d+\/dismiss$/, run: () => OK({ status: 'ok' }) },
  { method: 'POST', re: /^\/api\/activity\/feed\/mark-seen$/, run: (_r, _m, srv) => OK({ feedLastSeenAt: srv.nowIso() }) },
  {
    method: 'PUT',
    re: /^\/api\/my-turn\/dismissals\/([a-z_]+)\/(\d+)$/,
    run: (_req, m, srv) => {
      srv.overlay.dismissed.add(`${m[1]}:${m[2]}`);
      return OK({ target: { kind: m[1], id: Number(m[2]) }, dismissedAt: srv.nowIso() });
    },
  },
  {
    method: 'DELETE',
    re: /^\/api\/my-turn\/dismissals\/([a-z_]+)\/(\d+)$/,
    run: (_req, m, srv) => {
      srv.overlay.dismissed.delete(`${m[1]}:${m[2]}`);
      return { status: 204 };
    },
  },

  // Claude Review: edits, posting and the chat. (Starting runs lives in ./runs.ts.)
  { method: 'PATCH', re: /^\/api\/claude-reviews\/\d+$/, run: () => OK({ status: 'ok' }) },
  { method: 'PATCH', re: /^\/api\/claude-findings\/\d+$/, run: () => OK({ status: 'ok' }) },
  { method: 'POST', re: /^\/api\/claude-findings\/\d+\/post$/, run: (req, _m, srv) => OK({ githubCommentId: String(srv.nextId()), postedAt: srv.nowIso(), ...(bodyRecord(req).reminder ? { reminder: true } : {}) }) },
  { method: 'POST', re: /^\/api\/claude-reviews\/\d+\/follow-up\/\d+\/reply$/, run: (_r, _m, srv) => OK({ status: 'posted', commentId: String(srv.nextId()), error: null }) },
  {
    method: 'POST',
    re: /^\/api\/claude-reviews\/(\d+)\/post$/,
    run: (req, m, srv) => {
      const reviewId = Number(m[1]);
      const stored = findReview(srv, reviewId);
      const findings = isRecord(stored) && Array.isArray(stored.findings) ? stored.findings.filter(isRecord) : [];
      const verdict = bodyRecord(req).userVerdict ?? (isRecord(stored) ? stored.verdict : null) ?? 'comment';
      if (req.query.get('dryRun') === 'true') {
        return OK({
          commitId: isRecord(stored) && typeof stored.headSha === 'string' ? stored.headSha : fakeSha(reviewId),
          body: isRecord(stored) ? String(stored.userBody ?? stored.summary ?? '') : '',
          event: verdict,
          comments: findings
            .filter((f) => typeof f.path === 'string' && typeof f.line === 'number')
            .map((f) => ({ path: f.path, line: f.line, side: f.side ?? 'RIGHT', body: String(f.body ?? f.title ?? '') })),
          prComments: [],
        });
      }
      return OK({ postedReviewId: String(srv.nextId()), postedAt: srv.nowIso(), postedCommentCount: findings.length, prCommentCount: 0 });
    },
  },
  {
    method: 'GET',
    re: /^\/api\/claude-reviews\/(\d+)\/chat$/,
    run: (req, m, srv) => {
      const reviewId = Number(m[1]);
      const findingId = req.query.get('findingId');
      const key = `review:${reviewId}:${findingId ?? 'general'}`;
      const added = srv.overlay.chats.get(key);
      if (!added) return null;
      const rec = srv.recorded('GET', req.url);
      const base = isRecord(rec) && Array.isArray(rec.messages) ? rec.messages : [];
      return OK({ reviewId, findingId: findingId == null ? null : Number(findingId), messages: [...base, ...added], headMoved: false, answering: false });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/claude-reviews\/(\d+)\/chat$/,
    run: (req, m, srv) => {
      const reviewId = Number(m[1]);
      const b = bodyRecord(req);
      const findingId = typeof b.findingId === 'number' ? b.findingId : null;
      const key = `review:${reviewId}:${findingId ?? 'general'}`;
      const now = srv.nowIso();
      const turns = [
        { id: srv.nextId(), findingId, role: 'user', content: String(b.question ?? ''), createdAt: now, pins: null, explanations: null },
        { id: srv.nextId(), findingId, role: 'assistant', content: DEMO_ANSWER, createdAt: now, pins: null, explanations: null },
      ];
      srv.overlay.chats.set(key, [...(srv.overlay.chats.get(key) ?? []), ...turns]);
      const rec = srv.recorded('GET', `/api/claude-reviews/${reviewId}/chat${findingId != null ? `?findingId=${findingId}` : ''}`);
      const base = isRecord(rec) && Array.isArray(rec.messages) ? rec.messages : [];
      return OK({ messages: [...base, ...(srv.overlay.chats.get(key) ?? [])], trimmedTurns: 0, headMoved: false });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/ticket-reviews\/\d+\/post$/,
    run: (_r, _m, srv) => OK({ items: [], visible: true, commentId: String(srv.nextId()) }),
  },
  {
    method: 'POST',
    re: /^\/api\/sprint-graph\/ask$/,
    run: (req) => OK({ workspaceId: Number(bodyRecord(req).workspaceId) || 1, answer: DEMO_ANSWER, trimmedTurns: 0, model: 'demo', costUsd: null }),
  },
  {
    method: 'POST',
    re: /^\/api\/docs\/chat$/,
    run: (req, _m, srv) => {
      const b = bodyRecord(req);
      const now = srv.nowIso();
      return OK({
        workspaceId: Number(b.workspaceId) || 1,
        conversationId: typeof b.conversationId === 'string' ? b.conversationId : `demo-${srv.nextId()}`,
        question: { id: srv.nextId(), role: 'user', text: String(b.question ?? ''), citations: [], createdAt: now, costUsd: null },
        answer: { id: srv.nextId(), role: 'assistant', text: DEMO_ANSWER, citations: [], createdAt: now, costUsd: null },
      });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/(prs\/\d+\/sequence-diagrams|sequence-diagrams\/story)\/redraw$/,
    run: (req, _m, srv) => {
      const path = req.pathname.replace(/\/redraw$/, '');
      const rec = srv.recorded('GET', req.pathname.startsWith('/api/prs/') ? path : `${path}?ident=${encodeURIComponent(String(bodyRecord(req).ident ?? ''))}`);
      const diagram = isRecord(rec) ? (isRecord(rec.pr) ? rec.pr.diagram : rec.diagram) : null;
      return OK({ outcome: 'already_running', diagramId: isRecord(diagram) && typeof diagram.id === 'number' ? diagram.id : null });
    },
  },

  // Workspaces.
  {
    method: 'POST',
    re: /^\/api\/workspaces$/,
    run: (req, _m, srv) => {
      const list = workspaceList(srv);
      const ws = { id: srv.nextId(), name: String(bodyRecord(req).name ?? 'New workspace'), repoIds: [], repoCount: 0, isDefault: false, createdAt: srv.nowIso() };
      saveWorkspaces(srv, [...list, ws]);
      return OK({ workspace: ws });
    },
  },
  {
    method: 'PATCH',
    re: /^\/api\/workspaces\/(\d+)$/,
    run: (req, m, srv) => {
      const b = bodyRecord(req);
      const id = Number(m[1]);
      const fields: Record<string, unknown> = {};
      if (typeof b.name === 'string') fields.name = b.name;
      if (Array.isArray(b.repoIds)) {
        const ids = numberList(b.repoIds);
        fields.repoIds = ids;
        // A repo is in exactly one workspace: moving it here takes it out of the others.
        const list = workspaceList(srv).map((w) =>
          w.id === id ? w : { ...w, repoIds: numberList(w.repoIds).filter((r) => !ids.includes(r)), repoCount: numberList(w.repoIds).filter((r) => !ids.includes(r)).length },
        );
        saveWorkspaces(srv, list);
      }
      return patchWorkspace(srv, id, fields);
    },
  },
  {
    method: 'DELETE',
    re: /^\/api\/workspaces\/(\d+)$/,
    run: (_req, m, srv) => {
      const id = Number(m[1]);
      const list = workspaceList(srv);
      const gone = list.find((w) => w.id === id);
      if (!gone || gone.isDefault) return notInDemo(400);
      saveWorkspaces(
        srv,
        list.filter((w) => w.id !== id).map((w) => (w.isDefault ? { ...w, repoIds: [...numberList(w.repoIds), ...numberList(gone.repoIds)], repoCount: numberList(w.repoIds).length + numberList(gone.repoIds).length } : w)),
      );
      return { status: 204 };
    },
  },
  {
    method: 'PUT',
    re: /^\/api\/workspaces\/(\d+)\/pending-mute$/,
    run: (req, m, srv) => {
      const b = bodyRecord(req);
      const fields: Record<string, unknown> = {};
      if (typeof b.muted === 'boolean') fields.pendingMuted = b.muted;
      if (Array.isArray(b.mutedRepoIds)) fields.mutedRepoIds = numberList(b.mutedRepoIds);
      return patchWorkspace(srv, Number(m[1]), fields);
    },
  },
  { method: 'PUT', re: /^\/api\/workspaces\/(\d+)\/flow-settings$/, run: (req, m, srv) => patchWorkspace(srv, Number(m[1]), { flowSettings: req.body ?? null }) },
  {
    method: 'POST',
    re: /^\/api\/workspaces\/(\d+)\/repos$/,
    run: (req, m, srv) => {
      const id = Number(m[1]);
      const repoId = Number(bodyRecord(req).repoId);
      const list = workspaceList(srv).map((w): Record<string, unknown> => {
        const ids = numberList(w.repoIds).filter((r) => r !== repoId);
        if (w.id === id) ids.push(repoId);
        return { ...w, repoIds: ids, repoCount: ids.length };
      });
      saveWorkspaces(srv, list);
      return OK({ workspace: list.find((w) => w.id === id) ?? null });
    },
  },
  {
    method: 'PATCH',
    re: /^\/api\/bot-reviewers\/(\d+)$/,
    run: (req, m, srv) => {
      const userId = Number(m[1]);
      const prev = srv.overlay.stored.get(`bot:${userId}`);
      const row = isRecord(prev) ? prev : findReviewer(srv, userId);
      if (!row) return notInDemo(404);
      const next = mergeSettings(row, bodyRecord(req));
      srv.overlay.stored.set(`bot:${userId}`, next);
      return OK(next);
    },
  },
  {
    method: 'PUT',
    re: /^\/api\/bot-reviewers\/(\d+)\/cost$/,
    run: (req, m, srv) => {
      const userId = Number(m[1]);
      const prev = srv.overlay.stored.get(`bot:${userId}`);
      const row = isRecord(prev) ? prev : findReviewer(srv, userId);
      if (!row) return notInDemo(404);
      const next = mergeSettings(row, bodyRecord(req));
      srv.overlay.stored.set(`bot:${userId}`, next);
      return OK(next);
    },
  },
  {
    method: 'DELETE',
    re: /^\/api\/bot-reviewers\/(\d+)\/(judgement|identity)$/,
    run: (_req, m, srv) => {
      const userId = Number(m[1]);
      srv.overlay.stored.delete(`bot:${userId}`);
      const row = findReviewer(srv, userId);
      return row ? OK(row) : notInDemo(404);
    },
  },

  // Every other settings write: folded into the read of the same path.
  {
    method: ['PUT', 'PATCH'],
    re: /^\/api\/(workspaces\/\d+\/[a-z-]+|pro\/settings\/workspace|pro\/slack\/target|pro\/settings)$/,
    run: (req, _m, srv) => genericSettingsWrite(req, srv),
  },
  {
    method: 'DELETE',
    re: /^\/api\/pro\/slack\/target$/,
    run: (req, _m, srv) => {
      const cur = currentRead(srv, req.url);
      if (!isRecord(cur)) return notInDemo();
      const next = { ...cur, target: null };
      srv.overlay.stored.set(normalisePath(req.url), next);
      return OK(next);
    },
  },
  { method: 'POST', re: /^\/api\/pro\/slack\/test$/, run: () => OK({ sent: false, message: 'Nothing is sent from the demo.' }) },
];

function findReview(srv: DemoServer, reviewId: number): Record<string, unknown> | null {
  const direct = srv.recorded('GET', `/api/claude-reviews/${reviewId}`);
  if (isRecord(direct)) return direct;
  for (const g of srv.recordedGets(/^\/api\/prs\/\d+\/claude-review$/)) {
    if (isRecord(g.body) && isRecord(g.body.review) && g.body.review.id === reviewId) return g.body.review;
  }
  const run = srv.runs.byRunId('claude-review', reviewId);
  return run ? srv.runs.runObject(run) : null;
}

function findReviewer(srv: DemoServer, userId: number): Record<string, unknown> | null {
  for (const g of srv.recordedGets(/^\/api\/bot-reviewers$/)) {
    const list = isRecord(g.body) && Array.isArray(g.body.reviewers) ? g.body.reviewers : [];
    const row = list.find((r) => isRecord(r) && r.userId === userId);
    if (isRecord(row)) return row;
  }
  return null;
}

// ── fallbacks for GETs the recording does not have ───────────────────────────────────────────
// Only shapes that are small and fully known; everything else answers 404 "Not available in the
// demo", which every query already handles as an error state.

export const GET_FALLBACKS: DemoRoute[] = [
  {
    method: 'GET',
    re: /^.*$/,
    // A settings path the reader saved this session, with nothing recorded under it.
    run: (req, _m, srv) => {
      const key = normalisePath(req.url);
      return srv.overlay.stored.has(key) ? OK(srv.overlay.stored.get(key)) : null;
    },
  },
  {
    method: 'GET',
    re: /^\/api\/prs\/(\d+)\/claude-review\/thread-check$/,
    run: (_req, m) => OK({ prId: Number(m[1]), check: null, progress: null }),
  },
  {
    method: 'GET',
    re: /^\/api\/prs\/(\d+)\/claude-review\/status$/,
    run: () => OK({ status: 'idle', reviewId: null, progress: null }),
  },
  {
    method: 'GET',
    re: /^\/api\/pro\/prs\/(\d+)\/ai-fix\/status$/,
    run: () => OK({ status: 'idle', fixId: null, progress: null }),
  },
  { method: 'GET', re: /^\/api\/prs\/(\d+)\/mention-candidates$/, run: (_r, _m, srv) => OK(srv.recorded('GET', '/api/users') ?? []) },
  { method: 'GET', re: /^\/api\/prs\/(\d+)\/suggested-reviewers$/, run: () => OK({ suggestedReviewers: [], users: [] }) },
  { method: 'GET', re: /^\/api\/prs\/(\d+)\/ml-labels$/, run: (_r, m, srv) => OK({ prId: Number(m[1]), labels: [], generatedAt: srv.nowIso() }) },
  { method: 'GET', re: /^\/api\/prs\/(\d+)\/sonar$/, run: (_r, m) => OK({ prId: Number(m[1]), configured: false, snapshot: null }) },
  { method: 'GET', re: /^\/api\/auto-merge$/, run: (req, _m, srv) => OK(patchRecordedGet(req, { requests: [] }, srv)) },
  { method: 'GET', re: /^\/api\/claude-reviews\/active$/, run: () => OK({ reviews: [] }) },
  { method: 'GET', re: /^\/api\/mergers$/, run: () => OK([]) },
  { method: 'GET', re: /^\/api\/auth\/providers$/, run: () => OK({ providers: [] }) },
];

// ── the overlay, folded into recorded reads ───────────────────────────────────────────────────

export function patchRecordedGet(req: DemoRequest, body: unknown, srv: DemoServer): unknown {
  const p = req.pathname;
  const o = srv.overlay;
  const key = normalisePath(req.url);
  if (o.stored.has(key)) return o.stored.get(key);
  if (p === '/api/workspaces' && o.stored.has('/api/workspaces')) return o.stored.get('/api/workspaces');

  let m: RegExpMatchArray | null;
  if ((m = p.match(/^\/api\/prs\/(\d+)$/)) && isRecord(body)) return patchPrDetail(srv, Number(m[1]), body);
  if (/^\/api\/threads\/\d+$/.test(p) && isRecord(body)) return patchThread(srv, body);

  if ((p === '/api/open-prs' || p === '/api/timeline') && isRecord(body) && Array.isArray(body.prs)) {
    const gone = o.closedPrIds();
    const prs = body.prs
      .filter((x) => !(p === '/api/open-prs' && isRecord(x) && typeof x.id === 'number' && gone.has(x.id)))
      .map((x) => (isRecord(x) && typeof x.id === 'number' && o.prFields.has(x.id) ? patchListPr(x, o.prFields.get(x.id) ?? {}) : x));
    return { ...body, prs };
  }

  if (p === '/api/auto-merge' && isRecord(body)) {
    const requests = Array.isArray(body.requests) ? body.requests.filter(isRecord) : [];
    const kept = requests.filter((r) => !(typeof r.prId === 'number' && o.armed.has(r.prId)));
    const added = [...o.armed.values()].filter(isRecord);
    return { ...body, requests: [...kept, ...added] };
  }

  if (p === '/api/bot-reviewers' && isRecord(body) && Array.isArray(body.reviewers)) {
    return {
      ...body,
      reviewers: body.reviewers.map((r) => {
        const s = isRecord(r) ? o.stored.get(`bot:${String(r.userId)}`) : undefined;
        return isRecord(s) ? s : r;
      }),
    };
  }
  return body;
}

/** Only the fields a list row shares with the detail (state and clocks), never the detail's arrays. */
function patchListPr(row: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const [k, v] of Object.entries(fields)) if (k in row && !Array.isArray(v)) out[k] = v;
  return out;
}
