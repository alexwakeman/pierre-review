import { and, eq } from 'drizzle-orm';
import type {
  SlackDigestCadence,
  SlackTarget,
  WorkspaceSlackTargetResponse,
  WorkspaceSlackTargetUpdate,
} from '@pierre-review/shared';
import { SLACK_TARGET_WORKSPACE_CAP } from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import { proSchemaFor } from '../db.js';
import {
  VALID_CADENCE,
  clampInt,
  normalizeSlackWebhookUrl,
} from '../settings/store.js';

// ── THE PER-WORKSPACE SLACK DELIVERY TARGETS (plugin migration 0030) ─────────────────────────
//
// One row per (account, workspace) in `workspace_slack_targets`. A ROW IS A TARGET: it exists ⇒
// that workspace's digest is generated on this schedule and posted to this channel; no row ⇒ that
// workspace gets nothing. This module is the ONLY reader and the ONLY writer.
//
// ⚠ ONE WORKSPACE PER WRITE. The multi-select and its "apply to all selected" fan-out are GONE:
// the Slack digest is configured for the workspace the reader is currently in, like every other
// per-workspace control. `writeTarget` upserts exactly one row and `deleteTarget` removes exactly
// one — a save can no longer drop a delivery by leaving it out of a list.
//
// ⚠ NO INHERITANCE, NO ACCOUNT-LEVEL FALLBACK. Nothing in this file consults `pro_settings`, and
// nothing should be added that does: null-means-INHERIT is the bug class CLAUDE.md names, and a
// webhook is the worst possible field to inherit — it would silently post a new team's private
// figures into whichever channel somebody configured years ago. The seven `pro_settings.slack_*`
// columns this replaces are DORMANT (migration 0030 copied them into a Default-workspace row and
// the drizzle schema no longer declares them). ONE live spelling.
//
// ⚠ THE CRON'S POPULATION IS NOW "EVERY WORKSPACE THAT HAS A ROW" — not a user's selection. The
// cap did not become decorative when the picker went away; it became the bound on how many
// workspaces one sweep will BILL for. It is enforced here on the act of adding a row, disclosed on
// the read (`configuredCount` / `cap`), and re-applied defensively in the sweep (./cron.ts).
//
// ⚠ EVERY WRITE ROUTES THROUGH `normalizeSlackWebhookUrl`. That allowlist is the SSRF control at
// the point of STORAGE — a new write path that skips it bypasses the control entirely, which is
// precisely the failure the sink-side re-check in ./send.ts exists to backstop. Both halves stay.

/** The raw row shape (sqlite returns Date for timestamp columns; the number branch is defensive). */
export interface SlackTargetRow {
  accountId: number;
  workspaceId: number;
  webhookUrl: string;
  cadence: SlackDigestCadence | null;
  hour1: number | null;
  hour2: number | null;
  timezone: string | null;
  lastSentAt: Date | number | null;
  lastSentSlot: string | null;
  /** Include the deterministic "Review bots" block in this delivery (plugin migration 0033).
   *  null = never set → false, the documented default of the account flag it replaces. */
  botDigest: boolean | null;
  /** The two Slack EVENT signals (plugin migration 0040). null = never set → off. */
  notifyReviews: boolean | null;
  notifyMerges: boolean | null;
}

const toMs = (v: Date | number | null | undefined): number | null =>
  v == null ? null : v instanceof Date ? v.getTime() : Number(v);

/** The public projection. ⚠ `webhookUrl` NEVER travels — only `configured`. */
export function toPublicTarget(row: SlackTargetRow, workspaceName: string): SlackTarget {
  const sentMs = toMs(row.lastSentAt);
  return {
    workspaceId: row.workspaceId,
    workspaceName,
    // Always true for a stored row (`webhook_url` is NOT NULL), and on the wire anyway so the SPA
    // renders "•••••••• (unchanged)" from a field rather than from the row's mere existence.
    configured: row.webhookUrl.trim() !== '',
    cadence: row.cadence ?? 'off',
    hour1: row.hour1 ?? 9,
    hour2: row.hour2 ?? 16,
    timezone: row.timezone ?? null,
    lastSentAt: sentMs == null ? null : new Date(sentMs).toISOString(),
    // ⚠ null → false. A row that predates plugin 0033 and belonged to an account with the flag OFF
    // is indistinguishable from one that never set it, and both mean "no bot block".
    botDigest: row.botDigest ?? false,
    notifyReviews: row.notifyReviews ?? false,
    notifyMerges: row.notifyMerges ?? false,
  };
}

