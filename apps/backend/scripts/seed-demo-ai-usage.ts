// THE DEMO'S AI USAGE LEDGER (Reports → AI usage) — run after the agentic seed.
//
// The agentic seed stores every run through the product's own pipeline, but with `recordAiUsage`
// stubbed out (nothing is billed in a seed). This file writes the ledger the report reads:
//
//   • ONE ROW PER SEEDED RUN that the product would have billed — every Claude Review run, ticket
//     review, CI review and AI Fix build/plan (`ai_fixes`) — with that run's own provider, model, tokens and cost,
//     dated at the run.
//   • THREE EARLIER AUTO RE-REVIEWS of #116 on older heads (copies of its seeded run, on the standard
//     model) and ONE auto run that failed part-way, so the report's suggestions have something real
//     to say ("auto review re-ran on new pushes", "runs failed after spending").
//   • TWELVE WEEKS OF HISTORY: a deterministic, gently rising spread of runs across every feature, on
//     both providers, tied to the Platform workspace's pull requests (sprint view, docs and summaries
//     tied to none: machine-wide, as the product records them).
//
// Deterministic (a fixed LCG), so `pnpm demo:record` produces the same recording twice. Fictional.
import { and, eq, inArray } from 'drizzle-orm';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export interface AiUsageSeedCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  now: Date;
  workspaceId: number;
}

/** A small deterministic generator (Numerical Recipes LCG), 0 ≤ x < 1. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface FeatureShape {
  feature: string;
  seam: 'agent' | 'summary';
  /** Mean input / output tokens of one run. */
  input: number;
  output: number;
  /** Relative frequency. */
  weight: number;
  /** Tied to a PR (else machine-wide). */
  onPr: boolean;
  claudeModel: string;
  codexModel: string;
}

const SHAPES: FeatureShape[] = [
  { feature: 'claude_review', seam: 'agent', input: 32_000, output: 2_400, weight: 10, onPr: true, claudeModel: 'claude-opus-5-5', codexModel: 'gpt-6.1-sol' },
  { feature: 'replies_check', seam: 'agent', input: 6_000, output: 500, weight: 3, onPr: true, claudeModel: 'claude-sonnet-5', codexModel: 'gpt-6.1-terra' },
  { feature: 'thread_check', seam: 'agent', input: 8_000, output: 700, weight: 2, onPr: true, claudeModel: 'claude-sonnet-5', codexModel: 'gpt-6.1-terra' },
  { feature: 'ticket_review', seam: 'agent', input: 18_000, output: 1_600, weight: 3, onPr: true, claudeModel: 'claude-sonnet-5', codexModel: 'gpt-6.1-terra' },
  { feature: 'ci_review', seam: 'agent', input: 14_000, output: 1_200, weight: 2, onPr: true, claudeModel: 'claude-sonnet-5', codexModel: 'gpt-6.1-terra' },
  { feature: 'ai_fix', seam: 'agent', input: 42_000, output: 5_000, weight: 2, onPr: true, claudeModel: 'claude-opus-5-5', codexModel: 'gpt-6.1-sol' },
  { feature: 'ai_fix_plan', seam: 'agent', input: 20_000, output: 1_800, weight: 1, onPr: true, claudeModel: 'claude-opus-5-5', codexModel: 'gpt-6.1-sol' },
  { feature: 'claude_review_chat', seam: 'agent', input: 9_000, output: 800, weight: 3, onPr: true, claudeModel: 'claude-sonnet-5', codexModel: 'gpt-6.1-terra' },
  { feature: 'sequence_diagram', seam: 'agent', input: 12_000, output: 1_500, weight: 1, onPr: true, claudeModel: 'claude-sonnet-5', codexModel: 'gpt-6.1-terra' },
  { feature: 'ai_resolve', seam: 'agent', input: 22_000, output: 2_600, weight: 0.5, onPr: true, claudeModel: 'claude-opus-5-5', codexModel: 'gpt-6.1-sol' },
  { feature: 'sprint_briefs', seam: 'summary', input: 3_500, output: 400, weight: 3, onPr: false, claudeModel: 'claude-haiku-5-5', codexModel: 'gpt-6-luna' },
  { feature: 'sprint_paths', seam: 'agent', input: 11_000, output: 900, weight: 1, onPr: false, claudeModel: 'claude-sonnet-5', codexModel: 'gpt-6.1-terra' },
  { feature: 'reference_docs_build', seam: 'agent', input: 24_000, output: 3_000, weight: 0.4, onPr: false, claudeModel: 'claude-sonnet-5', codexModel: 'gpt-6.1-terra' },
  { feature: 'story_docs_alignment', seam: 'agent', input: 10_000, output: 900, weight: 0.6, onPr: false, claudeModel: 'claude-sonnet-5', codexModel: 'gpt-6.1-terra' },
  { feature: 'flow_pointers', seam: 'summary', input: 4_000, output: 500, weight: 1, onPr: false, claudeModel: 'claude-haiku-5-5', codexModel: 'gpt-6-luna' },
];

