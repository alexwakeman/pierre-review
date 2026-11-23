// THE DEMO'S AI VENDOR SIGNALS (Reports → Download report; docs/AI-ADOPTION-REPORT.md § Detection).
//
// The seed writes PRs and commits directly, never through persistPr, so nothing has scanned them.
// This stamps every seeded PR as scanned at the current detector version and gives a realistic mix
// of AI involvement, so the adoption slides have something to draw:
//
//   • Each PERSON has a tool habit (Claude, Copilot, Cursor, Codex, Devin, a pair of tools, or none),
//     fixed by their user id, so "How widely AI is used" shows different counts on different tools.
//   • Adoption RISES over the last twelve weeks (about one PR in eight at the start, about half at
//     the end), so the trend slide and the before/after comparison move.
//   • The verdicts are the REAL DETECTOR's (`detectAiPrSignals` / `detectAiCommitSignals`), run on the
//     raw text each tool writes: a `Co-Authored-By: Claude <noreply@anthropic.com>` trailer, a
//     `cursor[bot]` commit author, "Generated with Claude Code" in a description, a Codex task URL, a
//     `codex/` branch beside its task URL… As at sync time, only the verdict is stored, never the text (lean storage).
//     The branch and title markers are written to the PR too, so what the app shows agrees.
//     Bot-authored PRs are scanned clean.
//   • Every other PR is scanned clean (`[]`), never left NULL: NULL would read "not scanned".
//
// Deterministic (hashed from ids), so two seeds produce the same data. Fictional.
import { and, eq, inArray } from 'drizzle-orm';
import {
  AI_SIGNALS_VERSION,
  detectAiCommitSignals,
  detectAiPrSignals,
  mergeAiSignals,
  serializeAiSignals,
  type AiCodingVendor,
  type AiCommitSignalInput,
  type AiPrSignalInput,
  type AiSignal,
} from '@pierre-review/shared';

const DAY = 86_400_000;

export interface AiSignalsSeedCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  now: Date;
}

/** A stable 0 ≤ x < 1 from integers (a small integer hash; no state). */
function unit(...xs: number[]): number {
  let h = 0x811c9dc5;
  for (const x of xs) {
    h ^= x >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995) >>> 0;
  }
  return (h >>> 0) / 2 ** 32;
}

/** The tool habits a person can have. `[]` = does not use an AI coding tool (that the PR shows). */
const HABITS: readonly (readonly AiCodingVendor[])[] = [
  ['claude'],
  ['copilot'],
  ['claude', 'cursor'],
  ['codex'],
  [],
  ['copilot', 'claude'],
  ['cursor'],
  ['devin', 'claude'],
  [],
  ['claude', 'codex'],
];

/** A short slug from a PR title, for a tool's default branch name. */
function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'change'
  );
}

/** What a tool leaves on a PR and its first commit: the raw text the detector reads at sync time. */
interface Footprint {
  pr: AiPrSignalInput;
  commit: AiCommitSignalInput | null;
}

/**
 * Each tool's footprints, as the tools write them (docs/AI-ADOPTION-REPORT.md § Detection; the
 * detector's fixtures in apps/backend/src/sync/__fixtures__/ai-vendors/).
 */
const FOOTPRINTS: Readonly<Record<string, ((title: string, branch: string, id: number) => Footprint)[]>> = {
  claude: [
    // Claude Code's footer in the description and the commit, plus its co-author trailer.
    (title, branch) => ({
      pr: { title, headRefName: branch, bodyText: `Summary of the change.\n\n🤖 Generated with Claude Code` },
      commit: { message: `${title}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>` },
    }),
    // The co-author trailer alone.
    (title, branch) => ({ pr: { title, headRefName: branch }, commit: { message: `${title}\n\nCo-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>` } }),
    // Claude Code on the web: its claude/ branch, commits authored by the Claude app.
    (title, _branch, id) => ({
      pr: { title, headRefName: `claude/${slug(title)}-${id}` },
      commit: { message: title, authorLogin: 'claude[bot]', authorName: 'Claude', authorEmail: '209825114+claude[bot]@users.noreply.github.com' },
    }),
  ],
  copilot: [
    // An applied Copilot suggestion: GitHub's own co-author line.
    (title, branch) => ({ pr: { title, headRefName: branch }, commit: { message: `${title}\n\nCo-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>` } }),
    // The coding agent: a copilot/ branch and commits by copilot-swe-agent[bot].
    (title, _branch, id) => ({
      pr: { title, headRefName: `copilot/${slug(title)}-${id}` },
      commit: { message: title, authorLogin: 'copilot-swe-agent[bot]', authorName: 'copilot-swe-agent[bot]', authorEmail: '198982749+Copilot@users.noreply.github.com' },
    }),
  ],
  cursor: [
    (title, branch) => ({ pr: { title, headRefName: branch }, commit: { message: `${title}\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>` } }),
    (title, branch) => ({ pr: { title, headRefName: branch }, commit: { message: title, authorLogin: 'cursor[bot]', authorName: 'Cursor Agent', authorEmail: 'cursoragent@cursor.com' } }),
  ],
  codex: [
    // Codex cloud: its codex/ branch and the task link in the description.
    (title, _branch, id) => ({
      pr: { title, headRefName: `codex/${slug(title)}`, bodyText: `Summary\n\nTesting\n\nhttps://chatgpt.com/codex/tasks/task_e_${(id * 2654435761 >>> 0).toString(16)}` },
      commit: null,
    }),
    // Codex CLI: its co-author trailer on a person's commit.
    (title, branch) => ({ pr: { title, headRefName: branch }, commit: { message: `${title}\n\nCo-authored-by: Codex <noreply@openai.com>` } }),
  ],
  devin: [
    (title, branch, id) => ({
      pr: { title, headRefName: branch, bodyText: `Link to Devin run: https://app.devin.ai/sessions/${(id * 40503 >>> 0).toString(16)}` },
      commit: { message: title, authorLogin: 'devin-ai-integration[bot]', authorName: 'Devin AI', authorEmail: '158243242+devin-ai-integration[bot]@users.noreply.github.com' },
    }),
  ],
};

