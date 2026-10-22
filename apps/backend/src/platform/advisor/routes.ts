// Bot Tuning Advisor routes — the ONLY advisor module handed ctx besides store / measure /
// discovery / refine (§B.1). All under /api/pro/advisor/* (the automatic 402 entitlement
// gate); rate tiers are carved out explicitly in core's tierFor. Scope always resolves via
// the workspace resolver — never a hand-assembled BotScope.
//
// The write contracts that matter:
//  • config-pr RE-DERIVES intents from live findings ∩ the client's selected dedupeKeys —
//    client-sent config text is never trusted (refined prose re-passes the deterministic
//    diff-guard against OUR templated block).
//  • After GitHub 201s a PR/issue, the route may not fail: persistence and visibility
//    problems degrade to `visible:false` / logged warnings, never an error (a retry
//    double-posts).
//  • An UNCONFIRMED manifest never reaches an emitter (advisory only).
import type { FastifyInstance } from 'fastify';
import type {
  AdvisorBotOverlay,
  AdvisorBriefResponse,
  AdvisorConfigEventBody,
  AdvisorConfigPrBody,
  AdvisorConfigPrResponse,
  AdvisorDiscoveryResponse,
  AdvisorFindingsPayload,
  AdvisorFindingsResponse,
  AdvisorIntentWire,
  AdvisorManifestConfirmBody,
  AdvisorPreviewResponse,
  AdvisorProfilePutBody,
  AdvisorRefineBody,
  AdvisorRefineResponse,
} from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../contract.js';
import { and, eq } from 'drizzle-orm';
import {
  resolveRequestScope,
  resolveRequestWorkspaceId,
  workspaceScope,
} from '../insights/workspace-request.js';
import { parseFindingsPayload } from './findings.js';
import { deriveIntents, type LintTemplateStat } from './intents.js';
import { extractLintTemplates } from './emitters/lint.js';
import { adapterForKind, type AnyBotAdapter } from './emitters/registry.js';
import { genericProseAdapter, extractManagedBlock } from './emitters/prose.js';
import { manifestAdapter, parseManifest, validateManifest } from './emitters/manifest.js';
import type { AdapterFileInput } from './emitters/adapter.js';
import { COPILOT_CHAR_BUDGET, COPILOT_PATH } from './emitters/copilot-prose.js';
import { buildConfigPr } from './outputs/config-pr.js';
import { renderBrief } from './outputs/brief.js';
import { guardRefinedBlock } from './refine/diff-guard.js';
import { refineManagedBlock } from './refine/refine.js';
import { getEffectResponse } from './measure/effect.js';
import { appSlugFor, scanWorkflows } from './discovery/tier2.js';
import { inferManifest } from './discovery/tier3.js';
import {
  getProfileRow,
  insertConfigEvent,
  listConfigEvents,
  listProfiles,
  listRecommendations,
  promoteMergedPrs,
  putProfileManifest,
  putProfileT1,
  upsertRecommendation,
} from './store.js';

// Evidence window: fixed rolling_30 in v1 (a named constant, not a ninth copy of the
// ternary); the 90-day initial backfill means a newly-added repo has the data.
export const ADVISOR_WINDOW = 'rolling_30' as const;

const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

interface DerivedState {
  payload: AdvisorFindingsPayload;
  intents: AdvisorIntentWire[];
  overlays: AdvisorBotOverlay[];
}

// Resolve the emitter serving one bot: known adapter by kind → confirmed manifest →
// profile-declared prose configPath → null (T5: the brief is the deliverable).
function resolveAdapter(
  kind: string,
  profile: { configPath: string | null; manifestJson: string | null; manifestConfirmedAt: string | null } | null,
): AnyBotAdapter | null {
  const known = adapterForKind(kind);
  if (known) return known;
  if (profile?.manifestJson && profile.manifestConfirmedAt) {
    const parsed = parseManifest(profile.manifestJson);
    if (parsed.ok) return manifestAdapter(parsed.manifest) as AnyBotAdapter;
  }
  if (profile?.configPath) {
    const budget = profile.configPath === COPILOT_PATH ? COPILOT_CHAR_BUDGET : undefined;
    return genericProseAdapter(profile.configPath, { charBudget: budget }) as AnyBotAdapter;
  }
  return null;
}

