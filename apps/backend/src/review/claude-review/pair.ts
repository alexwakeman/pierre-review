// CLAUDE + CODEX — ONE REVIEW BY BOTH PROVIDERS (docs/CLAUDE-REVIEW.md § Claude + Codex). The pure
// half: who may run a pair, what the second run is shown, the code dedupe after it, and the words of
// the one combined post. The manager (manager.ts) runs the two halves; auto-post.ts posts them.
//
// A pair is TWO ORDINARY RUNS (each its own row, label, follow-up chain, ledger and budget), linked by
// `claude_reviews.pair_id` / `pair_role` (migration 0135). Claude runs FIRST, then Codex, which is
// shown Claude's findings as already raised (a fenced block, prompts.ts `pushPairSection`) and told
// not to repeat them; anything it repeats anyway is DROPPED here, after the run, and counted on its
// row (`pair_dropped`).
import { and, eq } from 'drizzle-orm';
import {
  aiProviderName,
  type AutoReviewProviders,
  type AiProviderId,
  type AiProviderName,
} from '@pierre-review/shared';
import { similarTitles } from './settled-by-reply.js';
import type { PromptPairInput } from './prompts.js';
import type { AgentContext } from '../agent-context.js';

/** The order a pair runs in: Claude first, Codex second. */
export const PAIR_ORDER: readonly [AiProviderId, AiProviderId] = ['claude', 'codex'];

/** A per-provider pre-flight (ai/run-choice.ts `preflightFor`). */
export type ProviderPreflight = (provider: AiProviderId, kind: 'review') => { status: 'ok' | 'none'; message?: string };

/**
 * Which providers a pair would run right now, in order: both when both can review, else the one
 * that can (a pair asked for with one provider signed in runs just that one), else none.
 */
export function pairProvidersReady(detect: ProviderPreflight): AiProviderId[] {
  return PAIR_ORDER.filter((p) => detect(p, 'review').status === 'ok');
}

// Two findings at most this many lines apart on the same file are "the same place" for the dedupe.
export const PAIR_LINE_SLACK = 5;

type Placed = { path: string; line: number | null; title: string; priorFindingId?: number | null };

/**
 * Does `b` repeat `a`? Both re-raise the SAME earlier finding (a pair's merged-away duplicate is
 * followed up through the finding kept in its place, so both halves may carry it), or: same file, the
 * same place (lines within PAIR_LINE_SLACK, or either one about the whole file) and a similar title
 * (`similarTitles`, the settled-by-reply identity).
 */
export function isPairRepeat(a: Placed, b: Placed): boolean {
  if (a.priorFindingId != null && a.priorFindingId === b.priorFindingId) return true;
  if (a.path !== b.path) return false;
  if (a.line != null && b.line != null && Math.abs(a.line - b.line) > PAIR_LINE_SLACK) return false;
  return similarTitles(a.title, b.title);
}

/** THE CODE DEDUPE: drop every second-run finding that repeats a first-run finding. */
export function dropPairRepeats<F extends Placed>(second: readonly F[], first: readonly Placed[]): { kept: F[]; dropped: F[] } {
  const kept: F[] = [];
  const dropped: F[] = [];
  for (const f of second) (first.some((a) => isPairRepeat(a, f)) ? dropped : kept).push(f);
  return { kept, dropped };
}

/** The second run's prompt input from the first run's stored findings (praise is never shown). */
export function pairInputOf(
  by: AiProviderId,
  findings: ReadonlyArray<{ title: string; path: string; line: number | null; severity: string; body: string; editedBody?: string | null }>,
): PromptPairInput {
  return {
    by: aiProviderName(by),
    findings: findings
      .filter((f) => f.severity !== 'praise')
      .map((f) => ({ title: f.title, path: f.path, line: f.line, severity: f.severity, body: f.body })),
  };
}

/** The lead line of a posted comment in a pair's one review: who raised it ("Codex", "Claude + Codex"). */
export function pairRaisedByLead(by: string): string {
  return `_Raised by ${by}._`;
}

// The pair's verdict as one model verdict for `autoVerdictFor` (strict by default; the workspace's
// `pairStrictness` may relax it) lives with the verdict rule, ./auto-verdict.ts.
export { pairVerdict } from './auto-verdict.js';

/** One run's part of a pair body: who ran it and its line (already worded). */
export interface PairBodyPart {
  by: AiProviderName;
  text: string | null;
}

/**
 * THE ONE BODY of a pair's GitHub review: each provider's line, named, then `footer` (the auto-post
 * footer naming both — shared `PAIR_AUTO_POST_FOOTER` — or nothing on a manual post). An empty part
 * (a manual run with no draft) is left out.
 */
export function pairReviewBody(parts: readonly PairBodyPart[], footer: string | null): string {
  const lines: string[] = [];
  for (const p of parts) {
    const text = (p.text ?? '').trim();
    if (text !== '') lines.push(`**${p.by}:** ${text}`);
  }
  if (footer) lines.push(footer);
  return lines.join('\n\n');
}

/** The stored `workspaces.auto_review_providers` → the setting in force. Anything but 'both' is the default. */
export function resolveAutoReviewProviders(stored: unknown): AutoReviewProviders {
  return stored === 'both' ? 'both' : 'default';
}

/**
 * Who runs AUTO reviews in the workspace holding this PR's repo (`auto_review_providers`, migration
 * 0135): 'both' = Claude + Codex as one pair, else the default provider. Read by the manager when an
 * auto run starts. A repo with no membership row (or an unknown PR) reads 'default', and so does a
 * failed read.
 */
export async function readAutoReviewProvidersForPr(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<AutoReviewProviders> {
  try {
    const { workspaces: w, workspaceRepos: wr, pullRequests: prs } = ctx.schema;
    const rows = (await ctx.db
      .select({ providers: w.autoReviewProviders })
      .from(prs)
      .innerJoin(wr, and(eq(wr.repoId, prs.repoId), eq(wr.accountId, accountId)))
      .innerJoin(w, and(eq(w.id, wr.workspaceId), eq(w.accountId, accountId)))
      .where(and(eq(prs.id, prId), eq(prs.accountId, accountId)))
      .limit(1)
      .execute()) as Array<{ providers: string | null }>;
    return resolveAutoReviewProviders(rows[0]?.providers);
  } catch {
    return 'default';
  }
}
