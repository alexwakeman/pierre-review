// THE AGENTIC RUN SIMULATOR — Claude Review, AI Fix, ticket review, CI review, Check threads and
// the story's docs check, started from the demo.
//
// A start copies a FINISHED run of the same kind from the recording (this PR's own when there is
// one, else any) as the run's TEMPLATE, gives it a new id, and plays it out on a short clock: the
// run reads as `running` for a few seconds — its stream sends a snapshot, a handful of progress
// frames and a `done` — and then as the template's finished result, re-keyed to this PR. With no
// finished run of that kind in the recording, the start answers "Not available in the demo."

import type { RecordedStreamFrame } from './recording.js';
import type { DemoReply, DemoRequest, DemoServer } from './server.js';
import { isRecord, notInDemo } from './util.js';
import { demoRunEffort, ranOnNow } from './provider.js';

export type RunKind = 'claude-review' | 'ai-fix' | 'ticket-review' | 'ci-review' | 'thread-check' | 'docs-alignment';

export interface SimulatedRun {
  kind: RunKind;
  id: number;
  /** PR id, or ticket ident for ticket reviews and docs checks. */
  key: string;
  prId: number | null;
  ident: string | null;
  startedMs: number;
  durationMs: number;
  template: Record<string, unknown>;
  /** The status the run ends in. */
  finalStatus: string;
  /** An AI Fix pushed in THIS session. Kept apart from the template, whose recorded push state
   *  belongs to another run and is cleared on every read. */
  pushed?: { pushedBranch: string; pushedAt: string };
  /** What the run runs on: the provider active when it STARTED and its model of the template's depth
   *  (a switch afterwards leaves it alone, as on the server). */
  ranOn: { provider: 'claude' | 'codex'; model: string; effort?: string };
}

/** A review or AI Fix stores the effort it ran at (Settings → AI → Effort); other kinds store none. */
function ranOnWithEffort(
  srv: DemoServer,
  kind: RunKind,
  ran: { provider: 'claude' | 'codex'; model: string },
): SimulatedRun['ranOn'] {
  return kind === 'claude-review' || kind === 'ai-fix' ? { ...ran, effort: demoRunEffort(srv, ran) } : ran;
}

const DURATION_MS: Record<RunKind, number> = {
  'claude-review': 9000,
  'ai-fix': 9000,
  'ticket-review': 8000,
  'ci-review': 7000,
  'thread-check': 5000,
  'docs-alignment': 6000,
};

/** What each kind's progress frames say, in order. Plain English: these are shown to the reader. */
const PROGRESS: Record<RunKind, Array<{ phase: string; line: string }>> = {
  'claude-review': [
    { phase: 'cloning', line: 'Checking out the pull request' },
    { phase: 'fetching_diff', line: 'Reading the diff' },
    { phase: 'deciding', line: 'Choosing how deep to look' },
    { phase: 'reviewing', line: 'Reading the changed files' },
    { phase: 'reviewing', line: 'Checking the tests' },
    { phase: 'persisting', line: 'Saving the review' },
  ],
  'ai-fix': [
    { phase: 'cloning', line: 'Checking out the branch' },
    { phase: 'fixing', line: 'Reading the review findings' },
    { phase: 'fixing', line: 'Editing the files' },
    { phase: 'capturing', line: 'Collecting the changes' },
    { phase: 'persisting', line: 'Saving the fix' },
  ],
  'ticket-review': [
    { phase: 'preparing', line: 'Reading the ticket' },
    { phase: 'reviewing', line: 'Comparing each criterion with the code' },
    { phase: 'saving', line: 'Saving the result' },
  ],
  'ci-review': [
    { phase: 'reading_logs', line: 'Reading the failing job logs' },
    { phase: 'reviewing', line: 'Finding the cause' },
    { phase: 'saving', line: 'Saving the result' },
  ],
  'thread-check': [
    { phase: 'preparing', line: 'Collecting the changed threads' },
    { phase: 'checking', line: 'Checking each thread against the code' },
    { phase: 'saving', line: 'Saving the result' },
  ],
  'docs-alignment': [
    { phase: 'running', line: 'Choosing the relevant sections' },
    { phase: 'running', line: 'Reading the documents' },
  ],
};

