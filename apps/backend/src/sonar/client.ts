import { SONARCLOUD_HOST } from '@pierre-review/shared';
import { JiraFetchError, jiraGetJson, nodeTransport, type JiraTransport } from '../tracker/jira/fetch.js';

// THE ONE SONARCLOUD CALLER. Every request goes to the FIXED host (`SONARCLOUD_HOST`) through the
// tracker's guarded GET (tracker/jira/fetch.ts): GET only, no redirects followed (a 3xx would
// forward the token to a host nobody chose), a 10s timeout, a response size cap, JSON only, and —
// because the cloud policy is always on here — https and public addresses only. Nothing the customer
// types becomes part of the host; an organization or project key only ever travels as a QUERY
// PARAMETER, URL-encoded by URLSearchParams.
//
// The token is sent as `Authorization: Bearer <token>` (SonarCloud user tokens).
// ⚠ NEVER LOG the headers or the token, in any form. Errors carry a CODE and never the upstream body.

export type SonarErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'timeout'
  | 'network'
  | 'redirect'
  | 'http'
  | 'not_json'
  | 'too_large'
  | 'blocked'
  | 'bad_url';

export class SonarError extends Error {
  constructor(
    public readonly code: SonarErrorCode,
    public readonly status: number | null = null,
  ) {
    super(`sonarcloud request failed: ${code}${status != null ? ` (${status})` : ''}`);
    this.name = 'SonarError';
  }
}

export type SonarParams = Record<string, string | number | boolean | null | undefined>;

export interface SonarClient {
  /** GET `<host>/<path>?<params>` and parse JSON. Throws `SonarError`. */
  get(path: string, params?: SonarParams): Promise<unknown>;
}

/** The URL of an API path on the fixed host. Exported for its test. */
export function sonarUrl(path: string, params: SonarParams = {}): string {
  const clean = path.replace(/^\/+/, '');
  if (!/^api\/[a-z_/]+$/.test(clean)) throw new SonarError('bad_url');
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
  const qs = q.toString();
  return `${SONARCLOUD_HOST}/${clean}${qs ? `?${qs}` : ''}`;
}

export function sonarClient(token: string, transport: JiraTransport = nodeTransport): SonarClient {
  return {
    async get(path, params = {}) {
      try {
        return await jiraGetJson(sonarUrl(path, params), { authorization: `Bearer ${token}` }, { cloud: true }, transport);
      } catch (err) {
        if (err instanceof SonarError) throw err;
        if (err instanceof JiraFetchError) {
          const code: SonarErrorCode = err.code === 'no_access' ? 'forbidden' : err.code;
          throw new SonarError(code, err.status);
        }
        throw new SonarError('network');
      }
    },
  };
}

/** A sentence we wrote for a SonarCloud failure — never SonarCloud's own body. */
export function sonarErrorMessage(err: unknown): string {
  const code = err instanceof SonarError ? err.code : 'network';
  switch (code) {
    case 'unauthorized':
      return 'SonarCloud refused the token. Save a new token in Settings.';
    case 'forbidden':
      return 'The token cannot read this SonarCloud project.';
    case 'not_found':
      return 'SonarCloud has no such project or organization.';
    case 'timeout':
      return 'SonarCloud did not answer in time.';
    case 'redirect':
    case 'blocked':
    case 'bad_url':
      return 'SonarCloud could not be reached.';
    case 'too_large':
      return 'SonarCloud sent more than Limn reads at once.';
    case 'not_json':
    case 'http':
    case 'network':
    default:
      return 'SonarCloud could not be reached.';
  }
}
