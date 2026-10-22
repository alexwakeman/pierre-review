// Recommendation / profile / config-event persistence (ctx.db over the plugin schema).
// One of the FOUR advisor modules allowed to hold ctx (routes / store / measure / discovery /
// refine — everything else is pure).
//
// Write rules inherited from the one-bot-object story:
//  • Every onConflictDoUpdate targets EXACTLY the table's declared unique (the 0042/0045
//    lesson — a stale target type-checks and throws at the first real write).
//  • The T1 and T3 profile writers build SEPARATE narrowed `set:` objects — a T1 re-answer
//    must never wipe a confirmed manifest and vice versa (the persist() shared-values
//    landmine, verbatim).
//  • Recommendation upserts SPREAD observed keys only: a dismiss must not null out a stored
//    prUrl, an issue filing must not clear retroJson (the partial-response write policy).
import { and, desc, eq } from 'drizzle-orm';
import type {
  AdvisorConfigEventWire,
  AdvisorBotProfileWire,
  AdvisorRecommendationStatus,
  AdvisorRecommendationWire,
  AdvisorIntentKind,
} from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import { proSchemaFor } from '../db.js';

export interface RecommendationSeed {
  botUserId: number;
  intent: string;
  dedupeKey: string;
  targetJson: string;
  evidenceJson: string;
  retroJson?: string;
  outputJson?: string;
}

export interface RecommendationPatch {
  status: AdvisorRecommendationStatus;
  prRepoId?: number;
  prNumber?: number;
  prUrl?: string;
  issueUrl?: string;
}

export async function upsertRecommendation(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
  seed: RecommendationSeed,
  patch: RecommendationPatch,
): Promise<void> {
  const pro = proSchemaFor(ctx.isPg);
  const t = pro.advisorRecommendations;
  const now = new Date();
  // SPREAD the observed keys — `undefined` must mean "leave the stored value alone" in the
  // update half, never "write NULL".
  const observed = {
    ...(patch.prRepoId !== undefined ? { prRepoId: patch.prRepoId } : {}),
    ...(patch.prNumber !== undefined ? { prNumber: patch.prNumber } : {}),
    ...(patch.prUrl !== undefined ? { prUrl: patch.prUrl } : {}),
    ...(patch.issueUrl !== undefined ? { issueUrl: patch.issueUrl } : {}),
    ...(seed.retroJson !== undefined ? { retroJson: seed.retroJson } : {}),
    ...(seed.outputJson !== undefined ? { outputJson: seed.outputJson } : {}),
  };
  await ctx.db
    .insert(t)
    .values({
      accountId,
      workspaceId,
      botUserId: seed.botUserId,
      intent: seed.intent,
      dedupeKey: seed.dedupeKey,
      targetJson: seed.targetJson,
      evidenceJson: seed.evidenceJson,
      retroJson: seed.retroJson ?? null,
      outputJson: seed.outputJson ?? null,
      status: patch.status,
      prRepoId: patch.prRepoId ?? null,
      prNumber: patch.prNumber ?? null,
      prUrl: patch.prUrl ?? null,
      issueUrl: patch.issueUrl ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      // ⚠ Must match advrec_account_ws_key EXACTLY: (account_id, workspace_id, dedupe_key).
      target: [t.accountId, t.workspaceId, t.dedupeKey],
      set: {
        status: patch.status,
        targetJson: seed.targetJson,
        evidenceJson: seed.evidenceJson,
        ...observed,
        updatedAt: now,
      },
    })
    .execute();
}

