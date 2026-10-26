// The ONE work-plan endpoint: GET /api/pro/work-plan (the free evidence fold + cache read + the
// staleness probe — it NEVER generates) and POST /api/pro/work-plan (the only billing path).
// Structurally the synthesis seam, because every cost gate there is a bill somebody paid.
//
// WHAT IS FREE AND WHAT IS PAID, which is the shape of the whole feature:
//   the RANKED WORKLIST is core compute (db/work-plan.ts) folded fresh on BOTH verbs — every
//   figure, id, link and rank in it is code-derived, and it renders with or without prose;
//   the NARRATION is one Haiku call, cached in pro_work_plans and returned unbilled when the
//   evidence has not moved.
//
// ENTITLEMENT, the standard /api/pro/* stack (the registerSynthesisRoutes model):
//  1. Registration — the routes exist only when the plugin loads; pure OSS has no route at all
//     (the SPA gates `useWorkPlan` on the `workPlan` capability).
//  2. Self-gate — DIGEST_ENABLED (the paid summary tier): a flag-less local run answers
//     `enabled:false`, never an error.
//  3. Cloud per-account entitlement — the host's automatic /api/pro/* 402 gate. Staying under
//     /api/pro/ is what keeps that automatic.
//
// SCOPE: `?workspace=` resolves via resolveRequestScope — absent / unparseable / unknown /
// ANOTHER TENANT'S id all degrade to the account's DEFAULT workspace, never a 404 (no existence
// oracle; the ownership SELECT inside that resolver is not optional). `?repoIds=` survives as DATA
// NARROWING ONLY, intersected with the resolved membership. This surface sits under the Activity
// brief strip, where the repo picker is not even mounted, so the narrowing is a forward seam
// rather than something the UI sends today.
//
// COST DISCIPLINE (copied deliberately, gate for gate):
//  - a per-account IN-FLIGHT guard claimed SYNCHRONOUSLY (serialisation — a second click while one
//    runs gets the cached row flagged `throttled`, it never double-bills);
//  - a per-account MIN-INTERVAL between BILLED generations, armed only when money actually moved;
//  - the metered-plan credit gate INSIDE the guard;
//  - the payload-hash $0-on-unchanged cache (./hash.ts — stable fields only, no clock);
//  - `recordAiUsage` the moment the model answers, BEFORE anything can fail after it.
//
// The output validation lives in ./prompt.ts: ids ⊆ the evidence (strays dropped and COUNTED), the
// D4 digit gate on every string, the narrowed ownership gate. An unparseable answer does NOT 502
// here — this surface has a deterministic primary, so the row is stored empty (which is what stops
// a retry loop-billing) and the panel carries on with the ranked rows.
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type {
  StoredWorkPlan,
  WorkPlanEvidence,
  WorkPlanResponse,
  WorkPlanStep,
} from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../contract.js';
import type { LlmClient } from '../llm/seam.js';
import { proSchemaFor } from '../db.js';
import { scopeKeyFor } from '../insights/workspace-scope.js';
import { resolveRequestScope } from '../insights/workspace-request.js';
import { DIGEST_MODEL } from '../llm/gate.js';
import { workPlanPayloadHash } from './hash.js';
import {
  WORK_PLAN_MAX_TOKENS,
  WORK_PLAN_SYSTEM,
  buildWorkPlanUserPrompt,
  parseWorkPlanOutput,
} from './prompt.js';

// Min interval between BILLED generations per account. Enforced on the SPEND, not the click: a
// payload-hash cache hit is free and must never arm the throttle, or a $0 read would lock the
// account out of a real regenerate. Longer than synthesis's 15s because a work plan turns over on
// the timescale of the board (a PR gets approved, a thread gets answered), not of a click.
const MIN_INTERVAL_SEC = (() => {
  const v = process.env.PRO_WORK_PLAN_MIN_INTERVAL_SEC;
  const n = v == null ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 30;
})();

// Per-account serialisation + throttle state. Module-level and ACCOUNT-keyed, not scope-keyed:
// scope-keyed would let one account fan out N parallel Haiku calls by opening N workspaces.
const inFlightAccounts = new Set<number>();
const lastBilledAtByAccount = new Map<number, number>();

interface StoredRow {
  scopeKey: string;
  payloadHash: string;
  output: string;
  model: string;
  itemCount: number;
  generatedAt: Date | number | null;
}

function tsToIso(v: Date | number | null): string {
  if (v == null) return new Date(0).toISOString();
  return (v instanceof Date ? v : new Date(Number(v))).toISOString();
}

/** The stored blob's shape (the `output` column) — MODEL PROSE ONLY. No figure, id, link or rank
 *  is stored here: the steps join back to the LIVE evidence by `WorkPlanItem.id`, so nothing in
 *  this row can put an item, or a number, on the board by itself. Versioned by
 *  WORK_PLAN_SCHEMA_VERSION through the payload hash — a shape change bumps the const and every
 *  row regenerates on the next click. */
