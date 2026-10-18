// WHICH SPRINT PASSES ARE RUNNING RIGHT NOW — the in-memory flag the sprint graph reads for its status
// line (`SprintGraphResponse.passes`). The brief pass and the theme pass (review/sprint-briefs/,
// review/sprint-themes/) set it around their work; the builder keeps its own (db/sprint-paths.ts
// `isSprintPathsRunning`). Process-local, like every pass's own claim: a restart clears it, and a pass
// that is not running is simply not running. Never a database read, never a GitHub or model call.

export type SprintPassKind = 'briefs' | 'themes';

const flights = new Set<string>();
const keyOf = (kind: SprintPassKind, accountId: number, workspaceId: number): string =>
  `${kind}:${accountId}:${workspaceId}`;

export function setSprintPassRunning(kind: SprintPassKind, accountId: number, workspaceId: number, on: boolean): void {
  const k = keyOf(kind, accountId, workspaceId);
  if (on) flights.add(k);
  else flights.delete(k);
}

export function isSprintPassRunning(kind: SprintPassKind, accountId: number, workspaceId: number): boolean {
  return flights.has(keyOf(kind, accountId, workspaceId));
}

/** Test seam. */
export function _resetSprintPassFlights(): void {
  flights.clear();
}
