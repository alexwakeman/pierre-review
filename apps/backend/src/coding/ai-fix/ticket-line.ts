// THE PER-TICKET LINE (docs/CLAUDE-REVIEW.md § AI Fix → The fix start queue, "One ticket at a time"). A fix READS
// the other open PRs of its ticket at their heads (sandbox/session/fix.ts `bases`): those in ANOTHER repository the
// fix loads (`lineSiblingPrIds`: the same repository set rules). While a fix of one of THOSE PRs runs — from its
// start's check through its boot, its agent turns and its own review loop — this fix does not start: it WAITS in
// the fix start queue (start-queue.ts), so it never works from that PR's old head. A same-repository sibling, or
// one whose repository the fix does not load, never blocks. The line is released the moment the holder stops
// running (built with its review loop ended, a Plan first's plan turn started, failed, stopped, discarded,
// pushed); the waiting fix then reads the holder's built, unpushed fix laid on its head (the overlay).
//
//   • CHECK AND HOLD IN ONE TICK (`tryHoldTicketLine`), after the async sibling lookup: two starts of one ticket
//     at the same time never block each other — the first holds, the second waits.
//   • A HOLD IS A TOKEN: a start's bail releases ITS token only; the session releases by its fix id only once
//     the id is bound (`bindTicketLineFix`), so an older session of the PR never releases a newer start's hold.
//   • IN MEMORY, keyed by the PR (one fix per PR: fix.ts `claimFixPr`). A restart drops it with the sessions.
//   • Dependency automation's narrow fixes neither wait nor hold. A reader's "Start now" holds without waiting.
//   • A Plan first's BUILD (Start fix) takes the line again (manager.ts `approvePlan`); a reader's follow-up turn
//     in a built manual session does not (a sibling's fix built meanwhile is flagged stale on read).

interface Holder {
  accountId: number;
  number: number;
  token: number;
  /** The fix that holds it, once bound (null while the start runs its checks). */
  fixId: number | null;
}

const holders = new Map<number, Holder>();
let nextToken = 1;
/** Called whenever a holder lets go (the AI Fix manager binds the start queue's pump). */
let onReleased: () => void = () => {};

export function bindTicketLine(o: { onReleased: () => void }): void {
  onReleased = o.onReleased;
}

/** A running fix of a PR this fix would read at its head (`reads`), or null. Pure read. */
export function ticketLineBlocker(accountId: number, prId: number, reads: Iterable<number>): { prId: number; number: number } | null {
  for (const r of reads) {
    if (r === prId) continue;
    const h = holders.get(r);
    if (h != null && h.accountId === accountId) return { prId: r, number: h.number };
  }
  return null;
}

/**
 * The start's check AND hold, SYNCHRONOUSLY: blocked ⇒ `{blocked}` (nothing held); otherwise this PR holds the
 * line and its token comes back. `skip` (a reader's Start now) holds without the check.
 */
export function tryHoldTicketLine(
  a: { accountId: number; prId: number; number: number; reads: Iterable<number> },
  o: { skip?: boolean } = {},
): { blocked: { prId: number; number: number } } | { token: number } {
  if (o.skip !== true) {
    const b = ticketLineBlocker(a.accountId, a.prId, a.reads);
    if (b != null) return { blocked: b };
  }
  const token = nextToken++;
  holders.set(a.prId, { accountId: a.accountId, number: a.number, token, fixId: null });
  return { token };
}

/** The started fix's id joins its hold (only the hold of that token). */
export function bindTicketLineFix(prId: number, token: number, fixId: number): void {
  const h = holders.get(prId);
  if (h && h.token === token) h.fixId = fixId;
}

/** Does this PR hold the line now? */
export function holdsTicketLine(prId: number): boolean {
  return holders.has(prId);
}

/**
 * Let go: the fix left running (`{fixId}`, only once that id is bound to the hold), or its start bailed
 * (`{token}`). No argument (tests, a reset) releases whatever holds it. Wakes the start queue when something was
 * released. Never throws.
 */
export function releaseTicketLine(prId: number, who?: { token: number } | { fixId: number }): void {
  const h = holders.get(prId);
  if (h == null) return;
  if (who != null && ('token' in who ? h.token !== who.token : h.fixId !== who.fixId)) return;
  holders.delete(prId);
  try {
    onReleased();
  } catch {
    /* the pump never throws; a missed wake costs the sweep's minute */
  }
}

/** Test hook. */
export function _resetTicketLineForTest(): void {
  holders.clear();
}
