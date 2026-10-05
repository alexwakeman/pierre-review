// THE CI REVIEW'S READ STEP (prepare.ts `readCiInputs`) over a fake `ctx.ci`. What this pins:
//   1. Only FAILING Actions jobs have their log read (one tail window each); a third-party check is
//      listed no_log and never read.
//   2. ⚠ Refusals are decided here, with no model: nothing failing, no Actions log at all, no log
//      readable, the checks unreadable.
//   3. Carry-forward: same head + same job ⇒ the earlier diagnosis, no log read, nothing sent.
//
//   pnpm --filter @pierre-review/backend test ci-review/prepare
import { describe, expect, it, vi } from 'vitest';
import type { CheckLogsResponse, CheckRun, CiReviewItem } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { readCiInputs } from './prepare.js';

const HEAD = 'a'.repeat(40);
const check = (name: string, state: CheckRun['state'], jobId: number | null): CheckRun => ({
  name,
  state,
  url: jobId != null ? `https://github.com/o/r/actions/runs/1/job/${jobId}` : `https://ci.example/${name}`,
  runId: jobId != null ? 1 : null,
  jobId,
});
const okLog = (text: string): CheckLogsResponse => ({
  available: true,
  text,
  totalLines: 1,
  returnedLines: 1,
  totalBytes: 10_000_000,
  startByte: 9_000_000,
  endByte: 10_000_000,
  hasMore: true,
  truncated: true,
});

function fakeCtx(checks: CheckRun[] | null, rollup: string | null = 'FAILURE', log: CheckLogsResponse | null = okLog('Error: x')) {
  const readJobLog = vi.fn(async () => log ?? ({ available: false, reason: 'expired', text: '' } as unknown as CheckLogsResponse));
  const readFailedStep = vi.fn(async () => 'Run tests');
  const ctx = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ci: {
      readCommitChecks: vi.fn(async () =>
        checks == null ? { ok: false as const, reason: 'error' as const } : { ok: true as const, rollupState: rollup, checks },
      ),
      readJobLog,
      readFailedStep,
    },
  } as unknown as AgentContext;
  return { ctx, readJobLog, readFailedStep };
}
const args = (prior: CiReviewItem[] | null = null) => ({ accountId: 1, prId: 7, owner: 'o', name: 'r', headSha: HEAD, prior });

describe('readCiInputs', () => {
  it('refuses with no model: unreadable checks, nothing failing, no Actions log, no log readable', async () => {
    expect(await readCiInputs({ log: { warn: () => {} } } as unknown as AgentContext, args())).toMatchObject({
      ok: false,
      reason: 'checks_unreadable',
    });
    expect(await readCiInputs(fakeCtx(null).ctx, args())).toMatchObject({ ok: false, reason: 'checks_unreadable' });
    const green = fakeCtx([check('ok', 'success', 1)], 'SUCCESS');
    expect(await readCiInputs(green.ctx, args())).toMatchObject({ ok: false, reason: 'no_failures' });
    expect(green.readJobLog).not.toHaveBeenCalled();
    const ext = fakeCtx([check('sonar', 'failure', null)]);
    expect(await readCiInputs(ext.ctx, args())).toMatchObject({ ok: false, reason: 'no_logs', failingChecks: ['sonar'] });
    expect(ext.readJobLog).not.toHaveBeenCalled();
    const gone = fakeCtx([check('bad', 'failure', 2)], 'FAILURE', null);
    expect(await readCiInputs(gone.ctx, args())).toMatchObject({ ok: false, reason: 'logs_unavailable' });
  });

  it('reads the failing Actions jobs only, and marks a window from the end of the log', async () => {
    const { ctx, readJobLog, readFailedStep } = fakeCtx([check('ok', 'success', 1), check('bad', 'failure', 2), check('ext', 'failure', null)]);
    const r = await readCiInputs(ctx, args());
    if (!r.ok) throw new Error('expected inputs');
    expect(readJobLog).toHaveBeenCalledTimes(1);
    expect(readJobLog).toHaveBeenCalledWith(1, { owner: 'o', name: 'r', jobId: 2 });
    expect(readFailedStep).toHaveBeenCalledTimes(1);
    expect(r.failingChecks).toEqual(['bad', 'ext']);
    expect(r.ciState).toEqual({ state: 'failing', checkCount: 3 });
    expect(r.plan.sent).toHaveLength(1);
    expect(r.plan.sent[0]!.step).toBe('Run tests');
    expect(r.plan.sent[0]!.excerpt.windowTruncated).toBe(true);
    expect(r.plan.unsent).toEqual([expect.objectContaining({ reason: 'no_log' })]);
  });

  it('same head, same failing job ⇒ carried, no log read, nothing sent', async () => {
    const { ctx, readJobLog } = fakeCtx([check('bad', 'failure', 2)]);
    const prior: CiReviewItem = {
      id: 1,
      ciReviewId: 1,
      ref: 'F1',
      checkName: 'bad',
      jobId: 2,
      step: 'Run tests',
      url: null,
      sent: true,
      carried: false,
      status: 'diagnosed',
      notCheckedReason: null,
      cause: 'c',
      explanation: 'e',
      category: 'test',
      fixableInPr: true,
      relatedFiles: [],
      assessedAtHead: HEAD,
      path: 'src/a.ts',
      line: 3,
      suggestion: 's',
    };
    const r = await readCiInputs(ctx, args([prior]));
    if (!r.ok) throw new Error('expected inputs');
    expect(readJobLog).not.toHaveBeenCalled();
    expect(r.plan.sent).toHaveLength(0);
    expect(r.plan.carried).toEqual([expect.objectContaining({ checkName: 'bad', carried: true })]);
    expect([...r.carriedExtras.values()]).toEqual([{ path: 'src/a.ts', line: 3, suggestion: 's' }]);
  });
});
