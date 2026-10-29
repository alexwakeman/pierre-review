import { createHash } from 'node:crypto';
import {
  JIRA_MAX_BYTES,
  JIRA_TIMEOUT_MS,
  JiraFetchError,
  checkJiraUrl,
  guardedLookup,
  nodeTransport,
  type RawResponse,
} from '../jira/fetch.js';
import type { TrackerCall } from '../types.js';

// NOTION — THE CLIENT (docs/TRACKERS.md § Notion). Every Notion call goes through `notionRequest`.
//
//   • ONE FIXED HOST: `https://api.notion.com/v1`. The database URL typed in Settings is an IDENTITY
//     (its id is the ticket root), never fetched. The call rides the same transport as Jira's and
//     Linear's (tracker/jira/fetch.ts): no redirects (following one would forward the token), a 10 s
//     timeout, a 5 MiB cap, JSON only.
//   • THE TOKEN is a Notion INTERNAL INTEGRATION token (`ntn_…`, or the older `secret_…`), sent as
//     `Authorization: Bearer <token>` with a pinned `Notion-Version`. It is the workspace's sealed,
//     write-only tracker token (tracker/secret.ts); nothing here logs it, errors carry a CODE only.
//   • RATE LIMIT: Notion allows about three requests a second per integration. Calls with one token
//     are SPACED `NOTION_MIN_GAP_MS` apart (a lane per token, in memory). A 429 records Notion's
//     `Retry-After` and throws an HTTP 429; every call before that moment throws the same 429 WITHOUT
//     calling. The worker turns a 429 into a 5-minute WORKSPACE backoff (no row written), exactly as
//     for Linear.
//   • Errors: 401 `unauthorized` → `unauthorized` (a 30-minute workspace backoff); 403
//     `restricted_resource` → `forbidden`; 404 `object_not_found` (which is ALSO Notion's answer for a
//     page the integration was not given) → `not_found`; anything else → `http`.
//
// ⚠ VERSION. `2022-06-28` — the databases API (`/databases/{id}/query`). Notion's 2025 versions move
// queries to data sources; pinning keeps every call on one documented shape.

export const NOTION_API_ORIGIN = 'https://api.notion.com';
export const NOTION_VERSION = '2022-06-28';
/** ≈ 3 requests a second. */
export const NOTION_MIN_GAP_MS = 340;
/** The longest `Retry-After` honoured (a larger value is clamped). */
export const NOTION_RETRY_AFTER_MAX_MS = 15 * 60_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;

// ---- the per-token lane (in memory; a restart forgets it, which is harmless) ----

export interface NotionClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: NotionClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
let clock: NotionClock = realClock;

const lanes = new Map<string, { next: number; limitedUntil: number }>();

const tokenFp = (token: string): string => createHash('sha256').update(`notion\0${token}`).digest('hex').slice(0, 16);

/** Test seam: a fake clock (and reset every lane). */
export function __setNotionClock(c: NotionClock | null): void {
  clock = c ?? realClock;
  lanes.clear();
}

/** True while Notion has asked this token to wait (a 429's Retry-After). */
export function isNotionLimited(token: string, now: number = clock.now()): boolean {
  return (lanes.get(tokenFp(token))?.limitedUntil ?? 0) > now;
}

/**
 * Wait for this token's next slot: calls with one token go NOTION_MIN_GAP_MS apart. ONE lane per token
 * for EVERY Notion caller — this tracker client and the Notion wiki source (reference-docs/wiki/notion.ts)
 * — so a workspace that uses one integration for both is paced once, never twice as fast.
 */
export async function waitNotionSlot(token: string): Promise<void> {
  const fp = tokenFp(token);
  const lane = lanes.get(fp) ?? { next: 0, limitedUntil: 0 };
  lanes.set(fp, lane);
  const now = clock.now();
  // ⚠ Claimed SYNCHRONOUSLY, before the await, so concurrent calls queue one gap apart.
  const at = Math.max(now, lane.next);
  lane.next = at + NOTION_MIN_GAP_MS;
  if (at > now) await clock.sleep(at - now);
}

