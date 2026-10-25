import { and, eq, inArray } from 'drizzle-orm';
import type {
  AnnotationKind,
  AnnotationRunResponse,
  AnnotationTargetKind,
  CommentAnnotation,
} from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import type { LlmClient } from '../llm/seam.js';
import { proSchemaFor } from '../db.js';
import { tsToIso } from '../llm/gate.js';
import { MAX_TOKENS_SINGLE, SYSTEM_FOR, VERDICTS, parseSingle } from './prompts.js';
import { currentHashFor, impactForPr, loadPrCorpus, type PrCorpus } from './targets.js';

// The runner behind the blast-radius IMPACT NOTE — the one kind left on the annotations platform.
// (The per-comment validity / addressed / simplify judgements, the combined "Check review" run,
// the evidence grounding and the chunked prompts are REMOVED; their stored rows are DORMANT and
// the read below skips them.)
//
// COST MODEL. Build the payload → hash it → if an UNCHANGED hash already has a row, that's a $0
// cache hit and no call is made. Only a miss reaches the model.
//
// PASSIVE STALENESS. Nothing here ever runs on its own. The GET marks a row stale, the UI shows
// it, and a human presses the button.

const MODEL = 'claude-haiku-5-5';

// One run per ACCOUNT at a time: the spend is per-account, so a per-PR guard would let a caller fan
// out across PR ids to the same total.
const inFlightAccounts = new Set<number>();

// Minimum gap between BILLING runs. Not applied to a cached run — free work is never refused.
const MIN_RUN_INTERVAL_MS = 30_000;
const lastRunAt = new Map<number, number>();

export type RunGate = 'in_flight' | 'too_soon' | null;

function gateFor(accountId: number): RunGate {
  if (inFlightAccounts.has(accountId)) return 'in_flight';
  const last = lastRunAt.get(accountId);
  if (last != null && Date.now() - last < MIN_RUN_INTERVAL_MS) return 'too_soon';
  return null;
}

export interface RunOptions {
  /** Checked before the billing call; halts cleanly when the client went away. */
  shouldStop?: () => boolean;
}

export function emptyResult(kind: AnnotationKind = 'impact'): AnnotationRunResponse {
  return {
    kind,
    requested: 0,
    generated: 0,
    cached: 0,
    skipped: 0,
    failed: 0,
    truncated: false,
    creditsExhausted: false,
  };
}

// ---- stored rows ---------------------------------------------------------------------------

/**
 * One stored row. `kind` / `targetKind` are typed as the raw column text on purpose: the table
 * still holds DORMANT rows of the removed comment kinds, and the readers below must be able to
 * see (and skip) them rather than pretend they are not there.
 */
interface AnnotationRow {
  kind: string;
  targetKind: string;
  targetId: number;
  prId: number;
  verdict: string | null;
  confidence: number | null;
  body: string;
  payloadHash: string;
  model: string;
  createdAt: Date | number | null;
}

const ROW_COLUMNS = (t: ReturnType<typeof proSchemaFor>['prCommentAnnotations']) => ({
  kind: t.kind,
  targetKind: t.targetKind,
  targetId: t.targetId,
  prId: t.prId,
  verdict: t.verdict,
  confidence: t.confidence,
  body: t.body,
  payloadHash: t.payloadHash,
  model: t.model,
  createdAt: t.createdAt,
});

/** Every stored row for one PR (optionally narrowed to some kinds), account-scoped. */
export async function readPrAnnotationRows(
  ctx: ProContext,
  accountId: number,
  prId: number,
  kinds?: readonly string[],
): Promise<AnnotationRow[]> {
  const t = proSchemaFor().prCommentAnnotations;
  const where =
    kinds && kinds.length > 0
      ? and(eq(t.accountId, accountId), eq(t.prId, prId), inArray(t.kind, [...kinds]))
      : and(eq(t.accountId, accountId), eq(t.prId, prId));
  return (await ctx.db.select(ROW_COLUMNS(t)).from(t).where(where).execute()) as AnnotationRow[];
}

/** One stored row, account-scoped. */
export async function readAnnotation(
  ctx: ProContext,
  accountId: number,
  kind: string,
  targetKind: string,
  targetId: number,
): Promise<AnnotationRow | null> {
  const t = proSchemaFor().prCommentAnnotations;
  const rows = (await ctx.db
    .select(ROW_COLUMNS(t))
    .from(t)
    .where(
      and(
        eq(t.accountId, accountId),
        eq(t.kind, kind),
        eq(t.targetKind, targetKind),
        eq(t.targetId, targetId),
      ),
    )
    .limit(1)
    .execute()) as AnnotationRow[];
  return rows[0] ?? null;
}

export interface UpsertArgs {
  accountId: number;
  repoId: number;
  prId: number;
  kind: AnnotationKind;
  targetKind: AnnotationTargetKind;
  targetId: number;
  verdict: string | null;
  confidence: number | null;
  body: string;
  payloadHash: string;
  model: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  createdAt: Date;
}