export class RunSimulator {
  private readonly latest = new Map<string, SimulatedRun>();
  private readonly byId = new Map<string, SimulatedRun>();

  constructor(private readonly srv: DemoServer) {}

  // ── state ──────────────────────────────────────────────────────────────────────────────────

  latestFor(kind: RunKind, key: string | number): SimulatedRun | undefined {
    return this.latest.get(`${kind}|${key}`);
  }

  byRunId(kind: RunKind, id: number): SimulatedRun | undefined {
    return this.byId.get(`${kind}#${id}`);
  }

  isDone(run: SimulatedRun): boolean {
    return this.srv.now() >= run.startedMs + run.durationMs;
  }

  isActive(run: SimulatedRun | undefined): boolean {
    return run != null && !this.isDone(run);
  }

  statusOf(run: SimulatedRun): string {
    if (this.isDone(run)) return run.finalStatus;
    return this.srv.now() - run.startedMs < 600 ? 'queued' : 'running';
  }

  /** The run as its kind's stored object: the template, re-keyed, re-dated, with this status. */
  runObject(run: SimulatedRun): Record<string, unknown> {
    const done = this.isDone(run);
    const o: Record<string, unknown> = { ...run.template, id: run.id, status: this.statusOf(run) };
    const iso = (ms: number): string => new Date(ms).toISOString();
    if ('prId' in o && run.prId != null) o.prId = run.prId;
    if ('ident' in o && run.ident != null) o.ident = run.ident;
    if ('createdAt' in o) o.createdAt = iso(run.startedMs);
    if ('startedAt' in o) o.startedAt = iso(run.startedMs);
    for (const k of ['finishedAt', 'completedAt']) if (k in o) o[k] = done ? iso(run.startedMs + run.durationMs) : null;
    if ('trigger' in o) o.trigger = 'manual';
    if ('current' in o) o.current = true;
    if ('staleBecause' in o && Array.isArray(o.staleBecause)) o.staleBecause = [];
    for (const k of ['postedAt', 'postedReviewId', 'pushedAt', 'pushedBranch', 'pushedPrNumber', 'pushedPrUrl', 'autoPost']) {
      if (k in o) o[k] = null;
    }
    if (run.pushed) Object.assign(o, run.pushed);
    // Labelled by what THIS run ran on, never the template's provider (it may be the other one).
    if ('model' in o) Object.assign(o, run.ranOn);
    if (isRecord(o.plan) && 'model' in o.plan) o.plan = { ...o.plan, ...run.ranOn };
    if (run.kind === 'claude-review' || run.kind === 'ai-fix' || run.kind === 'thread-check') {
      const head = this.prHeadSha(run.prId);
      if (head && 'headSha' in o) o.headSha = head;
    }
    if (!done) {
      for (const k of ['error', 'refused', 'refusal']) if (k in o) o[k] = null;
    }
    return o;
  }

  private prHeadSha(prId: number | null): string | null {
    if (prId == null) return null;
    const pr = this.srv.recorded('GET', `/api/prs/${prId}`);
    return isRecord(pr) && typeof pr.headSha === 'string' ? pr.headSha : null;
  }

  progressOf(run: SimulatedRun): Record<string, unknown> | null {
    if (this.isDone(run)) return null;
    const steps = PROGRESS[run.kind];
    const frac = Math.min(0.999, (this.srv.now() - run.startedMs) / run.durationMs);
    const i = Math.min(steps.length - 1, Math.floor(frac * steps.length));
    return this.progressAt(run, i);
  }

  private progressAt(run: SimulatedRun, i: number): Record<string, unknown> {
    const steps = PROGRESS[run.kind];
    const step = steps[Math.max(0, Math.min(steps.length - 1, i))] ?? { phase: 'running', line: 'Working' };
    const recentActivity = steps.slice(0, i + 1).map((s) => s.line);
    const tokens = 4000 * (i + 1);
    const usage =
      run.kind === 'claude-review' || run.kind === 'ai-fix'
        ? { inputTokens: tokens, outputTokens: tokens / 8, cacheReadTokens: tokens * 3, cacheCreationTokens: 0, estCostUsd: 0.06 * (i + 1) }
        : { inputTokens: tokens, outputTokens: tokens / 8, costUsd: 0.02 * (i + 1) };
    return { phase: step.phase, message: step.line, recentActivity, usage };
  }