async function deriveForScope(
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
): Promise<DerivedState> {
  const payload = parseFindingsPayload(
    await ctx.queries.getAdvisorFindings(accountId, ADVISOR_WINDOW, scope),
  );
  const profiles = await listProfiles(ctx, accountId, scope.workspaceId);
  const profileByBot = new Map(profiles.map((p) => [p.botUserId, p]));
  const botsWithConfigTarget = new Set<number>();
  const overlays: AdvisorBotOverlay[] = [];
  for (const bot of payload.bots) {
    const row = profileByBot.get(bot.botUserId) ?? null;
    const adapter = resolveAdapter(bot.kind, row);
    if (adapter) botsWithConfigTarget.add(bot.botUserId);
    // Strip manifestJson before the wire — the profile card shows `hasManifest`, and only
    // the config-pr/manifest paths ever execute the stored manifest.
    const { manifestJson: _manifestJson, ...profileWire } = row ?? {};
    overlays.push({
      botUserId: bot.botUserId,
      adapterKey: adapter?.key ?? null,
      adapterName: adapter?.displayName ?? null,
      configTargets: adapter?.configTargets ?? [],
      capabilities: adapter?.capabilities ?? null,
      profile: row ? (profileWire as AdvisorBotOverlay['profile']) : null,
    });
  }

  // T4 lint templates — DeepSource only in v1, and only when such a bot is present (the
  // comments read ships bodies and is not free).
  let lintTemplates: LintTemplateStat[] | undefined;
  const deepsourceBots = payload.bots.filter((b) => b.kind === 'deepsource');
  if (deepsourceBots.length > 0) {
    try {
      const raw = (await ctx.queries.getBotReviewComments(accountId, ADVISOR_WINDOW, scope)) as {
        comments: Array<{ authorUserId: number; body: string | null; derivedState: string | null }>;
      };
      const ids = new Set(deepsourceBots.map((b) => b.botUserId));
      lintTemplates = extractLintTemplates(
        raw.comments
          .filter((c) => ids.has(c.authorUserId) && c.body)
          .map((c) => ({
            botUserId: c.authorUserId,
            body: c.body!,
            actedOn: c.derivedState === 'resolved' || c.derivedState === 'likely_addressed',
          })),
      );
    } catch (err) {
      ctx.log.warn({ err }, 'advisor: lint-template extraction failed');
    }
  }

  const intents = deriveIntents(payload, { botsWithConfigTarget, lintTemplates });
  return { payload, intents, overlays };
}

