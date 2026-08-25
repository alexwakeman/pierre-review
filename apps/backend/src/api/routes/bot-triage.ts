import type { FastifyInstance } from 'fastify';
import type {
  BotAnalyticsResponse,
  BotFlaggingRefine,
  BotFlaggingResponse,
  BotFlaggingSelector,
  BotOnlyPrsResponse,
  ResolvableThreadPrsResponse,
  BotVendorCommentsResponse,
  BotVendorPrsResponse,
  BotVolumePrSort,
  BotVolumePrsResponse,
  BotVolumeRefine,
  BotVolumeResponse,
  BotVolumeScatterResponse,
  BotWindowKind,
  DetectedReviewersResponse,
  MlCategory,
  MlSeverity,
  ResolveBotThreadsResult,
  ReviewerCostBody,
  ScopeResolveBotThreadsBody,
  SeverityAgreementCellRef,
  VendorDisagreeDirection,
  VendorSeverityAxis,
  WorkspaceReviewer,
  WorkspaceReviewerPatchBody,
} from '@pierre-review/shared';
import { getBotFlaggingComments, getBotVendorComments } from '../../db/ml-labels.js';
import { getBotOverlapClusters } from '../../db/bot-overlap.js';
import { getBotVolume, getBotVolumeScatter, getPrBotVolume } from '../../db/bot-volume.js';
import {
  getBotAnalytics,
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
import { getAutomationOutput } from '../../db/automation-output.js';
import { accountIdOf } from '../plugins/auth.js';
import { entitledProCapabilities } from '../../pro/contract.js';

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

// The explicit-bounds span cap — mirrors the synthesis person grain's PERSON_WINDOW_MAX_MS
// (packages/pro/src/synthesis/scope.ts; a plugin constant core cannot import): far past any real
// reporting period, tight enough that one request can never name a decade of rows.
const WINDOW_BOUNDS_MAX_SPAN_MS = 200 * 86_400_000;

// Resolve the optional `?fromMs=&toMs=` pair into `getBotAnalytics`' widened window form
// (`{kind, fromMs, toMs}` — apiVersion 18; the enum alone when no bounds were sent). The pair
// names a POPULATION, so garbage 400s rather than degrading (`{error}` here → 400 in the
// handler): both-or-neither, `fromMs < toMs`, span ≤ the 200-day cap. The digits-only shape is
// already ajv-enforced by the route schemas; bounds only narrow WHAT IS MEASURED inside the
// account's own resolved scope — they carry no authority, exactly like the enum they refine.
function parseWindowBounds(
  window: BotWindowKind,
  fromMs?: string,
  toMs?: string,
): { window: BotWindowKind | { kind: BotWindowKind; fromMs: number; toMs: number } } | { error: string } {
  if (fromMs == null && toMs == null) return { window };
  if (fromMs == null || toMs == null) {
    return { error: '`fromMs` and `toMs` are only valid together' };
  }
  const from = Number(fromMs);
  const to = Number(toMs);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
    return { error: '`fromMs`/`toMs` must be epoch-ms integers' };
  }
  if (from >= to) return { error: '`fromMs` must be earlier than `toMs`' };
  if (to - from > WINDOW_BOUNDS_MAX_SPAN_MS) {
    return { error: '`fromMs`/`toMs` span too large (max 200 days)' };
  }
  return { window: { kind: window, fromMs: from, toMs: to } };
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
      // Must stay in lockstep with `ReviewerRole` in shared — the schema is the only validation
      // this field gets, and an unlisted role is rejected with a 400 rather than stored.
      role: {
        type: 'string',
        enum: ['review', 'quality_check', 'dependency', 'code_agent', 'release', 'housekeeping'],
      },
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

// GET /api/bot-analytics?window=&workspace=&repoIds=[&fromMs=&toMs=] — the window is a closed
// 4-value set, safe to enum + default; the optional bounds pair refines it to a REAL period (the
// People report's bot sections) and is validated by `parseWindowBounds` (only-together, ordered,
// span-capped ⇒ 400 — a bad bound is a client bug, not a stale bookmark).
// GET /api/bot-authoring — the AUTHORING half of "what did this automation do" (plan follow-up).
// Bounds are REQUIRED here, unlike the two routes above: this endpoint exists to serve the People
// report's bot sections, which always know their period, and a vector whose window silently
// defaulted to a rolling enum would be captioned with the report's dates while measuring
// something else. Same digits-only ajv shape and the same `parseWindowBounds` rules otherwise.
const authoringSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    required: ['userId', 'fromMs', 'toMs'],
    properties: {
      userId: { type: 'string', pattern: '^[0-9]+$' },
      workspace: { type: 'string' },
      repoIds: { type: 'string' },
      fromMs: { type: 'string', pattern: '^[0-9]+$' },
      toMs: { type: 'string', pattern: '^[0-9]+$' },
      // `1` adds the receipt rows under the vector, mirroring the person route's `?evidence=1`.
      evidence: { type: 'string' },
    },
  },
} as const;

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
      // Optional explicit bounds (epoch-ms integer strings, half-open [fromMs, toMs)) — they
      // only narrow WHAT IS MEASURED inside the resolved scope, never who counts as a bot.
      fromMs: { type: 'string', pattern: '^[0-9]+$' },
      toMs: { type: 'string', pattern: '^[0-9]+$' },
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

