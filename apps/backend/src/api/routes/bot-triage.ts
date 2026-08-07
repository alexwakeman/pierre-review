import type { FastifyInstance } from 'fastify';
import type {
  BotAnalyticsResponse,
  BotBehaviourResponse,
  BotOnlyPrsResponse,
  ResolvableThreadPrsResponse,
  BotVendorPrsResponse,
  BotWindowKind,
  DetectedReviewersResponse,
  ResolveBotThreadsResult,
  ReviewerCostBody,
  ScopeResolveBotThreadsBody,
  WorkspaceReviewer,
  WorkspaceReviewerPatchBody,
} from '@pierre-review/shared';
import {
  getBotAnalytics,
  getBotBehaviourAnalytics,
  getBotOnlyPrs,
  getBotVendorPrs,
  getBotDedupClusters,
  getResolvableBotThreadPrs,
  getResolvableBotThreadsForScope,
  listDetectedReviewers,
  resetWorkspaceReviewerIdentity,
  resetWorkspaceReviewerJudgement,
  resolveWorkspaceScope,
  setReviewerCost,
  setWorkspaceReviewer,
  SCOPE_RESOLVE_THREAD_CAP,
} from '../../db/queries.js';
import { resolveThreadsOnGitHub } from '../../bot-triage/resolve.js';
import { accountIdOf } from '../plugins/auth.js';

// Parse a comma-separated id list into a positive-int array, or null when empty/absent (so
// `resolveWorkspaceScope` treats it as "no narrowing — every repo in the workspace"). Mirrors the
// parser in activity.ts.
//
// ⚠ ITS RESULT IS NEVER A SCOPE. It is the `narrow` argument to `resolveWorkspaceScope`, which
// INTERSECTS it with the workspace's membership. A handler that passed this list straight to a
// getter would let `?workspace=5&repoIds=<a repo of workspace 9>` measure one workspace's data
// through another's verdicts, and make the listing's lazy classifier write workspace-5 rows for
// actors with zero footprint there.
function parseIntList(raw?: string): number[] | null {
  if (raw == null || raw.trim() === '') return null;
  const ids = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : null;
}