interface StoredOutput {
  headline: string;
  steps: WorkPlanStep[];
  parked: string | null;
  droppedIds: number;
}

/** The sentinel written when the model answered but NOTHING survived validation. It exists so the
 *  payload hash gets a row: without one, the next click would pay for another unparseable answer,
 *  and the one after that, forever. An empty headline is how a reader of this column tells the
 *  sentinel apart from a real plan. */
const EMPTY_OUTPUT: StoredOutput = { headline: '', steps: [], parked: null, droppedIds: 0 };

/**
 * A stored row → the wire plan.
 *
 * THREE outcomes, and the distinction is load-bearing:
 *   `null`          — the column did not parse as a plan blob at all (a CORRUPT row). The POST
 *                     falls through and regenerates; the GET reports no plan.
 *   `{plan: null}`  — a VALIDLY STORED EMPTY plan (the sentinel above). Serve it as "no
 *                     narration"; never re-bill for it, because it already cost a generation.
 *   `{plan}`        — a real plan.
 */
function readStored(row: StoredRow): { plan: StoredWorkPlan | null } | null {
  let parsed: StoredOutput;
  try {
    parsed = JSON.parse(row.output) as StoredOutput;
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object') return null;
  if (typeof parsed.headline !== 'string') return null;
  const steps = Array.isArray(parsed.steps)
    ? parsed.steps.filter(
        (s): s is WorkPlanStep =>
          s != null && typeof s === 'object' && typeof s.id === 'string' && typeof s.why === 'string',
      )
    : [];
  if (parsed.headline === '' && steps.length === 0) return { plan: null };
  return {
    plan: {
      headline: parsed.headline,
      steps,
      parked: typeof parsed.parked === 'string' ? parsed.parked : null,
      model: row.model,
      generatedAt: tsToIso(row.generatedAt),
      droppedIds: typeof parsed.droppedIds === 'number' ? parsed.droppedIds : 0,
    },
  };
}

/** Pure cache read — EXPORTED for the isolation test (the accountId predicate is what it pins). */
export async function loadWorkPlan(
  ctx: ProContext,
  accountId: number,
  scopeKey: string,
): Promise<StoredRow | null> {
  const pro = proSchemaFor();
  const rows = (await ctx.db
    .select()
    .from(pro.proWorkPlans)
    .where(and(eq(pro.proWorkPlans.accountId, accountId), eq(pro.proWorkPlans.scopeKey, scopeKey)))
    .limit(1)
    .execute()) as StoredRow[];
  return rows[0] ?? null;
}

// Comma-separated positive-int list → number[] | null (null = "no narrowing"). Mirrors
// synthesis/routes.ts and core's parseIntList — its result is NEVER a scope, only the narrow set.
function parseIntList(raw?: string): number[] | null {
  if (raw == null || raw.trim() === '') return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : null;
}

interface ResolvedWorkPlanScope {
  scope: BotScopeWire;
  scopeKey: string;
}

/**
 * The wire params → the resolved scope + its cache-row identity.
 *
 * THE KEY: `ws:<workspaceId>`, plus a `|r:<sorted csv>` tail ONLY when the request actually
 * narrowed BELOW the workspace's full membership. An absent slot stays absent rather than being
 * spelled, so the unnarrowed workspace and a narrowing that happens to cover every repo cannot
 * mint two spellings of one plan. (The `ws:` prefix is load-bearing — see scopeKeyFor.)
 *
 * ⚠ That tail keys on the INTERSECTION, which means workspace membership drift re-mints a
 * narrowed row. Deliberate, and the opposite of synthesis's choice: this key's job is to make the
 * common unnarrowed case ONE row, and correctness never rests on the key anyway — the payload hash
 * folds the actual item set.
 */
async function resolveWorkPlanScope(
  ctx: ProContext,
  accountId: number,
  workspaceRaw: string | undefined,
  repoIdsRaw: string | undefined,
): Promise<ResolvedWorkPlanScope> {
  const resolved = await resolveRequestScope(ctx, accountId, workspaceRaw);
  const narrow = parseIntList(repoIdsRaw);
  // membership ∩ narrow — the BotScopeWire invariant (repoIds ⊆ membership). Never the raw narrow.
  const repoIds =
    narrow == null ? resolved.repoIds : resolved.repoIds.filter((id) => narrow.includes(id));
  const narrowed = repoIds.length !== resolved.repoIds.length;
  const base = scopeKeyFor(resolved.workspaceId);
  return {
    scope: { workspaceId: resolved.workspaceId, repoIds },
    scopeKey: narrowed
      ? `${base}|r:${[...repoIds].sort((a, b) => a - b).join(',')}`
      : base,
  };
}

export function registerWorkPlanRoutes(
  app: FastifyInstance,
  ctx: ProContext,
  llm: LlmClient,
): void {
  const disabled = (): WorkPlanResponse => ({ enabled: false, evidence: null, plan: null });

  /**
   * ⚠ `ctx.queries.getWorkPlan` IS OPTIONAL ON THE HOST CONTRACT, on purpose — that is what keeps
   * apiVersion at 21 (a REQUIRED member would demand a bump, and a bump is four literals across
   * TWO repos whose half-application degrades the ENTIRE plugin to OSS mode with nothing thrown).
   * So a newer plugin against an older host must degrade to THIS ONE FEATURE going dark, exactly
   * like the OSS answer, rather than throwing on an undefined call. Bound once per request so the
   * narrowing survives the awaits below, and `.bind` rather than a bare reference so a host that
   * implements the seam as a method rather than an arrow keeps its receiver.
   */
  const evidenceFold = (): ((a: number, s: BotScopeWire) => Promise<WorkPlanEvidence>) | undefined =>
    ctx.queries.getWorkPlan?.bind(ctx.queries);

  type Wire = { workspace?: string; repoIds?: string };

  // ── The free evidence fold + cache read + staleness probe. NEVER generates. ───────────────
  // Recomputes the payload hash from the SAME core fold (plain DB reads — ./hash.ts's fields were
  // chosen so this is possible at zero external cost). It returns the evidence EVEN WHEN there is
  // no stored plan, because the deterministic worklist is the PRIMARY surface here: the narration
  // decorates rows, it does not produce them. Rate tier `search` (this fold re-runs
  // getWorkspaceInsights plus an open-PR walk) — pinned in core's rate-limit.test.ts.
  app.get<{ Querystring: Wire }>('/api/pro/work-plan', async (req, reply) => {
    const fold = evidenceFold();
    if (fold == null) return reply.send(disabled());
    const accountId = ctx.accountIdOf(req);
    const rs = await resolveWorkPlanScope(ctx, accountId, req.query.workspace, req.query.repoIds);
    const evidence = await fold(accountId, rs.scope);
    const stored = await loadWorkPlan(ctx, accountId, rs.scopeKey);
    const read = stored ? readStored(stored) : null;
    if (!stored || !read) {
      const resp: WorkPlanResponse = { enabled: true, evidence, plan: null };
      return reply.send(resp);
    }
    const resp: WorkPlanResponse = {
      enabled: true,
      evidence,
      plan: read.plan,
      // Describes the ROW, not the prose: a stored-empty plan whose evidence has moved is still
      // worth regenerating.
      stale: workPlanPayloadHash(rs.scopeKey, evidence) !== stored.payloadHash,
    };
    return reply.send(resp);
  });

  // ── Generate (the ONLY billing path). ─────────────────────────────────────────────────────
  // Params ride the query string OR the body (the synthesis/bot-themes refresh convention).
  // Rate tier `ai` (20/min) + `ai_hourly`.
  app.post<{ Querystring: Wire; Body?: Wire }>('/api/pro/work-plan', async (req, reply) => {
    const fold = evidenceFold();
    if (fold == null) return reply.send(disabled());
    const accountId = ctx.accountIdOf(req);
    const merged: Wire = { ...(req.body ?? {}), ...req.query };
    const rs = await resolveWorkPlanScope(ctx, accountId, merged.workspace, merged.repoIds);

    // THE ONE FOLD, run BEFORE the throttle checks — a DELIBERATE divergence from synthesis, which
    // folds its input after them. Two reasons: `WorkPlanResponse.evidence` is documented "always
    // present when enabled" (the worklist renders whatever happens to the narration), so a
    // throttled reply that dropped it would hand the panel nothing; and the cost is bounded by
    // this route's own `ai` bucket at 20/min, which is TIGHTER than the free GET's 60/min
    // `search` bucket running the identical fold. It also removes a class of bug outright — no
    // branch below can forget to include the evidence.
    const evidence = await fold(accountId, rs.scope);
    if (evidence.items.length === 0) {
      // Nothing needs doing in this workspace: nothing generated, nothing stored, nothing billed.
      const resp: WorkPlanResponse = { enabled: true, evidence, plan: null, empty: true };
      return reply.send(resp);
    }

    const cachedResponse = async (
      flag: 'throttled' | 'creditsExhausted',
    ): Promise<WorkPlanResponse> => {
      const stored = await loadWorkPlan(ctx, accountId, rs.scopeKey);
      const read = stored ? readStored(stored) : null;
      const base: WorkPlanResponse = { enabled: true, evidence, plan: read?.plan ?? null };
      if (flag === 'throttled') base.throttled = true;
      else base.creditsExhausted = true;
      return base;
    };

    // Serialisation: one generation per account at a time (a no-op click reads as `throttled`).
    // ⚠ THE SLOT IS CLAIMED SYNCHRONOUSLY — no `await` may sit between the has() and the add()
    // below, or two concurrent POSTs both pass the check, both miss the not-yet-written hash
    // cache, and BOTH BILL. The min-interval read between them is deliberately synchronous
    // (Date.now + a Map read) for exactly that reason, and the CREDIT CHECK therefore runs INSIDE
    // the try/finally: a blocked call holds the guard only for that one lookup, and the finally
    // releases it on every path including a throw.
    if (inFlightAccounts.has(accountId)) return reply.send(await cachedResponse('throttled'));
    const last = lastBilledAtByAccount.get(accountId) ?? 0;
    if (Date.now() - last < MIN_INTERVAL_SEC * 1000) {
      return reply.send(await cachedResponse('throttled'));
    }
    inFlightAccounts.add(accountId);
    try {

      // $0-on-unchanged: a stored row whose payload hash matches is returned unbilled.
      const hash = workPlanPayloadHash(rs.scopeKey, evidence);
      const existing = await loadWorkPlan(ctx, accountId, rs.scopeKey);
      if (existing && existing.payloadHash === hash) {
        const read = readStored(existing);
        if (read) {
          // Includes the STORED-EMPTY sentinel (`plan: null`): it already cost a generation once,
          // and re-running it against identical evidence would just buy the same failure twice.
          const resp: WorkPlanResponse = {
            enabled: true,
            evidence,
            plan: read.plan,
            stale: false,
          };
          return reply.send(resp);
        }
        // A CORRUPT cache row (unparseable column) falls through to regenerate.
      }

      const out = await llm.complete({
        system: WORK_PLAN_SYSTEM,
        user: buildWorkPlanUserPrompt(evidence),
        maxTokens: WORK_PLAN_MAX_TOKENS,
      });
      // The spend happened the moment the model answered — record it BEFORE the parse can fail,
      // and arm the min-interval off the same fact. Best-effort, like every other ledger write.
      lastBilledAtByAccount.set(accountId, Date.now());
      await ctx
        .recordAiUsage({
          accountId,
          seam: 'summary',
          feature: 'work_plan',
          model: out.model ?? DIGEST_MODEL,
          provider: out.provider,
          costUsd: out.costUsd,
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
        })
        .catch(() => {});

      const validated = parseWorkPlanOutput(out.text, evidence);
      if (validated == null) {
        ctx.log.warn(
          { accountId, scopeKey: rs.scopeKey },
          'work plan: no narration survived validation — the panel renders the ranked rows alone',
        );
      } else if (validated.droppedIds > 0) {
        ctx.log.warn(
          { accountId, scopeKey: rs.scopeKey, dropped: validated.droppedIds },
          'work plan: model cited ids outside the evidence set — dropped (disclosed on screen)',
        );
      }
      const output: StoredOutput = validated ?? EMPTY_OUTPUT;
      const outputJson = JSON.stringify(output);
      const now = new Date();
      // What answered (Phase 4): the stored row names the model that RAN and its provider.
      const ranModel = out.model ?? DIGEST_MODEL;
      const ranProvider = out.provider ?? 'claude';
      const pro = proSchemaFor();
      await ctx.runTransaction(async (tx) => {
        await tx
          .insert(pro.proWorkPlans)
          .values({
            accountId,
            scopeKey: rs.scopeKey,
            payloadHash: hash,
            output: outputJson,
            model: ranModel,
            provider: ranProvider,
            // The items the plan was generated AGAINST (the capped evidence list), NOT the number
            // of steps the model chose to write — that is what "narrated N of M" discloses.
            itemCount: evidence.items.length,
            generatedAt: now,
          })
          // ⚠ Target = the DECLARED unique [accountId, scopeKey] (pro_work_plans_account_scope).
          // A stale target type-checks perfectly and raises "no unique or exclusion constraint
          // matching the ON CONFLICT specification" only when a row is actually WRITTEN, in both
          // dialects — the 0042/0045 lesson.
          .onConflictDoUpdate({
            target: [pro.proWorkPlans.accountId, pro.proWorkPlans.scopeKey],
            set: {
              payloadHash: hash,
              output: outputJson,
              model: ranModel,
              provider: ranProvider,
              itemCount: evidence.items.length,
              generatedAt: now,
            },
          })
          .execute();
      });

      const resp: WorkPlanResponse = {
        enabled: true,
        evidence,
        plan:
          validated == null
            ? null
            : {
                headline: validated.headline,
                steps: validated.steps,
                parked: validated.parked,
                model: ranModel,
                generatedAt: now.toISOString(),
                droppedIds: validated.droppedIds,
              },
        stale: false,
      };
      return reply.send(resp);
    } finally {
      inFlightAccounts.delete(accountId);
    }
  });
}
