import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { LocalScorerError, localScorerPid, scoreLocally, stopLocalScorer } from './local-scorer.js';
import { DEV_MODELS_DIR, HAVE_FIXTURES, loadManifest, loadRows } from './parity-fixtures.test-support.js';
import { SEVERITY_HEAD_SUBDIR } from './runtime.js';

// The real scoring PROCESS, end to end: spawn at background priority, load the model, score each
// comment alone, reply in input order. Needs the packages/ml checkout with its LFS model; skips loudly without it.
const weights = join(DEV_MODELS_DIR, SEVERITY_HEAD_SUBDIR, 'model_quantized.onnx');
const HAVE_MODEL = HAVE_FIXTURES && existsSync(weights) && statSync(weights).size > 1_000_000;

describe.skipIf(!HAVE_MODEL)('local scoring process', () => {
  afterAll(() => stopLocalScorer());

  // Chunk 0 is the shortest recorded rows: so alike in length that padding never moved them, so
  // one-at-a-time scoring matches what the service served there.
  it('scores the recorded short-comment chunk as the service did, at the lowest priority', async () => {
    const rows = loadRows();
    const chunk = loadManifest().chunks[0]!.map((i) => rows[i]!);
    const batch = await scoreLocally(
      DEV_MODELS_DIR,
      chunk.map((r) => ({ body: r.input.body, diffHunk: r.input.diff_hunk, path: r.input.path, vendor: r.input.vendor })),
    );
    expect(batch.modelVersion).toBe(loadManifest().model_version);
    expect(batch.results.map((r) => r.severity)).toEqual(chunk.map((r) => r.result.severity));
    expect(batch.results.map((r) => r.category)).toEqual(chunk.map((r) => r.result.category));
    const pid = localScorerPid();
    expect(pid).not.toBeNull();
    if (process.platform !== 'win32') {
      expect(execFileSync('ps', ['-o', 'nice=', '-p', String(pid)], { encoding: 'utf8' }).trim()).toBe('19');
    }
  }, 120_000);

  it('reports a model that cannot load as a load failure, then recovers on a good directory', async () => {
    const err = await scoreLocally('/nonexistent/models', [{ body: 'x' }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalScorerError);
    expect((err as LocalScorerError).loadFailed).toBe(true);
    const ok = await scoreLocally(DEV_MODELS_DIR, [{ body: 'Possible null dereference.', vendor: 'copilot' }]);
    expect(ok.results).toHaveLength(1);
  }, 120_000);
});
