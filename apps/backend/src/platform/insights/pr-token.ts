// Atomic `owner/name#N` PR-reference token + per-repo grouping for the Haiku prompt builders
// (chat / sprint / preset). The problem this solves: when a PR is fed to the model as two
// SEPARATE fields (`repo` + `pr`) inside a long, cross-repo, recency-interleaved list, the model has
// to re-pair them itself and can grab a number from one repo while emitting a neighbouring repo's
// name (the observed bevyengine/bevy#33485 → mrdoob/three.js cross-attribution). Handing it ONE
// pre-joined token per PR to copy verbatim — and, where it helps, grouping the list under explicit
// per-repo keys — removes that associative load. Keep in lockstep with the pr-refs.ts regex, which
// parses exactly this `owner/name#N` shape back out of the model's answer.
export const prToken = (repoFullName: string, prNumber: number): string =>
  `${repoFullName}#${prNumber}`;

// Group items under their repo full-name into an insertion-ordered record, so a payload can carry an
// explicit per-repo section (one unambiguous header per project) instead of a flat interleaved list.
// Repos appear in first-seen order — callers pre-sort `items` so the ordering is meaningful
// (e.g. newest-merge-first ⇒ most-recently-active repo first).
export function groupByRepo<T>(items: T[], repoOf: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const it of items) {
    const repo = repoOf(it) || 'unknown';
    (out[repo] ??= []).push(it);
  }
  return out;
}
