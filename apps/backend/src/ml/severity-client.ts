// Client for the `severity-api` microservice (the sibling `pierre-ml` repo) — a STATELESS
// text-in/labels-out classifier. Nothing here talks to a database, spends money, or touches
// GitHub; the caller owns persistence. See docs/ML-SEVERITY.md for the deployment shapes
// (Railway private DNS in cloud, 127.0.0.1 in local dev, absent under npx).
import { config } from '../config.js';

export type SeverityWord = 'NIT' | 'MINOR' | 'MAJOR' | 'CRITICAL';

/** One item as the service wants it. `vendor` is an optional hint for the marker parser;
 * `path` (the reviewed file's path) feeds the v2 model's input representation — a strong
 * testing/docs signal the service ignores gracefully on older artifacts. */
export interface SeverityRequestItem {
  body: string;
  diffHunk?: string | null;
  vendor?: string | null;
  path?: string | null;
}

/** One item as the service answers it (batch results omit `model_version` — see the envelope). */
export interface SeverityResult {
  category: string[];
  categoryProbs: Record<string, number>;
  severity: SeverityWord;
  severityOrd: number;
  severityProb: number;
  isSummary: boolean;
  backend: string;
}

export interface SeverityBatchResponse {
  results: SeverityResult[];
  modelVersion: string;
}

export interface SeverityHealth {
  status: string;
  db: string;
  taxonomyLoaded: boolean;
}

/**
 * Is the feature configured at all? THE one gate — everything else (worker, routes, the
 * `/api/me` flag) reads this rather than re-deriving it from the env.
 *
 * Only http/https are accepted. The URL is deployment config, never tenant data, but an
 * unparseable or exotic-scheme value would otherwise turn into a confusing runtime failure
 * inside the worker rather than a clean "feature off" at boot.
 */
export function isSeverityApiConfigured(): boolean {
  return parsedBase() !== null;
}

let cachedBase: { raw: string; url: URL | null } | null = null;

function parsedBase(): URL | null {
  const raw = config.severityApiUrl;
  if (!raw) return null;
  if (cachedBase?.raw === raw) return cachedBase.url;
  let url: URL | null = null;
  try {
    const u = new URL(raw);
    url = u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    url = null;
  }
  cachedBase = { raw, url };
  return url;
}

function endpoint(path: string): string {
  const base = parsedBase();
  if (!base) throw new Error('severity-api is not configured (SEVERITY_API_URL)');
  return new URL(path, base).toString();
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(endpoint(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.mlRequestTimeoutMs),
  });
  if (!res.ok) {
    // Bound the echoed body: a 500 from FastAPI can carry a full traceback, and this string
    // ends up in a log line on every failed tick.
    const text = await res.text().catch(() => '');
    throw new Error(`severity-api ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/**
 * Readiness + WHICH BACKEND is live. `taxonomyLoaded:false` means the ONNX model did not load
 * and the service is answering from the marker heuristic — it still answers, so a caller that
 * only checked for a 200 would never notice the quality drop. Logged at boot for exactly that
 * reason.
 */
export async function severityHealth(): Promise<SeverityHealth | null> {
  if (!isSeverityApiConfigured()) return null;
  try {
    const res = await fetch(endpoint('/health'), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      status?: string;
      db?: string;
      models_loaded?: { taxonomy?: boolean };
    };
    return {
      status: body.status ?? 'unknown',
      db: body.db ?? 'unknown',
      taxonomyLoaded: body.models_loaded?.taxonomy === true,
    };
  } catch {
    return null;
  }
}

/**
 * Classify a batch. Results come back IN INPUT ORDER — the caller zips them back onto its own
 * targets positionally, so this function must never reorder, filter or pad.
 *
 * Throws on any transport/HTTP failure. Callers treat that as "retry this batch on a later
 * tick"; nothing is written, so a failure costs only the round trip.
 */
export async function scoreComments(
  items: SeverityRequestItem[],
): Promise<SeverityBatchResponse> {
  if (items.length === 0) return { results: [], modelVersion: '' };
  if (items.length > 256) {
    // The service 422s past 256. Failing here instead makes the caller's paging bug obvious
    // rather than surfacing as an opaque validation error from another process.
    throw new Error(`severity-api batch too large: ${items.length} > 256`);
  }
  const payload = {
    comments: items.map((i) => ({
      body: i.body,
      ...(i.diffHunk ? { diff_hunk: i.diffHunk } : {}),
      ...(i.vendor ? { vendor: i.vendor } : {}),
      ...(i.path ? { path: i.path } : {}),
    })),
  };
  const raw = await postJson<{
    results: Array<{
      category: string[];
      category_probs: Record<string, number>;
      severity: SeverityWord;
      severity_ord: number;
      severity_prob: number;
      is_summary: boolean;
      backend: string;
    }>;
    count: number;
    model_version: string;
  }>('/score/comments', payload);

  if (!Array.isArray(raw.results) || raw.results.length !== items.length) {
    // Positional zipping is the whole contract. A short/long array would silently attach one
    // comment's severity to a different comment, which is worse than no label at all.
    throw new Error(
      `severity-api returned ${raw.results?.length ?? 0} results for ${items.length} items`,
    );
  }

  return {
    modelVersion: raw.model_version ?? '',
    results: raw.results.map((r) => ({
      category: Array.isArray(r.category) ? r.category : [],
      categoryProbs: r.category_probs ?? {},
      severity: r.severity,
      severityOrd: r.severity_ord,
      severityProb: r.severity_prob,
      isSummary: r.is_summary === true,
      backend: r.backend ?? '',
    })),
  };
}
