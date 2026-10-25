// The ONE synthesis endpoint (plan P2.1 / D3): GET /api/pro/synthesis (a pure cache read + the
// staleness probe — it NEVER generates) and POST /api/pro/synthesis (the only billing path).
// C3's drill-down verdicts and C6's workspace bot synthesis both land here — per-feature
// endpoints are exactly what D3 forbids.
//
// ENTITLEMENT, the standard /api/pro/* stack (the registerBotBehaviourRoutes model):
//  1. Registration — the routes exist only when the plugin loads; pure OSS has no route at all
//     (the SPA never fetches: `useSynthesis` gates on the `activityDigest` capability).
//  2. Self-gate — DIGEST_ENABLED (the activityDigest AI-summary tier, exactly like bot-themes):
//     a flag-less local run answers `enabled:false`, never an error.
//  3. Cloud per-account entitlement — the host's automatic /api/pro/* 402 gate. Staying under
//     /api/pro/ is what keeps that automatic (the advisor-routes rule).
//
// SCOPE: `?workspace=` resolves via resolveRequestScope (absent/unparseable/foreign → the
// account's DEFAULT workspace — host §5.1) and `?repoIds=` survives as DATA NARROWING ONLY,
// intersected with the resolved membership exactly as behaviour-routes does. Every OTHER
// parameter names a POPULATION (the tile/bot/direction the card sits beside) and 400s on garbage
// — see synthesis/scope.ts for the split.
//
// COST DISCIPLINE (the digest/themes discipline, copied deliberately):
//  - per-account IN-FLIGHT guard (serialisation — a second click while one runs returns the
//    cached row flagged `throttled`, it never double-bills);
//  - per-account MIN-INTERVAL between BILLED generations (marked only when a model call actually
//    happened, so a $0 cache-hit click never locks the account out);
//  - the metered-plan credit gate BEFORE claiming the in-flight slot;
//  - the payload-hash $0-on-unchanged cache (synthesis/hash.ts — §8.2 fields only);
//  - `recordAiUsage` on REAL generation only (feature 'synthesis', the shared ledger), recorded
//    the moment the model answered — even if the parse then fails, the spend happened.
//
// D4 lives in synthesis/prompt.ts: ids validated ⊆ input, counts computed server-side, the
// remainder recomputed. A completely unparseable model output THROWS → the mutation errors and
// the deterministic list stays primary (§8.20) — the spend is already on the ledger.
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  StoredSynthesis,
  SynthesisCluster,
  SynthesisInput,
  SynthesisResponse,
  SynthesisScope,
} from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import type { LlmClient } from '../llm/seam.js';
import { proSchemaFor } from '../db.js';
import { resolveRequestScope } from '../insights/workspace-request.js';
import { DIGEST_MODEL } from '../llm/gate.js';
import {
  parseSynthesisParams,
  synthesisParamsError,
  synthesisScopeKey,
  type SynthesisScopeParams,
  type SynthesisWireParams,
} from './scope.js';
import { synthesisPayloadHash } from './hash.js';
import {
  SYNTHESIS_MAX_TOKENS,
  SYNTHESIS_SYSTEM,
  buildSynthesisUserPrompt,
  parseClustersOutput,
} from './prompt.js';

// Min interval between BILLED generations per account. Enforced on the spend, not the click: a
// payload-hash cache hit is free and must not arm the throttle (unlike the digest, whose
// lastRefreshAtByAccount marks whole refresh runs — that map covers a 30-repo loop; this one
// covers a single call, so the honest anchor is the moment money moved).
const MIN_INTERVAL_SEC = (() => {
  const v = process.env.PRO_SYNTHESIS_MIN_INTERVAL_SEC;
  const n = v == null ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 15;
})();

// Per-account serialisation + throttle state (the digest's inFlightAccounts shape — module-level,
// account-keyed; scope-keyed would let one account fan out N parallel Haiku calls by opening N
// drill-downs).
const inFlightAccounts = new Set<number>();
const lastBilledAtByAccount = new Map<number, number>();