/** A rough US$ per token by model, for the demo's Claude rows only (an API key's view). */
function usd(model: string, input: number, output: number): number {
  const [i, o] = model.includes('opus') ? [5, 25] : model.includes('haiku') ? [1, 5] : [3, 15];
  return (input * i + output * o) / 1_000_000;
}

export async function seedDemoAiUsage(c: AiUsageSeedCtx): Promise<{ ledger: number; reruns: number }> {
  const { db, schema, now, workspaceId } = c;
  const nowMs = now.getTime();
  const { aiUsage, claudeReviews: cr, ticketReviews: tr, ciReviews, aiFixes, pullRequests: pr, workspaceRepos: wr } = schema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = [];
  const push = (r: {
    feature: string;
    seam: 'agent' | 'summary';
    provider: 'claude' | 'codex';
    model: string;
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    prId: number | null;
    repoId: number | null;
    at: Date;
  }) =>
    rows.push({
      accountId: 1,
      seam: r.seam,
      feature: r.feature,
      provider: r.provider,
      model: r.model,
      costUsd: r.provider === 'codex' ? 0 : (r.costUsd ?? usd(r.model, r.inputTokens ?? 0, r.outputTokens ?? 0)),
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      prId: r.prId,
      repoId: r.repoId,
      occurredAt: r.at,
    });

  // The workspace's pull requests.
  const repoIds = ((await db.select({ repoId: wr.repoId }).from(wr).where(eq(wr.workspaceId, workspaceId)).execute()) as Array<{ repoId: number }>).map((r) => r.repoId);
  const prs = (await db
    .select({ id: pr.id, repoId: pr.repoId })
    .from(pr)
    .where(and(eq(pr.accountId, 1), inArray(pr.repoId, repoIds)))
    .execute()) as Array<{ id: number; repoId: number }>;
  const repoOf = new Map(prs.map((p) => [p.id, p.repoId]));

  // 1. Every seeded Claude Review run → its ledger row.
  const reviews = (await db.select().from(cr).where(eq(cr.accountId, 1)).execute()) as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const r of reviews) {
    if (r.inputTokens == null && r.outputTokens == null) continue;
    push({
      feature: r.kind === 'replies' ? 'replies_check' : 'claude_review',
      seam: 'agent',
      provider: r.provider === 'codex' ? 'codex' : 'claude',
      model: r.model,
      costUsd: r.costUsd,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      prId: r.prId,
      repoId: repoOf.get(r.prId) ?? null,
      at: r.createdAt,
    });
  }

  // 2. Three earlier auto re-reviews of #116 on older heads, and one auto run that failed part-way.
  const r116 = reviews.filter((r) => r.prId === 116 && r.kind == null).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  let reruns = 0;
  if (r116 != null) {
    const { id: _id, ...rest } = r116;
    const base116 = r116.createdAt.getTime();
    const clones = [
      { head: 'demo116a', hoursBefore: 30, status: 'succeeded', input: 13_200, output: 1_000 },
      { head: 'demo116b', hoursBefore: 26, status: 'succeeded', input: 13_600, output: 1_000 },
      { head: 'demo116c', hoursBefore: 20, status: 'failed', input: 9_800, output: 300 },
      { head: 'demo116d', hoursBefore: 9, status: 'succeeded', input: 13_900, output: 1_100 },
    ];
    for (const k of clones) {
      const at = new Date(base116 - k.hoursBefore * HOUR);
      const model = 'claude-sonnet-5';
      const costUsd = usd(model, k.input, k.output);
      await db
        .insert(cr)
        .values({
          ...rest,
          headSha: `${k.head}${'0'.repeat(32)}`.slice(0, 40),
          status: k.status,
          model,
          provider: 'claude',
          trigger: 'auto',
          costUsd,
          inputTokens: k.input,
          outputTokens: k.output,
          cacheReadTokens: Math.round(k.input * 2.4),
          error: k.status === 'failed' ? 'The run stopped before it finished.' : null,
          postedReviewId: null,
          postedAt: null,
          autoPost: null,
          createdAt: at,
          finishedAt: new Date(at.getTime() + 4 * 60_000),
        })
        .execute();
      push({ feature: 'claude_review', seam: 'agent', provider: 'claude', model, costUsd, inputTokens: k.input, outputTokens: k.output, prId: 116, repoId: repoOf.get(116) ?? null, at });
      reruns += 1;
    }
  }

  // 3. Every seeded ticket review, CI review and AI Fix run → its ledger row.
  const tickets = (await db.select().from(tr).where(eq(tr.accountId, 1)).execute()) as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const t of tickets) {
    if (t.inputTokens == null && t.outputTokens == null) continue;
    push({ feature: 'ticket_review', seam: 'agent', provider: t.provider === 'codex' ? 'codex' : 'claude', model: t.model, costUsd: t.costUsd, inputTokens: t.inputTokens, outputTokens: t.outputTokens, prId: t.originPrId, repoId: t.originPrId != null ? (repoOf.get(t.originPrId) ?? null) : null, at: t.createdAt });
  }
  for (const r of (await db.select().from(ciReviews).where(eq(ciReviews.accountId, 1)).execute()) as Array<Record<string, any>>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (r.inputTokens == null && r.outputTokens == null) continue;
    push({ feature: 'ci_review', seam: 'agent', provider: r.provider === 'codex' ? 'codex' : 'claude', model: r.model, costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, prId: r.prId, repoId: repoOf.get(r.prId) ?? null, at: r.createdAt });
  }
  for (const r of (await db.select().from(aiFixes).where(eq(aiFixes.accountId, 1)).execute()) as Array<Record<string, any>>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (r.inputTokens != null || r.outputTokens != null) {
      push({ feature: 'ai_fix', seam: 'agent', provider: r.provider === 'codex' ? 'codex' : 'claude', model: r.model, costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, prId: r.prId, repoId: repoOf.get(r.prId) ?? null, at: r.createdAt });
    }
    // A plan stores its cost only: its ledger row carries no token count (the report counts it as a run).
    if (r.planCostUsd != null && r.planCostUsd > 0 && r.planProvider !== 'codex') {
      push({ feature: 'ai_fix_plan', seam: 'agent', provider: 'claude', model: r.planModel ?? r.model, costUsd: r.planCostUsd, inputTokens: null, outputTokens: null, prId: r.prId, repoId: repoOf.get(r.prId) ?? null, at: r.createdAt });
    }
  }

  // 4. Twelve weeks of history, rising gently, quieter at weekends. A handful of PRs take most of it.
  const rand = rng(20261030);
  const total = SHAPES.reduce((n, s) => n + s.weight, 0);
  const pick = (): FeatureShape => {
    let x = rand() * total;
    for (const s of SHAPES) if ((x -= s.weight) < 0) return s;
    return SHAPES[0]!;
  };
  const hot = prs.slice(0, Math.min(6, prs.length));
  for (let d = 84; d >= 1; d -= 1) {
    const day = new Date(nowMs - d * DAY);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const trend = 0.6 + (0.6 * (84 - d)) / 84;
    const runs = Math.round((weekend ? 2 : 9) * trend * (0.7 + rand() * 0.6));
    for (let i = 0; i < runs; i += 1) {
      const s = pick();
      const codex = rand() < 0.25;
      const scale = 0.6 + rand() * 0.8;
      const p = s.onPr && prs.length > 0 ? (rand() < 0.55 && hot.length > 0 ? hot[Math.floor(rand() * hot.length)]! : prs[Math.floor(rand() * prs.length)]!) : null;
      push({
        feature: s.feature,
        seam: s.seam,
        provider: codex ? 'codex' : 'claude',
        model: codex ? s.codexModel : s.claudeModel,
        costUsd: null,
        inputTokens: Math.round(s.input * scale),
        outputTokens: Math.round(s.output * scale),
        prId: p?.id ?? null,
        repoId: p?.repoId ?? null,
        at: new Date(day.getTime() + (9 + Math.floor(rand() * 9)) * HOUR),
      });
    }
  }

  for (let i = 0; i < rows.length; i += 200) await db.insert(aiUsage).values(rows.slice(i, i + 200)).execute();
  return { ledger: rows.length, reruns };
}
