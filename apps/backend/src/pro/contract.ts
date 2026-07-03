import type {
  FastifyInstance,
  FastifyRequest,
  FastifyBaseLogger,
} from 'fastify';
import type { ReviewEventBus, LearningsProvider } from '../review/events.js';

// The typed boundary between OSS core and the optional, dynamically-imported
// @pierre/pro plugin. This file has NO dependency on @pierre/pro — it only
// defines the contract (the ProContext the host hands in, the ProCapabilities
// advertised back, the live capability singleton). The plugin imports a
// hand-copied import type-only mirror of these shapes; the host refactors freely
// behind this one versioned surface.

export interface ProCapabilities {
  activityDigest: boolean; // WS2 per-repo LLM headlines digest
  reviewMemory: boolean; // WS3 Claude Review learnings
}

// A curated, stable slice of the read layer, handed to the plugin via ctx.queries
// (the plugin never imports the host's query module). Returns are `unknown` to
// keep the contract decoupled from the host's concrete result types; the plugin
// re-derives the shapes it needs. getInsights/getOpenPrs take an account id +
// optional repo ids (the host adapts these to its internal filters objects).
export interface ProHostQueries {
  getInsights(accountId: number, repoIds: number[] | null): Promise<unknown>;
  getRepoAnalytics(accountId: number, repoId: number): Promise<unknown>;
  getOpenPrs(args: {
    accountId: number;
    repoIds?: number[] | null;
  }): Promise<unknown>;
  getActivity(accountId: number, repoIds?: number[] | null): Promise<unknown>; // WS2 aggregate (lands in a later phase)
}

export interface ProContext {
  log: FastifyBaseLogger;
  host: { version: string; deploymentMode: 'local' | 'cloud'; isCloud: boolean };
  accountIdOf(req: FastifyRequest): number; // the single scoping seam
  // node-postgres-TYPED drizzle instance → a stray .get()/.all()/.run() is a
  // compile error in the plugin too.
  db: typeof import('../db/client.js').db;
  schema: typeof import('../db/client.js').schema;
  runTransaction: typeof import('../db/client.js').runTransaction;
  isPg: boolean;
  // Plugin-owned dual-dialect migrator hook (CREATE TABLE IF NOT EXISTS + its own
  // pro_migrations bookkeeping; see pro/migrate.ts).
  registerMigrations(sqliteFolder: string, pgFolder: string): Promise<void>;
  // The cheap-tier completion seam (review/llm.ts) — so the plugin adds no new
  // Anthropic dependency.
  llm: {
    complete(opts: {
      model?: string;
      system?: string;
      prompt: string;
      maxTokens?: number;
      // Explicit API key → the raw metered path; omitted → the ambient Claude
      // session. Lets the summary use its OWN discrete credential.
      apiKey?: string;
    }): Promise<{
      text: string;
      usage?: { inputTokens: number; outputTokens: number };
    }>;
  };
  queries: ProHostQueries;
  reviewEvents: ReviewEventBus; // WS3 capture seam
  registerLearningsProvider(p: LearningsProvider): void; // WS3 injection seam
}

export interface ProPlugin {
  apiVersion: 1; // contract handshake; host warns on mismatch
  register(app: FastifyInstance, ctx: ProContext): Promise<ProCapabilities>;
}

// The live capability singleton, mirrored to the frontend via /api/me exactly
// like claudeReviewEnabled. All-false in OSS mode (no plugin ever calls the
// setter).
const EMPTY: ProCapabilities = { activityDigest: false, reviewMemory: false };
let active: ProCapabilities = EMPTY;
export function setProCapabilities(c: ProCapabilities): void {
  active = c;
}
export function getProCapabilities(): ProCapabilities {
  return active;
}