/** The single writer for `pr_comment_annotations`. */
export async function upsertAnnotation(ctx: ProContext, a: UpsertArgs): Promise<void> {
  const t = proSchemaFor().prCommentAnnotations;
  const set = {
    repoId: a.repoId,
    prId: a.prId,
    verdict: a.verdict,
    confidence: a.confidence,
    body: a.body,
    payloadHash: a.payloadHash,
    model: a.model,
    // Always cleared: only the removed `addressed` kind ever wrote a grounding diff here.
    evidence: null,
    costUsd: a.costUsd,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
    createdAt: a.createdAt,
  };
  await ctx.runTransaction(async (tx) => {
    await tx
      .insert(t)
      .values({
        accountId: a.accountId,
        kind: a.kind,
        targetKind: a.targetKind,
        targetId: a.targetId,
        ...set,
      })
      .onConflictDoUpdate({
        target: [t.accountId, t.kind, t.targetKind, t.targetId],
        set,
      })
      .execute();
  });
}

const isLiveKind = (k: string): k is AnnotationKind => k in VERDICTS;

/** Wire shape for one stored row. `stale` is computed by the caller against the live corpus. */
export function toAnnotation(row: AnnotationRow, stale: boolean): CommentAnnotation {
  const kind = row.kind as AnnotationKind;
  const vocab = VERDICTS[kind] as ReadonlySet<string> | undefined;
  // A verdict that isn't in the kind's vocabulary (an older row, a renamed value) is dropped rather
  // than rendered — the client maps it to a chip and would show a stray label.
  const verdict =
    row.verdict != null && vocab != null && vocab.has(row.verdict) ? row.verdict : null;
  return {
    kind,
    targetKind: row.targetKind as AnnotationTargetKind,
    targetId: row.targetId,
    prId: row.prId,
    verdict,
    confidence: row.confidence,
    body: row.body,
    model: row.model,
    createdAt: tsToIso(row.createdAt),
    stale,
  };
}

// ---- the read path -------------------------------------------------------------------------

export interface PrAnnotationsRead {
  annotations: CommentAnnotation[];
  counts: Record<AnnotationKind, number>;
  staleCount: number;
}

/**
 * The pure CACHED read: the stored impact note for a PR, flagged `stale` when the pull request no
 * longer matches the hash it was generated from. A DORMANT row of a removed kind is skipped. No
 * generation, no billing.
 */
export function projectAnnotations(corpus: PrCorpus, rows: AnnotationRow[]): PrAnnotationsRead {
  const counts: Record<AnnotationKind, number> = { impact: 0 };
  let staleCount = 0;
  const annotations: CommentAnnotation[] = [];
  for (const row of rows) {
    if (!isLiveKind(row.kind)) continue; // a removed kind is not renderable
    const live = currentHashFor(corpus, row.kind, row.targetKind, row.targetId);
    // A target that no longer exists isn't "stale" — there is nothing to re-check.
    const stale = live != null && live !== row.payloadHash;
    if (stale) staleCount += 1;
    counts[row.kind] += 1;
    annotations.push(toAnnotation(row, stale));
  }
  return { annotations, counts, staleCount };
}

// ---- the run path --------------------------------------------------------------------------

/**
 * Write (or refresh) the impact note for one PR.
 *
 * Returns null when the PR is unknown or belongs to another account (the caller 404s), and a gate
 * marker when the per-account in-flight / interval guard refuses a BILLING run.
 */
export async function runAnnotations(
  ctx: ProContext,
  llm: LlmClient,
  accountId: number,
  prId: number,
  kind: AnnotationKind,
  opts: RunOptions = {},
): Promise<{ result: AnnotationRunResponse } | { gate: Exclude<RunGate, null> } | null> {
  const corpus = await loadPrCorpus(ctx, accountId, prId);
  if (corpus == null) return null;

  const result = emptyResult(kind);
  const target = impactForPr(corpus);
  if (target == null) return { result: { ...result, requested: 1, skipped: 1 } };
  result.requested = 1;

  const stored = await readAnnotation(ctx, accountId, kind, target.targetKind, target.targetId);
  if (stored != null && stored.payloadHash === target.payloadHash) {
    return { result: { ...result, cached: 1 } };
  }

  const gate = gateFor(accountId);
  if (gate) return { gate };

  inFlightAccounts.add(accountId);
  lastRunAt.set(accountId, Date.now());
  try {
    const auth = ctx.llm.detectAuth();
    // A credential-less run is refused, not failed.
    if (auth.status !== 'ok') return { result: { ...result, noAuth: true } };
    if (opts.shouldStop?.()) return { result };

    try {
      const out = await llm.complete({
        system: SYSTEM_FOR[kind],
        user: target.prompt,
        maxTokens: MAX_TOKENS_SINGLE[kind],
      });
      await ctx
        .recordAiUsage({
          accountId,
          seam: 'summary',
          feature: `annotation_${kind}`,
          model: out.model ?? MODEL,
          provider: out.provider,
          costUsd: out.costUsd,
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
          prId: target.prId,
          repoId: target.repoId,
        })
        .catch(() => {});

      const p = parseSingle(kind, out.text);
      if (p.body.trim() === '') return { result: { ...result, failed: 1 } };
      await upsertAnnotation(ctx, {
        accountId,
        repoId: target.repoId,
        prId: target.prId,
        kind,
        targetKind: target.targetKind,
        targetId: target.targetId,
        verdict: p.verdict,
        confidence: p.confidence,
        body: p.body,
        payloadHash: target.payloadHash,
        model: MODEL,
        costUsd: out.costUsd,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        createdAt: new Date(),
      });
      return { result: { ...result, generated: 1 } };
    } catch (err) {
      ctx.log.warn({ err, kind, prId }, 'pro annotations: impact run failed');
      return { result: { ...result, failed: 1 } };
    }
  } finally {
    inFlightAccounts.delete(accountId);
  }
}
