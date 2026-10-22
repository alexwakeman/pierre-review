import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { buildAgentContext, type AgentContext } from './agent-context.js';
import { registerClaudeReviewRoutes } from './claude-review/routes.js';
import { registerClaudeReviewChatRoutes } from './claude-review/chat.js';
import { registerAutoReviewSettingsRoutes } from './claude-review/auto-settings.js';
import { registerAutoReview } from './claude-review/auto.js';
import { reconcileReviewsOnStartup } from './claude-review/manager.js';
import { registerThreadCheckRoutes } from './claude-review/thread-check-routes.js';
import { reconcileThreadChecksOnStartup } from './claude-review/thread-check.js';
import { registerTicketReviewRoutes } from './ticket-review/routes.js';
import { reconcileTicketReviewsOnStartup } from './ticket-review/manager.js';
import { registerTicketReviewSweep } from './ticket-review/sweep.js';
import { registerCiReviewRoutes } from './ci-review/routes.js';
import { reconcileCiReviewsOnStartup } from './ci-review/manager.js';
import { registerCiReviewSweep } from './ci-review/sweep.js';
import { registerSequenceDiagramRoutes } from './diagrams/routes.js';
import { reconcileDiagramsOnStartup } from './diagrams/manager.js';
import { registerAiFixRoutes } from '../coding/ai-fix/routes.js';
import { reconcileFixesOnStartup } from '../coding/ai-fix/manager.js';
import { registerAiResolveRoutes } from '../coding/ai-resolve/routes.js';
import { registerStoryLabelRoutes } from './story-labels/routes.js';
import { registerSprintBriefs } from './sprint-briefs/index.js';
import { registerSprintAskRoutes } from './sprint-ask/routes.js';
import { runOpen } from '../api/routes/conflicts.js';
import { registerReferenceDocsRoutes } from '../reference-docs/routes.js';
import { reconcileReferenceDocsOnStartup } from '../reference-docs/startup.js';
import { registerStoryDocsRoutes } from './story-docs/routes.js';
import { reconcileStoryDocsOnStartup } from './story-docs/manager.js';

// THE AGENTIC FEATURES' ONE REGISTRATION POINT — Claude Review (run, follow-up, the chat, auto
// review), the ticket review (one run per ticket across its PRs, + its cascade sweeper), the CI
// review (why checks failed on a PR's head, + its sweeper) and AI Fix's fixer. CORE and FREE
// since apiVersion 22 (they were the plugin's "pro+" tier); they run on the user's OWN Claude Code session or
// ANTHROPIC_API_KEY (review/auth.ts), and Limn stores no key and charges nothing for them.
//
// LIMN_AI_DISABLED=true (the kill switch) turns `aiEnabled` off, and then nothing agentic
// registers — the routes 404.

/** Is any agentic surface allowed in this process? */
export function agenticAllowed(): boolean {
  return config.aiEnabled;
}

/** Register every agentic ROUTE. Called from buildApp; a no-op under the kill switch. */
export function registerAgenticRoutes(app: FastifyInstance): AgentContext | null {
  if (!agenticAllowed()) return null;
  const ctx = buildAgentContext(app.log);
  registerClaudeReviewRoutes(app, ctx);
  registerClaudeReviewChatRoutes(app, ctx);
  registerAutoReviewSettingsRoutes(app, ctx);
  // CHECK THREADS: a light, threads-only pass over the review threads changed since their last
  // judgement (claude-review/thread-check.ts) — a click, or the auto-review sweeper on a comment burst.
  registerThreadCheckRoutes(app, ctx);
  registerTicketReviewRoutes(app, ctx);
  registerCiReviewRoutes(app, ctx);
  // SEQUENCE DIAGRAMS: a separate Sonnet process queued after every finished review (and by Redraw).
  registerSequenceDiagramRoutes(app, ctx);
  registerAiFixRoutes(app, ctx);
  // "Resolve with Claude" — the agentic half of the merge-conflict resolver. The resolver's own
  // routes stay in both modes (app.ts); this one is agentic and follows this function's rule.
  registerAiResolveRoutes(app, ctx, { runOpen });
  // STORY LABELS (Reports → Stories): Haiku labels each story's criteria against a
  // fixed rubric. Pro on `periodReports` too, and agentic — so here and nowhere else.
  registerStoryLabelRoutes(app, ctx);
  // THIS SPRINT (its own rail line): the BRIEF pass the sprint read hands each workspace to (Haiku:
  // summary, itemised criteria, references → the graph's edges and ghost chains, then the themes and
  // the sprint builder) and "Ask Claude about this sprint" (Haiku over the stored graph). FREE (no Pro
  // gate) — local-only and agentic, like the rest. ("Check against code" was REMOVED 2026-10-18; its
  // tables are dormant.)
  registerSprintBriefs(ctx);
  registerSprintAskRoutes(app, ctx);
  // THE REFERENCE DOCS LIBRARY (Activity → Docs): upload / URL → a Sonnet 5 build into a markdown
  // tree (INDEX → CONTENTS → sections) + the docs chat. Agentic and local-only, so here and nowhere else.
  registerReferenceDocsRoutes(app, ctx);
  // CHECK A STORY AGAINST THE DOCS: on a click only, a Haiku shortlist of library sections, then a
  // Sonnet read of ONLY those documents (review/story-docs/). Agentic and local-only.
  registerStoryDocsRoutes(app, ctx);
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
    await reconcileThreadChecksOnStartup(ctx);
  } catch (err) {
    app.log.warn({ err }, 'thread checks: startup reconcile failed');
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
  try {
    await reconcileDiagramsOnStartup(ctx);
  } catch (err) {
    app.log.warn({ err }, 'sequence diagrams: startup reconcile failed');
  }
  await reconcileFixesOnStartup(ctx);
  try {
    await reconcileReferenceDocsOnStartup(ctx);
  } catch (err) {
    app.log.warn({ err }, 'reference docs: startup reconcile failed');
  }
  try {
    await reconcileStoryDocsOnStartup(ctx);
  } catch (err) {
    app.log.warn({ err }, 'story docs: startup reconcile failed');
  }
}
