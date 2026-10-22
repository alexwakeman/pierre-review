import type { FastifyInstance } from 'fastify';
import type { SlackDigestCadence } from '@pierre-review/shared';
import { SLACK_TARGET_WORKSPACE_CAP } from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import type { LlmClient } from '../llm/seam.js';
import { registerSlackRoutes } from './routes.js';
import { buildSlackReport } from './report.js';
import { stampSlot, type SlackTargetRow } from './targets.js';
import { postToSlack } from './send.js';
import { registerSlackSignals } from './signals.js';
import { proSchemaFor } from '../db.js';

// Slack digest delivery (Pro; `slackDigest`). A SINGLE ticking cron reads every delivery target —
// one row per (account, WORKSPACE) in `workspace_slack_targets` — and, when a row's send is due,
// generates that workspace's report FRESH and posts it to that row's webhook. Generation runs
// through the guarded, $0-on-unchanged entries, so a send costs nothing when nothing changed. A
// PER-ROW `lastSentSlot` dedupe marker makes it restart-safe (never double-sends a slot, never
// spams stale ones).
//
// ── ⚠ SCOPE AND COST — THE STORY CHANGED IN PLUGIN MIGRATION 0030. READ IT BEFORE EDITING. ─────
//
// This sweep used to be ONE DIGEST PER ACCOUNT, covering the account's DEFAULT workspace only, and
// this header used to say "Do not loop this sweep over workspaces: it would multiply a billed LLM
// call by workspace count." That reduction was real, and it is now DELIBERATELY REVERSED, capped.
// What the loop actually costs:
//
//   • THE SPRINT REPORT IS THE ONLY MULTIPLIER. `refreshSprintReport` is keyed (account,
//     workspace) — own throttle key, own `sprint_reports` row, own payload hash — so N due
//     workspaces are up to N Haiku calls, and $0 for any workspace whose insights have not moved.
//   • THE PER-REPO AI DIGESTS ARE NO LONGER SENT. The message opens on the TEAM tabs of the configuring
//     account's Pending board instead (never My turn) (host `getPendingBoard` — a DB fold, no model, no GitHub call).
//   • THE BOUND IS `SLACK_TARGET_WORKSPACE_CAP` (12), enforced at the WRITE (./targets.ts) and
//     DISCLOSED in the Settings copy. It is re-applied defensively below, because a cap that lives
//     only in a write path is one hand-written UPDATE away from not existing.
//
// ⚠ THE POPULATION IS "EVERY WORKSPACE THAT HAS A TARGET ROW", NOT A USER'S SELECTION. The
// multi-select picker is gone: a target is configured one workspace at a time, on the workspace
// the reader is in, so the set this sweep bills for is now assembled a row at a time rather than
// submitted as a list. That makes the cap MORE load-bearing, not less — it is the only thing
// standing between "add a Slack channel" repeated N times and N billed report generations every
// send. It is enforced when a workspace GAINS a row, disclosed on the read
// (`configuredCount` / `cap`), and truncated here.
//
// The Pending sections, the bot block and the app deep links cost nothing per workspace (DB reads / string building).
// Every 15 minutes: fine enough to catch a send-hour boundary promptly, cheap enough to run all day.
export const SLACK_CRON = '*/15 * * * *';

// ⚠ KEYED BY (account, workspace), NOT BY ACCOUNT. Its predecessor was a `Set<number>` of account
// ids, which under a per-workspace sweep would let the first workspace of an account block every
// other one for the whole run — and it would look like it worked: the skipped rows keep their old
// marker and simply try again on the next tick, forever, whenever generation is slow.
const running = new Set<string>();
const runKey = (accountId: number, workspaceId: number): string => `${accountId}:${workspaceId}`;

/** Just the fields `dueSlot` needs — so the schedule logic is testable without a database. */
export interface SlackSchedule {
  cadence: SlackDigestCadence | null;
  hour1: number | null;
  hour2: number | null;
  timezone: string | null;
  lastSentSlot: string | null;
}

// The account-local date + hour, honoring a stored IANA timezone (falls back to server time on an
// invalid/absent tz).
function localParts(nowMs: number, tz: string | null): { date: string; hour: number } {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz ?? undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]),
    );
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
  } catch {
    const d = new Date(nowMs);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      hour: d.getHours(),
    };
  }
}

// A lexically-orderable slot id ("2026-07-06T09"). Newer slot ⇒ greater string.
const slotId = (date: string, hour: number): string => `${date}T${String(hour).padStart(2, '0')}`;

