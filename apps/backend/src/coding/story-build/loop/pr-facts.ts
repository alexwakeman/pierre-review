// THE PULL REQUEST THE LOOP OPENS (docs/STORY-BUILD.md § The review loop → Opening the pull request): the
// SAME title, base and body as the Push button's (push.ts / push-stack.ts builders), plus the loop's
// `## Review in Limn` section. A repository target: `KEY: title`, the build's base (or the reader's own open
// ticket PR it stacks on); a planned PR: `KEY (n/m): title`, PR 1 on the base, PR k ≥ 2 on the PR before it.
import type { AgentContext } from '../../../review/agent-context.js';
import type { StoryBuildRow } from '../persist.js';
import { closesFor, coveredBy, firstPrBase, storyBuildPrBody, storyBuildPrTitle, storyBuildStackTitle } from '../push.js';
import { approvedRevision, decisionsFor } from '../push-stack.js';
import type { LoopTarget } from './targets.js';

export type PrOpenFacts = { ok: true; prBase: string; title: string; body: string } | { ok: false; code: string; message: string };

export async function prOpenFacts(
  ctx: AgentContext,
  accountId: number,
  build: StoryBuildRow,
  t: LoopTarget,
  all: readonly LoopTarget[],
  review: string | null,
): Promise<PrOpenFacts> {
  const ticketTitle = build.ticketTitle ?? build.seedJson?.story.title ?? null;
  const ticketUrl = build.seedJson?.story.url ?? null;
  if (t.kind === 'repo') {
    if (!t.repoRow) return { ok: false, code: 'NotFound', message: 'This repository is not part of the build.' };
    const first = await firstPrBase(ctx, accountId, t.repoRow, t.owner, t.name);
    if (!first.ok) return { ok: false, code: first.code, message: first.message };
    const title = storyBuildPrTitle(build.ticketKey, ticketTitle, t.commitMessage);
    const siblings = all
      .filter((x) => x.kind === 'repo' && x.id !== t.id && x.pushedPrNumber != null)
      .map((x) => ({ fullName: x.fullName, number: x.pushedPrNumber!, url: x.pushedPrUrl }));
    const body = storyBuildPrBody({
      summary: t.summary,
      ticketKey: build.ticketKey,
      ticketTitle,
      ticketUrl,
      covers: coveredBy(build, t.repoRow),
      siblings,
      stackedOnPrNumber: first.stackedNumber,
      closes: closesFor(build, all.filter((x) => x.kind === 'repo').length),
      review,
    });
    return { ok: true, prBase: first.prBase, title, body };
  }
  // A planned PR.
  let prBase: string;
  let stackedNumber: number | null = null;
  const prev = t.prevId != null ? all.find((x) => x.kind === 'pr' && x.id === t.prevId) ?? null : null;
  if (prev) {
    if (!prev.loopBranch) return { ok: false, code: 'STACK_PREVIOUS_NOT_PUSHED', message: `Push ${prev.key ?? 'the pull request before it'} first.` };
    prBase = prev.loopBranch;
  } else {
    if (!t.repoRow) return { ok: false, code: 'NotFound', message: 'This repository is not part of the build.' };
    const first = await firstPrBase(ctx, accountId, t.repoRow, t.owner, t.name);
    if (!first.ok) return { ok: false, code: first.code, message: first.message };
    prBase = first.prBase;
    stackedNumber = first.stackedNumber;
  }
  const parts = all.filter((x) => x.kind === 'pr');
  const total = parts.length;
  const position = parts.findIndex((x) => x.id === t.id) + 1;
  const title = total > 1 ? storyBuildStackTitle(build.ticketKey, position, total, t.title ?? '') : storyBuildPrTitle(build.ticketKey, ticketTitle, t.commitMessage);
  const approved = await approvedRevision(ctx, accountId, build).catch(() => null);
  const criteriaText = new Map((approved?.rev.criteria ?? []).map((c) => [c.ref, c.text || c.how]));
  const prCriteria = t.prRow?.criteriaJson ?? [];
  const covers = prCriteria.map((ref) => ({ ref, text: criteriaText.get(ref) ?? '' })).filter((c) => c.text !== '');
  const body = storyBuildPrBody({
    summary: t.summary,
    ticketKey: build.ticketKey,
    ticketTitle,
    ticketUrl,
    covers,
    siblings: [],
    stackedOnPrNumber: stackedNumber,
    closes: parts.at(-1)?.id === t.id ? closesFor(build, new Set(parts.map((x) => x.repoId)).size) : null,
    stack: {
      position,
      total,
      parts: parts.map((x) => ({ fullName: x.fullName, title: x.title ?? '', number: x.pushedPrNumber, url: x.pushedPrUrl, self: x.id === t.id })),
      buildsOnNumber: prev?.pushedPrNumber ?? null,
    },
    decisions: approved ? decisionsFor(approved.rev, approved.decisions, prCriteria) : [],
    review,
  });
  return { ok: true, prBase, title, body };
}
