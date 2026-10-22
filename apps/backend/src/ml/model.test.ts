import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeSeverity, softmax } from './decode.js';
import { loadLocalModel, type LocalModel } from './model.js';
import { HAVE_FIXTURES, DEV_MODELS_DIR, loadManifest, loadRows } from './parity-fixtures.test-support.js';
import { SEVERITY_HEAD_SUBDIR, loadOrt, loadTokenizers } from './runtime.js';

// The REAL model through onnxruntime-node, against what the Python service computed. Needs the
// packages/ml checkout WITH its Git LFS blobs (a pointer stub is ~130 bytes). Skips loudly
// otherwise.
const weights = join(DEV_MODELS_DIR, SEVERITY_HEAD_SUBDIR, 'model_quantized.onnx');
const HAVE_MODEL = HAVE_FIXTURES && existsSync(weights) && statSync(weights).size > 1_000_000;
if (HAVE_FIXTURES && !HAVE_MODEL) {
  console.warn('⚠ ML model parity SKIPPED: packages/ml/serving_assets has no real model (git lfs pull).');
}
/** Every chunk instead of three: ~4 min on an Intel Mac. */
const FULL = process.env.LIMN_ML_PARITY_FULL === '1';

// int8 kernels on different CPUs / builds may differ in the last bits; labels must not.
const LOGIT_TOLERANCE = 1e-3;

describe.skipIf(!HAVE_MODEL)('local model parity with the Python service', () => {
  let model: LocalModel;
  const rows = HAVE_MODEL ? loadRows() : [];
  const manifest = HAVE_MODEL ? loadManifest() : null;

  beforeAll(async () => {
    model = await loadLocalModel(DEV_MODELS_DIR, await loadOrt(), await loadTokenizers());
  }, 60_000);
  afterAll(async () => {
    await model?.release();
  });

  it('names the artifact exactly as the service does', () => {
    expect(model.modelVersion).toBe(manifest!.model_version);
  });

  it('tokenizes every row to the service ids', () => {
    const ids = model.head.encode(rows.map((r) => r.model_text));
    const bad = rows.filter((r, i) => JSON.stringify(ids[i]) !== JSON.stringify(r.token_ids)).map((r) => r.id);
    expect(bad).toEqual([]);
  });

  it('scores each comment ALONE: the same answer as a one-row run, whatever else is in the call', async () => {
    const some = rows.slice(0, 6);
    const items = some.map((r) => ({ body: r.input.body, diffHunk: r.input.diff_hunk, path: r.input.path, vendor: r.input.vendor }));
    const together = await model.score(items);
    for (const [k, r] of some.entries()) {
      const [one] = await model.head.logits([r.model_text]);
      expect(together[k]!.severity).toBe(decodeSeverity(model.head.spec, softmax(one!)).severity);
    }
    expect((await model.score(items.slice(2, 3)))[0]).toEqual(together[2]);
  }, 120_000);

  // A WHOLE recorded chunk, run on its own, re-forms that same chunk (same rows, same order, same
  // fit), so the padded width — which moves int8 logits — is the one the service used.
  const chunks = manifest?.chunks ?? [];
  const picked = FULL ? chunks.map((_, i) => i) : [0, Math.floor(chunks.length / 2), chunks.length - 1];
  it.each(picked)(
    'chunk %i: same logits (within tolerance) and the same served row',
    async (c) => {
      const idx = chunks[c]!;
      const batch = idx.map((i) => rows[i]!);
      const logits = await model.head.logits(batch.map((r) => r.model_text));
      let worst = 0;
      batch.forEach((r, k) => r.logits.forEach((want, j) => (worst = Math.max(worst, Math.abs(logits[k]![j]! - want)))));
      if (FULL) console.info(`chunk ${c}: ${batch.length} rows, worst |Δlogit| ${worst.toExponential(2)}`);
      expect(worst).toBeLessThan(LOGIT_TOLERANCE);

      // Decoding these batched logits gives the row the service served.
      const spec = model.head.spec;
      const wrong = batch
        .filter((r, k) => decodeSeverity(spec, softmax(logits[k]!)).severity !== r.result.severity)
        .map((r) => r.id);
      expect(wrong).toEqual([]);
    },
    FULL ? 600_000 : 120_000,
  );
});
