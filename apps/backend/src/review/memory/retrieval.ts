import { posix } from 'node:path';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { LearningMatch, StoredPrFile } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

// WS3 retrieval (Pro path). Reads the plugin's own review_learnings (accountId +
// repoId scoped), then aggregates in TS into bounded, confidence-labelled signals.
// Two consumers: the "Matches from past reviews" UI surface (getRelevantLearnings)
// and the prompt-injection provider (buildLearningsContext → the host's
// priorReviewContext slot).

const ROW_CAP = 500; // rows scanned per retrieval
const MATCH_CAP = 12; // aggregated signals returned
const CONTEXT_MATCH_CAP = 10; // signals rendered into the prompt block
const CONTEXT_CHAR_CAP = 2400; // ~600 tokens
const EXAMPLE_CHAR_CAP = 160;

interface LearnRow {
  kind: string;
  category: string | null;
  path: string | null;
  dirPath: string | null;
  ext: string | null;
  claudeVerdict: string | null;
  userVerdict: string | null;
  claudeTitle: string | null;
  claudeText: string | null;
  userText: string | null;
  postedCommentKind: string | null;
  createdAt: Date | number | null;
}

function globFor(row: LearnRow): string {
  if (row.dirPath && row.dirPath !== '.') return `${row.dirPath}/*`;
  if (row.dirPath === '.') return '*';
  if (row.ext) return `*${row.ext}`;
  return row.path ?? '(repo)';
}

function confidenceFor(count: number): 'low' | 'medium' | 'high' {
  if (count >= 7) return 'high';
  if (count >= 3) return 'medium';
  return 'low';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Coerce a stored createdAt (Date on pg, Date/number on sqlite) to ISO-8601.
function rowIso(v: Date | number | null): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  // A bare number is epoch seconds (sqlite mode:'timestamp') unless it's already ms-scale.
  return new Date(v > 1e12 ? v : v * 1000).toISOString();
}

// Render the bounded markdown block from a set of matches. Factored out of
// buildLearningsContext so the "exact context sent to Claude" UI surface shows the
// BYTE-IDENTICAL text that gets injected into the prompt (same cap, same formatting).
export function renderLearningsBlock(matches: LearningMatch[]): string {
  const lines: string[] = [
    '## Reviewer preferences from past reviews (this repo)',
    'Treat as guidance, not rules.',
  ];
  for (const m of matches.slice(0, CONTEXT_MATCH_CAP)) {
    const cat = m.category ? ` · ${m.category}` : '';
    lines.push(`- In \`${m.glob}\`${cat}: ${m.summary} (confidence: ${m.confidence})`);
    if (m.example && (m.example.claude || m.example.you)) {
      if (m.example.claude) lines.push(`  - Claude: "${m.example.claude}"`);
      if (m.example.you) lines.push(`  - You: "${m.example.you}"`);
    }
  }
  const block = lines.join('\n');
  return block.length > CONTEXT_CHAR_CAP ? `${block.slice(0, CONTEXT_CHAR_CAP)}…` : block;
}

