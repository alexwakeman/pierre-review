// THE ONE SEAM between bot-comment enrichment and whatever scores it: the local model (this
// process's worker thread, docs/ML-NODE-PORT.md) or the HTTP severity-api (cloud's Railway
// service, or a dev box running packages/ml). Same items in, same results out, in input order —
// the enrichment worker cannot tell which answered except by the label's model_version.
//
// ⚠ AVAILABILITY CAN CHANGE WHILE THE PROCESS RUNS — the reader presses "Set up" and the local
// model appears — so every gate asks `isMlScoringAvailable()` at the moment it matters, never once
// at boot. `isMlScoringPossible()` is the boot-time question ("could it ever be on?").
import { config } from '../config.js';
import type { ScoreResult } from './decode.js';
import { LocalScorerError, scoreLocally } from './local-scorer.js';
import { isOnBattery } from './power.js';
import { getMlStatus } from './runtime.js';
import {
  isSeverityApiConfigured,
  scoreComments as scoreOverHttp,
  severityApiAnswered,
  severityHealth,
  type SeverityBatchResponse,
  type SeverityRequestItem,
  type SeverityResult,
} from './severity-client.js';

export type { SeverityBatchResponse, SeverityRequestItem, SeverityResult };

export type ScorerKind = 'local' | 'http';

/** Which scorer would answer right now, or null when none can. */
export function activeScorer(): ScorerKind | null {
  const local = config.mlLocalEnabled && config.mlScorer !== 'http' && getMlStatus().state === 'ready';
  const http = config.mlScorer !== 'local' && isSeverityApiConfigured();
  if (config.mlScorer === 'http') return http ? 'http' : null;
  return local ? 'local' : http ? 'http' : null;
}

/** THE gate: is anything able to score bot comments right now? */
export function isMlScoringAvailable(): boolean {
  return activeScorer() !== null;
}

/** Could scoring ever come on in this process (with a "Set up", say)? For boot-time wiring. */
export function isMlScoringPossible(): boolean {
  return (config.mlLocalEnabled && config.mlScorer !== 'http') || isSeverityApiConfigured();
}

/** For log lines: what is answering. */
export function scorerLabel(): string {
  const kind = activeScorer();
  if (kind === 'local') return `the local model (${getMlStatus().modelsDir})`;
  if (kind === 'http') return `severity-api at ${config.severityApiUrl}`;
  return 'no scorer';
}

/**
 * Why scoring should not run RIGHT NOW, or null. Only the local scorer pauses (a remote service
 * spends no battery here). Synchronous and cached: the enrichment tick asks before its first
 * await. Pausing is not unavailability — `mlSeverity` and the stored labels stay on screen.
 */
export function scorerPaused(): string | null {
  if (activeScorer() !== 'local') return null;
  if (process.env.LIMN_ML_ON_BATTERY !== 'run' && isOnBattery() === true) return 'on battery';
  return null;
}

/**
 * Batch shape per scorer. The service batches a request itself; the LOCAL scorer scores one
 * comment at a time at a throttled pace (~2 s each at the default share), so its batches stay
 * small: a tick checks its wall-clock budget only BETWEEN batches.
 */
export function scorerBatchLimits(): { maxItems: number; maxChars: number } {
  if (activeScorer() === 'local') return { maxItems: 8, maxChars: config.mlBatchMaxChars };
  return { maxItems: config.mlBatchMaxItems, maxChars: config.mlBatchMaxChars };
}

export interface ScorerHealth {
  /** False when the scorer serves the marker fallback instead of the model (HTTP only). */
  taxonomyLoaded: boolean;
}

/** A readiness probe. The local model has nothing to probe: ready is ready. */
export async function scorerHealth(): Promise<ScorerHealth | null> {
  const kind = activeScorer();
  if (kind === 'local') return { taxonomyLoaded: true };
  if (kind === 'http') {
    const h = await severityHealth();
    return h ? { taxonomyLoaded: h.taxonomyLoaded } : null;
  }
  return null;
}

/**
 * True when a failure proves nothing about reachability: the scorer was there and rejected this
 * one batch. A local model that never LOADED is the "unreachable" case.
 */
export function scorerAnswered(err: unknown): boolean {
  if (err instanceof LocalScorerError) return !err.loadFailed;
  return severityApiAnswered(err);
}

function toWire(r: ScoreResult): SeverityResult {
  return {
    category: r.category,
    categoryProbs: r.categoryProbs,
    severity: r.severity,
    severityOrd: r.severityOrd,
    severityProb: r.severityProb,
    vendorSeverity: r.vendorSeverity as SeverityResult['vendorSeverity'],
    vendorSeverityConfidence: r.vendorSeverityConfidence as SeverityResult['vendorSeverityConfidence'],
    isSummary: r.isSummary,
    backend: r.backend,
  };
}

/** Score a batch. Results come back IN INPUT ORDER; throws on failure (retry next tick). */
export async function scoreComments(items: SeverityRequestItem[]): Promise<SeverityBatchResponse> {
  const kind = activeScorer();
  if (kind === 'local') {
    const dir = getMlStatus().modelsDir!;
    const batch = await scoreLocally(dir, items);
    return { results: batch.results.map(toWire), modelVersion: batch.modelVersion };
  }
  if (kind === 'http') return scoreOverHttp(items);
  throw new LocalScorerError('no scorer is available', true);
}
