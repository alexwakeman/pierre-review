import { checkJiraUrl, guardedLookup, JiraFetchError, nodeTransport, type JiraTransport } from '../tracker/jira/fetch.js';

// THE ONE FIGMA CALLER (docs/IMPLEMENT-UI-PLAN.md § 3). Every request goes to the FIXED host `api.figma.com`
// through the tracker's guarded transport: GET only, no redirect followed (a 3xx would forward the token to a
// host nobody chose), https and public addresses only, a timeout and a size cap, JSON only. A file key or a
// node id from a ticket travels only in the PATH after a strict shape check, or URL-encoded in the QUERY.
//
// The token goes in `X-Figma-Token` (a personal access token). ⚠ NEVER LOG the headers or the token. Errors
// carry a CODE, never the upstream body. Endpoint shapes are Figma's REST API v1 (/v1/me, /v1/files/:key,
// /v1/files/:key/nodes, /v1/images/:key); the readers below parse them defensively.

export const FIGMA_HOST = 'https://api.figma.com';
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 8 * 1024 * 1024;

export type FigmaErrorCode = 'unauthorized' | 'forbidden' | 'not_found' | 'rate_limited' | 'timeout' | 'network' | 'redirect' | 'http' | 'not_json' | 'too_large' | 'bad_input';

export class FigmaError extends Error {
  constructor(
    public readonly code: FigmaErrorCode,
    public readonly status: number | null = null,
  ) {
    super(`figma request failed: ${code}${status != null ? ` (${status})` : ''}`);
    this.name = 'FigmaError';
  }
}

/** A plain sentence for a failure. Never anything Figma sent back. */
export function figmaErrorMessage(err: unknown): string {
  const code = err instanceof FigmaError ? err.code : 'network';
  switch (code) {
    case 'unauthorized':
    case 'forbidden':
      return 'Figma refused the workspace’s token. Check it in Settings → Integrations → Figma.';
    case 'not_found':
      return 'Figma has no such file or frame that this token can open.';
    case 'rate_limited':
      return 'Figma’s rate limit for this token is used up. Try again later.';
    case 'timeout':
      return 'Figma did not answer in time.';
    case 'too_large':
      return 'Figma’s answer was too large to read.';
    case 'bad_input':
      return 'That is not a Figma file Ensemble can read.';
    default:
      return 'Figma could not be read just now.';
  }
}

/** A Figma file key, as it appears in a link. */
export const isFigmaFileKey = (s: string): boolean => /^[A-Za-z0-9]{10,128}$/.test(s);
/** A node id as the API names it (`12:34`; an instance's `I12:34;56:78`). */
export const isFigmaNodeId = (s: string): boolean => /^I?\d{1,12}:\d{1,12}(;\d{1,12}:\d{1,12}){0,8}$/.test(s);

export interface FigmaClient {
  get(path: string, query?: Record<string, string>): Promise<unknown>;
}

export function figmaClient(token: string, transport: JiraTransport = nodeTransport): FigmaClient {
  return {
    async get(path, query) {
      if (!/^\/v1\/[A-Za-z0-9/_:-]+$/.test(path)) throw new FigmaError('bad_input');
      const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
      let url: URL;
      try {
        url = checkJiraUrl(`${FIGMA_HOST}${path}${qs}`, { cloud: true });
      } catch {
        throw new FigmaError('bad_input');
      }
      let res;
      try {
        res = await transport(url, { accept: 'application/json', 'user-agent': 'Ensemble', 'x-figma-token': token }, { lookup: guardedLookup(), timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
      } catch (err) {
        if (err instanceof JiraFetchError) throw new FigmaError(err.code === 'redirect' ? 'redirect' : err.code === 'timeout' ? 'timeout' : err.code === 'too_large' ? 'too_large' : 'network', err.status);
        throw new FigmaError('network');
      }
      if (res.status === 401) throw new FigmaError('unauthorized', 401);
      if (res.status === 403) throw new FigmaError('forbidden', 403);
      if (res.status === 404) throw new FigmaError('not_found', 404);
      if (res.status === 429) throw new FigmaError('rate_limited', 429);
      if (res.status < 200 || res.status >= 300) throw new FigmaError('http', res.status);
      if (!/\bjson\b/i.test(res.contentType)) throw new FigmaError('not_json', res.status);
      try {
        return JSON.parse(res.body) as unknown;
      } catch {
        throw new FigmaError('not_json', res.status);
      }
    },
  };
}
