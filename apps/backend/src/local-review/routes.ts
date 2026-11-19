// LOCAL BRANCH REVIEW routes (docs/API.md § Local reviews; docs/SECURITY.md § Local branch reviews). Registered
// ONLY through `registerAgenticRoutes`, so nothing answers when AI is off (the clients then say "AI is off").
// Their clients are `ensemble mcp` and `ensemble review` (local-review/client.ts), over loopback.
//
//   POST /api/local-reviews               start: a git BUNDLE (base64, ≤ LOCAL_REVIEW_BUNDLE_MAX_BYTES) + the
//                                         branch facts. NEVER a filesystem path.            → ai + ai_hourly + sync
//   GET  /api/local-reviews?owner=&name=&branch=   the branch's runs, newest first          → read
//   GET  /api/local-reviews/:id?waitMs=   one run; waits ≤ LOCAL_REVIEW_WAIT_MAX_MS while it runs → read
//   POST /api/local-reviews/:id/cancel    stop a running run                                 → read
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  AI_EFFORTS,
  LOCAL_REVIEW_ANSWERS_MAX,
  LOCAL_REVIEW_BUNDLE_MAX_BYTES,
  LOCAL_REVIEW_SUBJECTS_MAX,
  LOCAL_REVIEW_WAIT_MAX_MS,
  type AiEffort,
  type LocalReview,
  type LocalReviewError,
  type LocalReviewListResponse,
  type LocalReviewStartResponse,
} from '@pierre-review/shared';
import type { AgentContext } from '../review/agent-context.js';
import { getLocalReview, listLocalReviews } from './persist.js';
import {
  cancelLocalReview,
  localReviewListItems,
  localReviewWire,
  LocalReviewRefusal,
  resolveLocalRepo,
  startLocalReview,
  waitForLocalReview,
  type LocalReviewStartInput,
} from './run.js';

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
/** A branch name as git allows it, bounded (shown in the prompt; never used as a path). */
const BRANCH = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/+-]{1,200}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The body cap: the bundle's base64 plus room for the facts. */
export const LOCAL_REVIEW_BODY_LIMIT = Math.ceil((LOCAL_REVIEW_BUNDLE_MAX_BYTES * 4) / 3) + 512 * 1024;

function bad(reply: FastifyReply, message: string, status = 400): LocalReviewError {
  reply.status(status);
  return { error: status === 400 ? 'bad_request' : 'refused', message };
}

/** The start body → the run's input, or a plain line. Pure (exported for the tests). */
export function parseStartBody(raw: unknown): LocalReviewStartInput | string {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return 'Send a JSON object.';
  const b = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const owner = str(b.owner);
  const name = str(b.name);
  if (!owner || !name || !SEGMENT.test(owner) || !SEGMENT.test(name)) return 'Send the repository as owner and name.';
  const branch = str(b.branch);
  if (!branch || !BRANCH.test(branch)) return 'Send the branch name.';
  const baseSha = str(b.baseSha);
  const headSha = str(b.headSha);
  if (!baseSha || !SHA.test(baseSha) || !headSha || !SHA.test(headSha)) return 'Send the base and head as commit ids.';
  const baseRef = str(b.baseRef) ?? '';
  if (baseRef.length > 200) return 'The base ref is too long.';
  const kind = b.kind === 'story' ? 'story' : b.kind === 'review' || b.kind == null ? 'review' : null;
  if (kind == null) return 'The kind must be "review" or "story".';
  const bundle64 = str(b.bundle);
  if (!bundle64 || !BASE64.test(bundle64)) return 'Send the branch as a git bundle (base64).';
  const bundle = Buffer.from(bundle64, 'base64');
  if (bundle.length === 0) return 'The bundle is empty.';
  if (bundle.length > LOCAL_REVIEW_BUNDLE_MAX_BYTES) return `The bundle is larger than ${Math.round(LOCAL_REVIEW_BUNDLE_MAX_BYTES / (1024 * 1024))} MB.`;
  const subjects = Array.isArray(b.subjects) ? b.subjects.filter((s): s is string => typeof s === 'string').slice(0, LOCAL_REVIEW_SUBJECTS_MAX).map((s) => s.slice(0, 300)) : [];
  const ticket = b.ticket == null ? null : str(b.ticket);
  if (b.ticket != null && (ticket == null || ticket.length > 120)) return 'The ticket must be a key such as PAY-142.';
  const provider = b.provider == null ? null : b.provider === 'claude' || b.provider === 'codex' ? b.provider : undefined;
  if (provider === undefined) return 'The provider must be "claude" or "codex".';
  const effort = b.effort == null ? null : (AI_EFFORTS as readonly string[]).includes(String(b.effort)) ? (b.effort as AiEffort) : undefined;
  if (effort === undefined) return `The effort must be one of ${AI_EFFORTS.join(', ')}.`;
  if (b.answers != null && !Array.isArray(b.answers)) return 'The answers must be a list.';
  const answers = (b.answers as unknown[] | undefined) ?? [];
  if (answers.length > LOCAL_REVIEW_ANSWERS_MAX) return `Send at most ${LOCAL_REVIEW_ANSWERS_MAX} answers.`;
  return {
    owner,
    name,
    branch,
    baseRef,
    baseSha,
    headSha,
    bundle,
    subjects,
    includeUncommitted: b.includeUncommitted === true,
    uncommittedChanges: b.uncommittedChanges === true,
    kind,
    ticket: ticket?.trim() || null,
    provider,
    effort,
    answers,
  };
}

