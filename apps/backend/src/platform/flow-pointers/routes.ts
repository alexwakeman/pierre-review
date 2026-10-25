// CHRONOLOGY POINTERS: GET /api/pro/flow-pointers (the free evidence fold + cache read + the
// staleness probe — it NEVER generates) and POST /api/pro/flow-pointers (the only billing path).
// Built to the work plan's shape, gate for gate, because every one of those gates is a bill
// somebody paid.
//
// ENTITLEMENT: `periodReports`, the flag Chronology itself rides. In this plugin that flag IS
// DIGEST_ENABLED (index.ts publishes `periodReports: digestEnabled`), so the self-gate below is
// the same test, and the host's automatic /api/pro/* 402 zeroes it for a free cloud plan.
//
// SCOPE: `?workspace=` via resolveRequestScope — absent, unknown or another tenant's id degrade to
// the account's DEFAULT workspace, never a 404. `?days=` is the Chronology window; core clamps it
// to [7, 90] and the cache key uses the CLAMPED value the evidence echoes, so `?days=400` and
// `?days=90` are one row. No repo narrowing: Chronology covers the whole workspace.
//
// COST DISCIPLINE (the work plan's, verbatim): a per-account in-flight slot claimed
// SYNCHRONOUSLY; a min-interval between BILLED runs; the credit gate INSIDE the slot's
// try/finally; the payload-hash $0 cache; `recordAiUsage` the moment the model answers.
//
// ⚠ THE LINKS ARE NEVER STORED. Every response rebuilds them from the LIVE evidence, so a cited PR
// that has left the window renders no link rather than one the cache remembered.
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type {
  FlowPointer,
  FlowPointerEvidence,
  FlowPointersResponse,
  FlowPrLink,
  StoredFlowPointers,
} from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../contract.js';
import type { LlmClient } from '../llm/seam.js';
import { proSchemaFor } from '../db.js';
import { resolveRequestScope } from '../insights/workspace-request.js';
import { DIGEST_MODEL } from '../llm/gate.js';
import { flowPointersPayloadHash, flowPointersScopeKeyFor } from './hash.js';
import {
  FLOW_POINTERS_MAX_TOKENS,
  FLOW_POINTERS_SYSTEM,
  buildFlowPointersUserPrompt,
  parseFlowPointersOutput,
} from './prompt.js';

const MIN_INTERVAL_SEC = (() => {
  const v = process.env.PRO_FLOW_POINTERS_MIN_INTERVAL_SEC;
  const n = v == null ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 30;
})();

// ACCOUNT-keyed, never scope-keyed: scope-keyed would let one account fan out parallel calls by
// opening three windows in three tabs.
const inFlightAccounts = new Set<number>();
const lastBilledAtByAccount = new Map<number, number>();

const DEFAULT_WINDOW_DAYS = 30;

interface StoredRow {
  scopeKey: string;
  payloadHash: string;
  output: string;
  model: string;
  prCount: number;
  generatedAt: Date | number | null;
}

interface StoredOutput {
  pointers: FlowPointer[];
  droppedIds: number;
  droppedPointers: number;
}

/** Written when the model answered but nothing survived validation — so the hash has a row and a
 *  retry cannot pay for the same failure again. */
const EMPTY_OUTPUT: StoredOutput = { pointers: [], droppedIds: 0, droppedPointers: 0 };

function tsToIso(v: Date | number | null): string {
  if (v == null) return new Date(0).toISOString();
  return (v instanceof Date ? v : new Date(Number(v))).toISOString();
}

/**
 * A stored row → the wire result. `null` = CORRUPT (the POST regenerates); `{result: null}` = a
 * validly stored EMPTY answer (never re-billed); `{result}` = real pointers.
 */
function readStored(row: StoredRow): { result: StoredFlowPointers | null } | null {
  let parsed: StoredOutput;
  try {
    parsed = JSON.parse(row.output) as StoredOutput;
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || !Array.isArray(parsed.pointers)) return null;
  const pointers = parsed.pointers.filter(
    (p): p is FlowPointer =>
      p != null &&
      typeof p === 'object' &&
      typeof p.text === 'string' &&
      typeof p.kind === 'string' &&
      Array.isArray(p.cites),
  );
  if (pointers.length === 0) return { result: null };
  return {
    result: {
      pointers,
      model: row.model,
      generatedAt: tsToIso(row.generatedAt),
      droppedIds: typeof parsed.droppedIds === 'number' ? parsed.droppedIds : 0,
      droppedPointers: typeof parsed.droppedPointers === 'number' ? parsed.droppedPointers : 0,
      prCount: row.prCount,
    },
  };
}