interface StoredRow {
  kind: string;
  scopeKey: string;
  payloadHash: string;
  output: string;
  model: string;
  inputCount: number;
  analyzedCount: number;
  generatedAt: Date | number | null;
}

function tsToIso(v: Date | number | null): string {
  if (v == null) return new Date(0).toISOString();
  return (v instanceof Date ? v : new Date(Number(v))).toISOString();
}

/** The stored blob's shape (the `output` column). Versioned by SYNTHESIS_SCHEMA_VERSION via the
 *  payload hash — a shape change bumps the const and every row regenerates on next click. */
interface StoredOutput {
  clusters: SynthesisCluster[];
  remainderIds: string[];
  truncated: boolean;
  // (A dormant 'person' / 'person_report' row also carries `ordering` / `sections`; nothing reads
  // them since those kinds were removed 2026-10-22, and their scope keys are no longer reachable.)
}

function toWire(row: StoredRow): StoredSynthesis | null {
  let parsed: StoredOutput;
  try {
    parsed = JSON.parse(row.output) as StoredOutput;
  } catch {
    return null; // a corrupt cache row reads as "no synthesis yet", never as an error
  }
  if (!Array.isArray(parsed.clusters)) return null;
  return {
    kind: row.kind as StoredSynthesis['kind'],
    scopeKey: row.scopeKey,
    clusters: parsed.clusters,
    remainderIds: Array.isArray(parsed.remainderIds) ? parsed.remainderIds : [],
    remainderCount: Array.isArray(parsed.remainderIds) ? parsed.remainderIds.length : 0,
    analyzedCount: row.analyzedCount,
    totalCount: row.inputCount,
    truncated: parsed.truncated === true,
    model: row.model,
    generatedAt: tsToIso(row.generatedAt),
  };
}

/** Pure cache read — EXPORTED for the isolation test (the accountId predicate is what it pins). */
export async function loadSynthesis(
  ctx: ProContext,
  accountId: number,
  scopeKey: string,
): Promise<StoredRow | null> {
  const pro = proSchemaFor();
  const rows = (await ctx.db
    .select()
    .from(pro.proSynthesis)
    .where(
      and(eq(pro.proSynthesis.accountId, accountId), eq(pro.proSynthesis.scopeKey, scopeKey)),
    )
    .limit(1)
    .execute()) as StoredRow[];
  return rows[0] ?? null;
}

// Comma-separated positive-int list → number[] | null (null = "no narrowing"). Mirrors
// behaviour-routes / core parseIntList — its result is NEVER a scope, only the narrow set.
function parseIntList(raw?: string): number[] | null {
  if (raw == null || raw.trim() === '') return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : null;
}

interface ResolvedSynthesisScope {
  scope: SynthesisScope;
  scopeKey: string;
}

// Wire params → the resolver-produced descriptor + its canonical key. `null` return = the params
// could not name a population (the caller has already 400'd).
async function resolveSynthesisScope(
  ctx: ProContext,
  accountId: number,
  params: SynthesisScopeParams,
  workspaceRaw: string | undefined,
  repoIdsRaw: string | undefined,
  reply: FastifyReply,
): Promise<ResolvedSynthesisScope | null> {
  const err = synthesisParamsError(params);
  if (err) {
    void reply.code(400).send({ error: 'BadRequest', message: err });
    return null;
  }
  const resolved = await resolveRequestScope(ctx, accountId, workspaceRaw);
  const narrow = parseIntList(repoIdsRaw);
  // membership ∩ narrow — the BotScopeWire invariant (repoIds ⊆ membership), exactly what core's
  // resolveWorkspaceScope does for the drill-down routes this must mirror.
  const repoIds =
    narrow == null ? resolved.repoIds : resolved.repoIds.filter((id) => narrow.includes(id));
  return {
    scope: { ...params, workspaceId: resolved.workspaceId, repoIds },
    scopeKey: synthesisScopeKey(resolved.workspaceId, params, narrow),
  };
}

