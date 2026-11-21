import { createHash } from 'node:crypto';
import { and, eq, notInArray } from 'drizzle-orm';
import type { StoryBuildScreen } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { BROWSER_SHOTS_DIR, type BuildReportScreen } from '../../sandbox/workspace/build-report.js';

// THE BUILD REPORT'S SCREENS, OUT OF THE SANDBOX (docs/SANDBOX.md § The browser → Screens in the build report;
// docs/IMPLEMENT-UI-PLAN.md § 8). ⚠ A NEW WAY OUT of the sandbox, so it is narrow:
//
//   • only the paths a VALID build report names, and only under the agent's `~/.limn/browser/` (the validator
//     and this module both check);
//   • each file read with a byte cap, and kept only when its first bytes are the PNG signature;
//   • per build at most SHOTS_MAX screenshots and SHOTS_MAX_BYTES in all (the newest report replaces the last);
//   • stored as bytes in `story_build_shots` (never a path), served by one route on a click.
//
// The screens themselves are a SELF-REPORT (the agent's verdict), shown as such.

export const SHOT_MAX_BYTES = 5 * 1024 * 1024;
export const SHOTS_MAX = 24;
export const SHOTS_MAX_BYTES = 30 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const isPng = (b: Buffer): boolean => b.length > PNG_SIGNATURE.length && b.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);

/** A shot path the report may name. Pure. */
export function shotPathAllowed(p: string): boolean {
  return p.startsWith(BROWSER_SHOTS_DIR) && p.length <= 300 && /^[A-Za-z0-9._/-]+\.png$/.test(p) && !p.split('/').includes('..');
}

type Ctx = Pick<AgentContext, 'db' | 'schema'> & Partial<Pick<AgentContext, 'runTransaction'>>;
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const T = (ctx: Pick<AgentContext, 'schema'>): { shots: any; builds: any } => ({ shots: (ctx.schema as any).storyBuildShots, builds: (ctx.schema as any).storyBuilds });

export interface StoreScreensResult {
  screens: StoryBuildScreen[];
  /** Screenshots left out (not found, not a PNG, too large, past the caps). */
  skipped: number;
}

/**
 * Read the shots the report names (`read`: the sandbox file, or null), then replace the build's screens and
 * shots. The reads (network to the container) are ALL done before the one DB transaction.
 */
export async function storeBuildScreens(
  ctx: Ctx,
  o: { accountId: number; buildId: number; screens: readonly BuildReportScreen[]; read: (path: string) => Promise<Buffer | null> },
): Promise<StoreScreensResult> {
  const bytesByPath = new Map<string, { sha: string; bytes: Buffer } | null>();
  let total = 0;
  let skipped = 0;
  for (const s of o.screens) {
    for (const p of s.shots) {
      if (bytesByPath.has(p)) continue;
      if (!shotPathAllowed(p) || bytesByPath.size >= SHOTS_MAX) {
        bytesByPath.set(p, null);
        skipped += 1;
        continue;
      }
      const b = await o.read(p).catch(() => null);
      if (b == null || !isPng(b) || b.length > SHOT_MAX_BYTES || total + b.length > SHOTS_MAX_BYTES) {
        bytesByPath.set(p, null);
        skipped += 1;
        continue;
      }
      total += b.length;
      bytesByPath.set(p, { sha: createHash('sha256').update(b).digest('hex'), bytes: b });
    }
  }
  const screens: StoryBuildScreen[] = o.screens.map((s) => {
    const shots: StoryBuildScreen['shots'] = [];
    for (const p of s.shots) {
      const got = bytesByPath.get(p);
      if (got && !shots.some((x) => x.sha === got.sha)) shots.push({ sha: got.sha, name: p.slice(p.lastIndexOf('/') + 1), bytes: got.bytes.length });
    }
    return {
      name: s.name.trim(),
      url: s.url?.trim() || null,
      comparedWith: s.comparedWith?.trim() || null,
      verdict: s.verdict,
      note: s.note.trim(),
      shots,
    };
  });
  const keep = new Map<string, Buffer>();
  for (const v of bytesByPath.values()) if (v) keep.set(v.sha, v.bytes);
  const { shots: t, builds: b } = T(ctx);
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const write = async (dbx: any): Promise<void> => {
    const shas = [...keep.keys()];
    await dbx
      .delete(t)
      .where(and(eq(t.accountId, o.accountId), eq(t.buildId, o.buildId), ...(shas.length > 0 ? [notInArray(t.sha256, shas)] : [])))
      .execute();
    for (const [sha, png] of keep) {
      await dbx.insert(t).values({ accountId: o.accountId, buildId: o.buildId, sha256: sha, png, bytes: png.length }).onConflictDoNothing().execute();
    }
    await dbx
      .update(b)
      .set({ screensJson: screens })
      .where(and(eq(b.id, o.buildId), eq(b.accountId, o.accountId)))
      .execute();
  };
  if (ctx.runTransaction) await ctx.runTransaction((tx) => write(tx));
  else await write(ctx.db);
  return { screens, skipped };
}

/** One stored screenshot (the account's own build), or null. */
export async function readBuildShot(ctx: Ctx, accountId: number, buildId: number, sha: string): Promise<Buffer | null> {
  if (!/^[0-9a-f]{64}$/.test(sha)) return null;
  const { shots: t } = T(ctx);
  const rows = (await ctx.db
    .select({ png: t.png })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.buildId, buildId), eq(t.sha256, sha)))
    .limit(1)
    .execute()) as Array<{ png: Buffer }>;
  return rows[0]?.png ?? null;
}