  /** The kind's stream: a snapshot now, the remaining progress steps, and `done` at the end. */
  framesFor(run: SimulatedRun): RecordedStreamFrame[] {
    const frames: RecordedStreamFrame[] = [];
    const idField = ID_FIELD[run.kind];
    const event = (type: string, extra: Record<string, unknown>): RecordedStreamFrame['data'] => ({
      type,
      status: type === 'done' ? run.finalStatus : 'running',
      [idField]: run.id,
      ...extra,
    });
    const steps = PROGRESS[run.kind];
    const elapsed = this.srv.now() - run.startedMs;
    if (this.isDone(run)) {
      frames.push({ event: 'message', data: event('snapshot', { status: run.finalStatus, progress: null }), delayMs: 0 });
      frames.push({ event: 'message', data: event('done', this.doneExtra(run)), delayMs: 50 });
      return frames;
    }
    const stepMs = run.durationMs / steps.length;
    const first = Math.min(steps.length - 1, Math.floor(elapsed / stepMs));
    frames.push({ event: 'message', data: event('snapshot', { progress: this.progressAt(run, first) }), delayMs: 0 });
    let clock = elapsed;
    for (let i = first + 1; i < steps.length; i++) {
      const at = i * stepMs;
      frames.push({ event: 'message', data: event('progress', { progress: this.progressAt(run, i) }), delayMs: Math.max(0, at - clock) });
      clock = at;
    }
    frames.push({ event: 'message', data: event('done', this.doneExtra(run)), delayMs: Math.max(0, run.durationMs - clock) + 50 });
    return frames;
  }

  private doneExtra(run: SimulatedRun): Record<string, unknown> {
    const base: Record<string, unknown> = { status: run.finalStatus };
    if (run.kind === 'ticket-review') {
      const members = Array.isArray(run.template.members) ? run.template.members : [];
      const ids = members.map((m) => (isRecord(m) ? m.prId : null)).filter((x): x is number => typeof x === 'number');
      base.memberPrIds = ids.length > 0 ? ids : run.prId != null ? [run.prId] : [];
    }
    if (run.kind === 'ci-review') base.prId = run.prId;
    return base;
  }

  // ── starting ───────────────────────────────────────────────────────────────────────────────

  start(
    kind: RunKind,
    key: string,
    prId: number | null,
    ident: string | null,
    finalStatus?: string,
    // A manual start's model menu pick (`{ provider, model }` in the body): the run goes THERE.
    pick?: { provider?: unknown; model?: unknown },
  ): SimulatedRun | null {
    const existing = this.latestFor(kind, key);
    if (existing && this.isActive(existing)) return existing;
    const template = this.findTemplate(kind, prId, ident);
    if (!template) return null;
    const run: SimulatedRun = {
      kind,
      id: this.srv.nextId(),
      key,
      prId,
      ident,
      startedMs: this.srv.now(),
      durationMs: DURATION_MS[kind],
      template,
      finalStatus: finalStatus ?? (typeof template.status === 'string' && template.status !== 'running' ? template.status : 'succeeded'),
      ranOn: ranOnWithEffort(this.srv, kind, ranOnNow(this.srv, template.model, pick)),
    };
    this.latest.set(`${kind}|${key}`, run);
    this.byId.set(`${kind}#${run.id}`, run);
    return run;
  }

  cancel(run: SimulatedRun): void {
    run.finalStatus = 'cancelled';
    run.durationMs = Math.max(0, this.srv.now() - run.startedMs);
  }