// ── THE SCOPE PARAMETER ─────────────────────────────────────────────────────────────────────
// Every read route here takes `?workspace=<integer>` (absent / unknown / unparseable / another
// tenant's id ⇒ the account's Default workspace — NOT a 404: every id yields the same response
// shape, so it is not an existence oracle, the resolved id is always one the caller owns, and a
// stale bookmark degrades to something renderable instead of a blank screen). `?repoIds=<csv>`
// survives alongside it and still narrows the DATA — it no longer competes with the scope for the
// VERDICT, because the workspace owns that outright.
//
// The wire type is `string`, not `integer`, on purpose: an ajv `integer` would 400 on a garbage
// `?workspace=`, and the contract above is that garbage degrades to Default rather than erroring.
//
// ── THE WRITE SURFACE: TWO ROUTES, SPLIT BY MUTABILITY (NOT BY GRAIN) ───────────────────────
// There is ONE grain now — a `workspace_reviewers` row, keyed (account, workspace, actor) — so the
// grain mismatch the old three-route split defended against cannot occur. What survives is a
// MUTABILITY difference:
//
//   PATCH /api/bot-reviewers/:userId       WorkspaceReviewerPatchBody  automated/role/kind/label
//   PUT   /api/bot-reviewers/:userId/cost  ReviewerCostBody            monthly_cents
//
// `automated`, `role`, `kind` and `label` are all RE-DERIVABLE: a wrong write is repaired by the
// next classification pass or by a reset, so they belong in one body keyed by two INDEPENDENT
// provenance flags. `monthly_cents` is derivable by nothing and is money. Keeping it on its own
// PUT means NO COMBINED BODY CAN ADDRESS THE COLUMN AT ALL, and the PATCH handler's `set:` object
// contains no cost key. That is the same structural guarantee the old two-table split provided,
// preserved with one fewer table — and `additionalProperties:false` is NOT what provides it
// (Fastify's ajv runs `removeAdditional:true`, so unknown keys are STRIPPED, not rejected). What
// provides it is that each handler calls exactly ONE query-layer function with a narrow `set:`.
//
// …plus TWO RESETS, one per PROVENANCE FLAG:
//
//   DELETE /api/bot-reviewers/:userId/judgement?workspaceId=  automated/role back to auto
//   DELETE /api/bot-reviewers/:userId/identity?workspaceId=   kind/label back to auto, PRICE KEPT
//
// ⚠ THE RESETS ARE NOT OPTIONAL POLISH. A manual write pins its half against re-derivation, and
// flipping the value back by hand leaves it just as pinned — so without a way back to auto, every
// edit here is permanent. That is also what makes the role-only patch's `source:'manual'` stamp
// (which pins `automated` for that workspace as a side effect) the right trade rather than a trap:
// the pin is visible AND undoable in the same place. `WorkspaceReviewer.isManualOverride` and
// `.identitySource` exist to drive exactly these two affordances.
//
// ⚠ BOTH RESETS ARE AN UPDATE + IMMEDIATE RE-DERIVE, NOT A ROW DELETE, and both answer 200 with
// the re-derived row. The old per-repo judgement reset DELETED its row (the row held nothing else,
// and the listing re-derived a missing one), so there was nothing to echo and it answered 204.
// This row also carries the identity AND the price, so a delete is lossy.
//
// ⚠ EVERY WRITE ON THIS SURFACE IS WORKSPACE-WIDE. The old per-repo PATCH could honestly promise
// "this leaves your other repos alone"; nothing here can. A control rendered in a repo-shaped
// context must say so in its copy.
//
// ⚠ READS DEGRADE, WRITES 404. A write names the row it edits, so an unowned or unknown
// `workspaceId` must not silently land in Default — the query layer's ownership gate returns null
// and the handler 404s. Only the read routes fall back, and only because their answer is shaped
// identically whatever the id was.

// PATCH /api/bot-reviewers/:userId — the four re-derivable fields of ONE workspace_reviewers row.
//
// `workspaceId` is REQUIRED and rides in the BODY: the row IS the object, and the workspace is
// part of its key, not a filter over it. The query layer verifies the workspace belongs to the
// caller and 404s otherwise (the composite FK `(workspace_id, account_id) → workspaces(id,
// account_id)` would also reject a cross-tenant write, but a constraint violation is a 500 and
// this must be a 404).
//
// `role` IS a closed 2-value set, so it is enumerated (an unknown role would land in a NOT NULL
// column the metric split branches on). `kind` is left an open nullable string: the
// `AutomatedReviewerKind` union lives in the types-only shared package the backend cannot import
// at runtime, and the query layer coerces an unknown kind, so pinning the vendor list here would
// only add drift. All four value fields are OPTIONAL — absent means "leave the stored value
// alone", so an old client that only knows `automated` cannot silently un-mark a quality check —
// but the handler rejects a body carrying NONE of them.
//
// ⚠ THERE IS NO `monthlyUsd` HERE, and that is the structural half of the cost guarantee: the
// handler calls `setWorkspaceReviewer`, whose `set:` object has no `monthlyCents` key.
const patchSchema = {
  params: {
    type: 'object',
    required: ['userId'],
    properties: { userId: { type: 'integer' } },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['workspaceId'],
    properties: {
      workspaceId: { type: 'integer', minimum: 1 },
      automated: { type: 'boolean' },
      role: { type: 'string', enum: ['review', 'quality_check'] },
      kind: { type: ['string', 'null'] },
      label: { type: ['string', 'null'] },
    },
  },
};