// GET /api/bot-analytics/vendor/:key/comments?window=[&fromMs=&toMs=] — the per-REVIEWER
// COMMENTS drill-down. Same shape as vendorPrsSchema, spelled out rather than aliased so the two
// can diverge without a shared-object surprise (the reset-schema precedent above) — and it HAS
// diverged: this one also takes the optional explicit-bounds pair (the People report's per-bot
// evidence cards cover the real period), validated exactly like /api/bot-analytics's.
const vendorCommentsSchema = {
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
      fromMs: { type: 'string', pattern: '^[0-9]+$' },
      toMs: { type: 'string', pattern: '^[0-9]+$' },
    },
  },
};

// The two ML enums, spelled out LOCALLY rather than imported from the shared package.
//
// ⚠ `@pierre-review/shared` is TYPES-ONLY and is not a published runtime dependency — the
// release build greps `release/dist` and FAILS on a surviving value import — so this file cannot
// write `enum: [...ML_CATEGORIES]`. `db/ml-labels.ts` carries exactly the same accommodation (its
// own private `ML_CATEGORY_VALUES` / `SEVERITY_KEYS`). These lists must stay in step with the
// `MlCategory` / `MlSeverity` unions; drift shows up as a 400 on a class the model really emits,
// which is why the `MlCategory[]` / `MlSeverity[]` annotations are load-bearing — a value the
// union dropped stops compiling here.
const FLAGGING_CATEGORY_VALUES: MlCategory[] = [
  'correctness_bug',
  'security',
  'performance',
  'style_readability',
  'maintainability_refactor',
  'testing',
  'documentation',
  'nitpick',
  'praise',
];

const FLAGGING_SEVERITY_VALUES: MlSeverity[] = ['nit', 'minor', 'major', 'critical'];

