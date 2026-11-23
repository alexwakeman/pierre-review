import { checkJiraUrl, guardedLookup, JiraFetchError, nodeTransport } from '../jira/fetch.js';
import type { TrackerCall } from '../types.js';
import { linearGraphql } from './client.js';

// LINEAR: A FILE AND A COMMENT — the two writes behind "Post screenshots to the ticket" on a Linear ticket
// (../ticket-screens.ts; docs/TRACKERS.md § The build's screenshots). Linear's own upload flow:
//
//   1. `fileUpload(contentType, filename, size)` with the workspace's key → a SIGNED upload address, the headers
//      Linear wants on the upload, and the file's `assetUrl`;
//   2. a PUT of the bytes to that address — WITHOUT the Linear key (the address is signed), with only Linear's
//      headers + the type, through the guarded transport (https, public addresses, no redirect followed);
//   3. ONE `commentCreate` (markdown) that shows the pictures by their `assetUrl`.
//
// ⚠ Every failure is a `JiraFetchError` code (the tracker's transport-generic codes); callers turn it into a
// sentence. Nothing Linear sent back is ever shown.

const UPLOAD_TIMEOUT_MS = 30_000;

const FILE_UPLOAD = `mutation EnsembleFileUpload($contentType: String!, $filename: String!, $size: Int!) {
  fileUpload(contentType: $contentType, filename: $filename, size: $size) {
    success
    uploadFile { uploadUrl assetUrl headers { key value } }
  }
}`;

const ISSUE_ID = `query EnsembleIssueId($id: String!) { issue(id: $id) { id } }`;

const COMMENT_CREATE = `mutation EnsembleComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}`;

type Errors = Array<{ message?: unknown; extensions?: { code?: unknown } }>;
const refused = (errors: Errors): boolean =>
  errors.some((e) => /FORBIDDEN|AUTHENTICATION|UNAUTHORI[SZ]ED/i.test(String(e?.extensions?.code ?? '')));

/** Linear's upload headers are forwarded as given, EXCEPT anything that carries a credential or steers the
 *  connection (those are ours to set, never Linear's answer's). */
const BLOCKED_HEADER = /^(authorization|proxy-authorization|cookie|host|content-length|transfer-encoding|connection|keep-alive|upgrade|te|trailer|expect|proxy-.*)$/i;
const HEADER_NAME = /^[A-Za-z0-9-]{1,60}$/;

/** Upload ONE file to Linear; answers its `assetUrl` (https). */
export async function linearUploadFile(call: TrackerCall, file: { name: string; contentType: string; bytes: Buffer }): Promise<string> {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(file.name) || !/^[a-z]+\/[a-z0-9.+-]+$/.test(file.contentType)) throw new JiraFetchError('bad_url');
  const { data, errors } = await linearGraphql<{
    fileUpload?: { success?: boolean | null; uploadFile?: { uploadUrl?: string | null; assetUrl?: string | null; headers?: Array<{ key?: string | null; value?: string | null }> | null } | null } | null;
  }>(call, FILE_UPLOAD, { contentType: file.contentType, filename: file.name, size: file.bytes.length });
  const up = data?.fileUpload?.uploadFile;
  if (data?.fileUpload?.success !== true || up?.uploadUrl == null || up.assetUrl == null) {
    if (refused(errors)) throw new JiraFetchError('forbidden', 403);
    throw new JiraFetchError('http', 400);
  }
  let asset: URL;
  try {
    asset = new URL(up.assetUrl);
  } catch {
    throw new JiraFetchError('bad_url');
  }
  if (asset.protocol !== 'https:' || asset.username !== '' || asset.password !== '') throw new JiraFetchError('bad_url');
  // The signed upload address: https and public only, the Linear key never sent there.
  const url = checkJiraUrl(up.uploadUrl, { cloud: true });
  const headers: Record<string, string> = { 'content-type': file.contentType, 'cache-control': 'public, max-age=31536000', 'user-agent': 'Ensemble' };
  for (const h of up.headers ?? []) {
    if (typeof h?.key === 'string' && typeof h.value === 'string' && HEADER_NAME.test(h.key) && !BLOCKED_HEADER.test(h.key) && !/[\r\n]/.test(h.value) && h.value.length <= 2000) headers[h.key.toLowerCase()] = h.value;
  }
  const transport = call.transport ?? nodeTransport;
  const res = await transport(url, headers, { lookup: guardedLookup(), timeoutMs: UPLOAD_TIMEOUT_MS, maxBytes: 64 * 1024 }, { method: 'PUT', body: `[file ${file.name}]`, bytes: file.bytes });
  if (res.status === 401 || res.status === 403) throw new JiraFetchError('forbidden', res.status);
  if (res.status < 200 || res.status >= 300) throw new JiraFetchError('http', res.status);
  return asset.href;
}

/** ONE comment (markdown) on a Linear issue named by its key (`ENG-123`). */
export async function linearCommentCreate(call: TrackerCall, key: string, body: string): Promise<void> {
  const issue = await linearGraphql<{ issue?: { id?: string | null } | null }>(call, ISSUE_ID, { id: key });
  const issueId = issue.data?.issue?.id;
  if (typeof issueId !== 'string' || issueId === '') {
    if (refused(issue.errors)) throw new JiraFetchError('forbidden', 403);
    throw new JiraFetchError('not_found', 404);
  }
  const { data, errors } = await linearGraphql<{ commentCreate?: { success?: boolean | null } | null }>(call, COMMENT_CREATE, { issueId, body });
  if (data?.commentCreate?.success !== true) {
    if (refused(errors)) throw new JiraFetchError('forbidden', 403);
    throw new JiraFetchError('http', 400);
  }
}