// DELETE /api/bot-reviewers/:userId/judgement?workspaceId= — hand automated/role/confidence/
// reasons back to detection for ONE workspace, and re-derive in the same request.
//
// `workspaceId` rides in the QUERY STRING rather than a body: a DELETE body is stripped by enough
// intermediaries (and by some fetch implementations) that it is not a place to put a required
// field. It is required for the same reason it is required on the PATCH — the row is the object.
const judgementResetSchema = {
  params: {
    type: 'object',
    required: ['userId'],
    properties: { userId: { type: 'integer' } },
  },
  querystring: {
    type: 'object',
    additionalProperties: false,
    required: ['workspaceId'],
    properties: { workspaceId: { type: 'integer', minimum: 1 } },
  },
};

// DELETE /api/bot-reviewers/:userId/identity?workspaceId= — clear kind/label, `identitySource`
// back to 'auto', re-derive immediately. Same shape and same reasoning as the judgement reset
// (spelled out rather than aliased so the two can diverge without a shared-object surprise).
const identityResetSchema = {
  params: {
    type: 'object',
    required: ['userId'],
    properties: { userId: { type: 'integer' } },
  },
  querystring: {
    type: 'object',
    additionalProperties: false,
    required: ['workspaceId'],
    properties: { workspaceId: { type: 'integer', minimum: 1 } },
  },
};

// PUT /api/bot-reviewers/:userId/cost — what this bot costs IN THIS WORKSPACE.
//
// `monthlyUsd` is REQUIRED and NULLABLE precisely so `undefined` is not a third meaning: a number
// sets the price (0 is real — "we pay nothing"), null clears it. Clearing is a COLUMN write, never
// a row delete: the row also carries the judgement and the identity.
//
// ⚠ THE BOUNDS ARE NOT COSMETIC. Storage is int4 CENTS in both dialects, and 21474836.47 is where
// the dialects STOP AGREEING: Postgres RAISES `integer out of range` (a 500) above it while
// SQLite's 64-bit integers accept the value happily — so an unbounded field means the same
// request succeeds locally and 500s in cloud, leaving a number cloud can never represent.
// (Measured: monthlyUsd 99999999999 stored 2147483647 on pg and 9999999999900 on sqlite.) ajv
// 400s out-of-range here; the query layer ALSO clamps, as the backstop for every other caller.
//
// `multipleOf: 0.01` rejects a fractional-cent price like $1.005, which nothing downstream can
// print and which the two rounding paths were measured disagreeing about. (Non-finite values
// cannot survive JSON.parse, and `type: number` rejects them anyway.)
//
// `costModel` is OPTIONAL (omitted ⇒ 'flat') and rides THIS body because it changes what the
// number MEANS: 'per_seat' makes `monthlyUsd` a per-seat unit price, multiplied on read by the
// workspace's derived seat count. It is money the same way the number is, so it must never appear
// in the PATCH body — the no-combined-body guarantee covers both columns or neither. A CLEAR
// (`monthlyUsd: null`) resets the stored model to 'flat' server-side regardless of what rides
// along.
const costSchema = {
  params: {
    type: 'object',
    required: ['userId'],
    properties: { userId: { type: 'integer' } },
  },
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['workspaceId', 'monthlyUsd'],
    properties: {
      workspaceId: { type: 'integer', minimum: 1 },
      monthlyUsd: {
        type: ['number', 'null'],
        minimum: 0,
        maximum: 21474836.47,
        multipleOf: 0.01,
      },
      costModel: { type: 'string', enum: ['flat', 'per_seat'] },
    },
  },
};

// GET /api/bot-reviewers?workspace=&repoIds= — the bot listing for ONE workspace. `workspace`
// decides the VERDICT; `repoIds` narrows which repos' footprints are displayed. They can no longer
// disagree, because they answer different questions — and the narrowing is bounded by the
// workspace's membership inside `resolveWorkspaceScope`, so it can never reach outside the scope.
const listReviewersSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      workspace: { type: 'string' },
      repoIds: { type: 'string' },
    },
  },
};

