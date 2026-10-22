import { describe, expect, it } from 'vitest';
import {
  buildResult,
  decodeSeverity,
  modelText,
  sanitize,
  softmax,
  tokenBudgetChunks,
  type ScoreResult,
  type SeverityHeadSpec,
} from './decode.js';
import { HAVE_FIXTURES, loadManifest, loadRows } from './parity-fixtures.test-support.js';

/** The fixture's snake_case `/score/comments` row, in this module's shape. */
function fromWire(r: Record<string, unknown>): ScoreResult {
  return {
    category: r.category as ScoreResult['category'],
    categoryProbs: r.category_probs as ScoreResult['categoryProbs'],
    severity: r.severity as ScoreResult['severity'],
    severityOrd: r.severity_ord as number,
    severityProb: r.severity_prob as number,
    isSummary: r.is_summary as boolean,
    backend: r.backend as string,
    vendorSeverity: r.vendor_severity as string | null,
    vendorSeverityConfidence: r.vendor_severity_confidence as string | null,
  };
}

describe.skipIf(!HAVE_FIXTURES)('decode parity with the Python service (stored logits, no model)', () => {
  const rows = HAVE_FIXTURES ? loadRows() : [];
  const manifest = HAVE_FIXTURES ? loadManifest() : null;
  const s = manifest?.serving;
  const spec: SeverityHeadSpec | null = s
    ? {
        id2label: Object.fromEntries(Object.entries(s.id2label).map(([k, v]) => [Number(k), v])),
        criticalIndex: s.critical_index,
        criticalEscalationThreshold: s.critical_escalation_threshold,
        classWeights: s.severity_class_weights,
        pathInText: s.path_in_text,
      }
    : null;

  const item = (r: (typeof rows)[number]) =>
    sanitize({ body: r.input.body, diffHunk: r.input.diff_hunk, path: r.input.path, vendor: r.input.vendor });

  it('builds the same model text', () => {
    const bad = rows.filter((r) => modelText(item(r), spec!.pathInText) !== r.model_text).map((r) => r.id);
    expect(bad).toEqual([]);
  });

  it('batches rows into the same chunks', () => {
    const chunks = tokenBudgetChunks(
      rows.map((r) => r.token_ids.length),
      s!.batch_size,
      s!.token_budget,
    );
    expect(chunks).toEqual(manifest!.chunks);
  });

  it('decodes the stored logits to the served row, every field', () => {
    const bad: { id: string; got: ScoreResult; want: ScoreResult }[] = [];
    for (const r of rows) {
      const { severity, prob } = decodeSeverity(spec!, softmax(r.logits));
      const got = buildResult(item(r), severity, prob);
      const want = fromWire(r.result);
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push({ id: r.id, got, want });
    }
    expect(bad.slice(0, 3)).toEqual([]);
  });
});

describe('decode', () => {
  const spec: SeverityHeadSpec = {
    id2label: { 0: 'NIT', 1: 'MINOR', 2: 'MAJOR', 3: 'CRITICAL' },
    criticalIndex: 3,
    criticalEscalationThreshold: null,
    classWeights: null,
    pathInText: true,
  };

  it('escalates MAJOR to CRITICAL only when a threshold is set and cleared', () => {
    const probs = [0.05, 0.1, 0.7, 0.15];
    expect(decodeSeverity(spec, probs)).toEqual({ severity: 'MAJOR', prob: 0.7 });
    expect(decodeSeverity({ ...spec, criticalEscalationThreshold: 0.1 }, probs)).toEqual({
      severity: 'CRITICAL',
      prob: 0.15,
    });
    expect(decodeSeverity({ ...spec, criticalEscalationThreshold: 0.2 }, probs).severity).toBe('MAJOR');
  });

  it('reports the RAW probability of the class the weights picked', () => {
    const weighted = { ...spec, classWeights: { NIT: 1, MINOR: 10, MAJOR: 1, CRITICAL: 1 } };
    expect(decodeSeverity(weighted, [0.1, 0.2, 0.6, 0.1])).toEqual({ severity: 'MINOR', prob: 0.2 });
  });

  it('chunks by padded tokens, shortest first, and never drops a row', () => {
    expect(tokenBudgetChunks([10, 300, 20, 400], 32, 600)).toEqual([[0, 2], [1], [3]]);
    expect(tokenBudgetChunks([5, 5, 5], 2, 0)).toEqual([[0, 1], [2]]);
    expect(tokenBudgetChunks([9000], 32, 4096)).toEqual([[0]]);
  });
});
