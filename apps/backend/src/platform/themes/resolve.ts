import { and, eq, inArray } from 'drizzle-orm';
import type { BotTheme, ThemePrRef, ThemeThreadRef } from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import type { ParsedTheme } from '../bot-themes/prompt.js';

// Shared post-LLM resolver for BOTH theme summaries (bot + human). The model returns each theme
// with `memberIds` (the payload cluster/comment ids it grouped) + `examplePrNumbers`; this expands
// those into the final wire `BotTheme` — concrete `threads` (deduped, capped, for the drill-down)
// and clickable `prs` (with PR title + author fetched once). Fully account-scoped.

const THREADS_PER_THEME = 30; // concrete member threads surfaced in the drill-down
const PRS_PER_THEME = 8;

const threadKey = (r: ThemeThreadRef): string =>
  r.source === 'review' ? `t${r.threadId ?? 'x'}` : `c${r.commentId ?? 'x'}`;

export async function resolveThemeRefs(
  ctx: ProContext,
  accountId: number,
  themes: ParsedTheme[],
  memberIndex: Map<number, ThemeThreadRef[]>,
): Promise<BotTheme[]> {
  // Global prNumber → a representative ref, for the examplePrNumbers fallback when memberIds are
  // missing. An ambiguous number (same number in two repos) resolves to the first seen.
  const prByNumber = new Map<number, ThemeThreadRef>();
  for (const refs of memberIndex.values()) {
    for (const r of refs) if (!prByNumber.has(r.prNumber)) prByNumber.set(r.prNumber, r);
  }

  // Per theme: gather deduped member threads + the distinct PRs (examplePrNumbers first, then member
  // order). Members come from the model's memberIds; a theme with none still gets PRs from the
  // examplePrNumbers fallback so its chips stay clickable.
  const perTheme = themes.map((t) => {
    const seen = new Set<string>();
    const threads: ThemeThreadRef[] = [];
    for (const id of t.memberIds) {
      for (const r of memberIndex.get(id) ?? []) {
        const k = threadKey(r);
        if (seen.has(k)) continue;
        seen.add(k);
        threads.push(r);
        if (threads.length >= THREADS_PER_THEME) break;
      }
      if (threads.length >= THREADS_PER_THEME) break;
    }
    const prOrder: ThemeThreadRef[] = [];
    const prSeen = new Set<number>();
    const pushPr = (r: ThemeThreadRef | undefined): void => {
      if (r && !prSeen.has(r.prId)) {
        prSeen.add(r.prId);
        prOrder.push(r);
      }
    };
    for (const n of t.examplePrNumbers) pushPr(prByNumber.get(n));
    for (const r of threads) pushPr(r);
    return { t, threads, prRefs: prOrder.slice(0, PRS_PER_THEME) };
  });

  // Fetch title + author login for every involved PR in one account-scoped query.
  const allPrIds = [...new Set(perTheme.flatMap((p) => p.prRefs.map((r) => r.prId)))];
  const titleById = new Map<number, string | null>();
  const authorById = new Map<number, string | null>();
  if (allPrIds.length > 0) {
    const prT = ctx.schema.pullRequests;
    const usersT = ctx.schema.users;
    const rows = (await ctx.db
      .select({ id: prT.id, title: prT.title, authorLogin: usersT.githubLogin })
      .from(prT)
      .leftJoin(usersT, eq(usersT.id, prT.authorId))
      .where(and(eq(prT.accountId, accountId), inArray(prT.id, allPrIds)))
      .execute()) as Array<{ id: number; title: string | null; authorLogin: string | null }>;
    for (const r of rows) {
      titleById.set(r.id, r.title ?? null);
      authorById.set(r.id, r.authorLogin ?? null);
    }
  }

  return perTheme.map(({ t, threads, prRefs }) => {
    const prs: ThemePrRef[] = prRefs.map((r) => ({
      prId: r.prId,
      prNumber: r.prNumber,
      repoFullName: r.repoFullName,
      title: titleById.get(r.prId) ?? null,
      authorLogin: authorById.get(r.prId) ?? null,
    }));
    return {
      title: t.title,
      category: t.category,
      severity: t.severity,
      summary: t.summary,
      occurrences: t.occurrences,
      bots: t.bots,
      areas: t.areas,
      prs,
      threads,
    };
  });
}