  /** A finished run of this kind from the recording, preferring the same PR / ticket. */
  findTemplate(kind: RunKind, prId: number | null, ident: string | null): Record<string, unknown> | null {
    const finished = (v: unknown): v is Record<string, unknown> =>
      isRecord(v) && (v.status === 'succeeded' || (kind === 'ai-fix' && v.status === 'planned'));
    const candidates: Array<{ own: boolean; run: Record<string, unknown> }> = [];
    const push = (own: boolean, v: unknown): void => {
      if (finished(v)) candidates.push({ own, run: v });
    };
    const prOf = (pathname: string): number | null => {
      const m = pathname.match(/^\/api\/(?:pro\/)?prs\/(\d+)\//);
      return m ? Number(m[1]) : null;
    };
    switch (kind) {
      case 'claude-review':
        for (const g of this.srv.recordedGets(/^\/api\/prs\/\d+\/claude-review$/)) {
          if (isRecord(g.body)) push(prOf(g.pathname) === prId, g.body.review);
        }
        for (const g of this.srv.recordedGets(/^\/api\/claude-reviews\/\d+$/)) push(isRecord(g.body) && g.body.prId === prId, g.body);
        break;
      case 'ai-fix':
        for (const g of this.srv.recordedGets(/^\/api\/pro\/prs\/\d+\/ai-fix$/)) {
          if (isRecord(g.body)) push(prOf(g.pathname) === prId, g.body.fix);
        }
        break;
      case 'ticket-review':
        for (const g of this.srv.recordedGets(/^\/api\/prs\/\d+\/ticket-reviews$/)) {
          const tickets = isRecord(g.body) && Array.isArray(g.body.tickets) ? g.body.tickets : [];
          for (const t of tickets) if (isRecord(t)) push(t.ident === ident, t.review);
        }
        for (const g of this.srv.recordedGets(/^\/api\/ticket-reviews\/\d+$/)) push(isRecord(g.body) && g.body.ident === ident, g.body);
        break;
      case 'ci-review':
        for (const g of this.srv.recordedGets(/^\/api\/prs\/\d+\/ci-review$/)) {
          if (isRecord(g.body)) push(prOf(g.pathname) === prId, g.body.review);
        }
        for (const g of this.srv.recordedGets(/^\/api\/ci-reviews\/\d+$/)) push(isRecord(g.body) && g.body.prId === prId, g.body);
        break;
      case 'thread-check':
        for (const g of this.srv.recordedGets(/^\/api\/prs\/\d+\/claude-review\/thread-check$/)) {
          if (isRecord(g.body)) push(prOf(g.pathname) === prId, g.body.check);
        }
        if (candidates.length === 0) {
          // The shape is small and fully known, so a check can run even with none recorded.
          candidates.push({
            own: true,
            run: {
              id: 0,
              prId,
              headSha: '',
              trigger: 'manual',
              status: 'succeeded',
              refused: null,
              error: null,
              threadsSent: 3,
              costUsd: 0.04,
              createdAt: '',
              startedAt: '',
              completedAt: '',
            },
          });
        }
        break;
      case 'docs-alignment':
        for (const g of this.srv.recordedGets(/^\/api\/docs\/story-alignment$/)) {
          if (!isRecord(g.body)) continue;
          push(g.body.ident === ident, g.body.lastSucceeded);
          push(g.body.ident === ident, g.body.run);
        }
        break;
    }
    const own = candidates.find((c) => c.own);
    return (own ?? candidates[0])?.run ?? null;
  }

  // ── routing ────────────────────────────────────────────────────────────────────────────────

  route(req: DemoRequest): DemoReply {
    const p = req.pathname;
    const g = req.method === 'GET';
    const post = req.method === 'POST';
    let m: RegExpMatchArray | null;

    // Claude Review
    if ((m = p.match(/^\/api\/prs\/(\d+)\/claude-review(\/status|\/stream|\/cancel)?$/))) {
      const prId = Number(m[1]);
      const sub = m[2] ?? '';
      const run = this.latestFor('claude-review', prId);
      if (post && sub === '') {
        const r = this.start('claude-review', String(prId), prId, null, undefined, isRecord(req.body) ? req.body : undefined);
        return r ? { status: 200, body: { reviewId: r.id, status: 'queued' } } : notInDemo();
      }
      if (!run) return null;
      if (post && sub === '/cancel') {
        this.cancel(run);
        return { status: 200, body: { status: 'cancelled' } };
      }
      if (g && sub === '/stream') return { stream: this.framesFor(run) };
      if (g && sub === '/status') {
        return { status: 200, body: { status: this.statusOf(run), reviewId: run.id, progress: this.progressOf(run), trigger: 'manual' } };
      }
      if (g && sub === '') {
        const base = this.srv.recorded('GET', req.url);
        const body: Record<string, unknown> = isRecord(base)
          ? base
          : { enabled: true, auth: 'ok', review: null, history: [] };
        const review = this.runObject(run);
        body.review = review;
        body.history = [summaryOf(review, body.history), ...(Array.isArray(body.history) ? body.history : [])];
        body.autoReview = null;
        body.autoReviewWaiting = null;
        return { status: 200, body };
      }
      return null;
    }
    if (g && (m = p.match(/^\/api\/claude-reviews\/(\d+)$/))) {
      const run = this.byRunId('claude-review', Number(m[1]));
      return run ? { status: 200, body: this.runObject(run) } : null;
    }
    if (g && p === '/api/claude-reviews/active') {
      const base = this.srv.recorded('GET', req.url);
      const reviews = isRecord(base) && Array.isArray(base.reviews) ? [...base.reviews] : [];
      for (const run of this.latest.values()) {
        if (run.kind !== 'claude-review' || !this.isActive(run) || run.prId == null) continue;
        const pr = this.srv.recorded('GET', `/api/prs/${run.prId}`);
        if (!isRecord(pr)) continue;
        reviews.push({
          reviewId: run.id,
          prId: run.prId,
          repoFullName: pr.repoFullName,
          prNumber: pr.number,
          prTitle: pr.title,
          status: this.statusOf(run),
          phase: this.progressOf(run)?.phase ?? null,
          trigger: 'manual',
        });
      }
      return { status: 200, body: { reviews } };
    }

    // AI Fix
    if ((m = p.match(/^\/api\/pro\/prs\/(\d+)\/ai-fix(\/status|\/stream|\/cancel|\/plan)?$/))) {
      const prId = Number(m[1]);
      const sub = m[2] ?? '';
      if (post && (sub === '' || sub === '/plan')) {
        const r = this.start(
          'ai-fix',
          String(prId),
          prId,
          null,
          sub === '/plan' ? 'planned' : 'succeeded',
          isRecord(req.body) ? req.body : undefined,
        );
        return r ? { status: 200, body: { fixId: r.id, status: 'queued' } } : notInDemo();
      }
      const run = this.latestFor('ai-fix', prId);
      if (!run) return null;
      if (post && sub === '/cancel') {
        this.cancel(run);
        return { status: 200, body: { status: 'cancelled' } };
      }
      if (g && sub === '/stream') return { stream: this.framesFor(run) };
      if (g && sub === '/status') {
        return { status: 200, body: { status: this.statusOf(run), fixId: run.id, progress: this.progressOf(run) } };
      }
      if (g && sub === '') {
        const base = this.srv.recorded('GET', req.url);
        const body: Record<string, unknown> = isRecord(base)
          ? base
          : { enabled: true, auth: 'ok', viewerCanPush: true, headInfo: null, fix: null, history: [] };
        const fix = this.runObject(run);
        body.fix = fix;
        body.history = [summaryOf(fix, body.history), ...(Array.isArray(body.history) ? body.history : [])];
        return { status: 200, body };
      }
      return null;
    }
    if (post && (m = p.match(/^\/api\/pro\/ai-fixes\/(\d+)\/(push|plan\/approve|plan\/discard|plan\/message)$/))) {
      const run = this.byRunId('ai-fix', Number(m[1]));
      if (!run) return null;
      if (m[2] === 'push') {
        const pr = run.prId != null ? this.srv.recorded('GET', `/api/prs/${run.prId}`) : undefined;
        const commitSha = (run.id * 7919).toString(16).padStart(40, '0');
        // A second push of the same fix is the first one's answer, not a new push.
        if (run.pushed) return { status: 200, body: { pushedBranch: run.pushed.pushedBranch, commitSha } };
        const branch = isRecord(pr) && typeof pr.headRefName === 'string' ? pr.headRefName : 'limn/ai-fix';
        run.pushed = { pushedBranch: branch, pushedAt: this.srv.nowIso() };
        return { status: 200, body: { pushedBranch: branch, commitSha } };
      }
      if (m[2] === 'plan/discard') {
        run.finalStatus = 'cancelled';
        return { status: 200, body: { status: 'cancelled' } };
      }
      // Approve (build from the plan) or a follow-up message: replay the run as a build.
      const next = this.start('ai-fix', run.key, run.prId, null, 'succeeded');
      if (next === run || !next) return { status: 200, body: { fixId: run.id, status: 'running' } };
      return { status: 200, body: { fixId: next.id, status: 'queued' } };
    }

    // Ticket review
    if (post && p === '/api/ticket-reviews') {
      const b = isRecord(req.body) ? req.body : {};
      const prId = typeof b.prId === 'number' ? b.prId : null;
      const idents = this.ticketIdentsFor(prId, typeof b.ident === 'string' ? b.ident : null);
      if (idents.length === 0) return notInDemo();
      const runs = idents.map((ident) => {
        const r = this.start('ticket-review', ident, prId, ident);
        return r
          ? { ident, ticketReviewId: r.id, outcome: 'queued', refused: null }
          : { ident, ticketReviewId: null, outcome: 'refused', refused: { reason: 'no_ticket', prCount: null } };
      });
      return { status: 200, body: { runs } };
    }
    if (g && (m = p.match(/^\/api\/ticket-reviews\/(\d+)(\/stream)?$/))) {
      const run = this.byRunId('ticket-review', Number(m[1]));
      if (!run) return null;
      return m[2] ? { stream: this.framesFor(run) } : { status: 200, body: this.runObject(run) };
    }
    if (g && (m = p.match(/^\/api\/prs\/(\d+)\/ticket-reviews$/))) {
      const base = this.srv.recorded('GET', req.url);
      if (!isRecord(base) || !Array.isArray(base.tickets)) return null;
      let touched = false;
      for (const t of base.tickets) {
        if (!isRecord(t) || typeof t.ident !== 'string') continue;
        const run = this.latestFor('ticket-review', t.ident);
        if (!run) continue;
        touched = true;
        t.review = this.runObject(run);
        t.state = this.ticketState(run, isRecord(t.state) ? t.state : {});
      }
      return touched ? { status: 200, body: base } : null;
    }

    // CI review
    if (post && p === '/api/ci-reviews') {
      const b = isRecord(req.body) ? req.body : {};
      const prId = typeof b.prId === 'number' ? b.prId : null;
      if (prId == null) return notInDemo(400);
      const r = this.start('ci-review', String(prId), prId, null);
      return r ? { status: 200, body: { outcome: 'queued', ciReviewId: r.id } } : notInDemo();
    }
    if (g && (m = p.match(/^\/api\/ci-reviews\/(\d+)(\/stream)?$/))) {
      const run = this.byRunId('ci-review', Number(m[1]));
      if (!run) return null;
      return m[2] ? { stream: this.framesFor(run) } : { status: 200, body: this.runObject(run) };
    }
    if (g && (m = p.match(/^\/api\/prs\/(\d+)\/ci-review$/))) {
      const prId = Number(m[1]);
      const run = this.latestFor('ci-review', prId);
      if (!run) return null;
      const base = this.srv.recorded('GET', req.url);
      const state = isRecord(base) && isRecord(base.state) ? base.state : {};
      return { status: 200, body: { prId, review: this.runObject(run), state: this.ciState(run, state) } };
    }

    // Check threads
    if ((m = p.match(/^\/api\/prs\/(\d+)\/claude-review\/thread-check(\/cancel)?$/))) {
      const prId = Number(m[1]);
      if (post && !m[2]) {
        const r = this.start('thread-check', String(prId), prId, null);
        if (!r) return notInDemo();
        const sent = typeof r.template.threadsSent === 'number' ? r.template.threadsSent : 1;
        return { status: 200, body: { outcome: 'queued', checkId: r.id, threadsSent: sent } };
      }
      const run = this.latestFor('thread-check', prId);
      if (!run) return null;
      if (post && m[2]) {
        this.cancel(run);
        return { status: 200, body: { cancelled: true } };
      }
      if (g && !m[2]) return { status: 200, body: { prId, check: this.runObject(run), progress: this.progressOf(run) } };
      return null;
    }

    // The story's docs check
    if (p === '/api/docs/story-alignment') {
      if (post) {
        const b = isRecord(req.body) ? req.body : {};
        const ident = typeof b.ident === 'string' ? b.ident : null;
        if (!ident) return notInDemo(400);
        const r = this.start('docs-alignment', ident, null, ident);
        return r ? { status: 200, body: { outcome: 'queued', runId: r.id } } : notInDemo();
      }
      if (g) {
        const ident = req.query.get('ident') ?? '';
        const run = this.latestFor('docs-alignment', ident);
        if (!run) return null;
        const base = this.srv.recorded('GET', req.url);
        const body: Record<string, unknown> = isRecord(base) ? base : { workspaceId: Number(req.query.get('workspace')) || 1, ident, available: true, docCount: 1 };
        const obj = this.runObject(run);
        body.run = obj;
        body.lastSucceeded = this.isDone(run) ? null : (body.lastSucceeded ?? null);
        return { status: 200, body };
      }
    }
    return null;
  }

  /** The tickets a ticket review of this PR covers: the one asked for, else the PR's recorded ones. */
  private ticketIdentsFor(prId: number | null, ident: string | null): string[] {
    if (ident) return [ident];
    if (prId == null) return [];
    const rec = this.srv.recorded('GET', `/api/prs/${prId}/ticket-reviews`);
    const tickets = isRecord(rec) && Array.isArray(rec.tickets) ? rec.tickets : [];
    return tickets.map((t) => (isRecord(t) && typeof t.ident === 'string' ? t.ident : null)).filter((x): x is string => x != null);
  }

  ticketState(run: SimulatedRun, base: Record<string, unknown>): Record<string, unknown> {
    const done = this.isDone(run);
    return {
      ident: run.ident,
      staleBecause: [],
      changedPrIds: [],
      alignment: null,
      counts: null,
      memberCount: 1,
      checkedAt: null,
      ...base,
      status: done ? 'current' : 'running',
      latestRunId: run.id,
      runningRunId: done ? null : run.id,
      ...(done && isRecord(run.template) && 'checkedAt' in base ? { checkedAt: this.srv.nowIso() } : {}),
    };
  }

  ciState(run: SimulatedRun, base: Record<string, unknown>): Record<string, unknown> {
    const done = this.isDone(run);
    return {
      prId: run.prId,
      staleBecause: null,
      headSha: null,
      counts: null,
      refused: null,
      checkedAt: null,
      ...base,
      status: done ? 'current' : 'running',
      latestRunId: run.id,
      runningRunId: done ? null : run.id,
    };
  }

  /** The Open PRs "Claude review" column's row for a PR with a run started here. */
  claudeState(run: SimulatedRun, base: Record<string, unknown> | null): Record<string, unknown> {
    const done = this.isDone(run);
    return {
      ticket: null,
      headMoved: false,
      ...(base ?? {}),
      prId: run.prId,
      reviewId: run.id,
      status: this.statusOf(run),
      verdict: done ? (run.template.verdict ?? null) : null,
      reviewedHeadSha: this.prHeadSha(run.prId),
      finishedAt: done ? new Date(run.startedMs + run.durationMs).toISOString() : null,
      trigger: 'manual',
      commitsSince: 0,
    };
  }
}

const ID_FIELD: Record<RunKind, string> = {
  'claude-review': 'reviewId',
  'ai-fix': 'fixId',
  'ticket-review': 'ticketReviewId',
  'ci-review': 'ciReviewId',
  'thread-check': 'checkId',
  'docs-alignment': 'runId',
};

/** A history row for a run: the keys of a recorded history row, filled from the run. */
function summaryOf(run: Record<string, unknown>, history: unknown): Record<string, unknown> {
  const sample = Array.isArray(history) ? history.find(isRecord) : undefined;
  if (!sample) return { ...run };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(sample)) out[k] = k in run ? run[k] : sample[k];
  // The history row's finding count is THIS run's, never the sample row's.
  if (Array.isArray(run.findings)) out.findingCount = run.findings.length;
  return out;
}
