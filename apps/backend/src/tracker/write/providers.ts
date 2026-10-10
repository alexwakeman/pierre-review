import {
  parseGithubIssueKey,
  type SprintReplaceTarget,
  type SprintWriteErrorCode,
  type TrackerProvider,
} from '@pierre-review/shared';
import { JiraFetchError, jiraGetJson, jiraSendJson, nodeTransport, type JiraTransport, type RawResponse } from '../jira/fetch.js';
import { jiraAuthHeader } from '../jira/client.js';
import { linearGraphql, type LinearGqlError } from '../linear/client.js';
import type { TrackerCall } from '../types.js';
import { markdownToAdf, markdownToJiraWiki } from './adf.js';
import { GithubWriteError, ghRestPatchFor, ghRestPostFor, type FetchLike } from './github-rest.js';

// THE SPRINT WRITE-BACK'S PROVIDER HALF — one writer per tracker, two verbs each: add a COMMENT, or
// REPLACE the criteria / description. Called ONLY by ./run.ts, after a person confirmed the exact
// text on ONE ticket and the record was claimed. No agent tool, no automatic path reaches these.
//
// A writer throws on failure; `classifyWriteError` turns every failure into the record's status +
// code. A failure AFTER the request may have been sent (a timeout, a dropped connection) is
// `maybe_written` — the tracker may well have stored it, so nothing retries and the ticket says so.

export interface WriteOutcome {
  url: string | null;
}

export interface TrackerWriter {
  comment(call: TrackerCall, key: string, markdown: string): Promise<WriteOutcome>;
  replace(
    call: TrackerCall,
    key: string,
    target: SprintReplaceTarget,
    markdown: string,
    /** `fieldType`: the Jira field's schema `custom` type when already known; null → read it from
     *  the issue's edit metadata. Ignored by Linear and GitHub. */
    ctx: { fieldType: string | null },
  ): Promise<WriteOutcome>;
}

/** A failure a writer names itself (it has already decided the code). */
export class WriteFailure extends Error {
  constructor(
    public readonly code: SprintWriteErrorCode,
    public readonly maybeWritten = false,
  ) {
    super(`tracker write failed: ${code}`);
    this.name = 'WriteFailure';
  }
}

export interface ClassifiedFailure {
  status: 'failed' | 'maybe_written';
  code: SprintWriteErrorCode;
}

/** Every write failure → the record's status + code. Never reads a response body. */
export function classifyWriteError(err: unknown): ClassifiedFailure {
  if (err instanceof WriteFailure) return { status: err.maybeWritten ? 'maybe_written' : 'failed', code: err.code };
  if (err instanceof JiraFetchError) {
    switch (err.code) {
      case 'unauthorized':
      case 'forbidden':
      case 'no_access':
        return { status: 'failed', code: 'no_write_permission' };
      case 'not_found':
        return { status: 'failed', code: 'not_found' };
      case 'timeout':
      case 'network':
        return { status: 'maybe_written', code: 'timeout' };
      case 'not_json':
      case 'too_large':
        // A 2xx whose body we could not read: the tracker accepted it.
        return err.status != null && err.status >= 200 && err.status < 300
          ? { status: 'maybe_written', code: 'failed' }
          : { status: 'failed', code: 'failed' };
      case 'http':
        if (err.status === 429) return { status: 'failed', code: 'rate_limited' };
        if (err.status != null && err.status >= 400 && err.status < 500) return { status: 'failed', code: 'rejected' };
        return { status: 'failed', code: 'failed' };
      default:
        return { status: 'failed', code: 'failed' };
    }
  }
  if (err instanceof GithubWriteError) {
    if (err.status == null) return { status: 'maybe_written', code: 'timeout' };
    if (err.status === 401 || err.status === 403) return { status: 'failed', code: 'no_write_permission' };
    if (err.status === 404) return { status: 'failed', code: 'not_found' };
    if (err.status === 429) return { status: 'failed', code: 'rate_limited' };
    if (err.status >= 400 && err.status < 500) return { status: 'failed', code: 'rejected' };
    return { status: 'failed', code: 'failed' };
  }
  return { status: 'failed', code: 'failed' };
}