export async function getRelevantLearnings(
  ctx: AgentContext,
  args: {
    accountId: number;
    repoId: number;
    changedPaths: string[];
    categories?: string[];
  },
): Promise<LearningMatch[]> {
  const dirs = Array.from(
    new Set(args.changedPaths.map((p) => posix.dirname(p)).filter((d) => d !== '')),
  );
  const exts = Array.from(
    new Set(args.changedPaths.map((p) => posix.extname(p)).filter((e) => e !== '')),
  );
  if (dirs.length === 0 && exts.length === 0) return [];

  const t = ctx.schema.reviewLearnings;
  const pathCond = or(
    dirs.length ? inArray(t.dirPath, dirs) : undefined,
    exts.length ? inArray(t.ext, exts) : undefined,
  );
  const catCond =
    args.categories && args.categories.length
      ? inArray(t.category, args.categories)
      : undefined;

  const rows = (await ctx.db
    .select()
    .from(t)
    .where(
      and(eq(t.accountId, args.accountId), eq(t.repoId, args.repoId), pathCond, catCond),
    )
    .orderBy(desc(t.createdAt))
    .limit(ROW_CAP)
    .execute()) as LearnRow[];

  // Aggregate keyed by (glob, category).
  const groups = new Map<string, { glob: string; category: string | null; rows: LearnRow[] }>();
  for (const row of rows) {
    const glob = globFor(row);
    const key = `${glob}|${row.category ?? ''}`;
    const g = groups.get(key) ?? { glob, category: row.category, rows: [] };
    g.rows.push(row);
    groups.set(key, g);
  }

  const matches: LearningMatch[] = [];
  for (const g of groups.values()) {
    const counts = {
      dismissed: 0,
      kept: 0,
      reworded: 0,
      posted: 0,
      verdict: 0,
      bodyRewritten: 0,
    };
    let rewordExample: LearnRow | undefined;
    let verdictExample: LearnRow | undefined;
    for (const r of g.rows) {
      switch (r.kind) {
        case 'finding_dismissed':
          counts.dismissed += 1;
          break;
        case 'finding_kept':
          counts.kept += 1;
          break;
        case 'finding_reworded':
          counts.reworded += 1;
          rewordExample ??= r;
          break;
        case 'finding_posted':
          counts.posted += 1;
          break;
        case 'verdict_overridden':
          counts.verdict += 1;
          verdictExample ??= r;
          break;
        case 'review_body_rewritten':
          counts.bodyRewritten += 1;
          break;
        default:
          break;
      }
    }

    let kind = g.rows[0]?.kind ?? 'unknown';
    let summary = '';
    let example: LearningMatch['example'];

    if (counts.reworded > 0) {
      kind = 'finding_reworded';
      summary = `You reworded ${counts.reworded} finding${counts.reworded === 1 ? '' : 's'} here.`;
      if (rewordExample)
        example = {
          claude: truncate(rewordExample.claudeText ?? '', EXAMPLE_CHAR_CAP),
          you: truncate(rewordExample.userText ?? '', EXAMPLE_CHAR_CAP),
        };
    } else if (counts.dismissed > 0 && counts.dismissed >= counts.kept) {
      kind = 'finding_dismissed';
      const total = counts.dismissed + counts.kept;
      summary = `You dismissed ${counts.dismissed} of ${total} finding${total === 1 ? '' : 's'} here.`;
    } else if (counts.verdict > 0) {
      kind = 'verdict_overridden';
      summary = `You changed the verdict ${counts.verdict} time${counts.verdict === 1 ? '' : 's'} here.`;
      if (verdictExample)
        example = {
          claude: verdictExample.claudeVerdict,
          you: verdictExample.userVerdict,
        };
    } else if (counts.posted > 0) {
      kind = 'finding_posted';
      summary = `You posted ${counts.posted} finding${counts.posted === 1 ? '' : 's'} here.`;
    } else if (counts.kept > 0) {
      kind = 'finding_kept';
      summary = `You kept ${counts.kept} finding${counts.kept === 1 ? '' : 's'} here.`;
    } else {
      summary = `${g.rows.length} prior review action${g.rows.length === 1 ? '' : 's'} here.`;
    }

    // Provenance breakdown: per-kind counts + when the most recent action landed. Rows are
    // ordered by createdAt DESC globally, so the first row in the group is its latest.
    const kindCounts = new Map<string, number>();
    for (const r of g.rows) kindCounts.set(r.kind, (kindCounts.get(r.kind) ?? 0) + 1);
    const kinds = [...kindCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, count]) => ({ kind: k, count }));

    matches.push({
      glob: g.glob,
      category: g.category,
      kind,
      summary,
      confidence: confidenceFor(g.rows.length),
      example,
      count: g.rows.length,
      lastActionAt: rowIso(g.rows[0]?.createdAt ?? null),
      kinds,
    });
  }

  matches.sort((a, b) => weight(b) - weight(a));
  return matches.slice(0, MATCH_CAP);
}

