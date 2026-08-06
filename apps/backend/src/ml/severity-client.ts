// Client for the `severity-api` microservice (the sibling `pierre-ml` repo) — a STATELESS
// text-in/labels-out classifier. Nothing here talks to a database, spends money, or touches
// GitHub; the caller owns persistence. See docs/ML-SEVERITY.md for the deployment shapes
// (Railway private DNS in cloud, 127.0.0.1 in local dev, absent under npx).
import type { MlSeverity, MlVendorConfidence } from '@pierre-review/shared';
import { config } from '../config.js';

export type SeverityWord = 'NIT' | 'MINOR' | 'MAJOR' | 'CRITICAL';

const VENDOR_SEVERITIES: MlSeverity[] = ['nit', 'minor', 'major', 'critical'];
const VENDOR_CONFIDENCES: MlVendorConfidence[] = ['high', 'medium', 'low'];

/**
 * Read one of the two OPTIONAL vendor fields off a result.
 *
 * Everything about this is deliberately permissive in one direction only: an absent field, a
 * null, a non-string, or a word outside the allowed set all become `null`, and NOTHING throws.
 * The deployed severity-api may be an older build that never heard of these fields, and that
 * must degrade to "no vendor claim" silently — a hard parse here would fail the whole batch,
 * and a failed batch abandons its workspace's backlog for the tick.
 *
 * Case is normalised because the two halves of the response disagree by design: our own
 * `severity` comes back SHOUTED (`MAJOR`) while the vendor fields are documented lowercase.
 * Accepting either costs nothing and removes a whole class of silent-null bug if the service
 * ever normalises differently from its docs.
 */
function pickEnum<T extends string>(raw: unknown, allowed: T[]): T | null {
  if (typeof raw !== 'string') return null;
  const word = raw.trim().toLowerCase();
  return (allowed as string[]).includes(word) ? (word as T) : null;
}

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
  /**
   * The VENDOR'S OWN declared severity, parsed from the bot's markup by the service's marker
   * reader — never the model's opinion. `null` when the vendor declared none (the common case)
   * AND when the service is an older build that omits the field; see `pickEnum`.
   *
   * ⚠ Measurably worse than `severity` (0.474 exact / 0.697 ordinal MAE vs 0.700 / 0.303 on
   * `gold_v2_sample`). It is carried through to be DISPLAYED next to ours; nothing in this
   * codebase may derive, correct or fall back our severity from it.
   */
  vendorSeverity: MlSeverity | null;
  /** The marker reader's confidence in the claim above. Optional, same null rules. */
  vendorSeverityConfidence: MlVendorConfidence | null;
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

let cachedHeaders: { raw: string; headers: Record<string, string> } | null = null;

/**
 * Extra headers to send with every severity-api call, from `SEVERITY_API_HEADERS` (a JSON object).
 *
 * The service is UNAUTHENTICATED by design in both shipped deployments — Railway reaches it over
 * private DNS with no public domain, and locally it is loopback-only. Neither needs a credential.
 * A rented endpoint (e.g. the Modal fleet in pierre-ml's `serve/modal_app.py`, used to drain a
 * large backlog faster than a dev box can) is the case that does, and it must not require a code
 * change to reach — hence a generic header bag rather than a provider-shaped `…_TOKEN` variable:
 * a shared secret and Modal's own `Modal-Key`/`Modal-Secret` pair are then the same feature.
 *
 * MALFORMED JSON IS IGNORED, NOT FATAL. This sits in the enrichment path, whose whole contract is
 * that the severity-api being unusable degrades to "no labels yet" rather than disturbing sync. A
 * throw here would surface as an unhandled rejection inside the concurrency workers — the one
 * thing `runMlEnrichmentTick` must never allow (a rejected `Promise.all` leaves its sibling worker
 * running detached). A wrong header simply gets a 401 from the far end, which is already a modelled
 * outcome: `SeverityApiError` with a status, i.e. "answered, rejected" rather than "unreachable".
 */
function extraHeaders(): Record<string, string> {
  const raw = config.severityApiHeaders;
  if (!raw) return {};
  if (cachedHeaders?.raw === raw) return cachedHeaders.headers;
  const headers: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }
  } catch {
    // Ignored on purpose — see above.
  }
  cachedHeaders = { raw, headers };
  return headers;
}

/**
 * A failed call, carrying the ONE distinction callers actually need: did the service ANSWER?
 *
 * "The service is down" and "the service rejected this batch" are different facts with different
 * consequences, and a bare Error made them indistinguishable. A 500 on one batch (four comments
 * in this repo's own dev database reliably produce one) means the service is up and the rest of
 * the corpus will score fine; a transport failure means nothing will. Reporting the first as
 * "unreachable" would tell the UI to hide a scoring phase that is in fact running.
 */
export class SeverityApiError extends Error {
  /** HTTP status when the service answered; null when it could not be reached at all. */
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'SeverityApiError';
    this.status = status;
  }
}

/** True when this failure proves nothing about reachability — the service answered. */
export function severityApiAnswered(err: unknown): boolean {
  return err instanceof SeverityApiError && err.status !== null;
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(endpoint(path), {
      method: 'POST',
      // Spread AFTER the content-type so a stray `content-type` in the env bag cannot break the
      // wire format — everything here posts JSON.
      headers: { 'content-type': 'application/json', ...extraHeaders() },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.mlRequestTimeoutMs),
    });
  } catch (err) {
    // Transport-level: connection refused, DNS, timeout. The service did not answer.
    throw new SeverityApiError(
      `severity-api unreachable: ${err instanceof Error ? err.message : String(err)}`,
      null,
    );
  }
  if (!res.ok) {
    // Bound the echoed body: a 500 from FastAPI can carry a full traceback, and this string
    // ends up in a log line on every failed tick.
    const text = await res.text().catch(() => '');
    throw new SeverityApiError(`severity-api ${res.status}: ${text.slice(0, 300)}`, res.status);
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
      // Sent here too: a deployment MAY choose to guard /health, and probing it unauthenticated
      // would then report a perfectly good service as down.
      headers: extraHeaders(),
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
      // OPTIONAL — typed as unknown rather than a union on purpose: these arrive from a
      // separately-deployed service that may predate them, so the only safe assumption is
      // that we know nothing about the value until `pickEnum` has looked at it.
      vendor_severity?: unknown;
      vendor_severity_confidence?: unknown;
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
      vendorSeverity: pickEnum(r.vendor_severity, VENDOR_SEVERITIES),
      vendorSeverityConfidence: pickEnum(r.vendor_severity_confidence, VENDOR_CONFIDENCES),
      isSummary: r.is_summary === true,
      backend: r.backend ?? '',
    })),
  };
}
