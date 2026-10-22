// The pure half of local severity scoring: model text in, wire result out. No ONNX, no tokenizer,
// no I/O — so every line here is tested from the parity fixtures' stored logits without the model.
//
// A port of the severity service's serving path (packages/ml `models/taxonomy.py`) for the v1
// composite decided in docs/ML-NODE-PORT.md: SEVERITY from the ONNX head, CATEGORY (plus
// `is_summary` and the vendor's own claim) from the marker parse.
import {
  CATEGORY_ORDER,
  MARKER_CONFIDENCE_SCORE,
  SEVERITY_ORD,
  coerceVendor,
  declaredConfidence,
  dropLoneSurrogates,
  extractMarkers,
  primaryCategory,
  stripVendorChrome,
  type Category,
  type MarkerResult,
  type Severity,
} from './markers.js';

/** One comment to score — the same shape the HTTP service took. */
export interface ScoreItem {
  body: string;
  diffHunk?: string | null;
  vendor?: string | null;
  path?: string | null;
}

/** One result, field for field the service's `/score/comments` row. */
export interface ScoreResult {
  category: Category[];
  categoryProbs: Record<Category, number>;
  severity: Severity;
  severityOrd: number;
  severityProb: number;
  isSummary: boolean;
  backend: string;
  vendorSeverity: string | null;
  vendorSeverityConfidence: string | null;
}

/** What the severity head's artifact says about itself (config / calibration / input_format). */
export interface SeverityHeadSpec {
  id2label: Record<number, string>;
  /** Column of CRITICAL, read from the labels — never assumed to be 3. */
  criticalIndex: number | null;
  /** Off (null) by default, as in the service's settings. */
  criticalEscalationThreshold: number | null;
  /** Label-shift calibration: softmax probabilities are multiplied by these before argmax. */
  classWeights: Record<string, number> | null;
  /** v2 artifacts read `path [SEP] body [SEP] diff`. */
  pathInText: boolean;
}

export const BACKEND = 'severity:modernbert-onnx+category:marker';
/** Residual probability for a category the markers did not name. */
const BASE_PROB = 0.03;

/** Python's `round(x, 4)`. Ties cannot occur: no 4-place tie is a binary fraction. */
export function round4(x: number): number {
  return Number(x.toFixed(4));
}

export function softmax(row: readonly number[]): number[] {
  const max = Math.max(...row);
  const exp = row.map((v) => Math.exp(v - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map((v) => v / sum);
}

function severityFromLabel(label: string | undefined): Severity {
  const up = label?.trim().toUpperCase();
  return up !== undefined && up in SEVERITY_ORD ? (up as Severity) : 'MINOR';
}

/** Argmax (after the class weights), then the optional MAJOR → CRITICAL escalation. */
export function decodeSeverity(
  spec: SeverityHeadSpec,
  probs: readonly number[],
): { severity: Severity; prob: number } {
  const scored = spec.classWeights
    ? probs.map((p, i) => p * (spec.classWeights![String(spec.id2label[i]).toUpperCase()] ?? 1))
    : probs;
  let argmax = 0;
  for (let i = 1; i < scored.length; i++) if (scored[i]! > scored[argmax]!) argmax = i;
  const raw = severityFromLabel(spec.id2label[argmax]);
  const pCrit = spec.criticalIndex !== null ? probs[spec.criticalIndex]! : 0;
  const t = spec.criticalEscalationThreshold;
  const severity = t !== null && raw === 'MAJOR' && pCrit >= t ? 'CRITICAL' : raw;
  // The RAW probability of the chosen class (under weights the max may be another class).
  return { severity, prob: round4(severity !== raw ? pCrit : probs[argmax]!) };
}

/** `path [SEP] body [SEP] diff` — the one text form both training and serving use. */
export function combineText(body: string, diffHunk: string | null, path: string | null): string {
  const text = diffHunk ? `${body}\n[SEP]\n${diffHunk}` : body;
  return path ? `${path}\n[SEP]\n${text}` : text;
}

/** An item after the service's HTTP boundary: lone surrogates gone from every string. */
export interface SanitizedItem {
  body: string;
  diffHunk: string | null;
  path: string | null;
  kind: ReturnType<typeof coerceVendor>;
}

export function sanitize(item: ScoreItem): SanitizedItem {
  return {
    body: dropLoneSurrogates(item.body),
    diffHunk: item.diffHunk == null ? null : dropLoneSurrogates(item.diffHunk),
    path: item.path == null ? null : dropLoneSurrogates(item.path),
    kind: coerceVendor(item.vendor == null ? null : dropLoneSurrogates(item.vendor)),
  };
}

/** The severity head's input text. The body is chrome-stripped: the head was trained on that. */
export function modelText(item: SanitizedItem, pathInText: boolean): string {
  return combineText(stripVendorChrome(item.body), item.diffHunk, pathInText ? item.path : null);
}

/**
 * Group row indexes into mini-batches bounded by PADDED tokens (rows × widest row), shortest
 * first. Returned in length order: callers scatter results back by these indexes.
 * ⚠ Not numerically neutral — the int8 export is not padding-invariant, so this must stay
 * identical to the service's `token_budget_chunks` for logits to match.
 */
export function tokenBudgetChunks(lengths: readonly number[], batchSize: number, tokenBudget: number): number[][] {
  if (tokenBudget <= 0) {
    const out: number[][] = [];
    for (let s = 0; s < lengths.length; s += batchSize) {
      out.push(Array.from({ length: Math.min(batchSize, lengths.length - s) }, (_, k) => s + k));
    }
    return out;
  }
  // Array.prototype.sort is stable, like Python's sorted().
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[a]! - lengths[b]!);
  const chunks: number[][] = [];
  let cur: number[] = [];
  for (const i of order) {
    // Ascending order: row i is the widest so far, so it sets the padded width.
    if (cur.length > 0 && (cur.length >= batchSize || (cur.length + 1) * lengths[i]! > tokenBudget)) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(i);
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/** The marker lexicon's category answer, as the service's `_marker_to_prediction` builds it. */
function markerCategories(m: MarkerResult): { category: Category[]; categoryProbs: Record<Category, number> } {
  const conf = MARKER_CONFIDENCE_SCORE[m.confidence];
  const probs = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, BASE_PROB])) as Record<Category, number>;
  for (const cat of m.categories) probs[cat] = round4(conf);
  let category = CATEGORY_ORDER.filter((c) => m.categories.has(c));
  if (category.length === 0) {
    // No structured category: the lowest-information bucket, flagged with a low probability.
    const fallback = primaryCategory(m) ?? 'nitpick';
    probs[fallback] = Math.max(probs[fallback], round4(conf * 0.5));
    category = [fallback];
  }
  return { category, categoryProbs: probs };
}

/** The wire row for one comment, from its marker parse and its decoded severity. */
export function buildResult(item: SanitizedItem, severity: Severity, severityProb: number): ScoreResult {
  const markers = extractMarkers(item.kind, item.body);
  const { category, categoryProbs } = markerCategories(markers);
  const rounded = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, round4(categoryProbs[c])])) as Record<
    Category,
    number
  >;
  const declared = markers.declaredSeverity;
  return {
    category,
    categoryProbs: rounded,
    severity,
    severityOrd: SEVERITY_ORD[severity],
    severityProb: round4(severityProb),
    isSummary: markers.isSummary,
    backend: BACKEND,
    vendorSeverity: declared === null ? null : declared.toLowerCase(),
    vendorSeverityConfidence: declaredConfidence(markers),
  };
}
