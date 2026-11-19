// THE SIBLING STATE A FIX WAS BUILT AGAINST, AND WHETHER IT IS STALE (docs/CLAUDE-REVIEW.md § AI Fix → The fix
// start queue, "Stale"). A fix reads the other open PRs of its ticket at their heads — with a sibling's built,
// unpushed AI Fix laid on top when there is one (sandbox/session/fix.ts `bases`, the OVERLAY). What it read is
// stored per sibling on the row (`ai_fixes.sibling_state_json`, migration 0210), WITH EACH STORED PATCH (a build
// turn's; a boot or a Resume alone writes nothing, so a Resume never clears staleness).
//
// STALE IS COMPUTED ON READ, never stored, never acted on by itself: an UNPUSHED, finished fix is stale when, for
// any sibling it read,
//   • the sibling's head moved (the synced `pull_requests.head_sha`) — unless the move IS the push of the very
//     fix it read as an overlay (the same code);
//   • the overlaid fix was discarded (or failed), or its patch changed since (a follow-up turn);
//   • a newer built fix of that sibling exists (one not built when this fix read it) — unless that fix was itself
//     built ON TOP OF this one (its own sibling state overlays this fix): it follows this fix, it does not change it.
// A stale fix shows ONE line in the AI Fix tab; automatic pushes ("Push automatically", "Push when done") hold it
// with that reason (auto-push.ts); the reader's own Push still pushes. Nothing is ever re-run.
// BUILT ON AN UNPUSHED FIX: while a sibling fix this one overlaid is not pushed, automatic pushes hold this fix too
// ("Not pushed: it builds on #12's AI Fix, which is not pushed yet."); a press still pushes.
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AgentContext } from '../../review/agent-context.js';
import type { AiFixRow } from './persist.js';

/** One sibling a fix read (stored JSON). */
export interface FixSiblingState {
  prId: number;
  number: number;
  repoId: number;
  /** The sibling's head the fix read (the overlay's base when there was one). */
  headSha: string;
  /** The sibling's built, unpushed AI Fix laid on its head; null ⇒ the head alone. */
  overlayFixId: number | null;
  /** `patchHash` of that fix's patch as it was read. */
  overlayPatchHash: string | null;
  /** The sibling's built, unpushed fixes that existed when the fix read it: any other built later is "newer". */
  builtFixIds?: number[];
  /** When the fix read the siblings (ms). */
  at: number;
}

/** A short, stable name of a patch's content (never shown). Pure. */
export function patchHash(patch: string): string {
  return createHash('sha256').update(patch, 'utf8').digest('hex').slice(0, 16);
}

