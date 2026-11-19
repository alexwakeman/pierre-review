// THE CLIENT OF THE RUNNING ENSEMBLE (docs/CLAUDE-REVIEW.md § Reviewing a local branch → The client). Used by
// `ensemble mcp` (mcp-server.ts) and `ensemble review` (cli-review.ts). It never starts a backend and never runs a
// review itself: only one backend may run per data directory (instance-lock.ts), it owns the database, the spend
// ledger and the clone cache.
//
//   FINDING IT   `<dataDir>/server.lock` ({pid, port}): a missing or stale lock (a dead pid) is ONE plain line,
//                NOT_RUNNING. Requests go to 127.0.0.1:<port> with a loopback Host and NO Origin (the host guard
//                and the cross-origin guard both let a local header-less client through).
//   AI OFF       the routes are not registered: their 404 reads as ONE plain line, AI_OFF.
//
// node: built-ins and relative files only (plus shared's constants), so `ensemble mcp` starts fast and loads no
// AI package (scripts/build-release.mjs asserts it).
import { request } from 'node:http';
import {
  LOCAL_REVIEW_WAIT_MAX_MS,
  type AiEffort,
  type AiProviderId,
  type LocalReview,
  type LocalReviewAnswer,
  type LocalReviewKind,
  type LocalReviewListResponse,
  type LocalReviewStartRequest,
  type LocalReviewStartResponse,
} from '@pierre-review/shared';
import { resolveDataDir } from '../data-dir.js';
import { readInstanceLock } from '../instance-lock.js';
import { repoOf, snapshotBranch, SnapshotRefusal } from './snapshot.js';

export const NOT_RUNNING = 'Ensemble is not running. Start it with: npx ensemble-review';
export const AI_OFF = 'AI is off in Ensemble (ENSEMBLE_AI_DISABLED is set), so it cannot review. Unset ENSEMBLE_AI_DISABLED, restart Ensemble and try again.';

/** A request the client could not complete: one plain line (never a stack). */
export class ClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientError';
  }
}

export interface ClientDeps {
  /** The backend's port, or null when none runs (default: the data directory's lock). */
  port(): number | null;
  /** A folder in the reader's repository (default: the process's working folder). */
  cwd(): string;
  snapshot: typeof snapshotBranch;
}

export const defaultClientDeps: ClientDeps = {
  port: () => readInstanceLock(resolveDataDir())?.port ?? null,
  cwd: () => process.cwd(),
  snapshot: snapshotBranch,
};

interface HttpAnswer {
  status: number;
  body: unknown;
}

function call(port: number, method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try {
            parsed = text === '' ? null : JSON.parse(text);
          } catch {
            /* a non-JSON body stays text */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const messageOf = (body: unknown): string | null =>
  body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : null;

/** A route that is not registered: the app's not-found 404 ("Route POST /api/local-reviews not found",
 *  api/plugins/error-handler.ts), or Fastify's default form ("Route POST:/api/local-reviews not found"). */
const isRouteMissing = (a: HttpAnswer): boolean => a.status === 404 && /^Route [A-Z]+[: ]\/api\/local-reviews/.test(messageOf(a.body) ?? '');

export class LocalReviewClient {
  constructor(private readonly deps: ClientDeps = defaultClientDeps) {}

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    const port = this.deps.port();
    if (port == null) throw new ClientError(NOT_RUNNING);
    let a: HttpAnswer;
    try {
      a = await call(port, method, path, body, timeoutMs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') throw new ClientError(NOT_RUNNING);
      throw new ClientError(`Ensemble did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (isRouteMissing(a)) throw new ClientError(AI_OFF);
    if (a.status === 429) throw new ClientError(`Ensemble is busy: ${messageOf(a.body) ?? 'too many requests'}. Try again in a minute.`);
    if (a.status < 200 || a.status >= 300) throw new ClientError(messageOf(a.body) ?? `Ensemble answered ${a.status}.`);
    return a.body as T;
  }

  /** Snapshot the branch here and start a review (or a story check). */
  async start(o: {
    kind: LocalReviewKind;
    includeUncommitted: boolean;
    ticket?: string | null;
    provider?: AiProviderId | null;
    effort?: AiEffort | null;
    answers?: LocalReviewAnswer[];
    base?: string | null;
    path?: string | null;
  }): Promise<LocalReviewStartResponse & { repo: string; branch: string; headSha: string; uncommittedChanges: boolean; skippedFiltered: string[] }> {
    // Fail fast before the git work when nothing runs.
    if (this.deps.port() == null) throw new ClientError(NOT_RUNNING);
    let snap;
    try {
      snap = await this.deps.snapshot({ cwd: o.path ?? this.deps.cwd(), includeUncommitted: o.includeUncommitted, base: o.base ?? null });
    } catch (err) {
      if (err instanceof SnapshotRefusal) throw new ClientError(err.message);
      throw err;
    }
    const body: LocalReviewStartRequest = {
      owner: snap.owner,
      name: snap.name,
      branch: snap.branch,
      baseSha: snap.baseSha,
      baseRef: snap.baseRef,
      headSha: snap.headSha,
      bundle: snap.bundle.toString('base64'),
      subjects: snap.subjects,
      includeUncommitted: snap.includeUncommitted,
      uncommittedChanges: snap.uncommittedChanges,
      kind: o.kind,
      ticket: o.ticket ?? null,
      provider: o.provider ?? null,
      effort: o.effort ?? null,
      answers: o.answers ?? [],
    };
    const res = await this.request<LocalReviewStartResponse>('POST', '/api/local-reviews', body, 300_000);
    return { ...res, repo: `${snap.owner}/${snap.name}`, branch: snap.branch, headSha: snap.headSha, uncommittedChanges: snap.uncommittedChanges, skippedFiltered: snap.skippedFiltered };
  }

  /** One run; waits up to `waitMs` (≤ 50 s) while it runs. */
  get(id: number, waitMs = 0): Promise<LocalReview> {
    const w = Math.max(0, Math.min(Math.floor(waitMs), LOCAL_REVIEW_WAIT_MAX_MS));
    return this.request<LocalReview>('GET', `/api/local-reviews/${id}${w > 0 ? `?waitMs=${w}` : ''}`, undefined, w + 30_000);
  }

  /** The runs of this repository's branch (the current branch unless `branch` is given; `all` = every branch). */
  async list(o: { path?: string | null; branch?: string | null; all?: boolean } = {}): Promise<LocalReviewListResponse> {
    if (this.deps.port() == null) throw new ClientError(NOT_RUNNING);
    let facts;
    try {
      facts = await repoOf(o.path ?? this.deps.cwd());
    } catch (err) {
      if (err instanceof SnapshotRefusal) throw new ClientError(err.message);
      throw err;
    }
    const branch = o.all ? null : o.branch ?? facts.branch;
    const q = new URLSearchParams({ owner: facts.owner, name: facts.name, ...(branch ? { branch } : {}) });
    return this.request<LocalReviewListResponse>('GET', `/api/local-reviews?${q.toString()}`);
  }

  cancel(id: number): Promise<{ cancelled: boolean; review: LocalReview }> {
    return this.request('POST', `/api/local-reviews/${id}/cancel`, {});
  }
}
