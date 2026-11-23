import { parseTicketIdent } from '@pierre-review/shared';
import { assignGate } from './assignee.js';
import { auth, issueUrl, markTicketDue, statusChangeErrorMessage, statusGate } from './status-change.js';
import type { TrackerContext } from './context.js';
import { JiraFetchError, jiraPostFile, jiraPostJson, type JiraTransport } from './jira/fetch.js';
import { linearErrorMessage } from './linear/client.js';
import { linearCommentCreate, linearUploadFile } from './linear/upload.js';

// THE BUILD'S SCREENSHOTS ON THE TICKET — A TRACKER WRITE (docs/TRACKERS.md § The build's screenshots). Jira and
// Linear. ONE reader's press ("Post screenshots to the ticket" in the build tab) posts, under the reader's own login
// (Jira) or the workspace's Linear key. Jira:
//
//   1. each screenshot as an ATTACHMENT (`POST …/issue/<key>/attachments`, multipart, `X-Atlassian-Token: no-check`),
//      named by Ensemble (never the agent): `ensemble-<build>-<n>.png`;
//   2. ONE COMMENT (`POST …/issue/<key>/comment`, wiki markup) that shows them inline (`!name|thumbnail!`), with
//      each screen's name and the agent's verdict, said as the agent's.
//
// Behind the same `statusGate` as every Jira write (the workspace reads Jira, the ticket is one Ensemble holds).
// LINEAR (linear/upload.ts): each screenshot through Linear's file upload (a signed address, the key never sent
// there), then ONE markdown comment showing them by their asset addresses; behind `assignGate`, the gate of
// Ensemble's other Linear write.
// ⚠ Nothing here runs on its own and nothing is retried: the caller CLAIMS the post before the first write.
// ⚠ Every failure answers a sentence Ensemble wrote, never Jira's body; the log carries the CODE only.

export const TICKET_SHOTS_MAX = 10;

export interface TicketShot {
  /** Ensemble's own file name (`ensemble-<build>-<n>.png`). */
  name: string;
  png: Buffer;
}

export type PostScreensResult =
  | { ok: true; attachments: number }
  | {
      ok: false;
      status: number;
      error: string;
      message: string;
      /** Something was already written to the ticket (an attachment): the post must not be tried again. */
      wrote: boolean;
    };

const MSG_NOT_JIRA = 'Posting screenshots to the ticket works with Jira and Linear.';

/** How the comment shows a picture: Jira wiki by attachment name, Linear markdown by asset address. */
export type ShotsCommentFormat = 'jira' | 'linear';

/** Jira's answer to an upload: the stored file names (Jira may rename a clash). */
function uploadedNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a) => (a != null && typeof a === 'object' && typeof (a as { filename?: unknown }).filename === 'string' ? [(a as { filename: string }).filename] : []));
}

/** A Jira wiki image reference must not break out of `!…!`. */
const safeWikiName = (n: string): string | null => (/^[A-Za-z0-9._ ()-]{1,200}$/.test(n) ? n : null);

export type UploadShotsResult =
  | { ok: true; names: Array<string | null> }
  | { ok: false; status: number; error: string; message: string; wrote: boolean };

/**
 * Upload the shots as attachments ONLY (no comment): "Build end to end"'s ticket step puts them in its own one
 * comment. The same gate and rules as `postTicketScreenshots`. Never throws.
 */
export async function uploadTicketShots(
  ctx: TrackerContext,
  a: { accountId: number; workspaceId: number; ident: string; shots: readonly TicketShot[] },
  transport?: JiraTransport,
): Promise<UploadShotsResult> {
  const gate = await statusGate(ctx, a.accountId, a.workspaceId, a.ident, transport, MSG_NOT_JIRA);
  if (!gate.ok) return { ok: false, status: gate.status, error: gate.error, message: gate.message, wrote: false };
  const names: Array<string | null> = [];
  for (const [i, s] of a.shots.slice(0, TICKET_SHOTS_MAX).entries()) {
    try {
      const raw = await jiraPostFile(`${issueUrl(gate.call, gate.key)}/attachments`, auth(gate.call), { name: s.name, contentType: 'image/png', bytes: s.png }, gate.call.policy, gate.call.transport);
      names.push(safeWikiName(uploadedNames(raw)[0] ?? s.name));
    } catch (err) {
      const code = err instanceof JiraFetchError ? err.code : 'unknown';
      ctx.log.warn({ accountId: a.accountId, workspaceId: a.workspaceId, route: 'ticket-screens', step: 'attachment', code }, 'jira screenshot upload failed');
      return { ok: false, status: 502, error: 'JiraError', message: statusChangeErrorMessage(err), wrote: i > 0 };
    }
  }
  return { ok: true, names };
}

