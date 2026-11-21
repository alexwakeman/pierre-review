import { createHash } from 'node:crypto';
import { and, eq, isNull, notInArray } from 'drizzle-orm';
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

// ── POSTING THE SCREENSHOTS TO THE TICKET (tracker/ticket-screens.ts; one reader's press) ───────────────────────

/** The shots a ticket post carries, in screen order, once each: Ensemble's own file names. Pure. */
export function ticketShotsOf(buildId: number, screens: readonly StoryBuildScreen[], max: number): Array<{ sha: string; name: string; screen: number }> {
  const out: Array<{ sha: string; name: string; screen: number }> = [];
  for (const [i, s] of screens.entries()) {
    for (const shot of s.shots) {
      if (out.length >= max) return out;
      if (out.some((o) => o.sha === shot.sha)) continue;
      out.push({ sha: shot.sha, name: `ensemble-${buildId}-${out.length + 1}.png`, screen: i });
    }
  }
  return out;
}

/** The agent's words, safe in Jira wiki markup: one line, no markup or mention characters, capped. Pure. */
export function wikiPlain(s: string, max = 300): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[[\]{}!|~^*_+#\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const VERDICT_WIKI: Record<StoryBuildScreen['verdict'], string> = { matches: 'matches', differs: 'differs', no_design: 'had no design to compare' };

/**
 * THE ONE COMMENT (Jira wiki): a heading, one line saying these are the agent's own words, then per screen its
 * name, the agent's verdict, what it compared with and its note, then its pictures inline. `names[k]` is the k-th
 * shot's name as Jira stored it (null: leave it out). Pure.
 */
export function screensTicketComment(o: { ticketKey: string; screens: readonly StoryBuildScreen[]; shots: ReadonlyArray<{ screen: number }>; names: ReadonlyArray<string | null> }): string {
  const lines = [`h4. Screenshots from Ensemble's build of ${wikiPlain(o.ticketKey, 40)}`, '', 'The agent took these while it built the change, and compared each screen itself. The verdicts are its own.', ''];
  for (const [i, s] of o.screens.entries()) {
    const pics = o.shots.map((sh, k) => (sh.screen === i ? o.names[k] : null)).filter((n): n is string => n != null);
    if (pics.length === 0) continue;
    const compared = s.comparedWith ? `, compared with ${wikiPlain(s.comparedWith, 200)}` : '';
    lines.push(`*${wikiPlain(s.name, 120)}*: the agent says it ${VERDICT_WIKI[s.verdict]}${compared}.`);
    if (s.note) lines.push(wikiPlain(s.note, 600));
    lines.push(pics.map((n) => `!${n}|thumbnail!`).join(' '), '');
  }
  return lines.join('\n').trim();
}

export interface PostScreensDeps {
  /** The tracker write (tracker/ticket-screens.ts with the tracker runtime's context). */
  post(a: { accountId: number; workspaceId: number; ident: string; shots: Array<{ name: string; png: Buffer }>; comment: (names: Array<string | null>) => string }): Promise<import('../../tracker/ticket-screens.js').PostScreensResult>;
  now(): number;
}

export const defaultPostScreensDeps: PostScreensDeps = {
  async post(a) {
    const [{ trackerContext }, { postTicketScreenshots }] = await Promise.all([import('../../tracker/runtime.js'), import('../../tracker/ticket-screens.js')]);
    return postTicketScreenshots(trackerContext(), a);
  },
  now: () => Date.now(),
};

export type PostScreensOutcome =
  | { status: 200; screensTicket: import('@pierre-review/shared').StoryBuildScreensTicket }
  | { status: 404 | 409 | 400 | 502 | number; error: string; message: string };

/**
 * "Post screenshots to the ticket" — THE READER'S ONE PRESS (docs/TRACKERS.md § The build's screenshots). CLAIMED
 * (compare-and-set from NULL) before the first Jira write. A failure before anything was written releases the
 * claim (the reader may press again); after, it is recorded and NEVER retried.
 */
export async function postBuildScreensToTicket(ctx: Ctx, accountId: number, buildId: number, deps: PostScreensDeps = defaultPostScreensDeps): Promise<PostScreensOutcome> {
  const { builds: b } = T(ctx);
  const [row] = (await ctx.db.select().from(b).where(and(eq(b.id, buildId), eq(b.accountId, accountId))).limit(1).execute()) as Array<{
    id: number;
    workspaceId: number;
    ident: string;
    ticketKey: string;
    screensJson: StoryBuildScreen[] | null;
    screensTicketJson: import('@pierre-review/shared').StoryBuildScreensTicketState | null;
  }>;
  if (row == null) return { status: 404, error: 'NotFound', message: 'Not found' };
  const screens = row.screensJson ?? [];
  const { TICKET_SHOTS_MAX } = await import('../../tracker/ticket-screens.js');
  const picked = ticketShotsOf(row.id, screens, TICKET_SHOTS_MAX);
  if (!row.ident.startsWith('jira:')) return { status: 400, error: 'NotJira', message: 'Posting screenshots to the ticket works with Jira only.' };
  if (picked.length === 0) return { status: 400, error: 'NoScreenshots', message: 'This build has no screenshots to post.' };
  const files: Array<{ name: string; png: Buffer }> = [];
  for (const p of picked) {
    const png = await readBuildShot(ctx, accountId, buildId, p.sha);
    if (png != null && isPng(png)) files.push({ name: p.name, png });
  }
  if (files.length === 0) return { status: 400, error: 'NoScreenshots', message: 'This build has no screenshots to post.' };
  // THE CLAIM: only one press ever writes.
  const claimedAt = new Date(deps.now()).toISOString();
  const won = (await ctx.db
    .update(b)
    .set({ screensTicketJson: { claimedAt } })
    .where(and(eq(b.id, buildId), eq(b.accountId, accountId), isNull(b.screensTicketJson)))
    .returning({ id: b.id })
    .execute()) as Array<{ id: number }>;
  if (won.length === 0) return { status: 409, error: 'AlreadyPosted', message: 'The screenshots of this build were already sent to the ticket.' };
  const kept = picked.filter((p) => files.some((f) => f.name === p.name));
  const r = await deps.post({
    accountId,
    workspaceId: row.workspaceId,
    ident: row.ident,
    shots: files,
    comment: (names) => screensTicketComment({ ticketKey: row.ticketKey, screens, shots: kept, names }),
  });
  const state: import('@pierre-review/shared').StoryBuildScreensTicketState | null = r.ok
    ? { claimedAt, postedAt: new Date(deps.now()).toISOString(), attachments: r.attachments }
    : r.wrote
      ? { claimedAt, error: r.message }
      : null;
  await ctx.db.update(b).set({ screensTicketJson: state }).where(and(eq(b.id, buildId), eq(b.accountId, accountId))).execute();
  if (!r.ok) return { status: r.status, error: r.error, message: r.wrote ? `${r.message} Some screenshots may be on the ticket already, so Ensemble will not try again.` : r.message };
  const { screensTicketOf } = await import('./persist.js');
  return { status: 200, screensTicket: screensTicketOf({ ident: row.ident, screensJson: screens, screensTicketJson: state }) };
}
