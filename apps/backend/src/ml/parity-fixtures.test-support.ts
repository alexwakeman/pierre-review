// Test-only: the severity service's parity fixtures (packages/ml/scripts/export_parity_fixtures.py).
// packages/ml is a submodule, so a checkout without it has none — every suite reading these
// skips, and says so loudly, because a skipped parity suite reads as green.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { Kind } from './markers.js';

const PARITY_DIR = new URL('../../../../packages/ml/data/parity/', import.meta.url);
const ROWS = new URL('rows.jsonl.gz', PARITY_DIR);
const MANIFEST = new URL('manifest.json', PARITY_DIR);
export const COERCION = new URL('coercion.json', PARITY_DIR);
/** The checkout's serving assets: the model the fixtures were exported from. */
export const DEV_MODELS_DIR = fileURLToPath(new URL('../../../../packages/ml/serving_assets/', import.meta.url));

export const HAVE_FIXTURES = existsSync(ROWS) && existsSync(MANIFEST) && existsSync(COERCION);
if (!HAVE_FIXTURES) {
  console.warn(
    '⚠ ML parity replay SKIPPED: packages/ml/data/parity is absent (git submodule update --init packages/ml).',
  );
}

export interface FixtureRow {
  id: string;
  input: { body: string; diff_hunk: string | null; path: string | null; vendor: string | null };
  sanitized: { body: string; diff_hunk: string | null; path: string | null };
  vendor_kind: Kind;
  markers: Record<string, unknown>;
  stripped: string;
  model_text: string;
  token_ids: number[];
  n_tokens_untruncated: number;
  chunk: number;
  logits: number[];
  result: Record<string, unknown>;
}

export interface FixtureManifest {
  model_version: string;
  serving: {
    max_length: number;
    batch_size: number;
    token_budget: number;
    id2label: Record<string, string>;
    critical_index: number | null;
    critical_escalation_threshold: number | null;
    severity_class_weights: Record<string, number> | null;
    path_in_text: boolean;
  };
  chunks: number[][];
}

let rowsCache: FixtureRow[] | null = null;
export function loadRows(): FixtureRow[] {
  rowsCache ??= gunzipSync(readFileSync(ROWS))
    .toString('ascii')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureRow);
  return rowsCache;
}

export function loadManifest(): FixtureManifest {
  return JSON.parse(readFileSync(MANIFEST, 'utf8')) as FixtureManifest;
}
