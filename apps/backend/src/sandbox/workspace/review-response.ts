// THE REVIEW LOOP'S RESPONSE REPORT, READ OUT OF THE SANDBOX (docs/SANDBOX.md § The review response). The
// vocabulary, the ONE validator and the checker script are the shared loop core's
// (coding/review-loop/response.ts); this module only reads the agent's file out of a live sandbox and
// checks it with that validator, and removes it before a fix turn.
import { posix } from 'node:path';
import type { SandboxRuntime } from '../runtime/types.js';
import { REVIEW_RESPONSE_FILE, REVIEW_RESPONSE_MAX_BYTES, validateReviewResponse, type ReviewResponseCheck } from '../../coding/review-loop/response.js';

export type ReadReviewResponseResult =
  | { kind: 'ok'; check: ReviewResponseCheck }
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string };

/** The report out of the sandbox, parsed and checked. Never throws. */
export async function readReviewResponse(
  runtime: SandboxRuntime,
  container: string,
  layoutRoot: string,
  shown: readonly string[],
): Promise<ReadReviewResponseResult> {
  const file = posix.join(layoutRoot, REVIEW_RESPONSE_FILE);
  try {
    const r = await runtime.run(container, ['sh', '-c', 'test -f "$1" || exit 4; head -c "$2" "$1"', 'sh', file, String(REVIEW_RESPONSE_MAX_BYTES + 1)], { timeoutMs: 30_000 });
    if (r.code === 4) return { kind: 'missing' };
    if (r.code !== 0) return { kind: 'unreadable', reason: 'The answers could not be read from the sandbox.' };
    const text = r.stdout.toString('utf8');
    if (Buffer.byteLength(text, 'utf8') > REVIEW_RESPONSE_MAX_BYTES) return { kind: 'unreadable', reason: `The answers are larger than ${REVIEW_RESPONSE_MAX_BYTES / 1024} KB.` };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { kind: 'unreadable', reason: 'The answers are not valid JSON.' };
    }
    return { kind: 'ok', check: validateReviewResponse(raw, shown) };
  } catch {
    return { kind: 'unreadable', reason: 'The answers could not be read from the sandbox.' };
  }
}

/** Before a fix turn: the old report goes, so a report found after the turn is that turn's. */
export async function removeReviewResponse(runtime: SandboxRuntime, container: string, layoutRoot: string): Promise<void> {
  await runtime.run(container, ['rm', '-f', posix.join(layoutRoot, REVIEW_RESPONSE_FILE)], { timeoutMs: 30_000 }).catch(() => {});
}