// GET /api/bot-analytics?window=&workspace=&repoIds= — the window is a closed 4-value set, safe to
// enum + default.
const analyticsSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      window: {
        type: 'string',
        enum: ['rolling_7', 'rolling_14', 'rolling_30', 'sprint'],
        default: 'rolling_14',
      },
      // The workspace whose verdicts these metrics are computed under. Absent/unknown ⇒ Default.
      workspace: { type: 'string' },
      // Optional DATA narrowing (comma-separated repo ids) — the per-repo Bots tab. It is
      // intersected with the workspace's membership; it does NOT change who counts as a bot.
      repoIds: { type: 'string' },
    },
  },
};

// GET /api/bot-analytics/vendor/:key/prs?window= — per-REVIEWER PR drill-down. `key` is the
// analytics-row identity: `u<userId>` (a single reviewer) or the 'pierre' sentinel; the handler
// parses it (anything else → 400). The window/workspace/repoIds resolution is identical to
// /api/bot-analytics, because this list must reproduce ONE of that panel's rows.
const vendorPrsSchema = {
  params: {
    type: 'object',
    required: ['key'],
    properties: { key: { type: 'string' } },
  },
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      window: {
        type: 'string',
        enum: ['rolling_7', 'rolling_14', 'rolling_30', 'sprint'],
        default: 'rolling_14',
      },
      workspace: { type: 'string' },
      repoIds: { type: 'string' },
    },
  },
};

const prIdParamSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' } },
  },
};

// GET /api/bot-threads/resolvable?workspace=&repoIds= — the workspace-wide review list. Same
// scope resolution as the analytics routes.
const resolvableSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      workspace: { type: 'string' },
      repoIds: { type: 'string' },
    },
  },
};

// POST /api/bot-threads/resolve — the confirm-gated workspace-wide resolve. `threadIds` is the
// explicit reviewed list (required; [] is a legal no-op), capped at SCOPE_RESOLVE_THREAD_CAP per
// request (the client chunks a larger selection); `workspaceId` is the scope the server re-derives
// eligibility against.
//
// ⚠ `workspaceId` IS REQUIRED, and it is what makes "the listing and the resolve agree" structural
// rather than a convention. Its predecessor carried an optional `repoIds` while the listing was
// resolved from a TEAM scope, so a reviewer marked automated only under a per-team override had
// its threads offered by the listing and then found ineligible here — the route resolved 0 with no
// error anywhere. One workspace id on both sides cannot disagree with itself.
const scopeResolveSchema = {
  body: {
    type: 'object',
    required: ['threadIds', 'workspaceId'],
    additionalProperties: false,
    properties: {
      threadIds: {
        type: 'array',
        items: { type: 'integer' },
        maxItems: SCOPE_RESOLVE_THREAD_CAP,
      },
      workspaceId: { type: 'integer', minimum: 1 },
    },
  },
};