/** Every target row for one account. Ordered by workspace id so the list is stable across reads. */
export async function readTargetRows(
  ctx: ProContext,
  accountId: number,
): Promise<SlackTargetRow[]> {
  const pro = proSchemaFor(ctx.isPg);
  const rows = (await ctx.db
    .select({
      accountId: pro.workspaceSlackTargets.accountId,
      workspaceId: pro.workspaceSlackTargets.workspaceId,
      webhookUrl: pro.workspaceSlackTargets.webhookUrl,
      cadence: pro.workspaceSlackTargets.cadence,
      hour1: pro.workspaceSlackTargets.hour1,
      hour2: pro.workspaceSlackTargets.hour2,
      timezone: pro.workspaceSlackTargets.timezone,
      lastSentAt: pro.workspaceSlackTargets.lastSentAt,
      lastSentSlot: pro.workspaceSlackTargets.lastSentSlot,
      botDigest: pro.workspaceSlackTargets.botDigest,
      notifyReviews: pro.workspaceSlackTargets.notifyReviews,
      notifyMerges: pro.workspaceSlackTargets.notifyMerges,
    })
    .from(pro.workspaceSlackTargets)
    .where(eq(pro.workspaceSlackTargets.accountId, accountId))
    .execute()) as SlackTargetRow[];
  return rows.sort((a, b) => a.workspaceId - b.workspaceId);
}

/**
 * ONE workspace's display name, scoped to the account that owns it.
 *
 * ⚠ IT REPLACED an `readAccountWorkspaces()` that listed every workspace for the picker. There is
 * no picker: the route edits the workspace in `?workspace=`, which `resolveRequestWorkspaceId` has
 * already proven this account owns. Nothing here should grow back into a cross-workspace listing —
 * that is the shape whose Save could silently retarget somebody else's team.
 *
 * The `and(id, accountId)` predicate is belt-and-braces on top of that resolution: a name is the
 * one thing this file emits verbatim, and reading it by bare id would make a cross-tenant id leak
 * a workspace NAME even while every other field stayed empty.
 */
