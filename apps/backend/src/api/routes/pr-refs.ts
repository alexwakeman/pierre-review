import type { FastifyInstance } from 'fastify';
import {
  PR_REF_RESOLVE_MAX,
  type PrRefQuery,
  type ResolvePrRefsResponse,
} from '@pierre-review/shared';
import { resolvePrRefs } from '../../db/pr-refs.js';
import { accountIdOf } from '../plugins/auth.js';

// POST /api/prs/resolve — PR references in the Review tab's prose → local PR ids (CORE, free,
// both modes). DB-only: two account-scoped reads, no GitHub call and no model, so it sits on the
// `read` tier (spelled out in rate-limit.ts). The Review tab sends at most ONE batch per pane, and
// only the refs it could not resolve from data already on screen.
//
// A POST because the ref list is a body; over `PR_REF_RESOLVE_MAX` refs it 400s rather than
// truncating (a silently shorter answer would read as "these PRs do not exist").
export async function prRefRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/prs/resolve', async (req, reply): Promise<ResolvePrRefsResponse | void> => {
    const refs = parseRefs((req.body as { refs?: unknown } | null)?.refs);
    if (refs === 'invalid') return reply.code(400).send({ error: 'BadRequest', message: 'refs must be a list of { repo, number }.' });
    if (refs.length > PR_REF_RESOLVE_MAX) {
      return reply.code(400).send({ error: 'TooMany', message: `At most ${PR_REF_RESOLVE_MAX} refs per request.` });
    }
    return { refs: await resolvePrRefs(accountIdOf(req), refs) };
  });
}

/** A PR number is a Postgres int4 column; anything larger is refused here, not by the database. */
const PR_NUMBER_MAX = 2_147_483_647;

/** Exported for the route test. */
export function parseRefs(raw: unknown): PrRefQuery[] | 'invalid' {
  if (!Array.isArray(raw)) return 'invalid';
  const out: PrRefQuery[] = [];
  for (const r of raw) {
    if (r == null || typeof r !== 'object') return 'invalid';
    const { repo, number } = r as { repo?: unknown; number?: unknown };
    if (typeof repo !== 'string' || repo.trim() === '' || repo.length > 200) return 'invalid';
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > PR_NUMBER_MAX) return 'invalid';
    out.push({ repo, number });
  }
  return out;
}