const intOf = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
};

async function repoNameOf(ctx: AgentContext, accountId: number, repoId: number): Promise<string> {
  const r = ctx.schema.repos;
  const { and, eq } = await import('drizzle-orm');
  const rows = (await ctx.db.select({ owner: r.owner, name: r.name }).from(r).where(and(eq(r.id, repoId), eq(r.accountId, accountId))).limit(1).execute()) as Array<{ owner: string; name: string }>;
  return rows[0] ? `${rows[0].owner}/${rows[0].name}` : `repository ${repoId}`;
}

export function registerLocalReviewRoutes(app: FastifyInstance, ctx: AgentContext): void {
  app.post('/api/local-reviews', { bodyLimit: LOCAL_REVIEW_BODY_LIMIT }, async (req, reply): Promise<LocalReviewStartResponse | LocalReviewError> => {
    const input = parseStartBody(req.body);
    if (typeof input === 'string') return bad(reply, input);
    try {
      return await startLocalReview(ctx, ctx.accountIdOf(req), input);
    } catch (err) {
      if (err instanceof LocalReviewRefusal) {
        reply.status(err.status);
        return { error: err.code, message: err.message };
      }
      throw err;
    }
  });

  app.get('/api/local-reviews', async (req, reply): Promise<LocalReviewListResponse | LocalReviewError> => {
    const q = req.query as { owner?: string; name?: string; branch?: string };
    if (!q.owner || !q.name || !SEGMENT.test(q.owner) || !SEGMENT.test(q.name)) return bad(reply, 'Send the repository as owner and name.');
    const branch = q.branch == null || q.branch === '' ? null : q.branch;
    if (branch != null && !BRANCH.test(branch)) return bad(reply, 'Send a branch name.');
    const accountId = ctx.accountIdOf(req);
    try {
      const repo = await resolveLocalRepo(ctx, accountId, q.owner, q.name);
      const rows = await listLocalReviews(ctx, accountId, repo.repoId, branch, 20);
      return { repo: `${repo.owner}/${repo.name}`, branch, reviews: await localReviewListItems(ctx, accountId, rows) };
    } catch (err) {
      if (err instanceof LocalReviewRefusal) {
        reply.status(err.status);
        return { error: err.code, message: err.message };
      }
      throw err;
    }
  });

  app.get('/api/local-reviews/:id', async (req, reply): Promise<LocalReview | LocalReviewError> => {
    const id = intOf((req.params as { id?: string }).id);
    if (id == null) return bad(reply, 'Send a review id.');
    const accountId = ctx.accountIdOf(req);
    let row = await getLocalReview(ctx, accountId, id);
    if (!row) return bad(reply, `There is no local review ${id}.`, 404);
    const waitMs = Math.min(intOf((req.query as { waitMs?: string }).waitMs) ?? 0, LOCAL_REVIEW_WAIT_MAX_MS);
    if (row.status === 'running' && waitMs > 0) {
      await waitForLocalReview(id, waitMs);
      row = (await getLocalReview(ctx, accountId, id)) ?? row;
    }
    return localReviewWire(ctx, accountId, row, await repoNameOf(ctx, accountId, row.repoId));
  });

  app.post('/api/local-reviews/:id/cancel', async (req, reply): Promise<{ cancelled: boolean; review: LocalReview } | LocalReviewError> => {
    const id = intOf((req.params as { id?: string }).id);
    if (id == null) return bad(reply, 'Send a review id.');
    const accountId = ctx.accountIdOf(req);
    if (!(await getLocalReview(ctx, accountId, id))) return bad(reply, `There is no local review ${id}.`, 404);
    const cancelled = await cancelLocalReview(ctx, accountId, id);
    const row = (await getLocalReview(ctx, accountId, id))!;
    return { cancelled, review: await localReviewWire(ctx, accountId, row, await repoNameOf(ctx, accountId, row.repoId)) };
  });
}