interface RecommendationRow {
  id: number;
  botUserId: number;
  intent: string;
  dedupeKey: string;
  status: string;
  prRepoId: number | null;
  prNumber: number | null;
  prUrl: string | null;
  issueUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function listRecommendations(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<AdvisorRecommendationWire[]> {
  const pro = proSchemaFor(ctx.isPg);
  const t = pro.advisorRecommendations;
  const rows = (await ctx.db
    .select({
      id: t.id,
      botUserId: t.botUserId,
      intent: t.intent,
      dedupeKey: t.dedupeKey,
      status: t.status,
      prRepoId: t.prRepoId,
      prNumber: t.prNumber,
      prUrl: t.prUrl,
      issueUrl: t.issueUrl,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .orderBy(desc(t.updatedAt))
    .execute()) as RecommendationRow[];
  return rows.map((r) => ({
    dedupeKey: r.dedupeKey,
    intent: r.intent as AdvisorIntentKind,
    botUserId: r.botUserId,
    status: r.status as AdvisorRecommendationStatus,
    prNumber: r.prNumber,
    prUrl: r.prUrl,
    issueUrl: r.issueUrl,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

// Compute-on-read staleness pass (no cron): promote 'pr_opened' → 'pr_merged' off the SYNCED
// core pull_requests row, and write the 'advisor_pr' config-event anchor at mergedAt — the
// moment measurement starts caring. ⚠ ctx.schema is Record<string, any>: the core columns
// named here (state / mergedAt / repoId / number / accountId) are greped facts, not
// compiler-checked ones.
export async function promoteMergedPrs(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<void> {
  const pro = proSchemaFor(ctx.isPg);
  const t = pro.advisorRecommendations;
  const rows = (await ctx.db
    .select({
      id: t.id,
      botUserId: t.botUserId,
      dedupeKey: t.dedupeKey,
      prRepoId: t.prRepoId,
      prNumber: t.prNumber,
      prUrl: t.prUrl,
      targetJson: t.targetJson,
    })
    .from(t)
    .where(
      and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), eq(t.status, 'pr_opened')),
    )
    .execute()) as Array<{
    id: number;
    botUserId: number;
    dedupeKey: string;
    prRepoId: number | null;
    prNumber: number | null;
    prUrl: string | null;
    targetJson: string;
  }>;
  if (rows.length === 0) return;
  const prT = ctx.schema.pullRequests;
  for (const row of rows) {
    if (row.prRepoId == null || row.prNumber == null) continue;
    try {
      const prs = (await ctx.db
        .select({ state: prT.state, mergedAt: prT.mergedAt })
        .from(prT)
        .where(
          and(
            eq(prT.accountId, accountId),
            eq(prT.repoId, row.prRepoId),
            eq(prT.number, row.prNumber),
          ),
        )
        .limit(1)
        .execute()) as Array<{ state: string; mergedAt: Date | null }>;
      const pr = prs[0];
      if (!pr || pr.state !== 'merged') continue;
      const mergedAt = pr.mergedAt ?? new Date();
      await ctx.db
        .update(t)
        .set({ status: 'pr_merged', updatedAt: new Date() })
        .where(eq(t.id, row.id))
        .execute();
      await insertConfigEvent(ctx, accountId, workspaceId, {
        repoId: row.prRepoId,
        botUserId: row.botUserId,
        source: 'advisor_pr',
        occurredAt: mergedAt,
        description: `Advisor tuning PR #${row.prNumber} merged`,
        recommendationId: row.id,
        prNumber: row.prNumber,
        prUrl: row.prUrl,
      });
    } catch (err) {
      ctx.log.warn({ err, dedupeKey: row.dedupeKey }, 'advisor: pr_merged promotion failed');
    }
  }
}

// ── Profiles (one row per (account, workspace, bot) — the one-bot-object rule) ─────────────

interface ProfileRow {
  botUserId: number;
  kindHint: string | null;
  configPath: string | null;
  ownerContact: string | null;
  ownerRepo: string | null;
  notes: string | null;
  profileSource: string | null;
  manifestJson: string | null;
  manifestConfirmedAt: Date | null;
}

const toProfileWire = (r: ProfileRow): AdvisorBotProfileWire => ({
  botUserId: r.botUserId,
  kindHint: r.kindHint,
  configPath: r.configPath,
  ownerContact: r.ownerContact,
  ownerRepo: r.ownerRepo,
  notes: r.notes,
  profileSource: (r.profileSource as 'user' | 'inferred' | null) ?? null,
  hasManifest: r.manifestJson != null,
  manifestConfirmedAt: r.manifestConfirmedAt?.toISOString() ?? null,
});

// Returns the wire shape PLUS manifestJson (the routes strip it before it reaches a
// response — only the config-pr/manifest paths execute it).
export async function listProfiles(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<(AdvisorBotProfileWire & { manifestJson: string | null })[]> {
  const pro = proSchemaFor(ctx.isPg);
  const t = pro.advisorBotProfiles;
  const rows = (await ctx.db
    .select({
      botUserId: t.botUserId,
      kindHint: t.kindHint,
      configPath: t.configPath,
      ownerContact: t.ownerContact,
      ownerRepo: t.ownerRepo,
      notes: t.notes,
      profileSource: t.profileSource,
      manifestJson: t.manifestJson,
      manifestConfirmedAt: t.manifestConfirmedAt,
    })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .execute()) as ProfileRow[];
  return rows.map((r) => ({ ...toProfileWire(r), manifestJson: r.manifestJson }));
}

export async function getProfileRow(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
  botUserId: number,
): Promise<(AdvisorBotProfileWire & { manifestJson: string | null }) | null> {
  const pro = proSchemaFor(ctx.isPg);
  const t = pro.advisorBotProfiles;
  const rows = (await ctx.db
    .select({
      botUserId: t.botUserId,
      kindHint: t.kindHint,
      configPath: t.configPath,
      ownerContact: t.ownerContact,
      ownerRepo: t.ownerRepo,
      notes: t.notes,
      profileSource: t.profileSource,
      manifestJson: t.manifestJson,
      manifestConfirmedAt: t.manifestConfirmedAt,
    })
    .from(t)
    .where(
      and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), eq(t.botUserId, botUserId)),
    )
    .limit(1)
    .execute()) as ProfileRow[];
  const row = rows[0];
  return row ? { ...toProfileWire(row), manifestJson: row.manifestJson } : null;
}

export interface ProfileT1Patch {
  kindHint?: string | null;
  configPath?: string | null;
  ownerContact?: string | null;
  ownerRepo?: string | null;
  notes?: string | null;
}

// T1 writer — NARROWED set: never touches manifestJson / manifestConfirmedAt.
export async function putProfileT1(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
  botUserId: number,
  patch: ProfileT1Patch,
): Promise<void> {
  const pro = proSchemaFor(ctx.isPg);
  const t = pro.advisorBotProfiles;
  const now = new Date();
  const observed = {
    ...(patch.kindHint !== undefined ? { kindHint: patch.kindHint } : {}),
    ...(patch.configPath !== undefined ? { configPath: patch.configPath } : {}),
    ...(patch.ownerContact !== undefined ? { ownerContact: patch.ownerContact } : {}),
    ...(patch.ownerRepo !== undefined ? { ownerRepo: patch.ownerRepo } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
  };
  await ctx.db
    .insert(t)
    .values({
      accountId,
      workspaceId,
      botUserId,
      kindHint: patch.kindHint ?? null,
      configPath: patch.configPath ?? null,
      ownerContact: patch.ownerContact ?? null,
      ownerRepo: patch.ownerRepo ?? null,
      notes: patch.notes ?? null,
      profileSource: 'user',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      // ⚠ Must match advprof_account_ws_bot EXACTLY: (account_id, workspace_id, bot_user_id).
      target: [t.accountId, t.workspaceId, t.botUserId],
      set: { ...observed, profileSource: 'user', updatedAt: now },
    })
    .execute();
}

// T3 writer — NARROWED set: never touches the T1 fields.
export async function putProfileManifest(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
  botUserId: number,
  manifestJson: string,
): Promise<void> {
  const pro = proSchemaFor(ctx.isPg);
  const t = pro.advisorBotProfiles;
  const now = new Date();
  await ctx.db
    .insert(t)
    .values({
      accountId,
      workspaceId,
      botUserId,
      manifestJson,
      manifestConfirmedAt: now,
      profileSource: 'user',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [t.accountId, t.workspaceId, t.botUserId],
      set: { manifestJson, manifestConfirmedAt: now, updatedAt: now },
    })
    .execute();
}

// ── Config events (append-only anchor log) ─────────────────────────────────────────────────

export interface ConfigEventSeed {
  repoId: number;
  botUserId: number;
  source: 'advisor_pr' | 'user_reported' | 'detected';
  occurredAt: Date;
  configPath?: string | null;
  description?: string | null;
  recommendationId?: number | null;
  prNumber?: number | null;
  prUrl?: string | null;
}

export async function insertConfigEvent(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
  seed: ConfigEventSeed,
): Promise<void> {
  const pro = proSchemaFor(ctx.isPg);
  await ctx.db
    .insert(pro.advisorConfigEvents)
    .values({
      accountId,
      workspaceId,
      repoId: seed.repoId,
      botUserId: seed.botUserId,
      source: seed.source,
      occurredAt: seed.occurredAt,
      configPath: seed.configPath ?? null,
      description: seed.description ?? null,
      recommendationId: seed.recommendationId ?? null,
      prNumber: seed.prNumber ?? null,
      prUrl: seed.prUrl ?? null,
      createdAt: new Date(),
    })
    .execute();
}

export async function listConfigEvents(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
  botUserId?: number,
): Promise<(AdvisorConfigEventWire & { occurredAtMs: number })[]> {
  const pro = proSchemaFor(ctx.isPg);
  const t = pro.advisorConfigEvents;
  const where = botUserId
    ? and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId), eq(t.botUserId, botUserId))
    : and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId));
  const rows = (await ctx.db
    .select({
      id: t.id,
      repoId: t.repoId,
      botUserId: t.botUserId,
      source: t.source,
      occurredAt: t.occurredAt,
      configPath: t.configPath,
      description: t.description,
      prNumber: t.prNumber,
      prUrl: t.prUrl,
    })
    .from(t)
    .where(where)
    .orderBy(desc(t.occurredAt))
    .execute()) as Array<{
    id: number;
    repoId: number;
    botUserId: number;
    source: string;
    occurredAt: Date;
    configPath: string | null;
    description: string | null;
    prNumber: number | null;
    prUrl: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    repoId: r.repoId,
    botUserId: r.botUserId,
    source: r.source as 'advisor_pr' | 'user_reported' | 'detected',
    occurredAt: r.occurredAt.toISOString(),
    occurredAtMs: r.occurredAt.getTime(),
    configPath: r.configPath,
    description: r.description,
    prNumber: r.prNumber,
    prUrl: r.prUrl,
  }));
}