// Sort signals by confidence bucket then presence of an example.
function weight(m: LearningMatch): number {
  const c = m.confidence === 'high' ? 3 : m.confidence === 'medium' ? 2 : 1;
  return c * 10 + (m.example ? 1 : 0);
}

// Derive the PR's changed paths: prefer the stored `files` JSON on pull_requests;
// fall back to this PR's Claude-finding paths if files aren't available.
async function changedPathsForPr(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<{ repoId: number; changedPaths: string[] } | null> {
  const prT = ctx.schema.pullRequests;
  const prRows = (await ctx.db
    .select()
    .from(prT)
    .where(and(eq(prT.id, prId), eq(prT.accountId, accountId)))
    .limit(1)
    .execute()) as Array<{ id: number; repoId: number; files: StoredPrFile[] | null }>;
  const pr = prRows[0];
  if (!pr) return null;

  let changedPaths = (pr.files ?? []).map((f) => f.path).filter(Boolean);
  if (changedPaths.length === 0) {
    try {
      const crT = ctx.schema.claudeReviews;
      const reviews = (await ctx.db
        .select()
        .from(crT)
        .where(and(eq(crT.accountId, accountId), eq(crT.prId, prId)))
        .execute()) as Array<{ id: number }>;
      const reviewIds = reviews.map((r) => r.id);
      if (reviewIds.length) {
        const fT = ctx.schema.claudeReviewFindings;
        const findings = (await ctx.db
          .select()
          .from(fT)
          .where(inArray(fT.reviewId, reviewIds))
          .execute()) as Array<{ path: string }>;
        changedPaths = Array.from(new Set(findings.map((f) => f.path).filter(Boolean)));
      }
    } catch {
      /* best-effort fallback */
    }
  }
  return { repoId: pr.repoId, changedPaths };
}

// Backs the "Matches from past reviews" UI surface (GET /api/pro/prs/:id/
// review-learnings). Returns null when the PR isn't the caller's (→ 404).
export async function getPrLearningMatches(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<{ repoId: number; matches: LearningMatch[]; contextBlock: string | null } | null> {
  const ctxPaths = await changedPathsForPr(ctx, accountId, prId);
  if (!ctxPaths) return null;
  if (ctxPaths.changedPaths.length === 0)
    return { repoId: ctxPaths.repoId, matches: [], contextBlock: null };
  const matches = await getRelevantLearnings(ctx, {
    accountId,
    repoId: ctxPaths.repoId,
    changedPaths: ctxPaths.changedPaths,
  });
  // The exact block that buildLearningsContext would inject for this PR — so the UI can
  // show precisely what feeds the next run. null when there's nothing to inject.
  const contextBlock = matches.length > 0 ? renderLearningsBlock(matches) : null;
  return { repoId: ctxPaths.repoId, matches, contextBlock };
}

// The injection seam: render a bounded markdown block from this repo's learnings
// matched to the PR's touched paths, or undefined when there's nothing to add (so
// the OSS prompt stays byte-identical).
export async function buildLearningsContext(
  ctx: AgentContext,
  a: { accountId: number; prId: number; headSha: string },
): Promise<string | undefined> {
  try {
    const ctxPaths = await changedPathsForPr(ctx, a.accountId, a.prId);
    if (!ctxPaths || ctxPaths.changedPaths.length === 0) return undefined;
    const matches = await getRelevantLearnings(ctx, {
      accountId: a.accountId,
      repoId: ctxPaths.repoId,
      changedPaths: ctxPaths.changedPaths,
    });
    if (matches.length === 0) return undefined;
    // Reuse the shared renderer so the injected block is byte-identical to what the UI
    // shows via getPrLearningMatches().contextBlock.
    return renderLearningsBlock(matches);
  } catch (err) {
    ctx.log.warn({ err, prId: a.prId }, 'buildLearningsContext failed');
    return undefined;
  }
}
