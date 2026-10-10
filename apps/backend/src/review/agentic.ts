import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { buildAgentContext, type AgentContext } from './agent-context.js';
import { registerClaudeReviewRoutes } from './claude-review/routes.js';
import { registerClaudeReviewChatRoutes } from './claude-review/chat.js';
import { registerAutoReviewSettingsRoutes } from './claude-review/auto-settings.js';
import { registerAutoReview } from './claude-review/auto.js';
import { reconcileReviewsOnStartup } from './claude-review/manager.js';
import { registerTicketReviewRoutes } from './ticket-review/routes.js';
import { reconcileTicketReviewsOnStartup } from './ticket-review/manager.js';
import { registerTicketReviewSweep } from './ticket-review/sweep.js';
import { registerCiReviewRoutes } from './ci-review/routes.js';
import { reconcileCiReviewsOnStartup } from './ci-review/manager.js';
import { registerCiReviewSweep } from './ci-review/sweep.js';
import { registerAiFixRoutes } from '../coding/ai-fix/routes.js';
import { reconcileFixesOnStartup } from '../coding/ai-fix/manager.js';
import { registerAiResolveRoutes } from '../coding/ai-resolve/routes.js';
import { registerStoryReportRoutes } from './story-report/routes.js';
import { reconcileStoryReportsOnStartup } from './story-report/manager.js';
import { registerStoryLabelRoutes } from './story-labels/routes.js';
import { registerSprintAssessRoutes } from './sprint-assess/routes.js';
import { reconcileSprintAssessmentsOnStartup } from './sprint-assess/manager.js';
import { registerSprintLabelling } from './sprint-labels/index.js';
import { runOpen } from '../api/routes/conflicts.js';

// THE AGENTIC FEATURES' ONE REGISTRATION POINT — Claude Review (run, follow-up, the chat, auto
// review), the ticket review (one run per ticket across its PRs, + its cascade sweeper), the CI
// review (why checks failed on a PR's head, + its sweeper), AI Fix's fixer and the story report
// (Reports → Stories — the one agentic run that is ALSO Pro, on `periodReports`). CORE and FREE
// since apiVersion 22 (they were the plugin's "pro+" tier); they run on the user's OWN Claude Code session or
// ANTHROPIC_API_KEY (review/auth.ts), and Limn stores no key and charges nothing for them.
//
// ⚠ THE CLOUD GUARANTEE IS THIS `isCloud` CHECK, EXPLICITLY. It used to rest on an env var being
// unset (the plugin's PRO_ADVANCED_AI_ENABLED), so one Railway variable stood between a paid cloud
// account and routes with no SDK and no credential behind them. Now nothing agentic registers in
// cloud — the routes 404 — and the auth plugin's `isProPath` 402 (which still lists the Claude
// Review URLs and covers the `/api/pro/` AI Fix paths) is a SECOND guard, not the first.
// `config.aiEnabled` is also false in cloud; it is checked separately so the two never collapse
// into one flag again. LIMN_AI_DISABLED=true (the kill switch) turns `aiEnabled` off locally.

/** Is any agentic surface allowed in this process? */
export function agenticAllowed(): boolean {
  if (config.isCloud) return false;
  return config.aiEnabled;
}

/** Register every agentic ROUTE. Called from buildApp; a no-op in cloud or under the kill switch. */
export function registerAgenticRoutes(app: FastifyInstance): AgentContext | null {
  if (!agenticAllowed()) return null;
  const ctx = buildAgentContext(app.log);
  registerClaudeReviewRoutes(app, ctx);
  registerClaudeReviewChatRoutes(app, ctx);
  registerAutoReviewSettingsRoutes(app, ctx);
  registerTicketReviewRoutes(app, ctx);
  registerCiReviewRoutes(app, ctx);
  registerAiFixRoutes(app, ctx);
  // "Resolve with Claude" — the agentic half of the merge-conflict resolver. The resolver's own
  // routes stay in both modes (app.ts); this one is agentic and follows this function's rule.
  registerAiResolveRoutes(app, ctx, { runOpen });
  // The STORY REPORT (Reports → Stories): one Haiku run across 10-20 code-picked stories. Pro on
  // `periodReports` as well (its routes 402), and agentic, so it registers here and nowhere else.
  registerStoryReportRoutes(app, ctx);
  // STORY LABELS (Reports → Stories → Story health): Haiku labels each story's criteria against a
  // fixed rubric. Pro on `periodReports` too, and agentic — so here and nowhere else.
  registerStoryLabelRoutes(app, ctx);
  // REPORTS → THIS SPRINT: "Check against code" (one Sonnet run per ticket over read-only default-branch
  // checkouts, the shared review pool) and the free labels' after-read hook (the sprint list read
  // hands each workspace's unlabelled tickets to the story label run). Pro on `periodReports` too.
  registerSprintAssessRoutes(app, ctx);
  registerSprintLabelling(ctx);
  return ctx;
}

let backgroundStarted = false;

/**
 * The PROCESS-level half, run once at boot (index.ts) after the app is built: the auto-review
 * sweeper on the host scheduler and the crash-orphan reconciles (a run that was `running` when the process died is marked failed).
 * Separate from the routes so a test that builds the app twice does not schedule twice.
 */
export async function startAgenticBackground(app: FastifyInstance): Promise<void> {
  if (!agenticAllowed() || backgroundStarted) return;
  backgroundStarted = true;
  const ctx = buildAgentContext(app.log);
  registerAutoReview(ctx);
  // The ticket review's cascade sweeper rides the same per-workspace auto-review switch; it
  // registers only where auto review can run (`autoReviewAvailable`).
  registerTicketReviewSweep(ctx);
  // The CI review's sweeper rides the same switch: a check that fails on a PR's head is explained
  // at once (no settle, no CI hold — a failing check is final).
  registerCiReviewSweep(ctx);
  try {
    await reconcileReviewsOnStartup(ctx);
  } catch (err) {
    app.log.warn({ err }, 'claude review: startup reconcile failed');
  }
  try {
    await reconcileTicketReviewsOnStartup(ctx);
  } catch (err) {
    app.log.warn({ err }, 'ticket review: startup reconcile failed');
  }
  try {
    await reconcileCiReviewsOnStartup(ctx);
  } catch (err) {
    app.log.warn({ err }, 'ci review: startup reconcile failed');
  }
  await reconcileFixesOnStartup(ctx);
  try {
    await reconcileStoryReportsOnStartup();
  } catch (err) {
    app.log.warn({ err }, 'story report: startup reconcile failed');
  }
  try {
    await reconcileSprintAssessmentsOnStartup();
  } catch (err) {
    app.log.warn({ err }, 'sprint assessment: startup reconcile failed');
  }
}