// The latest send-hour that is due today AND strictly newer than the last-sent slot; null if not
// due. Picking the LATEST due-unsent slot means a process that was off past several send-hours
// sends exactly ONE (the most recent) digest, not a burst of stale ones.
//
// ⚠ `lastSentSlot` IS NOW A PER-WORKSPACE MARKER, and that is the whole reason the column moved off
// `pro_settings`. With ONE marker per account, a restart part-way through a sweep would RE-SEND the
// workspaces that had already gone out (their send never advanced the shared marker) and, once
// some other workspace did advance it, silently SKIP the ones still owed a digest.
export function dueSlot(row: SlackSchedule, nowMs: number): string | null {
  const cadence = row.cadence ?? 'off';
  if (cadence === 'off') return null;
  const hours =
    cadence === 'twice_daily' ? [row.hour1 ?? 9, row.hour2 ?? 16] : [row.hour1 ?? 9];
  const { date, hour } = localParts(nowMs, row.timezone ?? null);
  const due = hours
    .filter((h) => hour >= h)
    .map((h) => slotId(date, h))
    .sort();
  const latest = due[due.length - 1];
  if (latest == null) return null;
  return latest > (row.lastSentSlot ?? '') ? latest : null;
}

/**
 * The rows one tick will actually consider, per account, with the cap re-applied.
 *
 * ⚠ THIS ONE TRUNCATES, BY A STABLE ORDER (workspace id) — the OPPOSITE trade from the write path,
 * on purpose. `writeTarget` REFUSES a row that would push the account past the cap, with the count
 * in the message, because a silent acceptance on a Save reads as success. By the time a sweep is
 * running there is nobody to tell, and an unbounded loop is a bill. A row that fell outside the cap
 * keeps its marker untouched, so removing a target properly later double-sends nothing.
 */
export function cappedTargets(rows: SlackTargetRow[]): SlackTargetRow[] {
  const byAccount = new Map<number, SlackTargetRow[]>();
  for (const r of rows) {
    const list = byAccount.get(r.accountId);
    if (list) list.push(r);
    else byAccount.set(r.accountId, [r]);
  }
  const out: SlackTargetRow[] = [];
  for (const list of byAccount.values()) {
    out.push(
      ...list.sort((a, b) => a.workspaceId - b.workspaceId).slice(0, SLACK_TARGET_WORKSPACE_CAP),
    );
  }
  return out;
}

/**
 * One sweep. Every due target is launched concurrently (a slow workspace must not delay the rest)
 * and the returned promise settles when they all have — the cron ignores it, and the tests await
 * it so a "restart" can be simulated deterministically.
 */
export async function runSlackSweep(
  ctx: ProContext,
  llm: LlmClient,
  nowMs: number = Date.now(),
): Promise<void> {
  await sweepTargets(ctx, llm, nowMs);
}

// The sweep body — exported so a test can drive the real scheduling, dedupe and delivery path.
export async function sweepTargets(
  ctx: ProContext,
  llm: LlmClient,
  nowMs: number,
): Promise<void> {
  const rows = await readAllTargetRows(ctx);
  const sends: Promise<void>[] = [];
  for (const row of cappedTargets(rows)) {
    if (row.webhookUrl == null || row.webhookUrl.trim() === '') continue;
    const key = runKey(row.accountId, row.workspaceId);
    if (running.has(key)) continue;
    const slot = dueSlot(row, nowMs);
    if (slot == null) continue;

    running.add(key);
    sends.push(
      (async () => {
        try {
          const message = await buildSlackReport(ctx, llm, row.accountId, row.workspaceId);
          if (message) await postToSlack(row.webhookUrl, message);
          // Stamp the slot even when there was nothing to report, so it is not retried all day.
          // ⚠ PER ROW — see the note on dueSlot.
          await stampSlot(ctx, row.accountId, row.workspaceId, slot);
        } catch (err) {
          // ⚠ NEVER LOG THE WEBHOOK URL. It is a secret no route returns; the account and
          // workspace ids are enough to find the row.
          ctx.log.warn(
            { err, accountId: row.accountId, workspaceId: row.workspaceId },
            'slack digest send failed',
          );
        } finally {
          running.delete(key);
        }
      })(),
    );
  }
  await Promise.all(sends);
}

// Every account's rows in one select — the sweep is cross-tenant by construction (it is a cron,
// not a request), and each row carries its own accountId, which is what every downstream call is
// scoped by.
async function readAllTargetRows(ctx: ProContext): Promise<SlackTargetRow[]> {
  const pro = proSchemaFor();
  return (await ctx.db
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
    })
    .from(pro.workspaceSlackTargets)
    .execute()) as SlackTargetRow[];
}

// The digest cron, the Slack routes and the two event signals. Always on.
export function registerSlackFeature(
  app: FastifyInstance,
  ctx: ProContext,
  llm: LlmClient,
): void {
  ctx.registerScheduledJob(SLACK_CRON, () => runSlackSweep(ctx, llm), 'slack-digest');
  registerSlackRoutes(app, ctx, llm);
  registerSlackSignals(ctx);
}