export function registerSynthesisRoutes(
  app: FastifyInstance,
  ctx: ProContext,
  llm: LlmClient,
): void {
  const disabled = (): SynthesisResponse => ({ enabled: false, synthesis: null });

  type Wire = SynthesisWireParams & { workspace?: string; repoIds?: string };

  // ── The free cached read + staleness probe. NEVER generates. ─────────────────────────────
  // Recomputes the payload hash from getSynthesisInput alone (plain DB reads — §8.2's "the free
  // GET can recompute it" is the design constraint the hash fields were chosen under). Rate tier
  // `search` (the input fold re-runs the drill-down's own population scan) — pinned in core's
  // rate-limit.test.ts.
  app.get<{ Querystring: Wire }>('/api/pro/synthesis', async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const parsed = parseSynthesisParams(req.query);
    if (!parsed.ok) {
      return reply.code(400).send({ error: 'BadRequest', message: parsed.error });
    }
    const rs = await resolveSynthesisScope(
      ctx,
      accountId,
      parsed.params,
      req.query.workspace,
      req.query.repoIds,
      reply,
    );
    if (!rs) return reply;
    const stored = await loadSynthesis(ctx, accountId, rs.scopeKey);
    const wire = stored ? toWire(stored) : null;
    if (!stored || !wire) {
      const resp: SynthesisResponse = { enabled: true, synthesis: null };
      return reply.send(resp);
    }
    const input = await ctx.queries.getSynthesisInput(accountId, rs.scope);
    const resp: SynthesisResponse = {
      enabled: true,
      synthesis: wire,
      stale: synthesisPayloadHash(rs.scopeKey, input) !== stored.payloadHash,
    };
    return reply.send(resp);
  });

  // ── Generate (the ONLY billing path). ─────────────────────────────────────────────────────
  // Params ride the query string OR the body (the bot-themes refresh convention). Rate tier `ai`.
  app.post<{ Querystring: Wire; Body?: Wire }>('/api/pro/synthesis', async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const merged: Wire = { ...(req.body ?? {}), ...req.query };
    const parsed = parseSynthesisParams(merged);
    if (!parsed.ok) {
      return reply.code(400).send({ error: 'BadRequest', message: parsed.error });
    }
    const rs = await resolveSynthesisScope(
      ctx,
      accountId,
      parsed.params,
      merged.workspace,
      merged.repoIds,
      reply,
    );
    if (!rs) return reply;

    const cachedResponse = async (
      flag: 'throttled' | 'creditsExhausted',
    ): Promise<SynthesisResponse> => {
      const stored = await loadSynthesis(ctx, accountId, rs.scopeKey);
      const base: SynthesisResponse = {
        enabled: true,
        synthesis: stored ? toWire(stored) : null,
      };
      if (flag === 'throttled') base.throttled = true;
      else base.creditsExhausted = true;
      return base;
    };

    // Serialisation: one generation per account at a time (a no-op click reads as `throttled`).
    // The slot is claimed SYNCHRONOUSLY here — no await may sit between the has() and the add(),
    // or two concurrent POSTs (any client firing two kinds in one render cycle, as the deleted
    // BriefStrip did with brief + rollup) both pass the check, both miss the not-yet-written hash cache, and both bill. The credit
    // check therefore runs INSIDE the try/finally: a blocked call holds the guard only for the
    // duration of that one lookup, and the finally releases it on every path.
    if (inFlightAccounts.has(accountId)) return reply.send(await cachedResponse('throttled'));
    // Min interval between BILLED generations — armed only when money actually moved below.
    const last = lastBilledAtByAccount.get(accountId) ?? 0;
    if (Date.now() - last < MIN_INTERVAL_SEC * 1000) {
      return reply.send(await cachedResponse('throttled'));
    }
    inFlightAccounts.add(accountId);
    try {
      // The ONE input fold (§8.3) — the same rows the drill-down lists, capped + disclosed.
      const input: SynthesisInput = await ctx.queries.getSynthesisInput(accountId, rs.scope);
      if (input.items.length === 0) {
        const resp: SynthesisResponse = { enabled: true, synthesis: null, empty: true };
        return reply.send(resp);
      }

      // $0-on-unchanged: a stored row whose payload hash matches is returned unbilled.
      const hash = synthesisPayloadHash(rs.scopeKey, input);
      const existing = await loadSynthesis(ctx, accountId, rs.scopeKey);
      if (existing && existing.payloadHash === hash) {
        const wire = toWire(existing);
        if (wire) {
          const resp: SynthesisResponse = { enabled: true, synthesis: wire, stale: false };
          return reply.send(resp);
        }
        // A corrupt cache row falls through to regenerate.
      }

      const out = await llm.complete({
        system: SYNTHESIS_SYSTEM,
        user: buildSynthesisUserPrompt(input),
        maxTokens: SYNTHESIS_MAX_TOKENS,
      });
      // The spend happened the moment the model answered — record it BEFORE the parse can fail,
      // and arm the min-interval off the same fact. Best-effort, like every other ledger write.
      lastBilledAtByAccount.set(accountId, Date.now());
      await ctx
        .recordAiUsage({
          accountId,
          seam: 'summary',
          feature: 'synthesis',
          model: out.model ?? DIGEST_MODEL,
          provider: out.provider,
          costUsd: out.costUsd,
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
        })
        .catch(() => {});

      const validated = parseClustersOutput(out.text, input);
      if (!validated) {
        // §8.20: the deterministic list stays primary; the card surfaces the mutation error.
        return reply
          .code(502)
          .send({ error: 'BadGateway', message: 'The model returned unparseable output' });
      }
      if (validated.droppedIds.length > 0) {
        ctx.log.warn(
          { accountId, scopeKey: rs.scopeKey, dropped: validated.droppedIds.length },
          'synthesis: model cited ids outside the input set — dropped',
        );
      }
      const output: StoredOutput = {
        clusters: validated.clusters,
        remainderIds: validated.remainderIds,
        truncated: input.truncated,
      };
      const outputJson = JSON.stringify(output);
      const now = new Date();
      const pro = proSchemaFor();
      await ctx.runTransaction(async (tx) => {
        await tx
          .insert(pro.proSynthesis)
          .values({
            accountId,
            scopeKey: rs.scopeKey,
            kind: rs.scope.kind,
            payloadHash: hash,
            output: outputJson,
            model: DIGEST_MODEL,
            inputCount: input.totalCount,
            analyzedCount: input.analyzedCount,
            generatedAt: now,
          })
          // ⚠ Target = the declared unique [accountId, scopeKey] (pro_synthesis_account_scope).
          // A stale target here type-checks and then raises at the first real write — the
          // 0042/0045 lesson.
          .onConflictDoUpdate({
            target: [pro.proSynthesis.accountId, pro.proSynthesis.scopeKey],
            set: {
              kind: rs.scope.kind,
              payloadHash: hash,
              output: outputJson,
              model: DIGEST_MODEL,
              inputCount: input.totalCount,
              analyzedCount: input.analyzedCount,
              generatedAt: now,
            },
          })
          .execute();
      });

      const resp: SynthesisResponse = {
        enabled: true,
        synthesis: {
          kind: rs.scope.kind,
          scopeKey: rs.scopeKey,
          clusters: output.clusters,
          remainderIds: output.remainderIds,
          remainderCount: output.remainderIds.length,
          analyzedCount: input.analyzedCount,
          totalCount: input.totalCount,
          truncated: input.truncated,
          model: DIGEST_MODEL,
          generatedAt: now.toISOString(),
        },
        stale: false,
      };
      return reply.send(resp);
    } finally {
      inFlightAccounts.delete(accountId);
    }
  });
}