/** The stored JSON, checked; anything malformed is dropped (never throws). Pure. */
export function readSiblingState(raw: unknown): FixSiblingState[] {
  if (!Array.isArray(raw)) return [];
  const out: FixSiblingState[] = [];
  for (const x of raw) {
    if (x == null || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    if (typeof o.prId !== 'number' || typeof o.number !== 'number' || typeof o.repoId !== 'number' || typeof o.headSha !== 'string') continue;
    out.push({
      prId: o.prId,
      number: o.number,
      repoId: o.repoId,
      headSha: o.headSha,
      overlayFixId: typeof o.overlayFixId === 'number' ? o.overlayFixId : null,
      overlayPatchHash: typeof o.overlayPatchHash === 'string' ? o.overlayPatchHash : null,
      ...(Array.isArray(o.builtFixIds) ? { builtFixIds: o.builtFixIds.filter((n): n is number => typeof n === 'number') } : {}),
      at: typeof o.at === 'number' ? o.at : 0,
    });
  }
  return out;
}

/** What is true of one sibling NOW (DB only). */
export interface SiblingNow {
  /** The synced head; null = unknown (never read as "moved"). */
  headSha: string | null;
  /** The fix this one overlaid, as it is now; null when it is gone (or there was none). */
  overlay: { discarded: boolean; pushedCommitSha: string | null; pushed: boolean; patchHash: string | null } | null;
  /**
   * The sibling's built, unpushed fixes with a patch: id, when they last finished (ms), and the fixes THEY overlaid
   * (their own sibling state's `overlayFixId`s).
   */
  built: Array<{ fixId: number; finishedAtMs: number | null; buildsOn?: readonly number[] }>;
}

/** THE STALENESS FOLD. Pure: the first sibling that changed (its PR number), or null. `selfFixId`: this fix. */
export function siblingStaleness(state: readonly FixSiblingState[], now: ReadonlyMap<number, SiblingNow>, selfFixId: number | null = null): { prNumber: number } | null {
  for (const s of state) {
    const n = now.get(s.prId);
    if (n == null) continue;
    const stale = ((): boolean => {
      if (s.overlayFixId != null) {
        const o = n.overlay;
        if (o == null || o.discarded) return true;
        if (o.pushed) {
          // Its push IS the code this fix read: the head moving to that commit is not a change.
          if (n.headSha != null && n.headSha !== s.headSha && n.headSha !== o.pushedCommitSha) return true;
        } else {
          if (o.patchHash != null && s.overlayPatchHash != null && o.patchHash !== s.overlayPatchHash) return true;
          if (n.headSha != null && n.headSha !== s.headSha) return true;
        }
      } else if (n.headSha != null && n.headSha !== s.headSha) return true;
      // A NEWER built fix: one not among those built when the fix read the sibling (by id: timestamps are whole
      // seconds; an entry without that list falls back to "finished after the read") — and NOT built on this fix.
      const known = s.builtFixIds != null ? new Set(s.builtFixIds) : null;
      return n.built.some(
        (b) =>
          b.fixId !== s.overlayFixId &&
          (known != null ? !known.has(b.fixId) : b.finishedAtMs != null && b.finishedAtMs > s.at) &&
          !(selfFixId != null && (b.buildsOn ?? []).includes(selfFixId)),
      );
    })();
    if (stale) return { prNumber: s.number };
  }
  return null;
}

/**
 * BUILT ON AN UNPUSHED FIX. Pure: the first sibling whose overlaid fix is still built and NOT pushed (its PR number),
 * or null. A pushed one is fine (its code is on the head); a discarded one is already stale.
 */
export function overlayUnpushed(state: readonly FixSiblingState[], now: ReadonlyMap<number, SiblingNow>): { prNumber: number } | null {
  for (const s of state) {
    if (s.overlayFixId == null) continue;
    const o = now.get(s.prId)?.overlay;
    if (o != null && !o.discarded && !o.pushed) return { prNumber: s.number };
  }
  return null;
}

/** The AI Fix tab's ONE line for a stale fix. Pure. */
export function siblingStaleLine(prNumber: number): string {
  return `#${prNumber} changed after this fix was built.`;
}

/** Automatic pushes hold a stale fix with this line (`AiFix.pushHold`). Pure. */
export function siblingStaleHoldLine(prNumber: number): string {
  return `Not pushed: #${prNumber} changed after this fix was built. Check it, then press Push.`;
}

/** Automatic pushes hold a fix built on a sibling's unpushed fix with this line (`AiFix.pushHold`). Pure. */
export function overlayUnpushedHoldLine(prNumber: number): string {
  return `Not pushed: it builds on #${prNumber}'s AI Fix, which is not pushed yet.`;
}

const ms = (v: Date | number | null | undefined): number | null => (v == null ? null : v instanceof Date ? v.getTime() : Number(v) * 1000);

/** What the push rules and the AI Fix tab read of a fix's siblings: stale, and built on an unpushed fix. */
export interface FixSiblingFacts {
  stale: { prNumber: number } | null;
  overlayUnpushed: { prNumber: number } | null;
}

const NONE: FixSiblingFacts = { stale: null, overlayUnpushed: null };

/**
 * The sibling facts of a finished, UNPUSHED fix. DB only, account-scoped, and only the columns it needs (a patch is
 * read for the overlaid fixes only). NONE for a pushed or unfinished fix, a fix that read no sibling, and on any
 * failed read (never throws).
 */
export async function fixSiblingFacts(
  ctx: AgentContext,
  accountId: number,
  row: Pick<AiFixRow, 'id' | 'status' | 'pushedAt' | 'siblingStateJson'>,
): Promise<FixSiblingFacts> {
  if (row.status !== 'succeeded' || row.pushedAt != null) return NONE;
  const state = readSiblingState(row.siblingStateJson ?? null);
  if (state.length === 0) return NONE;
  try {
    const prIds = [...new Set(state.map((s) => s.prId))];
    const pr = ctx.schema.pullRequests;
    const heads = (await ctx.db
      .select({ id: pr.id, headSha: pr.headSha })
      .from(pr)
      .where(and(eq(pr.accountId, accountId), inArray(pr.id, prIds)))
      .execute()) as Array<{ id: number; headSha: string | null }>;
    const t = ctx.schema.aiFixes;
    const fixes = (await ctx.db
      .select({ id: t.id, prId: t.prId, status: t.status, sessionPhase: t.sessionPhase, pushedAt: t.pushedAt, pushedCommitSha: t.pushedCommitSha, finishedAt: t.finishedAt, hasPatch: sql<number>`${t.patch} IS NOT NULL` })
      .from(t)
      .where(and(eq(t.accountId, accountId), inArray(t.prId, prIds)))
      .execute()) as Array<{ id: number; prId: number; status: string; sessionPhase: string | null; pushedAt: Date | number | null; pushedCommitSha: string | null; finishedAt: Date | number | null; hasPatch: number | boolean | null }>;
    const builtRows = fixes.filter((f) => f.status === 'succeeded' && f.sessionPhase === 'built' && f.pushedAt == null && Boolean(f.hasPatch));
    // The overlaid fixes' patches (to tell a changed one), and what each built fix itself overlaid (to tell a fix
    // built on THIS one): two narrow reads.
    const overlayIds = [...new Set(state.flatMap((s) => (s.overlayFixId != null ? [s.overlayFixId] : [])))];
    const patches = overlayIds.length === 0
      ? []
      : ((await ctx.db.select({ id: t.id, patch: t.patch }).from(t).where(and(eq(t.accountId, accountId), inArray(t.id, overlayIds))).execute()) as Array<{ id: number; patch: string | null }>);
    const builtIds = builtRows.map((f) => f.id);
    const builtStates = builtIds.length === 0
      ? []
      : ((await ctx.db.select({ id: t.id, s: t.siblingStateJson }).from(t).where(and(eq(t.accountId, accountId), inArray(t.id, builtIds))).execute()) as Array<{ id: number; s: unknown }>);
    const now = new Map<number, SiblingNow>();
    for (const id of prIds) {
      const overlayId = state.find((s) => s.prId === id)?.overlayFixId ?? null;
      const o = overlayId != null ? (fixes.find((f) => f.id === overlayId && f.prId === id) ?? null) : null;
      const oPatch = o != null ? (patches.find((p) => p.id === o.id)?.patch ?? null) : null;
      now.set(id, {
        headSha: heads.find((h) => h.id === id)?.headSha ?? null,
        overlay: o
          ? {
              discarded: o.pushedAt == null && (o.sessionPhase === 'discarded' || o.status === 'cancelled' || o.status === 'failed'),
              pushed: o.pushedAt != null,
              pushedCommitSha: o.pushedCommitSha,
              patchHash: oPatch != null ? patchHash(oPatch) : null,
            }
          : null,
        built: builtRows
          .filter((f) => f.prId === id)
          .map((f) => ({
            fixId: f.id,
            finishedAtMs: ms(f.finishedAt),
            buildsOn: readSiblingState(builtStates.find((b) => b.id === f.id)?.s ?? null).flatMap((x) => (x.overlayFixId != null ? [x.overlayFixId] : [])),
          })),
      });
    }
    return { stale: siblingStaleness(state, now, row.id), overlayUnpushed: overlayUnpushed(state, now) };
  } catch {
    return NONE;
  }
}