/** The tracker's slot: as `waitNotionSlot`, but a 429 while Notion's Retry-After runs, without calling. */
async function takeSlot(token: string): Promise<void> {
  if (isNotionLimited(token)) throw new JiraFetchError('http', 429);
  await waitNotionSlot(token);
}

/** Notion's `Retry-After` (seconds) → milliseconds, clamped; the default when absent or unreadable. */
export function retryAfterMs(h: Record<string, string> | undefined): number {
  const raw = h?.['retry-after'];
  const n = raw != null ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(Math.ceil(n * 1000), NOTION_RETRY_AFTER_MAX_MS);
}

function noteLimited(token: string, h: Record<string, string> | undefined): void {
  noteNotionRetryAfter(token, retryAfterMs(h));
}

/** Notion asked this token to wait `ms` (a 429): every caller on the lane sees it (the wiki source too). */
export function noteNotionRetryAfter(token: string, ms: number): void {
  const fp = tokenFp(token);
  const lane = lanes.get(fp) ?? { next: 0, limitedUntil: 0 };
  lane.limitedUntil = Math.max(lane.limitedUntil, clock.now() + ms);
  lanes.set(fp, lane);
}

function parseJson(res: RawResponse): unknown {
  if (!/\bjson\b/i.test(res.contentType)) return undefined;
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * One Notion API call. `path` starts with `/v1/`. Returns the parsed JSON; throws `JiraFetchError`
 * (the tracker's transport-generic codes) for every failure.
 */
export async function notionRequest<T = unknown>(
  call: TrackerCall,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const token = call.credentials.token;
  if (token === '') throw new JiraFetchError('unauthorized');
  if (!path.startsWith('/v1/')) throw new JiraFetchError('bad_url');
  await takeSlot(token);
  const url = checkJiraUrl(`${NOTION_API_ORIGIN}${path}`, call.policy);
  const transport = call.transport ?? nodeTransport;
  const res = await transport(
    url,
    {
      accept: 'application/json',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      'user-agent': 'Limn',
      'notion-version': NOTION_VERSION,
      authorization: `Bearer ${token}`,
    },
    { lookup: call.policy.cloud ? guardedLookup() : undefined, timeoutMs: JIRA_TIMEOUT_MS, maxBytes: JIRA_MAX_BYTES },
    method === 'POST' ? { method: 'POST', body: JSON.stringify(body ?? {}) } : undefined,
  );
  if (res.status >= 300 && res.status < 400) throw new JiraFetchError('redirect', res.status);
  if (res.status === 429) {
    noteLimited(token, res.headers);
    throw new JiraFetchError('http', 429);
  }
  if (res.status === 401) throw new JiraFetchError('unauthorized', 401);
  if (res.status === 403) throw new JiraFetchError('forbidden', 403);
  if (res.status === 404) throw new JiraFetchError('not_found', 404);
  if (res.status < 200 || res.status >= 300) throw new JiraFetchError('http', res.status);
  const v = parseJson(res);
  if (v === undefined || v === null || typeof v !== 'object') throw new JiraFetchError('not_json', res.status);
  return v as T;
}

/** A plain-English sentence for a failure. Never anything Notion sent back. */
export function notionErrorMessage(err: unknown): string {
  const code = err instanceof JiraFetchError ? err.code : 'network';
  switch (code) {
    case 'not_found':
      return "Can't read this page. It is not in the Notion database in Settings, or the database is not shared with the integration.";
    case 'no_access':
      return "Can't read this page. The Notion integration does not have access to it.";
    case 'unauthorized':
      return 'Notion rejected this token. Save a new integration token in Settings.';
    case 'forbidden':
      return 'Notion refused the saved token. Check the integration’s capabilities and that the database is shared with it.';
    case 'bad_url':
      return 'The Notion database URL in Settings is not a Notion database link.';
    case 'redirect':
      return 'Notion answered with a redirect, which Limn does not follow.';
    case 'timeout':
      return 'Notion took too long to answer.';
    case 'not_json':
    case 'too_large':
      return 'Notion sent an answer Limn could not read.';
    case 'http':
      return err instanceof JiraFetchError && err.status === 429
        ? 'Notion’s rate limit is used up for now. Limn will read this ticket later.'
        : 'Notion answered with an error.';
    default:
      return 'Could not reach Notion.';
  }
}