/**
 * Upload the shots and post the one comment. `comment(refs, format)` builds the text from what the tracker stored:
 * Jira's attachment names (wiki) or Linear's asset addresses (markdown). Never throws.
 */
export async function postTicketScreenshots(
  ctx: TrackerContext,
  a: { accountId: number; workspaceId: number; ident: string; shots: readonly TicketShot[]; comment: (refs: Array<string | null>, format: ShotsCommentFormat) => string },
  transport?: JiraTransport,
): Promise<PostScreensResult> {
  if (parseTicketIdent(a.ident)?.provider === 'linear') return postLinearScreenshots(ctx, a, transport);
  const gate = await statusGate(ctx, a.accountId, a.workspaceId, a.ident, transport, MSG_NOT_JIRA);
  if (!gate.ok) return { ok: false, status: gate.status, error: gate.error, message: gate.message, wrote: false };
  const shots = a.shots.slice(0, TICKET_SHOTS_MAX);
  if (shots.length === 0) return { ok: false, status: 400, error: 'NoScreenshots', message: 'This build has no screenshots to post.', wrote: false };
  const failed = (err: unknown, step: string, wrote: boolean): PostScreensResult => {
    const code = err instanceof JiraFetchError ? err.code : 'unknown';
    ctx.log.warn({ accountId: a.accountId, workspaceId: a.workspaceId, route: 'ticket-screens', step, code }, 'jira screenshots post failed');
    return { ok: false, status: 502, error: 'JiraError', message: statusChangeErrorMessage(err), wrote };
  };
  const names: Array<string | null> = [];
  for (const [i, s] of shots.entries()) {
    try {
      const raw = await jiraPostFile(`${issueUrl(gate.call, gate.key)}/attachments`, auth(gate.call), { name: s.name, contentType: 'image/png', bytes: s.png }, gate.call.policy, gate.call.transport);
      names.push(safeWikiName(uploadedNames(raw)[0] ?? s.name));
    } catch (err) {
      return failed(err, 'attachment', i > 0);
    }
  }
  try {
    await jiraPostJson(`${issueUrl(gate.call, gate.key)}/comment`, auth(gate.call), { body: a.comment(names, 'jira') }, gate.call.policy, gate.call.transport);
  } catch (err) {
    return failed(err, 'comment', true);
  }
  ctx.log.info({ accountId: a.accountId, workspaceId: a.workspaceId, route: 'ticket-screens', attachments: shots.length }, 'jira screenshots posted');
  await markTicketDue(ctx, a.accountId, gate.apiRoot, gate.key);
  return { ok: true, attachments: shots.length };
}

/** LINEAR: upload each shot (Linear's signed file upload), then ONE markdown comment showing them. Never throws. */
async function postLinearScreenshots(
  ctx: TrackerContext,
  a: { accountId: number; workspaceId: number; ident: string; shots: readonly TicketShot[]; comment: (refs: Array<string | null>, format: ShotsCommentFormat) => string },
  transport?: JiraTransport,
): Promise<PostScreensResult> {
  const gate = await assignGate(ctx, a.accountId, a.workspaceId, a.ident, transport);
  if (!gate.ok) return { ok: false, status: gate.status, error: gate.error, message: gate.message, wrote: false };
  if (gate.provider !== 'linear') return { ok: false, status: 400, error: 'NotLinear', message: MSG_NOT_JIRA, wrote: false };
  const shots = a.shots.slice(0, TICKET_SHOTS_MAX);
  if (shots.length === 0) return { ok: false, status: 400, error: 'NoScreenshots', message: 'This build has no screenshots to post.', wrote: false };
  const failed = (err: unknown, step: string, wrote: boolean): PostScreensResult => {
    const code = err instanceof JiraFetchError ? err.code : 'unknown';
    ctx.log.warn({ accountId: a.accountId, workspaceId: a.workspaceId, route: 'ticket-screens', provider: 'linear', step, code }, 'linear screenshots post failed');
    return { ok: false, status: 502, error: 'LinearError', message: linearErrorMessage(err), wrote };
  };
  const assets: Array<string | null> = [];
  for (const [i, s] of shots.entries()) {
    try {
      assets.push(await linearUploadFile(gate.call, { name: s.name, contentType: 'image/png', bytes: s.png }));
    } catch (err) {
      // An uploaded Linear file is not on the ticket until a comment names it, but it is stored: never retried.
      return failed(err, 'upload', i > 0);
    }
  }
  try {
    await linearCommentCreate(gate.call, gate.key, a.comment(assets, 'linear'));
  } catch (err) {
    return failed(err, 'comment', true);
  }
  ctx.log.info({ accountId: a.accountId, workspaceId: a.workspaceId, route: 'ticket-screens', provider: 'linear', attachments: shots.length }, 'linear screenshots posted');
  await markTicketDue(ctx, a.accountId, gate.apiRoot, gate.key);
  return { ok: true, attachments: shots.length };
}
