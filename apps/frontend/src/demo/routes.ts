// The demo server's hand-written routes: the account, "nothing changed" answers for every sync
// and freshness call, the batched read POSTs, and the WRITE SIMULATOR — every write the SPA can
// make, answered with a plausible success shaped by the shared types and folded into the
// in-memory overlay so later reads show it.

import {
  aiKindsAll,
  aiProviderName,
  aiRunProvider,
  isAiEffort,
  isAiProviderSetting,
  LARGE_PR_CODE_LOC_DEFAULT,
  type AiFixChecksPreview,
  type CloneStorageResponse,
  type NotionPropertyInfo,
  type NotionSchemaResponse,
  type NotionTrackerMapping,
  type StoryBuildActionResponse,
  type StoryBuildCancelResponse,
  type StoryBuildDocsDecisionsResponse,
  type StoryBuildDocsResponse,
  type StoryBuildPushResponse,
} from '@pierre-review/shared';
import { normalisePath } from './recording.js';
import type { DemoReply, DemoRequest, DemoRoute, DemoServer } from './server.js';
import { fakeSha, isRecord, notInDemo } from './util.js';
import { getAiBudget, getAiUsageReport, putAiBudget } from './aiBudget.js';
import { activeProvider, aiState, DEMO_CODEX_PLAN, ranOnNow, setAiState } from './provider.js';

const OK = (body: unknown): DemoReply => ({ status: 200, body });

/** The "Run tests" picker's list in the demo (`AiFixChecksPreview`). */
const DEMO_CHECKS_PREVIEW: AiFixChecksPreview = {
  sandbox: 'seatbelt',
  unavailable: null,
  unsandboxed: false,
  checks: [
    { name: 'lint', kind: 'lint', command: 'make lint', source: 'Makefile target "lint"', defaultOn: true, needsDocker: false, refused: null },
    { name: 'test', kind: 'test', command: 'make test', source: 'Makefile target "test"', defaultOn: true, needsDocker: false, refused: null },
    { name: 'test-integration', kind: 'test', command: 'make test-integration', source: 'Makefile target "test-integration"', defaultOn: false, needsDocker: true, refused: 'It starts or builds containers.' },
    { name: 'pre-commit hook', kind: 'hook', command: 'git commit (.husky/pre-commit)', source: '.husky/pre-commit', defaultOn: true, needsDocker: false, refused: null },
  ],
};

/** The demo's Jira workflow for the story view's status picker (`TicketTransition[]`). */
const DEMO_TRANSITIONS: Array<{ id: string; name: string; to: { name: string; category: 'new' | 'indeterminate' | 'done' } }> = [
  { id: '11', name: 'Back to To Do', to: { name: 'To Do', category: 'new' } },
  { id: '21', name: 'Start progress', to: { name: 'In Progress', category: 'indeterminate' } },
  { id: '31', name: 'Send to review', to: { name: 'In Review', category: 'indeterminate' } },
  { id: '41', name: 'Done', to: { name: 'Done', category: 'done' } },
];

/** The demo's reader, used when the recording has no account of its own. */
export const DEMO_USER = {
  login: 'morgan-diaz',
  githubId: '1',
  avatarUrl: null,
  displayName: 'Morgan Diaz',
};

/** The canned answer, naming the provider the demo runs on now. */
function demoAnswer(srv: DemoServer): string {
  const name = aiProviderName(activeProvider(srv));
  return `This is the demo, so ${name} is not connected here. On your own machine Limn answers this with ${name}, reading the code and the review.`;
}

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
    // The in-app conflict resolver has no simulation here (its routes would answer "Not available
    // in the demo."), so the demo hides every door to it.
    conflictResolver: false,
    ai: demoAi(srv),
    authNotices: [],
  };
}

/**
 * `/api/me`'s AI block: AI on, both providers signed in (Claude Code; Codex with ChatGPT), the choice
 * this session made (provider.ts). Every run kind is ready on either provider.
 */
function demoAi(srv: DemoServer): Record<string, unknown> {
  const st = aiState(srv);
  const provider = activeProvider(srv);
  const codexAuth = st.codexSignedIn ? ('ok' as const) : ('none' as const);
  const codexMessage = st.codexSignedIn ? null : 'Sign in to Codex with ChatGPT.';
  const auth = provider === 'codex' ? codexAuth : ('ok' as const);
  const message = provider === 'codex' ? codexMessage : null;
  return {
    enabled: true,
    // Claude and Codex come with Limn (downloaded on the first boot): both are here already.
    autoInstall: true,
    runtime: 'ready',
    runtimeMessage: null,
    auth,
    authMessage: message,
    kinds: aiKindsAll({ auth, message }),
    provider,
    providerSetting: { value: st.setting, source: 'settings' },
    effortSetting: { value: st.effort, source: 'settings' },
    providers: {
      claude: { auth: 'ok', route: 'login', message: null, runtime: 'ready', runtimeMessage: null },
      codex: {
        runtime: 'ready',
        runtimeMessage: null,
        auth: codexAuth,
        route: st.codexSignedIn ? 'login' : 'none',
        signedIn: st.codexSignedIn,
        plan: st.codexSignedIn ? DEMO_CODEX_PLAN : null,
        available: true,
        message: codexMessage,
        kinds: aiKindsAll({ auth: codexAuth, message: codexMessage }),
      },
    },
  };
}

/** The Codex sign-in's state: never waiting (the demo's sign-in finishes at once). */
function codexLogin(srv: DemoServer): Record<string, unknown> {
  const st = aiState(srv);
  return { login: { state: 'idle' }, signedIn: st.codexSignedIn, plan: st.codexSignedIn ? DEMO_CODEX_PLAN : null };
}

