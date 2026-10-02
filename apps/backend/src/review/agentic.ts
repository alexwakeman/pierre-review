import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { buildAgentContext, type AgentContext } from './agent-context.js';
import { registerClaudeReviewRoutes } from './claude-review/routes.js';
import { registerClaudeReviewChatRoutes } from './claude-review/chat.js';
import { registerAutoReviewSettingsRoutes } from './claude-review/auto-settings.js';
import { registerAutoReview } from './claude-review/auto.js';
import { reconcileReviewsOnStartup } from './claude-review/manager.js';
import { registerAiFixRoutes } from '../coding/ai-fix/routes.js';
import { reconcileFixesOnStartup } from '../coding/ai-fix/manager.js';

// THE AGENTIC FEATURES' ONE REGISTRATION POINT — Claude Review (run, follow-up, ticket check, the
// chat, auto review) and AI Fix's fixer. CORE and FREE since apiVersion 22 (they
// were the plugin's "pro+" tier); they run on the user's OWN Claude Code session or
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
  registerAiFixRoutes(app, ctx);
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
  try {
    await reconcileReviewsOnStartup(ctx);
  } catch (err) {
    app.log.warn({ err }, 'claude review: startup reconcile failed');
  }
  await reconcileFixesOnStartup(ctx);
}