export async function seedDemoAiSignals(ctx: AiSignalsSeedCtx): Promise<{ scanned: number; withAi: number; commits: number }> {
  const { db, schema, now } = ctx;
  const { pullRequests, commits, users } = schema;
  const checkedAt = new Date(now.getTime() - 2 * DAY);
  const bots = new Set<number>(
    (await db.select({ id: users.id }).from(users).where(eq(users.isBot, true)).execute()).map((r: { id: number }) => r.id),
  );
  const prs: { id: number; authorId: number | null; openedAt: Date; title: string; headRefName: string | null }[] = await db
    .select({ id: pullRequests.id, authorId: pullRequests.authorId, openedAt: pullRequests.openedAt, title: pullRequests.title, headRefName: pullRequests.headRefName })
    .from(pullRequests)
    .where(eq(pullRequests.accountId, 1))
    .execute();
  const commitRows: { id: number; prId: number }[] = prs.length
    ? await db
        .select({ id: commits.id, prId: commits.prId })
        .from(commits)
        .where(inArray(commits.prId, prs.map((p) => p.id)))
        .execute()
    : [];
  const commitsByPr = new Map<number, number[]>();
  for (const c of commitRows) commitsByPr.set(c.prId, [...(commitsByPr.get(c.prId) ?? []), c.id]);
  for (const list of commitsByPr.values()) list.sort((a, b) => a - b);

  // Every commit of a seeded PR is scanned clean first; the AI ones are overwritten below.
  if (commitRows.length) await db.update(commits).set({ aiSignals: '[]' }).where(inArray(commits.id, commitRows.map((c) => c.id))).execute();

  const windowStart = now.getTime() - 84 * DAY;
  let withAi = 0;
  let commitWrites = 0;
  for (const pr of prs) {
    let prSignals: AiSignal[] = [];
    let commitSignals: AiSignal[] = [];
    let title = pr.title;
    let branch = pr.headRefName;
    if (pr.authorId != null && !bots.has(pr.authorId)) {
      const habit = HABITS[pr.authorId % HABITS.length]!;
      const t = Math.min(1, Math.max(0, (new Date(pr.openedAt).getTime() - windowStart) / (84 * DAY)));
      if (habit.length > 0 && unit(pr.id, 1) < 0.12 + 0.4 * t) {
        const vendor = habit[Math.floor(unit(pr.id, 2) * habit.length)]!;
        const options = FOOTPRINTS[vendor]!;
        const print = options[Math.floor(unit(pr.id, 3) * options.length)]!(pr.title, pr.headRefName ?? `feature/${slug(pr.title)}`, pr.id);
        // The real detector, on the raw text; only its verdicts are kept.
        prSignals = detectAiPrSignals(print.pr);
        commitSignals = print.commit == null ? [] : detectAiCommitSignals(print.commit);
        title = print.pr.title ?? pr.title;
        branch = print.pr.headRefName ?? pr.headRefName;
        if (prSignals.length + commitSignals.length === 0) throw new Error(`seed: the detector found nothing in the ${vendor} footprint`);
        withAi += 1;
      }
    }
    const first = commitsByPr.get(pr.id)?.[0];
    // No stored commit to carry the commit-side verdict: it stays on the PR, as its source says.
    if (commitSignals.length > 0 && first == null) {
      prSignals = mergeAiSignals(prSignals, commitSignals);
      commitSignals = [];
    }
    await db
      .update(pullRequests)
      .set({ title, headRefName: branch, aiSignals: serializeAiSignals(prSignals), aiSignalsVersion: AI_SIGNALS_VERSION, aiSignalsCheckedAt: checkedAt })
      .where(and(eq(pullRequests.id, pr.id), eq(pullRequests.accountId, 1)))
      .execute();
    if (commitSignals.length > 0 && first != null) {
      await db.update(commits).set({ aiSignals: serializeAiSignals(commitSignals) }).where(eq(commits.id, first)).execute();
      commitWrites += 1;
    }
  }
  return { scanned: prs.length, withAi, commits: commitWrites };
}