/** Pure cache read — EXPORTED for the isolation test (the accountId predicate is what it pins). */
export async function loadFlowPointers(
  ctx: ProContext,
  accountId: number,
  scopeKey: string,
): Promise<StoredRow | null> {
  const pro = proSchemaFor();
  const rows = (await ctx.db
    .select()
    .from(pro.proFlowPointers)
    .where(
      and(eq(pro.proFlowPointers.accountId, accountId), eq(pro.proFlowPointers.scopeKey, scopeKey)),
    )
    .limit(1)
    .execute()) as StoredRow[];
  return rows[0] ?? null;
}

/** Links for the cited PRs still in the LIVE evidence — the only place a link comes from. */
export function linksFor(result: StoredFlowPointers | null, e: FlowPointerEvidence): FlowPrLink[] {
  if (result == null) return [];
  const cited = new Set(result.pointers.flatMap((p) => p.cites));
  return e.rows
    .filter((r) => cited.has(r.prId))
    .map((r) => ({
      prId: r.prId,
      repoFullName: r.repoFullName,
      prNumber: r.prNumber,
      prTitle: r.prTitle,
      githubUrl: r.githubUrl,
    }));
}

function parseDays(raw: string | undefined): number {
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : DEFAULT_WINDOW_DAYS;
}