// GET /api/bot-analytics/flagging?select=&…&window=&workspace=&repoIds=&limit=&cursor= — the
// drill-down behind EVERY tile and chip on the Bots rail's ML strip. One route, one discriminated
// `select`, because every arm names a population of the SAME windowed label scan the strip is
// folded from; six routes could not have guaranteed that.
//
// ⚠ `workspace` and `repoIds` are STRING, never integer — the degrade-to-Default contract at the
// top of this file: an ajv `integer` would 400 on a garbage `?workspace=`, and garbage must
// render the Default workspace rather than error. `limit` IS an integer, and that asymmetry is
// the point: a bad page size is a client bug, not a stale bookmark.
//
// ⚠ `additionalProperties:false` here STRIPS unknown keys rather than rejecting them (Fastify's
// ajv runs `removeAdditional:true`), so it is tidiness, not a guarantee. What bounds this route is
// that the handler builds its selector from the enumerated keys and hands the scope to exactly one
// getter.
const flaggingSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    required: ['select'],
    properties: {
      select: {
        type: 'string',
        enum: ['findings', 'summaries', 'severity', 'category', 'overlap'],
      },
      // CSV for `select=severity` (the High-severity tile sends `major,critical`). ajv cannot
      // validate a CSV against an enum, so the handler parses it and 400s on anything unknown.
      severities: { type: 'string' },
      category: { type: 'string', enum: [...FLAGGING_CATEGORY_VALUES] },
      // The confusion-matrix cell filter — a PAIR. 'none' is the vendor axis for "the bot
      // declared no severity at all", which is a real column, not a missing value.
      cellVendor: { type: 'string', enum: ['nit', 'minor', 'major', 'critical', 'none'] },
      cellOurs: { type: 'string', enum: ['nit', 'minor', 'major', 'critical'] },
      disagree: { type: 'string', enum: ['any', 'over', 'under'] },
      // The per-bot narrowing, opened by the Behaviour tab's inflation index: a CSV of `users.id`s
      // (the numbers behind `u<userId>` keys), NOT vendor key strings.
      //
      // ⚠ A LIST, because the card-level "View all N →" sums over the PANEL's bots (role
      // `'review'`) while this route resolves role `'all'` — both deliberate — so only the exact
      // id set can make the button's number and the list it opens agree by construction.
      //
      // ⚠ STRING + `parseIntList`, the `repoIds` precedent, and NOT an ajv array: a CSV is what
      // every other id list on this surface is spelled as, and ajv cannot validate its members
      // anyway. Bounds and validation therefore live in `parseIntList` (positive integers only,
      // anything else dropped) exactly as they do for `repoIds`.
      //
      // ⚠ And it MUST be declared here at all: `additionalProperties: false` under Fastify's
      // `removeAdditional: true` STRIPS an undeclared key and answers 200, so a client sending
      // `authorUserIds` against a schema that never heard of it would list the WHOLE workspace
      // under a caption promising a subset.
      authorUserIds: { type: 'string' },
      window: {
        type: 'string',
        enum: ['rolling_7', 'rolling_14', 'rolling_30', 'sprint'],
        default: 'rolling_14',
      },
      workspace: { type: 'string' },
      repoIds: { type: 'string' },
      limit: { type: 'integer', default: 20, minimum: 1, maximum: 50 },
      // OPAQUE server-minted state. Bounded so a hostile client cannot make the handler parse an
      // arbitrarily long string; a malformed one degrades to the first page rather than 400ing.
      cursor: { type: 'string', minLength: 1, maxLength: 64 },
    },
  },
};

// ── Bot comment VOLUME (CORE, free, deterministic — db/bot-volume.ts) ───────────────────────
// Three routes over ONE base scan: the per-bot column, its PR drill-down, and the LOC chart.
//
// ⚠ `workspace`/`repoIds` are STRING here for the same reason they are everywhere else on this
// surface — an ajv `integer` would 400 on a stale bookmark, and a stale bookmark must degrade to
// the Default workspace. `limit` IS an integer (a bad page size is a client bug, not a bookmark).
//
// ⚠ EVERY PARAMETER THESE HANDLERS READ MUST BE DECLARED HERE. Fastify runs ajv with
// `removeAdditional: true`, so an undeclared key is STRIPPED and the request answers 200 with the
// filter silently not applied — a `sort=ratio` the schema never heard of would return the
// comments-sorted list under a caption promising the other one.
const volumeScopeSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      window: {
        type: 'string',
        enum: ['rolling_7', 'rolling_14', 'rolling_30', 'rolling_90', 'sprint'],
        default: 'rolling_30',
      },
      workspace: { type: 'string' },
      repoIds: { type: 'string' },
    },
  },
};

const volumePrsSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      window: {
        type: 'string',
        enum: ['rolling_7', 'rolling_14', 'rolling_30', 'rolling_90', 'sprint'],
        default: 'rolling_30',
      },
      workspace: { type: 'string' },
      repoIds: { type: 'string' },
      // The per-bot narrowing. A CSV of `users.id`s, the `BotFlaggingRefine.authorUserIds`
      // spelling verbatim — ONE convention on this surface, not two. Present-but-empty means NO
      // bots (see the handler); only absence widens.
      authorUserIds: { type: 'string' },
      // ⚠ AN ENUM, so an unknown sort 400s rather than silently falling back to the default and
      // presenting a comments-ranked list as a ratio-ranked one. The default is `'comments'` by
      // product decision even though raw count mostly ranks by SIZE — see BotVolumePrSort.
      sort: { type: 'string', enum: ['comments', 'ratio'], default: 'comments' },
      limit: { type: 'integer', default: 20, minimum: 1, maximum: 50 },
      // OPAQUE server-minted state, bounded so a hostile client cannot make the handler parse an
      // arbitrarily long string. A malformed cursor degrades to the first page rather than 400ing.
      cursor: { type: 'string', minLength: 1, maxLength: 64 },
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
    // ── PAID (`botDepth`, plan P0.3) ── The cost overlay re-gated from "plugin loaded"
    // (`botTriage`) to the paid depth tier. Same entitlement view /api/me serves and the
    // /api/pro/* 402 gate mirrors: local accounts are fully entitled whenever the plugin is
    // bound (so a flags-on local run keeps working), a free cloud account gets the same 402
    // shape as the plugin routes. Everything else on this resource (classification, identity,
    // role) stays free — this is the ONLY bot-reviewers route behind the check.
    if (!req.account || !entitledProCapabilities(req.account).botDepth) {
      reply.status(402);
      return { error: 'pro required' };
    }
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
  // The authoring-automation vector: CORE, free, deterministic, no AI. `output: null` is the ONE
  // degrade shape (unknown/foreign id, a HUMAN, or an automation that has never authored a PR in
  // this workspace) so the route is not an existence oracle — the person route's posture.
  app.get('/api/bot-authoring', { schema: authoringSchema }, async (req, reply) => {
    const { userId, workspace, repoIds, fromMs, toMs, evidence } = req.query as {
      userId: string;
      workspace?: string;
      repoIds?: string;
      fromMs: string;
      toMs: string;
      evidence?: string;
    };
    // Reuse the shared validator so the bounds rules (ordered, span-capped) have ONE spelling
    // across all three routes. The enum it refines is irrelevant here — the fold takes the pair.
    const bounds = parseWindowBounds('rolling_14', fromMs, toMs);
    if ('error' in bounds) {
      reply.status(400);
      return { error: 'BadRequest', message: bounds.error };
    }
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, workspace, parseIntList(repoIds));
    const output = await getAutomationOutput(
      accountId,
      scope,
      Number(userId),
      { fromMs: Number(fromMs), toMs: Number(toMs) },
      { evidence: evidence === '1' },
    );
    return {
      workspaceId: scope.workspaceId,
      window: { fromMs: Number(fromMs), toMs: Number(toMs) },
      output,
    };
  });

  app.get('/api/bot-analytics', { schema: analyticsSchema }, async (req, reply) => {
    const { window, workspace, repoIds, fromMs, toMs } = req.query as {
      window: BotWindowKind;
      workspace?: string;
      repoIds?: string;
      fromMs?: string;
      toMs?: string;
    };
    // Optional REAL bounds (the People report) refine the enum via the fold's widened
    // apiVersion-18 window form; a malformed pair 400s (it names a population, never degrades).
    const bounds = parseWindowBounds(window, fromMs, toMs);
    if ('error' in bounds) {
      reply.status(400);
      return { error: 'BadRequest', message: bounds.error };
    }
    const accountId = accountIdOf(req);
    // ONE object drives both halves: `workspaceId` decides who counts as a bot, `repoIds` narrows
    // which data is measured — and the narrowing is already bounded by the workspace's membership,
    // so the two cannot describe different sets of repos.
    const scope = await resolveWorkspaceScope(accountId, workspace, parseIntList(repoIds));
    // The Inflation column's split tier (plan P1.2/C2, open-question Q2): the current-window
    // counts are FREE (they ride the already-free ML fold — a verdict), while the WEEKLY history
    // behind the sparkline ships only under the paid `botDepth` entitlement — the same view
    // /api/me serves and the cost route above checks. Unentitled ⇒ the field is simply absent,
    // never an error (hidden, not upsold — the P0.2/P0.3 posture).
    const inflationHistory = Boolean(
      req.account && entitledProCapabilities(req.account).botDepth,
    );
    const resp: BotAnalyticsResponse = await getBotAnalytics(accountId, bounds.window, scope, {
      inflationHistory,
    });
    return resp;
  });

  // The bot BEHAVIOUR analytics route MOVED to the plugin (`GET /api/pro/bot-behaviour`,
  // packages/pro/src/bots/behaviour-routes.ts) behind the `botDepth` entitlement — the
  // periodReports precedent: the compute stays CORE (db/queries.ts getBotBehaviourAnalytics,
  // reached via the ProHostQueries.getBotBehaviour seam), but there is no free surface for it.

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

  // The per-REVIEWER COMMENTS drill-down behind the same Bot-ROI row: everything the reviewer
  // said in the window (inline review comments, PR comments, review bodies), each row with its
  // stored ML label INLINE — one response, never the per-PR label index per row. Same key parse
  // and the same scope resolution as the /prs sibling, so the list reproduces the same ROI row;
  // the 'pierre' sentinel answers empty (verbatim reviews are human-posted — no per-comment
  // rows to attribute). ⚠ Rate tier `search`, pinned in rate-limit.test.ts — this ships up to
  // 3000 comment BODIES per source plus a three-way label join per request.
  app.get(
    '/api/bot-analytics/vendor/:key/comments',
    { schema: vendorCommentsSchema },
    async (req, reply) => {
      const { key } = req.params as { key: string };
      const { window, workspace, repoIds, fromMs, toMs } = req.query as {
        window: BotWindowKind;
        workspace?: string;
        repoIds?: string;
        fromMs?: string;
        toMs?: string;
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
      // Same optional real-bounds refinement as /api/bot-analytics (the People report's per-bot
      // evidence cards) — a malformed pair 400s.
      const bounds = parseWindowBounds(window, fromMs, toMs);
      if ('error' in bounds) {
        reply.status(400);
        return { error: 'BadRequest', message: bounds.error };
      }
      const accountId = accountIdOf(req);
      const scope = await resolveWorkspaceScope(accountId, workspace, parseIntList(repoIds));
      const resp: BotVendorCommentsResponse = await getBotVendorComments(
        accountId,
        target,
        bounds.window,
        scope,
      );
      return resp;
    },
  );

  // ── "WHAT THE BOTS ARE FLAGGING" ──────────────────────────────────────────────────────────
  // The drill-down behind every tile and chip on the Bots rail's ML strip. `select` picks the
  // population; the response is discriminated on `kind` — 'comments' for the four label
  // selectors, 'clusters' for same-line overlap (deterministic line clusters, not ML rows).
  //
  // ⚠ `total` IS THE TILE'S NUMBER, BY CONSTRUCTION — not an independently-derived count that
  // happens to agree. The strip's buckets are a JS fold (`foldMlLabelRow`) over a JSON
  // `categories` column that no portable SQL predicate can express, so a `COUNT(*) WHERE
  // severity IN (…)` could never match it: it would count summaries and praise, could not
  // express praise at all, and would ignore both `coerceSeverity` failures and the scan cap's
  // newest-first truncation. The getters therefore re-run the strip's identical scan and
  // identical fold and then slice. Nothing on either side of this route re-derives a count —
  // note in particular that the client's `pillOf` tests praise BEFORE isSummary, the opposite
  // of the backend, so a client-side recount would disagree with the tile it drilled into.
  //
  // ⚠ Rate tier `search`, pinned in rate-limit.test.ts, and that predicate is anchored on this
  // EXACT path — spelling this route with a sub-path or a path parameter would silently drop it
  // back onto the 600/min blanket bucket with no error anywhere. Per request it re-runs the
  // strip's whole 50k-row label scan (the page offset is a JS slice over the fold) or the
  // window's whole thread scan plus ±3-line clustering, then hydrates a page of comment BODIES —
  // and an IntersectionObserver fires it again on every scroll.
  app.get('/api/bot-analytics/flagging', { schema: flaggingSchema }, async (req, reply) => {
    const q = req.query as {
      select: 'findings' | 'summaries' | 'severity' | 'category' | 'overlap';
      severities?: string;
      category?: MlCategory;
      cellVendor?: VendorSeverityAxis;
      cellOurs?: MlSeverity;
      disagree?: VendorDisagreeDirection;
      authorUserIds?: string;
      window: BotWindowKind;
      workspace?: string;
      repoIds?: string;
      limit: number;
      cursor?: string;
    };

    // The selector and the refinement are assembled BEFORE any DB work: every failure below is a
    // client bug, and there is nothing to resolve a scope for in a request that cannot name a
    // population.
    let selector: BotFlaggingSelector;
    if (q.select === 'severity') {
      // ⚠ AN UNKNOWN OR EMPTY SEVERITY LIST 400s, unlike `?workspace=`. The difference is who
      // minted the value: a workspace id can be a stale bookmark and must degrade to something
      // renderable, whereas this list is written by the tile that opened the tab. Silently
      // dropping an unrecognised class would name a DIFFERENT population than the tile did and
      // the list would quietly disagree with the number the user clicked.
      const raw = (q.severities ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      const severities = raw.filter((s): s is MlSeverity =>
        (FLAGGING_SEVERITY_VALUES as string[]).includes(s),
      );
      if (severities.length === 0 || severities.length !== raw.length) {
        reply.status(400);
        return {
          error: 'BadRequest',
          message: `\`severities\` must be a comma-separated subset of ${FLAGGING_SEVERITY_VALUES.join(', ')}`,
        };
      }
      selector = { kind: 'severity', severities };
    } else if (q.select === 'category') {
      // ajv has already rejected an unknown category VALUE, so only absence can reach here.
      if (!q.category) {
        reply.status(400);
        return { error: 'BadRequest', message: '`select=category` requires `category`' };
      }
      selector = { kind: 'category', category: q.category };
    } else if (q.select === 'summaries') {
      selector = { kind: 'summaries' };
    } else if (q.select === 'overlap') {
      selector = { kind: 'overlap' };
    } else {
      selector = { kind: 'findings' };
    }

    // A confusion-matrix cell is a PAIR; half of one names no cell. Rejected rather than
    // silently ignored, because a filter that appears to be applied and is not is the worse
    // failure mode — the user reads an unfiltered list as the filtered one.
    let cell: SeverityAgreementCellRef | null = null;
    if (q.cellVendor && q.cellOurs) {
      cell = { vendor: q.cellVendor, ours: q.cellOurs };
    } else if (q.cellVendor || q.cellOurs) {
      reply.status(400);
      return {
        error: 'BadRequest',
        message: '`cellVendor` and `cellOurs` must be sent together or not at all',
      };
    }
    // ⚠ NO OWNERSHIP CHECK ON `authorUserIds`, and that is not an oversight: `users` is a GLOBAL
    // table, so "does this account own that user row" is not a question it can answer. The
    // narrowing is applied as a predicate over an already accountId- and scope-filtered label
    // scan, so a foreign or nonexistent id matches nothing — an empty list, identical in both
    // cases, which is what stops it being an existence oracle.
    //
    // ⚠ PRESENT-BUT-EMPTY IS "NO BOTS", NEVER "EVERY BOT" — the `repoIds` rule (`if (ids)`, never
    // `ids.length > 0`). `parseIntList` collapses absence AND an unusable list to null, which is
    // right for a repo NARROW (null = don't narrow) and wrong here: a caller that computed an
    // empty bot set and sent it would get the whole workspace back under a caption promising a
    // subset — the very failure this parameter was widened to prevent. So the KEY's presence
    // decides whether there is a narrowing at all, and `parseIntList` only parses its members.
    const authorUserIds = q.authorUserIds == null ? null : (parseIntList(q.authorUserIds) ?? []);
    const refine: BotFlaggingRefine = {
      cell,
      disagree: q.disagree ?? null,
      authorUserIds,
    };

    // ⚠ THE CURSOR DEGRADES, IT NEVER 400s — the opposite rule to `severities` above, and for the
    // opposite reason: it is server-minted state a client only ever echoes back, and it is OPAQUE
    // on the wire precisely so its encoding can change (a later keyset switch) without breaking
    // in-flight clients. Today it carries an offset into the folded population. Anything that is
    // not exactly that — a stale shape, a value past the end, an unsafe integer — starts again at
    // the first page, which is always a renderable answer.
    const m = /^o:(\d+)$/.exec(q.cursor ?? '');
    const parsedOffset = m ? Number(m[1]) : 0;
    const offset = Number.isSafeInteger(parsedOffset) ? parsedOffset : 0;

    const accountId = accountIdOf(req);
    // The SAME scope the strip was measured at — this list reproduces one of that strip's tiles,
    // so it must take the identical workspace (who counts as a bot) and repo narrowing (which
    // data is measured), bounded by the workspace's membership inside the resolver. A `BotScope`
    // is only ever built here; `parseIntList`'s result is the `narrow` argument, never a scope.
    const scope = await resolveWorkspaceScope(accountId, q.workspace, parseIntList(q.repoIds));
    const page = { offset, limit: q.limit };
    const resp: BotFlaggingResponse =
      selector.kind === 'overlap'
        ? await getBotOverlapClusters(accountId, refine, q.window, scope, page)
        : await getBotFlaggingComments(accountId, selector, refine, q.window, scope, page);
    return resp;
  });

  // ── Bot comment VOLUME — the three routes over db/bot-volume.ts's one base scan ───────────
  //
  // GET /api/bot-analytics/volume — the ROI tab's "avg bot comments per PR" column + workspace
  // totals. The two averages differ ONLY by denominator (`avgCommentsPerCommentedPr` divides by
  // the PRs that bot touched, `avgCommentsPerScopePr` by every merged PR in scope) and on a quiet
  // repo they differ by ~6× — the field names carry that, and so must the column header.
  //
  // ⚠ Rate tier `search`, pinned in rate-limit.test.ts. Per request it walks every merged PR in
  // the window (up to 5000) plus three grouped comment counts over them, then folds in JS. No
  // GitHub, no model — this process's event loop, the flagging-drill-down shape of cost — so it
  // borrows the same 60/min bucket rather than the 600/min blanket one.
  app.get('/api/bot-analytics/volume', { schema: volumeScopeSchema }, async (req) => {
    const q = req.query as { window: BotWindowKind; workspace?: string; repoIds?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace, parseIntList(q.repoIds));
    const resp: BotVolumeResponse = await getBotVolume(accountId, q.window, scope);
    return resp;
  });

  // GET /api/bot-analytics/volume/prs — the paginated drill-down behind that column. Default sort
  // is raw `botComments` DESC; `sort=ratio` ranks by the bucket-relative expectation, which is
  // the only ordering that surfaces a small PR a bot tore apart (raw count mostly ranks by size).
  app.get('/api/bot-analytics/volume/prs', { schema: volumePrsSchema }, async (req) => {
    const q = req.query as {
      window: BotWindowKind;
      workspace?: string;
      repoIds?: string;
      authorUserIds?: string;
      sort: BotVolumePrSort;
      limit: number;
      cursor?: string;
    };
    const accountId = accountIdOf(req);
    // ⚠ PRESENT-BUT-EMPTY IS "NO BOTS", NEVER "EVERY BOT" — the `repoIds` rule (`if (ids)`, never
    // `ids.length > 0`), identical to the flagging route above. `parseIntList` collapses absence
    // AND an unusable list to null, which is right for a repo NARROW and wrong here: a caller
    // that computed an empty bot set and sent it would get the whole workspace back under a
    // caption promising a subset. So the KEY's presence decides whether there is a narrowing at
    // all, and `parseIntList` only parses its members.
    //
    // ⚠ NO OWNERSHIP CHECK, and that is not an oversight: `users` is a GLOBAL table, so "does this
    // account own that user row" is not a question it can answer. The narrowing is applied over an
    // already accountId- and scope-filtered fold, so a foreign or nonexistent id matches nothing —
    // an empty list, identical in both cases, which is what stops it being an existence oracle.
    const authorUserIds = q.authorUserIds == null ? null : (parseIntList(q.authorUserIds) ?? []);
    const refine: BotVolumeRefine = { authorUserIds };
    // ⚠ THE CURSOR DEGRADES, IT NEVER 400s — server-minted state a client only ever echoes back,
    // opaque precisely so its encoding can change without breaking in-flight clients. Anything
    // that is not exactly `o:<n>` starts again at the first page, which is always renderable.
    const m = /^o:(\d+)$/.exec(q.cursor ?? '');
    const parsedOffset = m ? Number(m[1]) : 0;
    const offset = Number.isSafeInteger(parsedOffset) ? parsedOffset : 0;
    const scope = await resolveWorkspaceScope(accountId, q.workspace, parseIntList(q.repoIds));
    const resp: BotVolumePrsResponse = await getPrBotVolume(accountId, q.window, scope, refine, {
      offset,
      limit: q.limit,
      sort: q.sort,
    });
    return resp;
  });

  // GET /api/bot-analytics/volume/scatter — the Behaviour tab's LOC-vs-volume chart: one point per
  // SIZED merged PR (capped at 2000, newest first) plus the five bucket means over the WHOLE
  // scope. The buckets are what make the chart readable — size is sublinear in comments, so the
  // expectation curve bends and the naive "comments per 100 LOC" reading is the one to avoid.
  app.get('/api/bot-analytics/volume/scatter', { schema: volumeScopeSchema }, async (req) => {
    const q = req.query as { window: BotWindowKind; workspace?: string; repoIds?: string };
    const accountId = accountIdOf(req);
    const scope = await resolveWorkspaceScope(accountId, q.workspace, parseIntList(q.repoIds));
    const resp: BotVolumeScatterResponse = await getBotVolumeScatter(accountId, q.window, scope);
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
