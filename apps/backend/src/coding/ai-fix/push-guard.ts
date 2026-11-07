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
