import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  SPRINT_BASE_HASH_RE,
  SPRINT_WRITE_REQUEST_ID_RE,
  type SprintReplaceTarget,
  type SprintWriteErrorBody,
  type SprintWriteMode,
  type SprintWriteResponse,
} from '@pierre-review/shared';
import { accountIdOf } from '../../api/plugins/auth.js';
import { entitledProCapabilities } from '../../pro/contract.js';
import { validateWriteText } from './validate.js';

// POST /api/sprint-stories/write — the sprint WRITE-BACK (Reports → This sprint). ONE ticket, the
// EXACT text the reader confirmed, one press. Core and in both modes (it runs no model: it sends text
// a person typed or approved), Pro on `periodReports` like the rest of Reports — the 402 comes before
// any DB work so it is identical for every workspace. No agent tool, no automatic setting, no bulk
// route. ./run.ts holds the claim-before-write, never-retry contract.
//
// ⚠ Lazy imports: ./run.ts opens the database and tracker/runtime.ts builds the shared context; a
// test importing this module must not do either.

export interface ParsedWriteBody {
  workspaceId: number;
  ident: string;
  mode: SprintWriteMode;
  text: string;
  requestId: string;
  target?: SprintReplaceTarget;
  baseHash?: string;
  assessmentId: number | null;
}

function parseTarget(raw: unknown): SprintReplaceTarget | undefined | 'bad' {
  if (raw == null) return undefined;
  if (typeof raw !== 'object') return 'bad';
  const o = raw as Record<string, unknown>;
  if (o.kind === 'description') return { kind: 'description' };
  if (o.kind === 'ac_field' && typeof o.fieldId === 'string' && typeof o.fieldName === 'string') {
    return { kind: 'ac_field', fieldId: o.fieldId, fieldName: o.fieldName };
  }
  return 'bad';
}

/** The request body, checked. Pure (exported for its test). */
export function parseWriteBody(raw: unknown): { ok: true; body: ParsedWriteBody } | { ok: false; status: 400; body: SprintWriteErrorBody } {
  const bad = (message: string) => ({ ok: false as const, status: 400 as const, body: { error: 'bad_request' as const, message } });
  if (typeof raw !== 'object' || raw == null) return bad('The request is not in the expected shape.');
  const o = raw as Record<string, unknown>;
  const workspaceId = typeof o.workspaceId === 'number' ? o.workspaceId : Number.NaN;
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) return bad('The workspace id is not valid.');
  if (o.mode !== 'comment' && o.mode !== 'replace') return bad('Choose "Add as a comment" or "Replace".');
  if (typeof o.requestId !== 'string' || !SPRINT_WRITE_REQUEST_ID_RE.test(o.requestId)) return bad('The request id is not valid.');
  if (typeof o.ident !== 'string' || o.ident.trim() === '' || o.ident.length > 512) return bad('The ticket is not valid.');
  const target = parseTarget(o.target);
  if (target === 'bad') return bad('The replace target is not valid.');
  if (o.mode === 'replace' && target == null) return bad('The replace target is missing.');
  if (o.baseHash != null && (typeof o.baseHash !== 'string' || !SPRINT_BASE_HASH_RE.test(o.baseHash))) return bad('The base text hash is not valid.');
  if (o.mode === 'replace' && o.baseHash == null) return bad('The base text hash is missing.');
  // An id column is a 32-bit integer on Postgres: a larger id would throw at the insert.
  const assessmentId =
    o.assessmentId == null
      ? null
      : typeof o.assessmentId === 'number' && Number.isSafeInteger(o.assessmentId) && o.assessmentId > 0 && o.assessmentId <= 2_147_483_647
        ? o.assessmentId
        : Number.NaN;
  if (Number.isNaN(assessmentId)) return bad('The assessment id is not valid.');
  const text = validateWriteText(o.text);
  if (!text.ok) return { ok: false, status: 400, body: { error: 'bad_text', message: text.message } };
  return {
    ok: true,
    body: {
      workspaceId,
      ident: o.ident,
      mode: o.mode,
      text: text.text,
      requestId: o.requestId,
      ...(target != null ? { target } : {}),
      ...(typeof o.baseHash === 'string' ? { baseHash: o.baseHash } : {}),
      assessmentId,
    },
  };
}

const entitled = (req: FastifyRequest): boolean => Boolean(req.account && entitledProCapabilities(req.account).periodReports);

export function registerTrackerWriteRoutes(app: FastifyInstance): void {
  app.post('/api/sprint-stories/write', async (req, reply): Promise<SprintWriteResponse | SprintWriteErrorBody | { error: string }> => {
    if (!entitled(req)) {
      reply.status(402);
      return { error: 'pro required' };
    }
    const parsed = parseWriteBody(req.body);
    if (!parsed.ok) {
      reply.status(parsed.status);
      return parsed.body;
    }
    const accountId = accountIdOf(req);
    const [{ trackerContext }, { resolveRequestWorkspaceId }, { performTrackerWrite }] = await Promise.all([
      import('../runtime.js'),
      import('../context.js'),
      import('./run.js'),
    ]);
    const ctx = trackerContext();
    const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, parsed.body.workspaceId);
    const out = await performTrackerWrite(ctx, {
      accountId,
      workspaceId,
      ident: parsed.body.ident,
      mode: parsed.body.mode,
      text: parsed.body.text,
      requestId: parsed.body.requestId,
      ...(parsed.body.target != null ? { target: parsed.body.target } : {}),
      ...(parsed.body.baseHash != null ? { baseHash: parsed.body.baseHash } : {}),
      assessmentId: parsed.body.assessmentId,
    });
    if (!out.ok) {
      reply.status(out.status);
      return out.body;
    }
    return { write: out.record };
  });
}