// Bot-triage platform routes (CORE, always registered). Detection/override, ROI analytics,
// per-PR cross-bot dedup, and the confirm-gated workspace-wide bot-thread resolve. Every handler
// is account-scoped via accountIdOf(req); id-addressed reads/writes verify ownership → 404. No AI.
export async function botTriageRoutes(app: FastifyInstance): Promise<void> {
  // One row per (workspace, actor), each carrying its judgement, identity, price and the evidence
  // behind them — including `repoFootprints[]`, the real blast radius of an edit that is
  // workspace-wide by design. Powers the Bots "Settings" tab.
  app.get('/api/bot-reviewers', { schema: listReviewersSchema }, async (req) => {
    const { workspace, repoIds } = req.query as { workspace?: string; repoIds?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, workspace, parseIntList(repoIds));
    const resp: DetectedReviewersResponse = await listDetectedReviewers(accountId, scope);
    return resp;
  });

  // ── THE ONE WRITE ─────────────────────────────────────────────────────────────────────────
  // Force a reviewer automated (or back to human), set its role, name its vendor, relabel it —
  // for ONE workspace. The two halves stamp their provenance flags INDEPENDENTLY: automated/role
  // stamp `source:'manual'`; kind/label stamp `identitySource:'manual'`.
  //
  // ⚠ THAT INDEPENDENCE IS THE ONLY THING LEFT DOING THE JOB THE TWO-TABLE SPLIT USED TO DO. The
  // predecessor wrote identity per repo and read it per actor, so "Not a bot" on ONE repo nulled
  // the kind and CodeRabbit lost its brand colour and vendor name on every repo the user never
  // touched. With both facts on one row there is no table boundary left to catch a handler that
  // stamps one flag while the user edited the other — only these two flags.
  //
  // ⚠ IT CANNOT REACH THE PRICE. No `monthlyUsd` in the body, and `setWorkspaceReviewer`'s `set:`
  // object carries no cost key.
  //
  // 404 covers an unknown user id, an unknown/foreign workspace id, AND an actor with no stored
  // row and no footprint in that workspace — deliberately the same status for all three:
  // distinguishing them would turn this route into an existence oracle over another tenant's
  // workspace ids and over the GLOBAL users table.
  app.patch('/api/bot-reviewers/:userId', { schema: patchSchema }, async (req, reply) => {
    const { userId } = req.params as { userId: number };
    const body = req.body as WorkspaceReviewerPatchBody;
    // An opinion-free patch is a client bug, not a no-op worth a 200: with none of the four fields
    // there is nothing to write, and stamping a provenance flag anyway would freeze detection for
    // that workspace on the strength of an empty request.
    if (
      body.automated === undefined &&
      body.role === undefined &&
      body.kind === undefined &&
      body.label === undefined
    ) {
      reply.status(400);
      return {
        error: 'BadRequest',
        message: 'Patch must carry at least one of `automated`, `role`, `kind`, `label`',
      };
    }
    const reviewer = await setWorkspaceReviewer(accountIdOf(req), userId, body);
    if (!reviewer) {
      reply.status(404);
      return {
        error: 'NotFound',
        message: `Reviewer ${userId} not found in workspace ${body.workspaceId}`,
      };
    }
    const resp: WorkspaceReviewer = reviewer;
    return resp;
  });

  // ── JUDGEMENT RESET ───────────────────────────────────────────────────────────────────────
  // Hand `automated`/`role`/`confidence`/`reasons` back to detection for one workspace and
  // re-derive in the same request, so the auto verdict lands in this response.
  //
  // ⚠ IT IS AN UPDATE, NOT A ROW DELETE, which is why it answers 200 and not the old 204. The row
  // also holds the vendor identity and the price; deleting it would take both with it. A
  // clear-WITHOUT-derive would be worse still: the human's values would sit under an auto label
  // until something else overwrote them — a stale opinion wearing the wrong provenance.
  //
  // ⚠ IT TOUCHES NEITHER THE IDENTITY NOR THE PRICE. Different provenance flag, different route.
  //
  // ⚠ BLAST RADIUS IS THE WHOLE WORKSPACE. The UI offers it only where `isManualOverride` is true
  // — a control that resets an already-auto row would appear to do nothing.
  //
  // Same 404 rule as the PATCH, and the same reason: one status for unknown user / unknown or
  // foreign workspace / no stored row, so it is never an existence oracle.
  app.delete(
    '/api/bot-reviewers/:userId/judgement',
    { schema: judgementResetSchema },
    async (req, reply) => {
      const { userId } = req.params as { userId: number };
      const { workspaceId } = req.query as { workspaceId: number };
      const reviewer = await resetWorkspaceReviewerJudgement(accountIdOf(req), userId, workspaceId);
      if (!reviewer) {
        reply.status(404);
        return {
          error: 'NotFound',
          message: `No stored judgement for reviewer ${userId} in workspace ${workspaceId}`,
        };
      }
      // Echoed, unlike its 204-answering predecessor: the row still exists (it still holds the
      // identity and the price), and this is the re-derived verdict the caller asked to fall back
      // to — which saves the client a refetch to learn what auto detection actually came back as.
      const resp: WorkspaceReviewer = reviewer;
      return resp;
    },
  );

  // ── IDENTITY RESET ────────────────────────────────────────────────────────────────────────
  // Hand `kind` + `label` back to detection: clear them, set `identitySource:'auto'`, and
  // re-derive immediately so the auto answer lands in this response.
  //
  // ⚠ IT KEEPS THE PRICE. The row also carries `monthly_cents`, and a price is not a
  // classification opinion — clearing it because someone un-named a vendor is exactly the coupling
  // this contract keeps separated. The UI says so in words, because "reset" reads as "delete
  // everything" otherwise.
  //
  // ⚠ IT TOUCHES NO JUDGEMENT FIELD. Naming a vendor is not a statement about how it behaves, and
  // stamping `source` from here would freeze auto-classification for the whole workspace.
  //
  // Same 404 rule as its judgement twin.
  app.delete(
    '/api/bot-reviewers/:userId/identity',
    { schema: identityResetSchema },
    async (req, reply) => {
      const { userId } = req.params as { userId: number };
      const { workspaceId } = req.query as { workspaceId: number };
      const reviewer = await resetWorkspaceReviewerIdentity(accountIdOf(req), userId, workspaceId);
      if (!reviewer) {
        reply.status(404);
        return {
          error: 'NotFound',
          message: `Reviewer ${userId} not found in workspace ${workspaceId}`,
        };
      }
      const resp: WorkspaceReviewer = reviewer;
      return resp;
    },
  );

  // ── COST ──────────────────────────────────────────────────────────────────────────────────
  // What this bot costs per month IN THIS WORKSPACE. A number sets it (0 is real: "we pay
  // nothing"); null CLEARS it — a column write, never a row delete, because the row also carries
  // the judgement and the identity.
  //
  // ⚠ IT IS A STANDALONE ROUTE ON PURPOSE, and that is the whole reason it did not fold into the
  // PATCH above when the two grains merged. Cost is derivable by nothing and is money: giving it
  // its own body means no combined body can address `monthly_cents` at all. That structural
  // guarantee survived the two-TABLE split; it must survive the two-GRAIN merge.
  //
  // ⚠ THE PRICE IS PER WORKSPACE, like every other attribute on the row. The UPDATE predicate is
  // (account_id, workspace_id, author_user_id) — exactly one row. The same actor's rows in other
  // workspaces are untouched and may legitimately hold different numbers; nothing reconciles them,
  // there is no fan-out writer and no INSERT seed. Within one workspace there is one row per
  // actor, so a total there is a plain sum; across workspaces it is not a sum at all, and no
  // surface may add them up.
  //
  // Same 404 rule as the resets: no row for that (workspace, actor) ⇒ no price to attach.
  app.put('/api/bot-reviewers/:userId/cost', { schema: costSchema }, async (req, reply) => {
    const { userId } = req.params as { userId: number };
    const { workspaceId, monthlyUsd, costModel } = req.body as ReviewerCostBody;
    const reviewer = await setReviewerCost(
      accountIdOf(req),
      userId,
      workspaceId,
      monthlyUsd,
      costModel,
    );
    if (!reviewer) {
      reply.status(404);
      return {
        error: 'NotFound',
        message: `Reviewer ${userId} not found in workspace ${workspaceId}`,
      };
    }
    const resp: WorkspaceReviewer = reviewer;
    return resp;
  });

  // Bot ROI / utilisation over a window (default rolling_14): per-vendor threads/acted-on/
  // untouched + verdict + trend + deterministic tuning suggestions. Cost is SERVER-resolved from
  // the workspace row — a null here is FINAL.
  //
  // ⚠ Never sum the price across workspaces. Within this one workspace's rows it is a plain sum.
  app.get('/api/bot-analytics', { schema: analyticsSchema }, async (req) => {
    const { window, workspace, repoIds } = req.query as {
      window: BotWindowKind;
      workspace?: string;
      repoIds?: string;
    };
    const accountId = accountIdOf(req);
    // ONE object drives both halves: `workspaceId` decides who counts as a bot, `repoIds` narrows
    // which data is measured — and the narrowing is already bounded by the workspace's membership,
    // so the two cannot describe different sets of repos.
    const scope = await resolveWorkspaceScope(accountId, workspace, parseIntList(repoIds));
    const resp: BotAnalyticsResponse = await getBotAnalytics(accountId, window, scope);
    return resp;
  });

  // EXPERIMENTAL bot BEHAVIOUR analytics (CORE, deterministic — no AI). Per bot, over the same
  // window/scope resolution as /api/bot-analytics: time-to-first-review, LoC-to-comments ratio,
  // the week×hour activity heatmap (coverage / rate-limit inference), and post-first-review
  // follow-up behaviour. Powers the Bots "Behaviour" sub-tab, kept separate from the ROI panel.
  app.get('/api/bot-behaviour', { schema: analyticsSchema }, async (req) => {
    const { window, workspace, repoIds } = req.query as {
      window: BotWindowKind;
      workspace?: string;
      repoIds?: string;
    };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, workspace, parseIntList(repoIds));
    const resp: BotBehaviourResponse = await getBotBehaviourAnalytics(accountId, window, scope);
    return resp;
  });

  // The exact PR list behind the analytics totals.botOnlyPrs count — "only a bot reviewed these".
  // Same window/scope resolution as /api/bot-analytics so the amber caption's number and this
  // expandable list are computed identically and can't drift. Unbounded but small (real bot-only
  // PRs); no pagination.
  app.get('/api/bot-analytics/bot-only-prs', { schema: analyticsSchema }, async (req) => {
    const { window, workspace, repoIds } = req.query as {
      window: BotWindowKind;
      workspace?: string;
      repoIds?: string;
    };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, workspace, parseIntList(repoIds));
    const { window: win, prs } = await getBotOnlyPrs(accountId, window, scope);
    const resp: BotOnlyPrsResponse = { window: win, prs, generatedAt: new Date().toISOString() };
    return resp;
  });

  // The per-REVIEWER PR drill-down behind one Bot-ROI row: the PRs that one automated reviewer
  // touched in the window (threads/comments/acted-on/untouched/bot-only), newest-activity first.
  // `key` is the analytics row identity — `u<userId>` (a single reviewer) or the 'pierre' sentinel;
  // anything else is a client bug → 400.
  app.get('/api/bot-analytics/vendor/:key/prs', { schema: vendorPrsSchema }, async (req, reply) => {
    const { key } = req.params as { key: string };
    const { window, workspace, repoIds } = req.query as {
      window: BotWindowKind;
      workspace?: string;
      repoIds?: string;
    };
    const m = /^u(\d+)$/.exec(key);
    const target = m
      ? { userId: Number(m[1]) }
      : key === 'pierre'
        ? ({ kind: 'pierre' } as const)
        : null;
    if (!target) {
      reply.status(400);
      return { error: 'BadRequest', message: `Invalid vendor key: ${key}` };
    }
    const accountId = accountIdOf(req);
    // The SAME scope the ROI row was computed at — this list reproduces one of that panel's rows,
    // so the header label and the per-PR `botOnly` badge must take the identical workspace and
    // repo set. One screen cannot show two contradictory bot-only answers.
    const scope = await resolveWorkspaceScope(accountId, workspace, parseIntList(repoIds));
    const resp: BotVendorPrsResponse = await getBotVendorPrs(accountId, target, window, scope);
    return resp;
  });

  // Cross-bot dedup clusters for one PR (≥2 automated reviewers on the same path/line window).
  // Ownership-scoped → 404 for a PR this account doesn't own. No `?workspace=`: the getter derives
  // the judgement scope from the PR's own repo, which is the only workspace that can be right for
  // it — a caller-supplied one could measure this PR's threads under another workspace's verdicts.
  app.get('/api/prs/:id/bot-dedup', { schema: prIdParamSchema }, async (req, reply) => {
    const { id } = req.params as { id: number };
    const resp = await getBotDedupClusters(id, accountIdOf(req));
    if (!resp) {
      reply.status(404);
      return { error: 'NotFound', message: `PR ${id} not found` };
    }
    return resp;
  });

  // The workspace-wide review list: every PR with ≥1 `likely_addressed` automated-reviewer thread
  // in the scope, UNCAPPED, newest-thread-first, each row carrying all its resolvable thread ids +
  // a bot thread-state mix + `totalThreads` (the whole backlog). The client sorts / paginates /
  // "Select all"s across pages and chunks the resolve. Read-only.
  app.get('/api/bot-threads/resolvable', { schema: resolvableSchema }, async (req) => {
    const { workspace, repoIds } = req.query as { workspace?: string; repoIds?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, workspace, parseIntList(repoIds));
    const { prs, totalThreads } = await getResolvableBotThreadPrs(accountId, scope);
    const resp: ResolvableThreadPrsResponse = {
      prs,
      totalThreads,
      generatedAt: new Date().toISOString(),
    };
    return resp;
  });

  // The confirm-gated workspace-wide resolve. NEVER blind: the server RE-DERIVES the eligible set
  // (owned + automated-reviewer-originated + `likely_addressed` + unresolved) ∩ the client's
  // explicit reviewed ids, under the workspace named in the body, then resolves each via the SAME
  // shared helper the per-PR route uses. An empty list is a no-op (not an error); per-thread
  // failures are reported, not fatal. The re-derive path passes `threadIds` so the page cap is
  // bypassed — no requested-and-eligible id is silently dropped.
  app.post('/api/bot-threads/resolve', { schema: scopeResolveSchema }, async (req) => {
    const { threadIds, workspaceId } = req.body as ScopeResolveBotThreadsBody;
    const accountId = accountIdOf(req);
    if (threadIds.length === 0) {
      const noop: ResolveBotThreadsResult = { resolved: 0, failed: 0, results: [] };
      return noop;
    }
    // The listing and the resolve now derive the judgement from THE SAME workspace id, so they
    // cannot evaluate different rules. Under the team grain the listing was team-resolved while
    // this re-derive ran at the account default, and a reviewer marked automated only under a
    // per-team override had its threads offered and then found ineligible — the route resolved 0.
    // No `repoIds` narrowing here on purpose: the resolve acts on ids the user explicitly ticked,
    // and narrowing them a second time could only silently drop some of them.
    //
    // `workspaceId` goes through the SCOPE resolver, not an ownership 404, because here it names a
    // scope rather than a row to write: an unknown or foreign id degrades to the caller's Default
    // like every other read scope, and the worst it can do is re-derive fewer eligible threads.
    // The resolver only ever returns a workspace the caller owns, so it can never reach another
    // tenant.
    const scope = await resolveWorkspaceScope(accountId, workspaceId);
    const { threads: eligible } = await getResolvableBotThreadsForScope(
      accountId,
      scope,
      threadIds,
    );
    const result = await resolveThreadsOnGitHub(
      accountId,
      eligible.map((t) => ({ id: t.threadId, threadNodeId: t.threadNodeId })),
    );
    req.log.info(
      {
        accountId,
        workspaceId: scope.workspaceId,
        requested: threadIds.length,
        eligible: eligible.length,
        resolved: result.resolved,
        failed: result.failed,
      },
      'workspace-wide bot-thread resolve',
    );
    return result;
  });
}