/** The provider that ran a review: a run started in this session, else the recorded review's. */
function reviewProviderOf(srv: DemoServer, reviewId: number): 'claude' | 'codex' | null {
  const run = srv.runs.byRunId('claude-review', reviewId);
  if (run) return run.ranOn.provider;
  const rec = srv.recorded('GET', `/api/claude-reviews/${reviewId}`);
  return isRecord(rec) ? aiRunProvider(typeof rec.provider === 'string' ? rec.provider : null, typeof rec.model === 'string' ? rec.model : null) : null;
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

/** A Notion schema answer made from a saved mapping (the demo makes no Notion call). */
export function demoNotionSchema(workspaceId: number, m: NotionTrackerMapping): NotionSchemaResponse {
  const props: NotionPropertyInfo[] = [
    { id: 'title', name: 'Name', type: 'title' },
    { id: m.uniqueId.property.id, name: m.uniqueId.property.name, type: 'unique_id', prefix: m.uniqueId.prefix },
  ];
  if (m.status != null) {
    const options = m.status.type === 'select' ? Object.keys(m.status.options) : ['Not started', 'In progress', 'In review', 'Done'];
    props.push({
      id: m.status.property.id,
      name: m.status.property.name,
      type: m.status.type,
      options,
      ...(m.status.type === 'status'
        ? { optionCategory: { 'Not started': 'new', 'In progress': 'indeterminate', 'In review': 'indeterminate', Done: 'done' } as const }
        : {}),
    });
  }
  if (m.assignee != null) props.push({ ...m.assignee, type: 'people' });
  if (m.sprint != null) {
    props.push({
      ...m.sprint.property,
      type: m.sprint.kind,
      ...(m.sprint.kind === 'relation' ? { relationDatabaseId: m.sprint.sprintDatabaseId } : {}),
      ...(m.sprint.kind === 'select' ? { options: [m.sprint.current] } : {}),
    });
  }
  if (m.issueType != null) props.push({ ...m.issueType, type: 'select', options: ['Story', 'Bug', 'Task'] });
  if (m.criteria != null) props.push({ ...m.criteria, type: 'rich_text' });
  if (m.blockedBy != null) props.push({ ...m.blockedBy, type: 'relation', relationDatabaseId: m.databaseId });
  return {
    workspaceId,
    databaseId: m.databaseId,
    title: 'Web tasks',
    properties: props,
    sprintDatabases:
      m.sprint?.kind === 'relation'
        ? { [m.sprint.property.id]: { databaseId: m.sprint.sprintDatabaseId, title: 'Web sprints', dateProperties: [m.sprint.dateProperty] } }
        : {},
    refusal: null,
    suggested: m,
  };
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
  // The Claude spend budget: simulated, never recorded (aiBudget.ts says why).
  { method: 'GET', re: /^\/api\/ai\/budget$/, run: (req, _m, srv) => getAiBudget(req, srv) },
  { method: 'PUT', re: /^\/api\/ai\/budget$/, run: (req, _m, srv) => putAiBudget(req, srv) },
  // Reports → AI usage: recorded, its cost re-worded by the demo's own subscription (aiBudget.ts).
  { method: 'GET', re: /^\/api\/ai\/usage-report$/, run: (req, _m, srv) => getAiUsageReport(req, srv) },
  // Settings → AI → Disk space: hand-written, never recorded — the real answer is the recording
  // machine's own clone cache. Fictional Acme figures: three repositories cloned, one run's checkout.
  {
    method: 'GET',
    re: /^\/api\/storage\/clones$/,
    run: () =>
      OK({
        cloneBytes: 1.3 * 1024 ** 3,
        checkouts: 1,
        checkoutBytes: 184 * 1024 * 1024,
        freedBytes30d: 2.4 * 1024 ** 3,
        lastSweepAt: null,
      } satisfies CloneStorageResponse),
  },
  // The AI provider choice and the Codex sign-in: simulated (provider.ts). A ChatGPT sign-in in the
  // demo completes at once, with no page to open.
  {
    method: 'PUT',
    re: /^\/api\/ai\/provider$/,
    run: (req, _m, srv) => {
      const value = bodyRecord(req).value;
      if (!isAiProviderSetting(value)) return { status: 400, body: { error: 'BadRequest', message: 'value must be claude, codex or auto.' } };
      setAiState(srv, { setting: value });
      return OK({ setting: { value, source: 'settings' }, provider: activeProvider(srv) });
    },
  },
  // Settings → AI → Effort: simulated (provider.ts); a later review or fix stores the level.
  {
    method: 'PUT',
    re: /^\/api\/ai\/effort$/,
    run: (req, _m, srv) => {
      const body = bodyRecord(req);
      const value = body.value;
      if (!('value' in body) || (value !== null && !isAiEffort(value))) {
        return { status: 400, body: { error: 'BadRequest', message: 'value must be low, medium, high, xhigh, max or null.' } };
      }
      setAiState(srv, { effort: value ?? null });
      return OK({ setting: { value: value ?? null, source: 'settings' } });
    },
  },
  // Settings → Issue tracker → Notion → "Change mapping": the schema read would call Notion, so the demo
  // answers it from the workspace's SAVED mapping (the recorded tracker GET): the mapped properties
  // and the Sprints database, the saved mapping as the suggestion.
  {
    method: 'GET',
    re: /^\/api\/workspaces\/(\d+)\/tracker\/notion-schema$/,
    run: (_req, m, srv) => {
      const id = Number(m[1]);
      const tracker = currentRead(srv, `/api/workspaces/${id}/tracker`) as Record<string, unknown> | null;
      const notion = (tracker?.notion ?? null) as NotionTrackerMapping | null;
      if (notion == null) {
        return { status: 400, body: { error: 'NoNotionMapping', message: 'Not available in the demo.' } };
      }
      return OK(demoNotionSchema(id, notion));
    },
  },
  { method: 'GET', re: /^\/api\/ai\/codex\/login$/, run: (_r, _m, srv) => OK(codexLogin(srv)) },
  {
    method: 'POST',
    re: /^\/api\/ai\/codex\/login$/,
    run: (_r, _m, srv) => {
      setAiState(srv, { codexSignedIn: true });
      return OK({ ...codexLogin(srv), login: { state: 'done' } });
    },
  },
  { method: 'POST', re: /^\/api\/ai\/codex\/login\/cancel$/, run: (_r, _m, srv) => OK(codexLogin(srv)) },
  {
    method: 'POST',
    re: /^\/api\/ai\/codex\/logout$/,
    run: (_r, _m, srv) => {
      setAiState(srv, { codexSignedIn: false });
      return OK({ ok: true, message: null });
    },
  },
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
  // "Run auto reviews now" / Retry on a failed auto run: the demo starts no run, so the sweep finds
  // nothing due ("Nothing to review.").
  {
    method: 'POST',
    re: /^\/api\/workspaces\/(\d+)\/auto-review\/sweep$/,
    run: (_req, m) =>
      OK({
        workspaceId: Number(m[1]),
        queued: 0,
        retried: 0,
        checksQueued: 0,
        repliesQueued: 0,
        capped: false,
        laneFull: false,
        aiNotReady: false,
        busy: false,
        off: false,
      }),
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
  // The story view's Jira status picker: a fixed workflow, and the pick kept in the overlay (the
  // story view, the sprint boards and the stacks fold it back in `patchRecordedGet`).
  {
    method: 'GET',
    re: /^\/api\/ticket-status\/transitions$/,
    run: (req) =>
      OK({
        workspaceId: Number(req.query.get('workspace') ?? 0),
        ident: req.query.get('ident') ?? '',
        transitions: DEMO_TRANSITIONS,
        canTransition: null,
      }),
  },
  {
    method: 'POST',
    re: /^\/api\/ticket-status$/,
    run: (req, _m, srv) => {
      const b = bodyRecord(req);
      const ident = typeof b.ident === 'string' ? b.ident : '';
      const t = DEMO_TRANSITIONS.find((x) => x.id === b.transitionId);
      if (ident === '' || t == null) return { status: 502, body: { error: 'JiraError', message: 'Jira refused this change.' } };
      srv.overlay.ticketStatuses.set(ident, t.to);
      return OK({ workspaceId: Number(req.query.get('workspace') ?? 0), ident, status: t.to });
    },
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
      const state = prDetail(srv, prId)?.state ?? srv.overlay.prFields.get(prId)?.state;
      if (state === 'merged' || state === 'closed') {
        // GitHub refuses a merge of a PR that is no longer open; the route passes that on as 409.
        return {
          status: 409,
          body: { error: 'NotMergeable', message: state === 'merged' ? 'This pull request is already merged.' : 'This pull request is closed.' },
        };
      }
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
  {
    method: 'POST',
    re: /^\/api\/prs\/mark-all-viewed$/,
    // The repo status panel's "Mark all seen" names its one repo: the /api/activity patch below
    // then clears that repo's blue line and sidebar dot. (An unscoped call is a no-op here.)
    run: (req, _m, srv) => {
      for (const id of numberList(bodyRecord(req).repoIds)) srv.overlay.seenRepoIds.add(id);
      return OK({ status: 'ok', count: 0 });
    },
  },
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
  // "Implement story" (docs/STORY-BUILD.md). The recorded sessions are read as recorded; every write
  // is INERT: nothing is planned, built or pushed in the demo, and every answer names the SAME session
  // (the SPA re-reads it and finds it unchanged). Start on a ticket with a recorded open session answers
  // that session (`already_open`); a pass (chat, Accept, Retry) answers its 202 shape with the session's
  // id; the docs run answers `current`; a push answers each repository "skipped" with the reason; the docs
  // ticks are kept in memory (read back through `patchRecordedGet`); Cancel and Discard change nothing.
  // The SSE stream is never recorded: an unrecorded stream simply ends (server.ts).
  { method: 'POST', re: /^\/api\/story-builds$/, run: (req, _m, srv) => startStoryBuild(srv, bodyRecord(req)) },
  {
    method: 'POST',
    re: /^\/api\/story-builds\/(\d+)\/(?:plan\/message|accept|repos\/\d+\/retry)$/,
    run: (_req, m) => ({ status: 202, body: { buildId: Number(m[1]) } satisfies StoryBuildActionResponse }),
  },
  {
    method: 'POST',
    re: /^\/api\/story-builds\/(\d+)\/docs$/,
    run: (_req, m) => OK({ outcome: 'current', buildId: Number(m[1]), message: null } satisfies StoryBuildDocsResponse),
  },
  {
    method: 'POST',
    re: /^\/api\/story-builds\/(\d+)\/(?:repos\/(\d+)\/)?push$/,
    run: (_req, m, srv) => pushStoryBuild(srv, Number(m[1]), m[2] != null ? Number(m[2]) : null),
  },
  { method: 'POST', re: /^\/api\/story-builds\/\d+\/cancel$/, run: () => OK({ status: 'idle' } satisfies StoryBuildCancelResponse) },
  { method: 'POST', re: /^\/api\/story-builds\/\d+\/discard$/, run: () => notInDemo() },
  {
    method: 'PUT',
    re: /^\/api\/story-builds\/(\d+)\/docs\/decisions$/,
    run: (req, m, srv) => {
      const id = Number(m[1]);
      const asked = isRecord(bodyRecord(req).decisions) ? (bodyRecord(req).decisions as Record<string, unknown>) : {};
      const prev = srv.overlay.stored.get(storyBuildDecisionsKey(id));
      const merged = { ...(isRecord(prev) ? prev : {}), ...asked };
      srv.overlay.stored.set(storyBuildDecisionsKey(id), merged);
      const b = recordedStoryBuilds(srv).find((x) => x.id === id);
      const decisions = { ...(isRecord(b) && isRecord(b.docsDecisions) ? b.docsDecisions : {}), ...merged } as StoryBuildDocsDecisionsResponse['decisions'];
      return OK({ decisions } satisfies StoryBuildDocsDecisionsResponse);
    },
  },
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
        // The chat answers on its REVIEW's provider (both are signed in here), as on the server.
        { id: srv.nextId(), findingId, role: 'assistant', content: demoAnswer(srv), createdAt: now, pins: null, explanations: null, ...ranOnNow(srv, 'claude-sonnet-5', { provider: reviewProviderOf(srv, reviewId) }) },
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
    run: (req, _m, srv) => OK({ workspaceId: Number(bodyRecord(req).workspaceId) || 1, answer: demoAnswer(srv), trimmedTurns: 0, model: 'demo', costUsd: null }),
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
        answer: { id: srv.nextId(), role: 'assistant', text: demoAnswer(srv), citations: [], createdAt: now, costUsd: null, ...ranOnNow(srv, 'claude-sonnet-5') },
      });
    },
  },
  // A Confluence document's "Refresh now" (docs/REFERENCE-DOCS.md § Wiki sources): the demo reads no
  // wiki, so nothing changed — the document answers as recorded, checked now (a page that cannot be
  // reached stays so).
  {
    method: 'POST',
    re: /^\/api\/docs\/(\d+)\/refresh$/,
    run: (_req, m, srv) => {
      const rec = srv.recorded('GET', '/api/docs?workspace=1');
      const docs = isRecord(rec) && Array.isArray(rec.docs) ? rec.docs : [];
      const doc = docs.find((d) => isRecord(d) && d.id === Number(m[1]));
      if (!isRecord(doc)) return notInDemo();
      const wiki = isRecord(doc.wiki) ? doc.wiki : null;
      return OK({ doc: wiki && wiki.unreachableSince == null ? { ...doc, wiki: { ...wiki, lastCheckedAt: srv.nowIso() } } : doc });
    },
  },
  // THE ADD-DOCUMENTS WIZARD's counts (docs/REFERENCE-DOCS.md § The SPA → Adding): the demo reads no
  // wiki and no repository, so each answers a fixed, fictional Acme count. Start is not in the demo.
  {
    method: 'POST',
    re: /^\/api\/docs\/wiki\/preflight$/,
    run: (req) => {
      const url = String(bodyRecord(req).url ?? '');
      const notion = /notion\.(so|site|com)/.test(url) || /^[0-9a-f-]{32,36}$/i.test(url.trim());
      if (notion) return OK({ provider: 'notion', rootTitle: 'Checkout design notes', scope: { kind: 'tree' }, pageCount: 6, more: false, credentialFrom: 'wiki', existing: null });
      const space = /\/wiki\/spaces\/[^/]+\/?(overview)?$/.test(url);
      return OK(
        space
          ? { provider: 'confluence', rootTitle: 'Engineering', scope: { kind: 'space', name: 'Engineering', key: 'ENG', id: '98304' }, pageCount: 42, more: false, credentialFrom: 'jira', existing: null }
          : { provider: 'confluence', rootTitle: 'Runbooks', scope: { kind: 'tree' }, pageCount: 9, more: false, credentialFrom: 'jira', existing: null },
      );
    },
  },
  {
    method: 'POST',
    re: /^\/api\/docs\/github\/preflight$/,
    run: (req) => {
      const [owner = 'acme', repo = 'web'] = String(bodyRecord(req).repo ?? 'acme/web').split('/');
      return OK({
        owner,
        repo,
        branch: 'main',
        folders: [
          { path: '', docs: 14 },
          { path: 'docs', docs: 11 },
          { path: 'docs/adr', docs: 6 },
          { path: 'docs/runbooks', docs: 4 },
        ],
        truncated: false,
      });
    },
  },
  // Settings → Confluence / Notion: a save answers the saved settings (no token ever comes back); the
  // test reads the fictional site (or Notion).
  {
    method: 'PUT',
    re: /^\/api\/workspaces\/(\d+)\/wiki-credentials$/,
    run: (req, m, srv) => {
      const rec = srv.recorded('GET', `/api/workspaces/${m[1]}/wiki-credentials`);
      const prev = isRecord(rec) && isRecord(rec.confluence) ? rec.confluence : {};
      const prevNotion = isRecord(rec) && isRecord(rec.notion) ? rec.notion : {};
      const body = bodyRecord(req);
      const patch = isRecord(body.confluence) ? (body.confluence as Record<string, unknown>) : {};
      const notion = isRecord(body.notion) ? (body.notion as Record<string, unknown>) : {};
      return OK({
        workspaceId: Number(m[1]),
        confluence: {
          siteUrl: 'siteUrl' in patch ? patch.siteUrl ?? null : prev.siteUrl ?? null,
          email: 'email' in patch ? patch.email ?? null : prev.email ?? null,
          hasToken: 'token' in patch ? patch.token != null && patch.token !== '' : Boolean(prev.hasToken),
          jiraSite: prev.jiraSite ?? null,
        },
        notion: { hasToken: 'token' in notion ? notion.token != null && notion.token !== '' : Boolean(prevNotion.hasToken) },
      });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/workspaces\/\d+\/wiki-credentials\/check$/,
    run: (req) => OK({ ok: true, message: bodyRecord(req).provider === 'notion' ? 'Connected to Notion.' : 'Connected to acme.atlassian.net.' }),
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
  // Related repos (Settings → Workspace): a GET answers what this session saved, else the recording;
  // a PUT replaces one repo's relations, both ways, like the server (db/related-repos.ts).
  {
    method: 'GET',
    re: /^\/api\/workspaces\/(\d+)\/related-repos$/,
    run: (req, _m, srv) => {
      const key = normalisePath(req.url);
      return srv.overlay.stored.has(key) ? OK(srv.overlay.stored.get(key)) : null;
    },
  },
  {
    method: 'PUT',
    re: /^\/api\/workspaces\/(\d+)\/related-repos\/(\d+)$/,
    run: (req, m, srv) => {
      const id = Number(m[1]);
      const repoId = Number(m[2]);
      const url = `/api/workspaces/${id}/related-repos`;
      const cur = currentRead(srv, url);
      const members = numberList(workspaceList(srv).find((w) => w.id === id)?.repoIds);
      if (!members.includes(repoId)) return notInDemo(404);
      const kept = (isRecord(cur) && Array.isArray(cur.pairs) ? cur.pairs.filter(isRecord) : []).filter(
        (p) => p.repoId !== repoId && p.relatedRepoId !== repoId,
      );
      const added = numberList(bodyRecord(req).relatedRepoIds)
        .filter((r) => r !== repoId && members.includes(r))
        .map((r) => ({ repoId: Math.min(r, repoId), relatedRepoId: Math.max(r, repoId) }));
      const pairs = [...kept, ...added].sort(
        (a, b) => Number(a.repoId) - Number(b.repoId) || Number(a.relatedRepoId) - Number(b.relatedRepoId),
      );
      const next = { workspaceId: id, pairs };
      srv.overlay.stored.set(normalisePath(url), next);
      return OK(next);
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

// ── "Implement story" ─────────────────────────────────────────────────────────────────────────

const storyBuildDecisionsKey = (id: number): string => `story-build-docs:${id}`;

/** Every recorded session, from the per-ticket reads and the per-id reads. */
function recordedStoryBuilds(srv: DemoServer): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const g of srv.recordedGets(/^\/api\/story-builds$/)) {
    if (isRecord(g.body) && isRecord(g.body.build)) out.push(g.body.build);
  }
  for (const g of srv.recordedGets(/^\/api\/story-builds\/\d+$/)) {
    if (isRecord(g.body)) out.push(g.body);
  }
  return out;
}

const OPEN_STATUSES = new Set(['assessing', 'planning', 'plan_ready', 'building', 'ready']);

function startStoryBuild(srv: DemoServer, body: Record<string, unknown>): DemoReply {
  const open = recordedStoryBuilds(srv).find((b) => b.ident === body.ident && OPEN_STATUSES.has(String(b.status)));
  return open != null && typeof open.id === 'number' ? OK({ outcome: 'already_open', buildId: open.id }) : notInDemo();
}

/** Push answers every repository it names as skipped: nothing leaves the demo. */
function pushStoryBuild(srv: DemoServer, id: number, repoId: number | null): DemoReply {
  const b = recordedStoryBuilds(srv).find((x) => x.id === id);
  const repos = isRecord(b) && Array.isArray(b.repos) ? b.repos.filter(isRecord) : [];
  const named = repos.filter((r) => (repoId != null ? r.repoId === repoId : r.include === true && r.status === 'ready'));
  return OK({
    results: named.map((r) => ({
      repoId: Number(r.repoId),
      outcome: 'skipped' as const,
      prNumber: null,
      prUrl: null,
      code: null,
      error: 'Nothing is pushed from the demo.',
    })),
  } satisfies StoryBuildPushResponse);
}

/** A session read with the docs ticks this visit made. */
function patchStoryBuild(srv: DemoServer, build: Record<string, unknown>): Record<string, unknown> {
  const stored = typeof build.id === 'number' ? srv.overlay.stored.get(storyBuildDecisionsKey(build.id)) : undefined;
  return isRecord(stored) ? { ...build, docsDecisions: { ...(isRecord(build.docsDecisions) ? build.docsDecisions : {}), ...stored } } : build;
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
  // AI Fix "Run tests": the checks a head declares (live, the backend reads the PR head's manifest
  // files from GitHub — the demo has none). A fictional Acme project: three default checks, one
  // refused by the deny scan, and its pre-commit hook.
  {
    method: 'GET',
    re: /^\/api\/pro\/prs\/(\d+)\/ai-fix\/checks$/,
    run: () => OK(DEMO_CHECKS_PREVIEW),
  },
  // "Implement story": a ticket the recorder never opened has no session (the build tab's start
  // state), and "Run tests" lists the demo project's checks.
  {
    method: 'GET',
    re: /^\/api\/story-builds$/,
    run: (req) => OK({ workspaceId: Number(req.query.get('workspace') ?? 0), build: null, earlier: [] }),
  },
  { method: 'GET', re: /^\/api\/story-builds\/\d+\/repos\/\d+\/checks$/, run: () => OK(DEMO_CHECKS_PREVIEW) },
  { method: 'GET', re: /^\/api\/prs\/(\d+)\/mention-candidates$/, run: (_r, _m, srv) => OK(srv.recorded('GET', '/api/users') ?? []) },
  { method: 'GET', re: /^\/api\/prs\/(\d+)\/suggested-reviewers$/, run: () => OK({ suggestedReviewers: [], users: [] }) },
  { method: 'GET', re: /^\/api\/prs\/(\d+)\/ml-labels$/, run: (_r, m, srv) => OK({ prId: Number(m[1]), labels: [], generatedAt: srv.nowIso() }) },
  { method: 'GET', re: /^\/api\/prs\/(\d+)\/sonar$/, run: (_r, m) => OK({ prId: Number(m[1]), configured: false, snapshot: null }) },
  { method: 'GET', re: /^\/api\/auto-merge$/, run: (req, _m, srv) => OK(patchRecordedGet(req, { requests: [] }, srv)) },
  { method: 'GET', re: /^\/api\/claude-reviews\/active$/, run: () => OK({ reviews: [] }) },
  { method: 'GET', re: /^\/api\/mergers$/, run: () => OK([]) },
  { method: 'GET', re: /^\/api\/auth\/providers$/, run: () => OK({ providers: [] }) },
  // A search the recorder never typed finds nothing — never another query's hits.
  { method: 'GET', re: /^\/api\/search$/, run: (req) => OK({ query: req.query.get('q') ?? '', hits: [], people: [], stories: [], total: 0 }) },
  // A written summary nobody generated for this bot / selection: the "not written yet" answer.
  { method: 'GET', re: /^\/api\/pro\/synthesis$/, run: () => OK({ enabled: true, synthesis: null }) },
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

  if (p === '/api/activity' && isRecord(body) && Array.isArray(body.repos)) return patchActivity(srv, body);

  if (p === '/api/story-builds' && isRecord(body) && isRecord(body.build)) return { ...body, build: patchStoryBuild(srv, body.build) };
  if (/^\/api\/story-builds\/\d+$/.test(p) && isRecord(body)) return patchStoryBuild(srv, body);
  if (p === '/api/attention' && isRecord(body)) return patchAttention(srv, body).body;
  if (p === '/api/my-turn' && isRecord(body)) return patchMyTurn(srv, body);
  if (p === '/api/daily-brief' && isRecord(body)) return patchDailyBrief(srv, body);
  if (p === '/api/pro/work-plan' && isRecord(body)) return patchWorkPlan(srv, body);

  if (p === '/api/auto-merge' && isRecord(body)) {
    const requests = Array.isArray(body.requests) ? body.requests.filter(isRecord) : [];
    const kept = requests.filter((r) => !(typeof r.prId === 'number' && o.armed.has(r.prId)));
    const added = [...o.armed.values()].filter(isRecord);
    return { ...body, requests: [...kept, ...added] };
  }

  // A status the reader set from the story view's picker: the story view's two reads and the sprint boards.
  if (o.ticketStatuses.size > 0 && (p === '/api/ticket-prs' || p === '/api/ticket-story') && isRecord(body) && isRecord(body.ticket)) {
    const s = o.ticketStatuses.get(req.query.get('ident') ?? '');
    if (s != null) return { ...body, ticket: { ...body.ticket, status: s } };
  }
  if (o.ticketStatuses.size > 0 && p === '/api/sprint-graph' && isRecord(body) && Array.isArray(body.nodes)) {
    return {
      ...body,
      nodes: body.nodes.map((n) => {
        const s = isRecord(n) && typeof n.ident === 'string' ? o.ticketStatuses.get(n.ident) : undefined;
        return s != null && isRecord(n) ? { ...n, status: s } : n;
      }),
    };
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
// /api/activity: a PR opened here (mark-viewed) or a repo marked seen loses its "new since you last
// opened it", so the repo status panel's blue line and the sidebar's blue dot clear as they do live.
function patchActivity(srv: DemoServer, body: Record<string, unknown>): Record<string, unknown> {
  const o = srv.overlay;
  if (o.prFields.size === 0 && o.seenRepoIds.size === 0) return body;
  const repos = (body.repos as unknown[]).map((r) => {
    if (!isRecord(r) || !Array.isArray(r.prs)) return r;
    const seen = typeof r.repoId === 'number' && o.seenRepoIds.has(r.repoId);
    const prs = r.prs.map((x) => {
      if (!isRecord(x) || typeof x.id !== 'number') return x;
      const row = o.prFields.has(x.id) ? patchListPr(x, o.prFields.get(x.id) ?? {}) : x;
      return seen ? { ...row, newSinceLastViewed: null } : row;
    });
    const stillNew = new Set(
      prs.filter((x) => isRecord(x) && x.newSinceLastViewed != null && typeof x.id === 'number').map((x) => (x as { id: number }).id),
    );
    const unreadPrs = Array.isArray(r.unreadPrs) ? r.unreadPrs.filter((u) => isRecord(u) && stillNew.has(u.prId as number)) : r.unreadPrs;
    return { ...r, prs, unreadPrs, hasUnread: Array.isArray(unreadPrs) ? unreadPrs.length > 0 : r.hasUnread };
  });
  return { ...body, repos };
}

function patchListPr(row: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const [k, v] of Object.entries(fields)) if (k in row && !Array.isArray(v)) out[k] = v;
  return out;
}

// ── the Pending reads ─────────────────────────────────────────────────────────────────────────
//
// /api/attention, /api/my-turn, /api/daily-brief and /api/pro/work-plan are four views of ONE
// fold on the server, so the overlay reaches all four the same way: a card of a PR merged or closed
// here leaves the board, a My Turn entry whose subject was dismissed here moves to "Dismissed", and
// every count that included a removed card loses it — a tab's total, its kind and lens splits, the
// brief's lines and the work plan's totals — so a count still matches the list it opens.

type Rec = Record<string, unknown>;

/** The My Turn type a `/api/my-turn` section holds (`MyTurnCardReason`). */
const MY_TURN_SECTIONS: Record<string, string> = {
  awaitingReview: 'review_request',
  mentions: 'mention',
  threadsAwaiting: 'thread',
  threadReplies: 'thread_reply',
  commentReplies: 'comment_reply',
  pushedSince: 'pushed_since',
  ownCiRed: 'own_ci_red',
  ownConflicts: 'own_conflicts',
  redTrunks: 'trunk_red',
  approvedPrs: 'pr_approved',
  ownReady: 'own_ready',
  yourPrs: 'your_pr',
  ownThreads: 'own_thread',
  claudeReviewsToAction: 'claude_review',
  watchedRepoPrs: 'watched_repo_pr',
};

/** The dismissal subject of a My Turn entry: its PR, or its repo for a red default branch. */
function myTurnSubject(reason: unknown, prId: unknown, repoId: unknown): string | null {
  if (reason === 'trunk_red') return typeof repoId === 'number' ? `repo:${repoId}` : null;
  return typeof prId === 'number' ? `pr:${prId}` : null;
}

/** Why the overlay takes a card off the board, or null when it stays. */
function cardRemoval(srv: DemoServer, card: Rec, gone: Set<number>): 'closed' | 'dismissed' | null {
  // A red trunk names the PR that LANDED its head — already merged — and review load names no PR.
  const aboutPr = typeof card.prId === 'number' && card.arm !== 'trunk' && card.kind !== 'reviewer_load';
  if (aboutPr && gone.has(card.prId as number)) return 'closed';
  if (card.kind === 'my_turn') {
    const subject = myTurnSubject(card.reason, card.prId, card.repoId);
    if (subject && srv.overlay.dismissed.has(subject)) return 'dismissed';
  }
  return null;
}

function dismissedItem(srv: DemoServer, subject: string, reason: unknown, row: Rec): Rec {
  const [kind, id] = subject.split(':');
  return {
    target: { kind, id: Number(id) },
    repoFullName: row.repoFullName ?? '',
    prNumber: kind === 'pr' ? (row.prNumber ?? row.number ?? null) : null,
    title: row.prTitle ?? row.title ?? row.branch ?? null,
    reason,
    githubUrl: row.githubUrl ?? '',
    dismissedAt: srv.nowIso(),
  };
}

function appendDismissed(existing: unknown, added: Rec[]): Rec[] {
  const list = Array.isArray(existing) ? existing.filter(isRecord) : [];
  const key = (d: Rec): string => (isRecord(d.target) ? `${String(d.target.kind)}:${String(d.target.id)}` : '');
  const seen = new Set(list.map(key));
  for (const d of added) if (!seen.has(key(d))) (seen.add(key(d)), list.push(d));
  return list;
}

function dec(o: unknown, k: string, by = 1): void {
  if (isRecord(o) && typeof o[k] === 'number') o[k] = Math.max(0, (o[k] as number) - by);
}

function relevanceSide(card: Rec, scores: unknown): 'mine' | 'others' {
  const s = isRecord(scores) && typeof card.id === 'string' ? scores[card.id] : undefined;
  const rel = card.relevance ?? (isRecord(s) ? s.relevance : undefined);
  return rel === 'direct' || rel === 'maintained' ? 'mine' : 'others';
}

/** `pendingAuthorSideOf`, on a card as it arrives on the wire. */
function authorSide(card: Rec): 'people' | 'automation' {
  return card.automation != null ? 'automation' : 'people';
}

/** `/api/attention` with the overlay applied, and the cards it took off. */
function patchAttention(srv: DemoServer, body: Rec): { body: Rec; removed: Rec[] } {
  const o = srv.overlay;
  const gone = o.closedPrIds();
  const cards = Array.isArray(body.cards) ? body.cards.filter(isRecord) : [];
  const removed: Rec[] = [];
  const dismissed: Rec[] = [];
  const kept: Rec[] = [];
  for (const c of cards) {
    const why = cardRemoval(srv, c, gone);
    if (why == null) {
      const fields = typeof c.prId === 'number' && c.arm !== 'trunk' ? o.prFields.get(c.prId) : undefined;
      kept.push(fields ? patchListPr(c, fields) : c);
      continue;
    }
    removed.push(c);
    if (why === 'dismissed') {
      const subject = myTurnSubject(c.reason, c.prId, c.repoId);
      if (subject) dismissed.push(dismissedItem(srv, subject, c.reason, c));
    }
  }
  if (removed.length === 0) return { body: { ...body, cards: kept }, removed };

  const byId = new Map(removed.map((c) => [String(c.id), c]));
  const tabs = Array.isArray(body.tabs)
    ? body.tabs.map((t) => {
        if (!isRecord(t) || !Array.isArray(t.cardIds)) return t;
        const out: Rec = structuredClone(t);
        const hit = (t.cardIds as unknown[]).map(String).filter((id) => byId.has(id));
        if (hit.length === 0) return t;
        out.cardIds = (t.cardIds as unknown[]).filter((id) => !byId.has(String(id)));
        if (Array.isArray(t.peopleCardIds)) out.peopleCardIds = t.peopleCardIds.filter((id) => !byId.has(String(id)));
        for (const id of hit) {
          const c = byId.get(id)!;
          const kind = String(c.kind);
          const side = authorSide(c);
          dec(out, 'total');
          dec(out.kindTotals, kind);
          dec(out.authorTotals, side);
          if (isRecord(out.kindAuthorTotals)) dec(out.kindAuthorTotals[kind], side);
          if (t.key === 'my_turn') {
            const rel = relevanceSide(c, body.scores);
            dec(out.relevanceTotals, rel);
            if (isRecord(out.relevanceAuthorTotals)) dec(out.relevanceAuthorTotals[rel], side);
          }
        }
        return out;
      })
    : body.tabs;
  const scores = isRecord(body.scores) ? Object.fromEntries(Object.entries(body.scores).filter(([id]) => !byId.has(id))) : body.scores;
  return {
    body: { ...body, cards: kept, tabs, scores, myTurnDismissed: appendDismissed(body.myTurnDismissed, dismissed) },
    removed,
  };
}

/** The cards the overlay removes from one workspace's board (empty when it was not recorded). */
function removedFromBoard(srv: DemoServer, workspaceId: unknown): Rec[] {
  const ws = typeof workspaceId === 'number' ? `?workspace=${workspaceId}` : '';
  const board = srv.recorded('GET', `/api/attention${ws}`);
  return isRecord(board) ? patchAttention(srv, board).removed : [];
}

/** Take the removed cards off a `DailyBriefCounts` (or the work plan's `counts`). */
function decBriefCounts(counts: unknown, removed: Rec[]): void {
  if (!isRecord(counts)) return;
  const both = (k: string): void => {
    dec(counts, k);
    dec(counts, `${k}Total`);
  };
  for (const c of removed) {
    switch (c.kind) {
      case 'my_turn': {
        if (c.reason === 'claude_review') break; // the Claude reviews tab: never in a my_turn figure
        both('myTurn');
        const rel = c.relevance;
        if (rel === 'direct' || rel === 'maintained') both('myTurnPersonal');
        if (rel === 'direct') both('myTurnDirect');
        else if (rel === 'maintained') both('myTurnMaintained');
        else both('myTurnOther');
        break;
      }
      case 'ci_failing':
        both('ciFailing');
        break;
      case 'security':
        dec(counts, 'security');
        break;
      case 'stalled_review':
        dec(counts, 'stalled');
        break;
      case 'untouched_thread':
        dec(counts, 'untouchedThreads');
        break;
      case 'reviewer_routing':
        dec(counts, 'needsReviewer');
        break;
    }
  }
}

function patchDailyBrief(srv: DemoServer, body: Rec): Rec {
  const out: Rec = structuredClone(body);
  decBriefCounts(out.counts, removedFromBoard(srv, out.workspaceId));
  if (Array.isArray(out.rollup)) for (const line of out.rollup) if (isRecord(line)) decBriefCounts(line.counts, removedFromBoard(srv, line.workspaceId));
  return out;
}

function patchMyTurn(srv: DemoServer, body: Rec): Rec {
  const o = srv.overlay;
  const gone = o.closedPrIds();
  const out: Rec = { ...body };
  const dismissed: Rec[] = [];
  for (const [section, reason] of Object.entries(MY_TURN_SECTIONS)) {
    const rows = body[section];
    if (!Array.isArray(rows)) continue;
    out[section] = rows.filter((r) => {
      if (!isRecord(r)) return true;
      if (reason !== 'trunk_red' && typeof r.prId === 'number' && gone.has(r.prId)) return false;
      const subject = myTurnSubject(reason, r.prId, r.repoId);
      if (subject && o.dismissed.has(subject)) {
        dismissed.push(dismissedItem(srv, subject, reason, r));
        return false;
      }
      return true;
    });
  }
  if (dismissed.length > 0) out.dismissed = appendDismissed(body.dismissed, dismissed);
  return out;
}

function patchWorkPlan(srv: DemoServer, body: Rec): Rec {
  if (!isRecord(body.evidence)) return body;
  const o = srv.overlay;
  const gone = o.closedPrIds();
  const out: Rec = structuredClone(body);
  const ev = out.evidence as Rec;
  const removed = removedFromBoard(srv, ev.workspaceId);
  const removedIds = new Set(removed.map((c) => String(c.id)));
  const items = Array.isArray(ev.items) ? ev.items.filter(isRecord) : [];
  const keep: Rec[] = [];
  for (const it of items) {
    const closed = it.subject === 'pr' && typeof it.prId === 'number' && gone.has(it.prId);
    if (closed || removedIds.has(String(it.cardId ?? it.id))) {
      dec(ev.totals, String(it.kind));
      continue;
    }
    const fields = it.subject === 'pr' && typeof it.prId === 'number' ? o.prFields.get(it.prId) : undefined;
    if (fields && isRecord(it.facts)) it.facts = patchListPr(it.facts, fields);
    keep.push(it);
  }
  ev.items = keep;
  decBriefCounts(ev.counts, removed);
  if (isRecord(out.plan) && Array.isArray(out.plan.steps)) {
    const ids = new Set(keep.map((it) => String(it.id)));
    out.plan.steps = out.plan.steps.filter((s) => isRecord(s) && ids.has(String(s.id)));
  }
  return out;
}