async function workspaceNameOf(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<string> {
  const wsT = ctx.schema.workspaces;
  const rows = (await ctx.db
    .select({ name: wsT.name })
    .from(wsT)
    .where(and(eq(wsT.id, workspaceId), eq(wsT.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ name: string }>;
  // A nameless row in a delivery control is an invitation to configure the wrong one.
  return rows[0]?.name ?? '(unknown workspace)';
}

/** Raised when configuring a NEW target would push the account past the sweep bound. */
export class SlackTargetCapError extends Error {
  readonly cap = SLACK_TARGET_WORKSPACE_CAP;
  constructor(configured: number) {
    super(
      `A Slack digest can cover at most ${SLACK_TARGET_WORKSPACE_CAP} workspaces ` +
        `(${configured} already have one). Each one generates its own report on every send — ` +
        `turn one off before adding another.`,
    );
  }
}

/** Raised when a workspace is configured for the first time with no webhook URL to deliver to. */
export class SlackTargetMissingWebhookError extends Error {
  constructor(readonly workspaceId: number) {
    super('A Slack webhook URL is required to start delivering to this workspace.');
  }
}

/** Raised when a supplied URL fails the `normalizeSlackWebhookUrl` allowlist. */
export class SlackTargetBadWebhookError extends Error {
  constructor(readonly workspaceId: number) {
    super(
      'Not a valid Slack incoming-webhook URL ' +
        '(expected https://hooks.slack.com/services/…).',
    );
  }
}

/**
 * Write ONE workspace's delivery target. A PARTIAL patch over one row.
 *
 * ⚠ IT EDITS EXACTLY THE WORKSPACE IT IS GIVEN. Its predecessor took the account's WHOLE selection
 * and deleted every workspace absent from the list — a shape that only made sense alongside a
 * multi-select picker. There is no picker: settings are for the workspace the reader is in, and
 * stopping a delivery is `deleteTarget`, an explicit VERB. Nothing can now drop a delivery by
 * omission.
 *
 * ⚠ THE CAP IS A SWEEP BOUND AND IT REFUSES, NEVER TRUNCATES. Every configured workspace is its own
 * billed sprint-report generation on every send, so the number of TARGET ROWS is the spend. With no
 * picker, the moment to enforce it is the moment a workspace GAINS a row: a PUT for a workspace
 * that has no row, when the account already holds `SLACK_TARGET_WORKSPACE_CAP` of them, is refused
 * with the count in the message. Editing an EXISTING row is always allowed — it adds no cost, and
 * an account that is somehow over the cap must still be able to turn things off.
 *
 * ⚠ AN OMITTED `webhookUrl` KEEPS THE STORED SECRET. The field is write-only, so a form that
 * re-submitted what it was shown would blank it. A workspace with no stored row and no supplied
 * URL is REFUSED rather than stored: an undeliverable row would sit in the sweep being skipped.
 *
 * ⚠ THE ALLOWLIST RUNS ON EVERY WRITE. `normalizeSlackWebhookUrl` is the SSRF control at the point
 * of STORAGE; the sink-side re-check in ./send.ts is a backstop, not a replacement. Both halves stay.
 */
export async function writeTarget(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
  patch: WorkspaceSlackTargetUpdate,
): Promise<void> {
  const pro = proSchemaFor(ctx.isPg);
  const rows = await readTargetRows(ctx, accountId);
  const prior = rows.find((r) => r.workspaceId === workspaceId) ?? null;
  if (prior == null && rows.length >= SLACK_TARGET_WORKSPACE_CAP) {
    throw new SlackTargetCapError(rows.length);
  }

  let webhookUrl: string;
  if (patch.webhookUrl !== undefined && patch.webhookUrl.trim() !== '') {
    const safe = normalizeSlackWebhookUrl(patch.webhookUrl);
    if (safe == null) throw new SlackTargetBadWebhookError(workspaceId);
    webhookUrl = safe;
  } else if (prior != null) {
    webhookUrl = prior.webhookUrl;
  } else {
    throw new SlackTargetMissingWebhookError(workspaceId);
  }

  const values = {
    webhookUrl,
    cadence:
      patch.cadence !== undefined && VALID_CADENCE.includes(patch.cadence)
        ? patch.cadence
        : (prior?.cadence ?? 'daily'),
    hour1: patch.hour1 !== undefined ? clampInt(patch.hour1, 0, 23) : (prior?.hour1 ?? 9),
    hour2: patch.hour2 !== undefined ? clampInt(patch.hour2, 0, 23) : (prior?.hour2 ?? 16),
    timezone:
      patch.timezone !== undefined
        ? patch.timezone && patch.timezone.trim() !== ''
          ? patch.timezone.trim()
          : null
        : (prior?.timezone ?? null),
    // ⚠ SEEDED FROM `prior` LIKE EVERY OTHER FIELD. This `values` object is spread into BOTH the
    // insert and the `set:`, so a column named here but not carried through from the stored row is
    // NULLED on any unrelated patch — the same hazard `mergeWorkspace` documents one table over.
    // Plugin migration 0033.
    botDigest: patch.botDigest !== undefined ? !!patch.botDigest : (prior?.botDigest ?? null),
    // The two event signals (plugin migration 0040) — seeded from `prior` for the same reason.
    notifyReviews:
      patch.notifyReviews !== undefined ? !!patch.notifyReviews : (prior?.notifyReviews ?? null),
    notifyMerges:
      patch.notifyMerges !== undefined ? !!patch.notifyMerges : (prior?.notifyMerges ?? null),
  };
  const now = new Date();
  await ctx.db
    .insert(pro.workspaceSlackTargets)
    .values({ accountId, workspaceId, ...values, updatedAt: now })
    .onConflictDoUpdate({
      // ⚠ EXACTLY the table's unique index (`wst_account_ws`). A stale conflict target
      // type-checks perfectly and raises "no unique or exclusion constraint matching the ON
      // CONFLICT specification" at RUNTIME, in both dialects, only when a row is written.
      target: [pro.workspaceSlackTargets.accountId, pro.workspaceSlackTargets.workspaceId],
      // ⚠ `lastSentSlot` / `lastSentAt` ARE ABSENT FROM THIS `set:` ON PURPOSE. They are the
      // cron's dedupe markers, not user settings: rewriting them on a settings save would
      // either re-send a slot already delivered (if cleared) or skip one that was not.
      set: { ...values, updatedAt: now },
    })
    .execute();
}

/**
 * Stop delivering to ONE workspace. Deleting the row IS the off switch — a row's existence is the
 * setting — and it frees a slot under the cap.
 *
 * ⚠ IT TAKES THE DEDUPE MARKER WITH IT, and that is correct: re-configuring the workspace later is
 * a new delivery, and a stale marker would silently swallow the first digest of the new
 * arrangement. `cadence: 'off'` is the PAUSE that keeps both the channel and the marker.
 */
export async function deleteTarget(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<void> {
  const pro = proSchemaFor(ctx.isPg);
  await ctx.db
    .delete(pro.workspaceSlackTargets)
    .where(
      and(
        eq(pro.workspaceSlackTargets.accountId, accountId),
        eq(pro.workspaceSlackTargets.workspaceId, workspaceId),
      ),
    )
    .execute();
}

/**
 * ONE workspace's target, projected for the wire (webhook URL withheld), plus the sweep bound and
 * how much of it the account is using.
 *
 * ⚠ `configuredCount` IS THE DISCLOSURE. With no picker there is no screen that shows all the
 * deliveries at once, so the count is the only way a reader learns they are near the bound BEFORE
 * a save is refused. It counts the account's target rows, this workspace included.
 */
export async function readTarget(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<WorkspaceSlackTargetResponse> {
  const [rows, workspaceName] = await Promise.all([
    readTargetRows(ctx, accountId),
    workspaceNameOf(ctx, accountId, workspaceId),
  ]);
  const row = rows.find((r) => r.workspaceId === workspaceId) ?? null;
  return {
    workspaceId,
    workspaceName,
    target: row == null ? null : toPublicTarget(row, workspaceName),
    cap: SLACK_TARGET_WORKSPACE_CAP,
    configuredCount: rows.length,
  };
}

/** One account's target for one workspace, or null. Used by the "Send test" route. */
export async function readTargetRow(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<SlackTargetRow | null> {
  return (await readTargetRows(ctx, accountId)).find((r) => r.workspaceId === workspaceId) ?? null;
}

/**
 * Stamp one row's dedupe marker after a send attempt.
 *
 * ⚠ PER (account, workspace) — the whole reason this column moved off `pro_settings`. One marker
 * per account under a per-workspace sweep means a restart mid-sweep RE-SENDS the workspaces that
 * already went out and, once the marker advances, SKIPS the ones that had not.
 *
 * It is stamped even when there was nothing to report, so a quiet workspace is not retried all day.
 */
export async function stampSlot(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
  slot: string,
): Promise<void> {
  const pro = proSchemaFor(ctx.isPg);
  await ctx.db
    .update(pro.workspaceSlackTargets)
    .set({ lastSentSlot: slot, lastSentAt: new Date() })
    .where(
      and(
        eq(pro.workspaceSlackTargets.accountId, accountId),
        eq(pro.workspaceSlackTargets.workspaceId, workspaceId),
      ),
    )
    .execute();
}