async function repoInScope(
  ctx: ProContext,
  accountId: number,
  scope: BotScopeWire,
  repoId: number,
): Promise<{ id: number; owner: string; name: string; viewerPermission: string | null } | null> {
  if (!scope.repoIds.includes(repoId)) return null;
  const reposT = ctx.schema.repos;
  const rows = (await ctx.db
    .select({
      id: reposT.id,
      owner: reposT.owner,
      name: reposT.name,
      viewerPermission: reposT.viewerPermission,
    })
    .from(reposT)
    .where(and(eq(reposT.id, repoId), eq(reposT.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ id: number; owner: string; name: string; viewerPermission: string | null }>;
  return rows[0] ?? null;
}

async function fetchAdapterFiles(
  ctx: ProContext,
  accountId: number,
  repo: { owner: string; name: string },
  adapter: AnyBotAdapter,
): Promise<AdapterFileInput[]> {
  const files: AdapterFileInput[] = [];
  for (const target of adapter.configTargets) {
    const read = await ctx.github.readRepoFile(accountId, {
      owner: repo.owner,
      name: repo.name,
      path: target.path,
    });
    files.push({ path: target.path, text: read.ok ? read.text : null });
  }
  return files;
}

const windowLabelFor = (payload: AdvisorFindingsPayload): string =>
  `the trailing 30 days (${payload.window.from.slice(0, 10)} → ${payload.window.to.slice(0, 10)})`;

const dateSlugFor = (payload: AdvisorFindingsPayload): string =>
  payload.generatedAt.slice(0, 10).replaceAll('-', '');

export function registerAdvisorRoutes(app: FastifyInstance, ctx: ProContext): void {
  // ── Read surface ──────────────────────────────────────────────────────────────────────

  app.get<{ Querystring: { workspace?: string } }>(
    '/api/pro/advisor/findings',
    async (req) => {
      const accountId = ctx.accountIdOf(req);
      const scope = await resolveRequestScope(ctx, accountId, req.query.workspace);
      const derived = await deriveForScope(ctx, accountId, scope);
      await promoteMergedPrs(ctx, accountId, scope.workspaceId);
      const recommendations = await listRecommendations(ctx, accountId, scope.workspaceId);
      const resp: AdvisorFindingsResponse = {
        enabled: true,
        workspaceId: scope.workspaceId,
        payload: derived.payload,
        intents: derived.intents,
        overlays: derived.overlays,
        recommendations,
      };
      return resp;
    },
  );

  app.get<{ Querystring: { workspace?: string } }>(
    '/api/pro/advisor/recommendations',
    async (req) => {
      const accountId = ctx.accountIdOf(req);
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, req.query.workspace);
      await promoteMergedPrs(ctx, accountId, workspaceId);
      return { workspaceId, recommendations: await listRecommendations(ctx, accountId, workspaceId) };
    },
  );

  app.post<{ Params: { dedupeKey: string }; Querystring: { workspace?: string } }>(
    '/api/pro/advisor/recommendations/:dedupeKey/dismiss',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const scope = await resolveRequestScope(ctx, accountId, req.query.workspace);
      const dedupeKey = req.params.dedupeKey;
      const [kind, botIdStr] = dedupeKey.split('|');
      const botUserId = Number.parseInt(botIdStr ?? '', 10);
      if (!kind || !Number.isInteger(botUserId)) {
        return reply.code(400).send({ error: 'BadKey', message: 'unrecognized dedupe key' });
      }
      // Attach the live intent's evidence when it still exists; a dismissal of a
      // no-longer-firing intent still records (that is the point of dismissing).
      const derived = await deriveForScope(ctx, accountId, scope);
      const live = derived.intents.find((i) => i.dedupeKey === dedupeKey);
      await upsertRecommendation(
        ctx,
        accountId,
        scope.workspaceId,
        {
          botUserId,
          intent: kind,
          dedupeKey,
          targetJson: JSON.stringify(live?.target ?? {}),
          evidenceJson: JSON.stringify(live?.evidence ?? {}),
          ...(live ? { retroJson: JSON.stringify(live.retro) } : {}),
        },
        { status: 'dismissed' },
      );
      return { ok: true, dedupeKey };
    },
  );

  app.get<{ Querystring: { workspace?: string; botUserId?: string; keys?: string } }>(
    '/api/pro/advisor/brief',
    async (req) => {
      const accountId = ctx.accountIdOf(req);
      const scope = await resolveRequestScope(ctx, accountId, req.query.workspace);
      const derived = await deriveForScope(ctx, accountId, scope);
      const botFilter = req.query.botUserId ? Number.parseInt(req.query.botUserId, 10) : null;
      const keyFilter = req.query.keys ? new Set(req.query.keys.split(',')) : null;
      const intents = derived.intents.filter(
        (i) =>
          (botFilter == null || i.botUserId === botFilter) &&
          (keyFilter == null || keyFilter.has(i.dedupeKey)),
      );
      const resp: AdvisorBriefResponse = {
        workspaceId: scope.workspaceId,
        markdown: renderBrief({
          intents,
          overlays: derived.overlays,
          windowLabel: windowLabelFor(derived.payload),
          generatedAt: derived.payload.generatedAt,
        }),
        dedupeKeys: intents.map((i) => i.dedupeKey),
      };
      return resp;
    },
  );

  app.get<{ Params: { userId: string }; Querystring: { workspace?: string } }>(
    '/api/pro/advisor/bots/:userId/effect',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const scope = await resolveRequestScope(ctx, accountId, req.query.workspace);
      const botUserId = Number.parseInt(req.params.userId, 10);
      if (!Number.isInteger(botUserId)) {
        return reply.code(400).send({ error: 'BadId', message: 'bot user id must be an integer' });
      }
      return getEffectResponse(ctx, accountId, scope, botUserId);
    },
  );

  app.get<{ Params: { userId: string }; Querystring: { workspace?: string; repoId?: string } }>(
    '/api/pro/advisor/bots/:userId/discovery',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const scope = await resolveRequestScope(ctx, accountId, req.query.workspace);
      const botUserId = Number.parseInt(req.params.userId, 10);
      const repoId = Number.parseInt(req.query.repoId ?? '', 10);
      if (!Number.isInteger(botUserId) || !Number.isInteger(repoId)) {
        return reply.code(400).send({ error: 'BadId', message: 'botUserId and repoId are required' });
      }
      const repo = await repoInScope(ctx, accountId, scope, repoId);
      if (!repo) {
        return reply.code(404).send({ error: 'NotFound', message: 'repo not in this workspace' });
      }
      const usersT = ctx.schema.users;
      const botRows = (await ctx.db
        .select({ login: usersT.githubLogin })
        .from(usersT)
        .where(eq(usersT.id, botUserId))
        .limit(1)
        .execute()) as Array<{ login: string | null }>;
      const login = botRows[0]?.login ?? null;
      const scan = await scanWorkflows(
        ctx,
        accountId,
        repo,
        login ? [login.replace(/\[bot\]$/, '')] : [],
      );
      const profile = await getProfileRow(ctx, accountId, scope.workspaceId, botUserId);
      // Probe: the repo-export manifest (wins over the DB row when present), the known
      // adapter targets, and the profile's declared configPath.
      const probePaths = new Set<string>(['.limn/bot-adapter.yml']);
      const kind = (await deriveForScope(ctx, accountId, scope)).payload.bots.find(
        (b) => b.botUserId === botUserId,
      )?.kind;
      const known = kind ? adapterForKind(kind) : null;
      for (const t of known?.configTargets ?? []) probePaths.add(t.path);
      if (profile?.configPath) probePaths.add(profile.configPath);
      const configProbes: { path: string; found: boolean }[] = [];
      let inferred: AdvisorDiscoveryResponse['inferredManifest'] = null;
      let tells: string[] = [];
      for (const path of probePaths) {
        const read = await ctx.github.readRepoFile(accountId, { owner: repo.owner, name: repo.name, path });
        const found = read.ok;
        configProbes.push({ path, found });
        // T3 inference runs on the profile-declared config when no known adapter serves the
        // bot — a structural proposal for the confirm flow, never executed as-is.
        if (found && !known && profile?.configPath === path) {
          const inference = inferManifest(path, read.text);
          inferred = inference.proposal;
          tells = inference.tells;
        }
      }
      const resp: AdvisorDiscoveryResponse = {
        botUserId,
        repoId,
        appSlug: await appSlugFor(ctx, botUserId),
        workflowMatches: scan.workflowMatches,
        configProbes,
        inferredManifest: inferred,
        inferenceTells: tells,
      };
      return resp;
    },
  );

  // ── Write surface ─────────────────────────────────────────────────────────────────────

  app.put<{ Params: { userId: string }; Body: AdvisorProfilePutBody }>(
    '/api/pro/advisor/bots/:userId/profile',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const botUserId = Number.parseInt(req.params.userId, 10);
      if (!Number.isInteger(botUserId)) {
        return reply.code(400).send({ error: 'BadId', message: 'bot user id must be an integer' });
      }
      const body = req.body ?? ({} as AdvisorProfilePutBody);
      // A foreign/unknown workspace id resolves to the caller's Default (the read rule,
      // applied to writes: nothing leaks, nothing 404s, the row lands in a workspace the
      // caller owns — and the composite FK backstops the cross-account pair regardless).
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, body.workspaceId);
      const clean = (v: unknown, max = 300): string | null =>
        typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : null;
      const ownerRepo = clean(body.ownerRepo);
      if (ownerRepo && !OWNER_REPO_RE.test(ownerRepo)) {
        return reply
          .code(400)
          .send({ error: 'BadOwnerRepo', message: 'ownerRepo must be owner/name' });
      }
      await putProfileT1(ctx, accountId, workspaceId, botUserId, {
        kindHint: clean(body.kindHint, 80),
        configPath: clean(body.configPath),
        ownerContact: clean(body.ownerContact),
        ownerRepo,
        notes: clean(body.notes, 2000),
      });
      const profile = await getProfileRow(ctx, accountId, workspaceId, botUserId);
      return { workspaceId, profile };
    },
  );

  app.post<{ Params: { userId: string }; Body: AdvisorManifestConfirmBody }>(
    '/api/pro/advisor/bots/:userId/manifest',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const botUserId = Number.parseInt(req.params.userId, 10);
      const body = req.body ?? ({} as AdvisorManifestConfirmBody);
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, body.workspaceId);
      const validated = validateManifest(body.manifest);
      if (!validated.ok) {
        return reply
          .code(422)
          .send({ error: 'BadManifest', message: validated.errors.join('; ') });
      }
      await putProfileManifest(ctx, accountId, workspaceId, botUserId, JSON.stringify(body.manifest));
      const profile = await getProfileRow(ctx, accountId, workspaceId, botUserId);
      return { workspaceId, profile };
    },
  );

  app.post<{ Body: AdvisorConfigEventBody; Querystring: { workspace?: string } }>(
    '/api/pro/advisor/config-events',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const body = req.body ?? ({} as AdvisorConfigEventBody);
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, body.workspaceId);
      const scope = await workspaceScope(ctx, accountId, workspaceId);
      const occurredMs = Date.parse(body.occurredAt ?? '');
      if (!Number.isFinite(occurredMs)) {
        return reply.code(400).send({ error: 'BadDate', message: 'occurredAt must be ISO-8601' });
      }
      if (!Number.isInteger(body.repoId) || !scope.repoIds.includes(body.repoId)) {
        return reply.code(404).send({ error: 'NotFound', message: 'repo not in this workspace' });
      }
      if (!Number.isInteger(body.botUserId)) {
        return reply.code(400).send({ error: 'BadId', message: 'botUserId must be an integer' });
      }
      await insertConfigEvent(ctx, accountId, workspaceId, {
        repoId: body.repoId,
        botUserId: body.botUserId,
        source: 'user_reported',
        occurredAt: new Date(occurredMs),
        configPath: typeof body.configPath === 'string' ? body.configPath.slice(0, 300) : null,
        description:
          typeof body.description === 'string' ? body.description.slice(0, 500) : null,
      });
      return { ok: true, events: await listConfigEvents(ctx, accountId, workspaceId, body.botUserId) };
    },
  );

  app.post<{ Body: AdvisorRefineBody; Querystring: { workspace?: string } }>(
    '/api/pro/advisor/refine',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const scope = await resolveRequestScope(ctx, accountId, req.query.workspace);
      const body = req.body ?? ({} as AdvisorRefineBody);
      const repo = await repoInScope(ctx, accountId, scope, body.repoId);
      if (!repo) {
        return reply.code(404).send({ error: 'NotFound', message: 'repo not in this workspace' });
      }
      const derived = await deriveForScope(ctx, accountId, scope);
      const keys = new Set(body.dedupeKeys ?? []);
      const intents = derived.intents.filter(
        (i) => i.botUserId === body.botUserId && keys.has(i.dedupeKey),
      );
      if (intents.length === 0) {
        return reply.code(422).send({ error: 'NoIntents', message: 'no live intents match' });
      }
      const bot = derived.payload.bots.find((b) => b.botUserId === body.botUserId);
      const profile = await getProfileRow(ctx, accountId, scope.workspaceId, body.botUserId);
      const adapter = bot ? resolveAdapter(bot.kind, profile) : null;
      if (!adapter) {
        return reply.code(422).send({ error: 'NoAdapter', message: 'no config surface for this bot' });
      }
      // Prose targets ONLY — a structured file has no refine path at all.
      const target = adapter.configTargets.find((t) => t.path === body.path);
      if (!target || target.format !== 'prose') {
        return reply
          .code(422)
          .send({ error: 'NotProse', message: 'refine applies to prose targets only' });
      }
      const files = await fetchAdapterFiles(ctx, accountId, repo, adapter);
      const build = buildConfigPr({
        intents,
        adapter,
        files,
        botLabel: bot!.label,
        repoFullName: `${repo.owner}/${repo.name}`,
        dateSlug: dateSlugFor(derived.payload),
        windowLabel: windowLabelFor(derived.payload),
      });
      if (!build.ok) return reply.code(build.status).send({ error: 'BuildFailed', message: build.error });
      const out = build.files.find((f) => f.path === body.path);
      const templated = out ? extractManagedBlock(out.content) : null;
      if (!templated) {
        return reply
          .code(422)
          .send({ error: 'NoBlock', message: 'no managed block on that path' });
      }
      const budget =
        body.path === COPILOT_PATH && out
          ? COPILOT_CHAR_BUDGET - (out.content.length - templated.length)
          : undefined;
      const outcome = await refineManagedBlock(ctx, accountId, templated, { charBudget: budget });
      const resp: AdvisorRefineResponse = {
        path: body.path,
        templated: outcome.templated,
        refined: outcome.refined,
        ...(outcome.creditsExhausted ? { creditsExhausted: true } : {}),
        ...(outcome.guardRejected ? { guardRejected: outcome.guardRejected } : {}),
      };
      return resp;
    },
  );

  // The config-PR DRY-RUN: identical derivation and gate chain, but nothing is written —
  // the response is the exact files the PR would commit (before/after), so the user sees
  // the generated YAML/JSON/prose before consenting to a PR. No write permission required
  // (it only reads the repo's config files); the rate tier matches discovery's.
  app.post<{ Body: AdvisorConfigPrBody; Querystring: { workspace?: string } }>(
    '/api/pro/advisor/preview',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const scope = await resolveRequestScope(ctx, accountId, req.query.workspace);
      const body = req.body ?? ({} as AdvisorConfigPrBody);
      const repo = await repoInScope(ctx, accountId, scope, body.repoId);
      if (!repo) {
        return reply.code(404).send({ error: 'NotFound', message: 'repo not in this workspace' });
      }
      const derived = await deriveForScope(ctx, accountId, scope);
      const keys = new Set(body.dedupeKeys ?? []);
      const intents = derived.intents.filter(
        (i) => i.botUserId === body.botUserId && keys.has(i.dedupeKey),
      );
      const bot = derived.payload.bots.find((b) => b.botUserId === body.botUserId);
      if (!bot || intents.length === 0) {
        return reply
          .code(422)
          .send({ error: 'NoIntents', message: 'no live intents match the selection' });
      }
      const profile = await getProfileRow(ctx, accountId, scope.workspaceId, body.botUserId);
      const adapter = resolveAdapter(bot.kind, profile);
      if (!adapter) {
        return reply.code(422).send({
          error: 'NoAdapter',
          message: 'no config surface for this bot — use the brief (or confirm a manifest)',
        });
      }
      const files = await fetchAdapterFiles(ctx, accountId, repo, adapter);
      const build = buildConfigPr({
        intents,
        adapter,
        files,
        refinedByPath: body.refinedByPath,
        guardRefined: guardRefinedBlock,
        botLabel: bot.label,
        repoFullName: `${repo.owner}/${repo.name}`,
        dateSlug: dateSlugFor(derived.payload),
        windowLabel: windowLabelFor(derived.payload),
      });
      if (!build.ok) {
        return reply.code(build.status).send({ error: 'BuildFailed', message: build.error });
      }
      const resp: AdvisorPreviewResponse = {
        workspaceId: scope.workspaceId,
        adapterKey: adapter.key,
        adapterName: adapter.displayName,
        branch: build.branch,
        title: build.title,
        files: build.files.map((f) => ({
          path: f.path,
          before: files.find((x) => x.path === f.path)?.text ?? null,
          after: f.content,
        })),
        applied: build.applied,
      };
      return resp;
    },
  );

  app.post<{ Body: AdvisorConfigPrBody; Querystring: { workspace?: string } }>(
    '/api/pro/advisor/config-pr',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const scope = await resolveRequestScope(ctx, accountId, req.query.workspace);
      const body = req.body ?? ({} as AdvisorConfigPrBody);
      const repo = await repoInScope(ctx, accountId, scope, body.repoId);
      if (!repo) {
        return reply.code(404).send({ error: 'NotFound', message: 'repo not in this workspace' });
      }
      if (!['WRITE', 'MAINTAIN', 'ADMIN'].includes(repo.viewerPermission ?? '')) {
        return reply
          .code(403)
          .send({ error: 'NotPermitted', message: 'You need write access to open a config PR.' });
      }
      // Server-side re-derivation: live findings ∩ the selected keys, this bot only.
      const derived = await deriveForScope(ctx, accountId, scope);
      const keys = new Set(body.dedupeKeys ?? []);
      const intents = derived.intents.filter(
        (i) => i.botUserId === body.botUserId && keys.has(i.dedupeKey),
      );
      const bot = derived.payload.bots.find((b) => b.botUserId === body.botUserId);
      if (!bot || intents.length === 0) {
        return reply
          .code(422)
          .send({ error: 'NoIntents', message: 'no live intents match the selection' });
      }
      const profile = await getProfileRow(ctx, accountId, scope.workspaceId, body.botUserId);
      const adapter = resolveAdapter(bot.kind, profile);
      if (!adapter) {
        return reply.code(422).send({
          error: 'NoAdapter',
          message: 'no config surface for this bot — use the brief (or confirm a manifest)',
        });
      }
      const files = await fetchAdapterFiles(ctx, accountId, repo, adapter);
      const build = buildConfigPr({
        intents,
        adapter,
        files,
        refinedByPath: body.refinedByPath,
        guardRefined: guardRefinedBlock,
        botLabel: bot.label,
        repoFullName: `${repo.owner}/${repo.name}`,
        dateSlug: dateSlugFor(derived.payload),
        windowLabel: windowLabelFor(derived.payload),
      });
      if (!build.ok) {
        return reply.code(build.status).send({ error: 'BuildFailed', message: build.error });
      }
      let pr: { prNumber: number; url: string; visible: boolean };
      try {
        pr = await ctx.coding.commitFilesAndOpenPr({
          accountId,
          owner: repo.owner,
          name: repo.name,
          files: build.files,
          branch: build.branch,
          title: build.title,
          body: build.body,
        });
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const message = err instanceof Error ? err.message : String(err);
        if (code === 'BRANCH_EXISTS')
          return reply.code(409).send({ error: 'BranchExists', message });
        if (code === 'PUSH_DENIED' || code === 'APPLY_FAILED' || code === 'TRUNK_FETCH_FAILED')
          return reply.code(422).send({ error: code, message });
        ctx.log.warn({ err }, 'advisor config-pr failed');
        return reply.code(500).send({ error: 'PrFailed', message });
      }
      // ── After the 201 the route may not fail. ─────────────────────────────────────────
      try {
        const outputJson = JSON.stringify({
          files: build.files.map((f) => ({ path: f.path, final: f.content })),
          applied: build.applied,
        });
        for (const intent of intents) {
          await upsertRecommendation(
            ctx,
            accountId,
            scope.workspaceId,
            {
              botUserId: intent.botUserId,
              intent: intent.kind,
              dedupeKey: intent.dedupeKey,
              targetJson: JSON.stringify(intent.target),
              evidenceJson: JSON.stringify(intent.evidence),
              retroJson: JSON.stringify(intent.retro),
              outputJson,
            },
            {
              status: 'pr_opened',
              prRepoId: repo.id,
              prNumber: pr.prNumber,
              prUrl: pr.url,
            },
          );
        }
      } catch (err) {
        ctx.log.warn({ err }, 'advisor: recommendation persist failed after PR open');
      }
      const resp: AdvisorConfigPrResponse = {
        prNumber: pr.prNumber,
        url: pr.url,
        visible: pr.visible,
        applied: build.applied,
      };
      return resp;
    },
  );

  app.post<{ Params: { dedupeKey: string }; Querystring: { workspace?: string } }>(
    '/api/pro/advisor/recommendations/:dedupeKey/issue',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const scope = await resolveRequestScope(ctx, accountId, req.query.workspace);
      const dedupeKey = req.params.dedupeKey;
      const derived = await deriveForScope(ctx, accountId, scope);
      const intent = derived.intents.find((i) => i.dedupeKey === dedupeKey);
      if (!intent) {
        return reply.code(422).send({ error: 'NoIntent', message: 'intent no longer fires' });
      }
      const profile = await getProfileRow(ctx, accountId, scope.workspaceId, intent.botUserId);
      // The issue target is the bot's OWN repo from its profile — user-confirmed, never
      // derived from comment text.
      const ownerRepo = profile?.ownerRepo;
      if (!ownerRepo || !OWNER_REPO_RE.test(ownerRepo)) {
        return reply.code(422).send({
          error: 'NoOwnerRepo',
          message: "set the bot's own repo on its profile first (ownerRepo)",
        });
      }
      const [owner, name] = ownerRepo.split('/') as [string, string];
      const markdown = renderBrief({
        intents: [intent],
        overlays: derived.overlays,
        windowLabel: windowLabelFor(derived.payload),
        generatedAt: derived.payload.generatedAt,
      });
      let issue: { number: number; url: string };
      try {
        issue = await ctx.github.openIssue(accountId, {
          owner,
          name,
          title: `Tuning feedback: ${intent.botLabel} — ${intent.kind.toLowerCase().replaceAll('_', ' ')} (${intent.targetKey})`,
          body: markdown,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: 'IssueFailed', message });
      }
      // Issues are NOT synced — store the URL on the row; nothing below may fail the route.
      try {
        await upsertRecommendation(
          ctx,
          accountId,
          scope.workspaceId,
          {
            botUserId: intent.botUserId,
            intent: intent.kind,
            dedupeKey,
            targetJson: JSON.stringify(intent.target),
            evidenceJson: JSON.stringify(intent.evidence),
            retroJson: JSON.stringify(intent.retro),
          },
          { status: 'issue_filed', issueUrl: issue.url },
        );
      } catch (err) {
        ctx.log.warn({ err }, 'advisor: recommendation persist failed after issue filing');
      }
      return { issueUrl: issue.url };
    },
  );

  app.post<{ Params: { userId: string }; Body: { workspaceId?: number; repoId?: number } }>(
    '/api/pro/advisor/bots/:userId/manifest-pr',
    async (req, reply) => {
      const accountId = ctx.accountIdOf(req);
      const botUserId = Number.parseInt(req.params.userId, 10);
      const body = req.body ?? {};
      const workspaceId = await resolveRequestWorkspaceId(ctx, accountId, body.workspaceId);
      const scope = await workspaceScope(ctx, accountId, workspaceId);
      const repo = Number.isInteger(body.repoId)
        ? await repoInScope(ctx, accountId, scope, body.repoId!)
        : null;
      if (!repo) {
        return reply.code(404).send({ error: 'NotFound', message: 'repo not in this workspace' });
      }
      if (!['WRITE', 'MAINTAIN', 'ADMIN'].includes(repo.viewerPermission ?? '')) {
        return reply
          .code(403)
          .send({ error: 'NotPermitted', message: 'You need write access to export a manifest.' });
      }
      const profile = await getProfileRow(ctx, accountId, workspaceId, botUserId);
      if (!profile?.manifestJson || !profile.manifestConfirmedAt) {
        return reply
          .code(422)
          .send({ error: 'NoManifest', message: 'confirm a manifest for this bot first' });
      }
      const parsed = parseManifest(profile.manifestJson);
      if (!parsed.ok) {
        return reply.code(422).send({ error: 'BadManifest', message: parsed.errors.join('; ') });
      }
      // The repo export: `.limn/bot-adapter.yml` — on discovery reads the repo copy wins
      // over the DB row when present.
      const { Document } = await import('yaml');
      const yamlText = new Document(parsed.manifest).toString();
      let pr: { prNumber: number; url: string; visible: boolean };
      try {
        pr = await ctx.coding.commitFilesAndOpenPr({
          accountId,
          owner: repo.owner,
          name: repo.name,
          files: [{ path: '.limn/bot-adapter.yml', content: yamlText }],
          branch: `limn/advisor/manifest-${botUserId}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`,
          title: 'Publish the Limn bot-adapter manifest',
          body: 'Publishes the confirmed `.limn/bot-adapter.yml` manifest so the advisor reads it from the repo (the repo copy wins over the stored one).',
        });
      } catch (err) {
        const code = (err as { code?: string })?.code;
        const message = err instanceof Error ? err.message : String(err);
        if (code === 'BRANCH_EXISTS')
          return reply.code(409).send({ error: 'BranchExists', message });
        if (code === 'PUSH_DENIED' || code === 'APPLY_FAILED' || code === 'TRUNK_FETCH_FAILED')
          return reply.code(422).send({ error: code, message });
        return reply.code(500).send({ error: 'PrFailed', message });
      }
      return { prNumber: pr.prNumber, url: pr.url, visible: pr.visible };
    },
  );
}
