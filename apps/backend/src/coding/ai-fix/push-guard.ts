// A fix being pushed (push.ts), set SYNCHRONOUSLY at the push's start: the fix session refuses a message,
// Start fix and Discard meanwhile (sandbox/session/fix.ts `busyReason`), and a second push is refused.
const pushing = new Set<number>();

export function isFixPushing(fixId: number): boolean {
  return pushing.has(fixId);
}

/** Take the push slot of a fix. false ⇒ a push of it runs. */
export function beginFixPush(fixId: number): boolean {
  if (pushing.has(fixId)) return false;
  pushing.add(fixId);
  return true;
}

export function endFixPush(fixId: number): void {
  pushing.delete(fixId);
}

// AN AUTOMATIC PUSH ON ITS WAY ("Push when done", "Push automatically"; sandbox/session/fix.ts): set when a build
// turn ends in a close that will push, cleared once that push settles (pushed, failed or skipped). It covers the
// close itself (the sandbox teardown) and the reads before `beginFixPush`, so the AI Fix tab says "Pushing to
// <branch>…" instead of offering Push for a moment. In memory: a restart reads as not pushing, and the push guards
// (already pushed, HEAD_MOVED) keep a press safe.
const pending = new Set<number>();

export function notePushPending(fixId: number): void {
  pending.add(fixId);
}

export function clearPushPending(fixId: number): void {
  pending.delete(fixId);
}

/** The wire's `AiFix.pushing`: a push runs now, or an automatic one is on its way. */
export function fixPushInFlight(fixId: number): boolean {
  return pushing.has(fixId) || pending.has(fixId);
}