const httpsOrNull = (u: unknown): string | null => {
  if (typeof u !== 'string') return null;
  try {
    return new URL(u).protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
};

// ── Jira ─────────────────────────────────────────────────────────────────────────────────────────
// Cloud (an email is saved → HTTP Basic, the same rule as `jiraAuthHeader`) speaks v3 + ADF; Server /
// Data Center speaks v2 + wiki markup.

const isJiraCloud = (call: TrackerCall): boolean => (call.credentials.email?.trim() ?? '') !== '';

/** A single-line Jira text field takes a plain string; every other text field (a paragraph field,
 *  the description) takes ADF on v3. */
const isPlainTextField = (custom: string | null): boolean => custom != null && /:textfield$/.test(custom);

async function jiraFieldCustomType(call: TrackerCall, key: string, fieldId: string): Promise<string | null> {
  const meta = await jiraGetJson(
    `${call.apiRoot}/rest/api/3/issue/${encodeURIComponent(key)}/editmeta`,
    { authorization: jiraAuthHeader(call.credentials) },
    call.policy,
    call.transport,
  );
  const fields = (meta as { fields?: Record<string, { schema?: { custom?: unknown; type?: unknown } }> } | null)?.fields;
  if (fields == null || Object.keys(fields).length === 0) {
    // Edit metadata lists the fields THIS credential may edit; none at all means it may edit nothing.
    throw new WriteFailure('no_write_permission');
  }
  const f = fields[fieldId];
  // The field exists but is not editable here (not on the edit screen for this issue type).
  if (f == null) throw new WriteFailure('rejected');
  return typeof f.schema?.custom === 'string' ? f.schema.custom : null;
}

const jiraWriter: TrackerWriter = {
  async comment(call, key, markdown) {
    const cloud = isJiraCloud(call);
    const out = await jiraSendJson(
      `${call.apiRoot}/rest/api/${cloud ? 3 : 2}/issue/${encodeURIComponent(key)}/comment`,
      'POST',
      { authorization: jiraAuthHeader(call.credentials) },
      { body: cloud ? markdownToAdf(markdown) : markdownToJiraWiki(markdown) },
      call.policy,
      call.transport,
    );
    const id = (out as { id?: unknown } | null)?.id;
    const browse = `${call.apiRoot}/browse/${encodeURIComponent(key)}`;
    return { url: httpsOrNull(typeof id === 'string' || typeof id === 'number' ? `${browse}?focusedCommentId=${id}` : browse) };
  },
  async replace(call, key, target, markdown, ctx) {
    const cloud = isJiraCloud(call);
    const fieldId = target.kind === 'ac_field' ? target.fieldId : 'description';
    let value: unknown;
    if (!cloud) value = markdownToJiraWiki(markdown);
    else if (target.kind === 'description') value = markdownToAdf(markdown);
    else {
      const custom = ctx.fieldType ?? (await jiraFieldCustomType(call, key, target.fieldId));
      value = isPlainTextField(custom) ? markdown : markdownToAdf(markdown);
    }
    await jiraSendJson(
      `${call.apiRoot}/rest/api/${cloud ? 3 : 2}/issue/${encodeURIComponent(key)}`,
      'PUT',
      { authorization: jiraAuthHeader(call.credentials) },
      { fields: { [fieldId]: value } },
      call.policy,
      call.transport,
    );
    return { url: httpsOrNull(`${call.apiRoot}/browse/${encodeURIComponent(key)}`) };
  },
};

// ── Linear ───────────────────────────────────────────────────────────────────────────────────────

const LINEAR_ISSUE_ID_QUERY = /* GraphQL */ `
  query LimnWriteIssue($id: String!) {
    issue(id: $id) { id url }
  }
`;
export const LINEAR_COMMENT_MUTATION = /* GraphQL */ `
  mutation LimnComment($input: CommentCreateInput!) {
    commentCreate(input: $input) { success comment { url } }
  }
`;
export const LINEAR_UPDATE_MUTATION = /* GraphQL */ `
  mutation LimnIssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success issue { url } }
  }
`;

function linearErrorFailure(errors: readonly LinearGqlError[]): WriteFailure | null {
  if (errors.length === 0) return null;
  const forbidden = errors.some((e) => {
    const code = String(e?.extensions?.code ?? '').toUpperCase();
    const type = String(e?.extensions?.type ?? '').toLowerCase();
    return code === 'FORBIDDEN' || type === 'forbidden' || e?.extensions?.statusCode === 403 || /forbidden|permission|scope/i.test(String(e?.message ?? ''));
  });
  if (forbidden) return new WriteFailure('no_write_permission');
  if (errors.some((e) => /not found/i.test(String(e?.message ?? '')) || String(e?.extensions?.code ?? '').toUpperCase() === 'NOT_FOUND')) {
    return new WriteFailure('not_found');
  }
  return new WriteFailure('rejected');
}

// `linearGraphql` turns a non-2xx into a bare `http` error; a read-only key's refusal arrives as a 400
// whose BODY says forbidden. So the call's transport is wrapped to keep the last raw answer, and a
// thrown 4xx is re-read for its GraphQL errors (codes and messages only, never echoed).
async function linearCall<T>(call: TrackerCall, query: string, variables: Record<string, unknown>): Promise<{ data: T | null; errors: LinearGqlError[] }> {
  let last: RawResponse | null = null;
  const inner: JiraTransport = call.transport ?? nodeTransport;
  const wrapped: TrackerCall = {
    ...call,
    transport: async (...args) => {
      last = await inner(...args);
      return last;
    },
  };
  try {
    return await linearGraphql<T>(wrapped, query, variables);
  } catch (e) {
    const raw = last as RawResponse | null;
    if (e instanceof JiraFetchError && e.code === 'http' && e.status !== 429 && raw != null) {
      try {
        const body = JSON.parse(raw.body) as { errors?: LinearGqlError[] };
        const f = Array.isArray(body.errors) ? linearErrorFailure(body.errors) : null;
        if (f != null) throw f;
      } catch (inner2) {
        if (inner2 instanceof WriteFailure) throw inner2;
      }
    }
    throw e;
  }
}

async function linearIssueId(call: TrackerCall, key: string): Promise<string> {
  const r = await linearCall<{ issue: { id: string; url: string } | null }>(call, LINEAR_ISSUE_ID_QUERY, { id: key });
  const id = r.data?.issue?.id;
  if (typeof id === 'string' && id !== '') return id;
  throw linearErrorFailure(r.errors) ?? new WriteFailure('not_found');
}

const linearWriter: TrackerWriter = {
  async comment(call, key, markdown) {
    const issueId = await linearIssueId(call, key);
    const r = await linearCall<{ commentCreate: { success: boolean; comment: { url: string } | null } | null }>(call, LINEAR_COMMENT_MUTATION, {
      input: { issueId, body: markdown },
    });
    if (r.data?.commentCreate?.success !== true) throw linearErrorFailure(r.errors) ?? new WriteFailure('rejected');
    return { url: httpsOrNull(r.data.commentCreate.comment?.url) };
  },
  async replace(call, key, _target, markdown) {
    const issueId = await linearIssueId(call, key);
    const r = await linearCall<{ issueUpdate: { success: boolean; issue: { url: string } | null } | null }>(call, LINEAR_UPDATE_MUTATION, {
      id: issueId,
      input: { description: markdown },
    });
    if (r.data?.issueUpdate?.success !== true) throw linearErrorFailure(r.errors) ?? new WriteFailure('rejected');
    return { url: httpsOrNull(r.data.issueUpdate.issue?.url) };
  },
};

// ── GitHub Issues ────────────────────────────────────────────────────────────────────────────────

export interface GithubWriterDeps {
  /** The ACCOUNT's GitHub token, resolved per call (`getAccessToken`). */
  token(accountId: number): Promise<string>;
  fetch?: FetchLike;
}

const defaultGithubDeps: GithubWriterDeps = {
  token: async (accountId) => (await import('../../auth/account.js')).getAccessToken(accountId),
};

export function githubWriter(deps: GithubWriterDeps = defaultGithubDeps): TrackerWriter {
  const issuePath = (key: string): string => {
    const k = parseGithubIssueKey(key);
    if (k == null) throw new WriteFailure('not_found');
    return `/repos/${encodeURIComponent(k.owner)}/${encodeURIComponent(k.repo)}/issues/${k.number}`;
  };
  const tokenOf = async (call: TrackerCall): Promise<string> => {
    if (call.github == null) throw new WriteFailure('failed');
    return deps.token(call.github.accountId);
  };
  return {
    async comment(call, key, markdown) {
      const path = `${issuePath(key)}/comments`;
      const out = await ghRestPostFor(await tokenOf(call), path, { body: markdown }, deps.fetch);
      return { url: httpsOrNull((out as { html_url?: unknown } | null)?.html_url) };
    },
    async replace(call, key, _target, markdown) {
      const path = issuePath(key);
      const out = await ghRestPatchFor(await tokenOf(call), path, { body: markdown }, deps.fetch);
      return { url: httpsOrNull((out as { html_url?: unknown } | null)?.html_url) };
    },
  };
}

export const WRITERS: Record<TrackerProvider, TrackerWriter> = {
  jira: jiraWriter,
  linear: linearWriter,
  github: githubWriter(),
};