export function registerFlowPointerRoutes(
  app: FastifyInstance,
  ctx: ProContext,
  llm: LlmClient,
): void {
  const disabled = (): FlowPointersResponse => ({ enabled: false, result: null, links: [] });

  /** OPTIONAL on the host contract (apiVersion stays 21): an older host turns this feature dark. */
  const evidenceFold = ():
    | ((
        a: number,
        s: BotScopeWire,
        d: number,
        o?: { reporting?: boolean },
      ) => Promise<FlowPointerEvidence>)
    | undefined => ctx.queries.getFlowPointerEvidence?.bind(ctx.queries);

  type Wire = { workspace?: string; days?: string; window?: string };
  // `?window=reporting` (also what an absent `?days=` means) is the workspace's REPORTING WINDOW,
  // the panel's default; core resolves it through the one resolver. `?days=` is 30/60/90.
  // Only a positive integer `?days=` picks a fixed span; anything else (absent, garbage, an
  // unknown `?window=`) is the reporting window — the same rule core's /api/flow-findings applies.
  const reportingOf = (w: Wire): { reporting?: boolean } => {
    const n = w.days == null ? Number.NaN : Number(w.days);
    return w.window === 'reporting' || !(Number.isInteger(n) && n > 0) ? { reporting: true } : {};
  };

  const resolve = async (accountId: number, w: Wire) => {
    const resolved = await resolveRequestScope(ctx, accountId, w.workspace);
    return { workspaceId: resolved.workspaceId, repoIds: resolved.repoIds } as BotScopeWire;
  };

  // ── The free read: evidence + cache + staleness. NEVER generates. Rate tier `search`. ───────
  app.get<{ Querystring: Wire }>('/api/pro/flow-pointers', async (req, reply) => {
    const fold = evidenceFold();
    if (fold == null) return reply.send(disabled());
    const accountId = ctx.accountIdOf(req);
    const scope = await resolve(accountId, req.query);
    const evidence = await fold(accountId, scope, parseDays(req.query.days), reportingOf(req.query));
    const scopeKey = flowPointersScopeKeyFor(evidence);
    const stored = await loadFlowPointers(ctx, accountId, scopeKey);
    const read = stored ? readStored(stored) : null;
    if (!stored || !read) {
      const resp: FlowPointersResponse = {
        enabled: true,
        result: null,
        links: [],
        ...(evidence.measuredPrs === 0 ? { empty: true } : {}),
      };
      return reply.send(resp);
    }
    const resp: FlowPointersResponse = {
      enabled: true,
      result: read.result,
      links: linksFor(read.result, evidence),
      stale: flowPointersPayloadHash(scopeKey, evidence) !== stored.payloadHash,
    };
    return reply.send(resp);
  });

  // ── Generate — the ONLY billing path. Rate tier `ai` + `ai_hourly`. ───────────────────────
  app.post<{ Querystring: Wire; Body?: Wire }>('/api/pro/flow-pointers', async (req, reply) => {
    const fold = evidenceFold();
    if (fold == null) return reply.send(disabled());
    const accountId = ctx.accountIdOf(req);
    const merged: Wire = { ...(req.body ?? {}), ...req.query };
    const scope = await resolve(accountId, merged);
    const evidence = await fold(accountId, scope, parseDays(merged.days), reportingOf(merged));
    const scopeKey = flowPointersScopeKeyFor(evidence);
    if (evidence.measuredPrs === 0 || evidence.rows.length === 0) {
      const resp: FlowPointersResponse = { enabled: true, result: null, links: [], empty: true };
      return reply.send(resp);
    }

    const cachedResponse = async (
      flag: 'throttled' | 'creditsExhausted',
    ): Promise<FlowPointersResponse> => {
      const stored = await loadFlowPointers(ctx, accountId, scopeKey);
      const read = stored ? readStored(stored) : null;
      const result = read?.result ?? null;
      return { enabled: true, result, links: linksFor(result, evidence), [flag]: true };
    };

    // ⚠ CLAIMED SYNCHRONOUSLY: no `await` between the has() and the add(), or two POSTs both pass
    // and both bill. The credit check therefore runs INSIDE the try/finally.
    if (inFlightAccounts.has(accountId)) return reply.send(await cachedResponse('throttled'));
    const last = lastBilledAtByAccount.get(accountId) ?? 0;
    if (Date.now() - last < MIN_INTERVAL_SEC * 1000) {
      return reply.send(await cachedResponse('throttled'));
    }
    inFlightAccounts.add(accountId);
    try {

      const hash = flowPointersPayloadHash(scopeKey, evidence);
      const existing = await loadFlowPointers(ctx, accountId, scopeKey);
      if (existing && existing.payloadHash === hash) {
        const read = readStored(existing);
        if (read) {
          const resp: FlowPointersResponse = {
            enabled: true,
            result: read.result,
            links: linksFor(read.result, evidence),
            stale: false,
          };
          return reply.send(resp);
        }
      }

      const out = await llm.complete({
        system: FLOW_POINTERS_SYSTEM,
        user: buildFlowPointersUserPrompt(evidence),
        maxTokens: FLOW_POINTERS_MAX_TOKENS,
      });
      lastBilledAtByAccount.set(accountId, Date.now());
      await ctx
        .recordAiUsage({
          accountId,
          seam: 'summary',
          feature: 'flow_pointers',
          model: out.model ?? DIGEST_MODEL,
          provider: out.provider,
          costUsd: out.costUsd,
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
        })
        .catch(() => {});

      const validated = parseFlowPointersOutput(out.text, evidence);
      if (validated == null) {
        ctx.log.warn({ accountId, scopeKey }, 'flow pointers: nothing survived validation');
      } else if (validated.droppedIds > 0 || validated.droppedPointers > 0) {
        ctx.log.warn(
          { accountId, scopeKey, droppedIds: validated.droppedIds, reasons: validated.reasons },
          'flow pointers: dropped citations or pointers (disclosed on screen)',
        );
      }
      const output: StoredOutput =
        validated == null
          ? EMPTY_OUTPUT
          : {
              pointers: validated.pointers,
              droppedIds: validated.droppedIds,
              droppedPointers: validated.droppedPointers,
            };
      const outputJson = JSON.stringify(output);
      const now = new Date();
      const pro = proSchemaFor();
      await ctx.runTransaction(async (tx) => {
        await tx
          .insert(pro.proFlowPointers)
          .values({
            accountId,
            scopeKey,
            payloadHash: hash,
            output: outputJson,
            model: DIGEST_MODEL,
            prCount: evidence.measuredPrs,
            generatedAt: now,
          })
          // ⚠ Target = the DECLARED unique [accountId, scopeKey].
          .onConflictDoUpdate({
            target: [pro.proFlowPointers.accountId, pro.proFlowPointers.scopeKey],
            set: {
              payloadHash: hash,
              output: outputJson,
              model: DIGEST_MODEL,
              prCount: evidence.measuredPrs,
              generatedAt: now,
            },
          })
          .execute();
      });

      const result: StoredFlowPointers | null =
        validated == null
          ? null
          : {
              pointers: validated.pointers,
              model: DIGEST_MODEL,
              generatedAt: now.toISOString(),
              droppedIds: validated.droppedIds,
              droppedPointers: validated.droppedPointers,
              prCount: evidence.measuredPrs,
            };
      const resp: FlowPointersResponse = {
        enabled: true,
        result,
        links: linksFor(result, evidence),
        stale: false,
      };
      return reply.send(resp);
    } finally {
      inFlightAccounts.delete(accountId);
    }
  });
}
