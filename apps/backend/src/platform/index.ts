import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ProContext } from './contract.js';
import { makeHaikuClient } from './llm/seam.js';
import { registerInsightsRoutes } from './insights/routes.js';
import { registerSprintReportRoutes } from './insights/sprint-report.js';
import { registerPeriodReportRoutes } from './insights/period-routes.js';
import { registerBotBehaviourRoutes } from './bots/behaviour-routes.js';
import { registerBotBenchmarkRoutes } from './bots/benchmark-routes.js';
import { registerBotBenchmarkPlacementRoutes } from './bots/benchmark/placement-routes.js';
import { registerSynthesisRoutes } from './synthesis/routes.js';
import { registerWorkPlanRoutes } from './work-plan/routes.js';
import { registerFlowPointerRoutes } from './flow-pointers/routes.js';
import { registerBotThemesRoutes } from './bot-themes/routes.js';
import { registerAdvisorRoutes } from './advisor/routes.js';
import { registerAnnotationRoutes } from './annotations/routes.js';
import { registerSettingsRoutes } from './settings/routes.js';
import { getComparisonWindow } from './settings/store.js';
import { registerSlackFeature } from './slack/cron.js';
import { eraseProByAccountId, pruneProByPrIds } from './retention.js';

// THE PLATFORM — reporting (Reports, Chronology pointers, period reports), Bots Monitoring (ROI,
// behaviour, the peer benchmark, the advisor, bot themes), the work-plan wording, the impact note,
// the Slack digest and the settings behind them. It was the private @pierre/pro plugin; it is core
// now, free, and registered statically at boot (platform/context.ts builds the context, index.ts
// calls this). Every feature is on for every account — there is no capability or entitlement.
//
// The `/api/pro/...` URL paths and the `pro_*` table names are historical and stay as they are:
// the SPA calls those paths, and existing databases hold those tables.

export async function registerPlatform(app: FastifyInstance, ctx: ProContext): Promise<void> {
  // The platform's own tables (each file runs once, tracked in `pro_migrations` —
  // the bookkeeping existing installs already carry, so nothing re-runs). The folders sit beside
  // this module in src/ and in the release build's dist/ alike.
  await ctx.registerMigrations(fileURLToPath(new URL('./migrations', import.meta.url)));

  // Prune the platform's own tables whenever the core TTL sweep deletes a batch of PRs.
  ctx.registerRetention(({ prIds }) => pruneProByPrIds(ctx, prIds));

  // Delete the platform's own account-scoped tables when a user erases their account.
  ctx.registerAccountErasure?.(({ accountId }) => eraseProByAccountId(ctx, accountId));

  // THE REPORTING WINDOW: core's Reports surfaces (flow tiles, Activity and Reach by repository,
  // Chronology) measure the SAME window as everything here, because they ask THIS resolver.
  ctx.registerReportingWindow?.(({ accountId, workspaceId, nowMs }) =>
    getComparisonWindow(ctx, accountId, workspaceId, nowMs),
  );

  // Per-workspace config (sprint window / Slack / bots) for the settings modal.
  registerSettingsRoutes(app, ctx);

  const llm = makeHaikuClient(ctx);
  // The one-shot features that run LOCALLY on the reader's Claude Code login (the host's ONE local
  // route): the impact note, the work-plan wording and the (Slack) sprint report. Reports and Bots
  // Monitoring keep `llm` and the summary key.
  const localLlm = makeHaikuClient(ctx, { localAgent: true });

  // Workspace review-intelligence "Insights" — no AI; the route reads existing data.
  registerInsightsRoutes(app, ctx);

  // Bot behaviour depth (no AI). The compute is in db/queries.ts (getBotBehaviourAnalytics).
  registerBotBehaviourRoutes(app, ctx);

  // The peer-cohort benchmark (no AI, no database, no GitHub) — projects the bundled
  // `data/benchmark/benchmark-fit.json`. Nothing about the caller reaches the response.
  registerBotBenchmarkRoutes(app, ctx);

  // …and placing the workspace IN that cohort, a sibling route: a real fold over the tenant's own
  // pull requests, threads and comments, workspace-scoped and echoing `workspaceId`.
  registerBotBenchmarkPlacementRoutes(app, ctx);

  // Insights "Sprint report" — a summary OF the Insights (headline metrics + PR-linked issues).
  registerSprintReportRoutes(app, ctx, localLlm);

  // Reports — period-over-period reporting: a stored, forwardable artifact per period, a
  // comparison over the coverage-stable repo subset, a refusable forecast and a narrated summary.
  // Generation is MANUAL; a stored report is immutable (a fingerprint mismatch flags it `stale`).
  registerPeriodReportRoutes(app, ctx);

  // The ONE synthesis seam — the cached grouping pass behind the drill-down verdict cards and the
  // workspace bot synthesis (GET = cache read + staleness probe, POST = the only generating path).
  registerSynthesisRoutes(app, ctx, llm);

  // The WORK PLAN's wording — the headline, the per-row "why" and the "what can wait" line on the
  // Pending board. ⚠ The RANKED WORKLIST is core's (db/work-plan.ts) and is not stored here; only
  // the model's prose is cached, joined back to the live rows by WorkPlanItem.id.
  registerWorkPlanRoutes(app, ctx, localLlm);

  // CHRONOLOGY POINTERS — evidence-led pointers beside Reports → Chronology, each citing the pull
  // requests behind it. Core folds the evidence (db/flow-pointers.ts) and sends no person.
  registerFlowPointerRoutes(app, ctx, llm);

  // Bots "What they're flagging" — build.ts computes every figure, the model contributes only the
  // themes + narrative.
  registerBotThemesRoutes(app, ctx, llm);

  // Bot Tuning Advisor — findings → intents → config-PR/brief/issue outputs + the effect panel.
  // Deterministic everywhere except POST …/refine (the one LLM route, its own AI tier).
  registerAdvisorRoutes(app, ctx);

  // The blast-radius IMPACT NOTE — the one kind left on the annotations platform
  // (`pr_comment_annotations`). Older stored kinds are DORMANT (the read skips unknown kinds).
  registerAnnotationRoutes(app, ctx, localLlm);

  // Slack digest delivery: a ticking cron sends the sprint report to a configured webhook at the
  // workspace's cadence, plus POST /api/pro/slack/test and the two per-workspace event signals
  // (slack/signals.ts — Claude Review ran, PR merged).
  registerSlackFeature(app, ctx, localLlm);
}
