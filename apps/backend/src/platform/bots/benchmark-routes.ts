import type { FastifyInstance } from 'fastify';
import type {
  BotBenchmarkCellEntry,
  BotBenchmarkResponse,
} from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import { loadBenchmarkArtifact, type LoadedArtifactOk } from './benchmark/artifact.js';
import { mapCell, mapManifest, mapUnfittableVendor } from './benchmark/map.js';

// GET /api/pro/bot-benchmark — the PEER COHORT half of "how does our bot compare".
//
// Serves the bundled `bot_monitor.benchmark_fit` artifact: per-(vendor × activity band) fitted
// distributions, their refusals, and the manifest that says what every number means. Nothing here
// touches the database, GitHub or Anthropic, and NOTHING ABOUT THE CALLER REACHES THE RESPONSE —
// the artifact is identical for every tenant and names no repository and no actor.
//
// ⚠ NO `?workspace=` AND NO `workspaceId` ECHO. That is a deliberate exception to host §5.1, not an
// oversight: the scope parameter exists to bound which of a tenant's repos a response covers, and
// this response covers none of them. There is no tenant data, so there is no IDOR surface and no
// existence oracle to protect.
//
// ── WHAT THIS ROUTE DOES NOT DO ─────────────────────────────────────────────────────────────────
// It makes NO claim about any customer. The per-(repository × automated reviewer) placement fold —
// computing the caller's own metric vector over the corpus's populations and `settle_hours`, plus
// each repo's merged-PRs-per-14-days for band assignment — is a SEPARATE step with its own
// correctness problem (the app's `actedOnPct` folds in the `likely_addressed` commit heuristic and
// divides by every in-window thread; the cohort's `acted_on_rate` divides by settled, fully-read
// threads; six of the thirteen metrics have no app counterpart at all). Serving the cohort and
// placing a customer in it are two decisions, and mixing them is how a benchmark starts comparing
// two columns that share a name and nothing else.
//
// ⚠ IF THIS ROUTE EVER GROWS A PLACEMENT LEG, ITS RATE TIER MUST BE RE-DECIDED IN THAT SAME
// CHANGE. The tier below is argued from "the response body is the work"; a leg that reads the
// tenant's PRs is a different cost with a different bucket. `/api/attention` learned this the
// expensive way — the fold moved in and the tier moved after the fact. Likewise it must never grow
// a GENERATION leg.
//
// ENTITLEMENT, three layers (the standard /api/pro/* stack, the bot-behaviour precedent verbatim):
//  1. Registration — the route exists only when the plugin loads; a pure-OSS checkout has no route
//     at all, and the SPA never fetches (its hook ANDs `botDepth` into its own `enabled`).
//  2. Self-gate — `botDepth` maps to the paid summary tier (PRO_DIGEST_ENABLED), so a flag-less
//     local run 404s a direct hit instead of leaking the corpus.
//  3. Cloud per-account entitlement — the host's AUTOMATIC /api/pro/* 402 gate
//     (api/plugins/auth.ts `registerAuthGate`/`isProPath`). Staying under the `/api/pro/` prefix is
//     the entire reason that is automatic; moving this route out from under it silently makes the
//     corpus free.

/** ⚠ MIRRORED from `@pierre-review/shared`'s `BOT_BENCHMARK_MAX_CELLS` (the plugin only
 *  `import type`s from that package — the AI_CREDITS_PER_USD mirror pattern). Keep in step. */
export const MAX_CELLS = 24;

/** `vendor:band`. Vendor strings are the fitter's vocabulary (lowercase, `_`/`-`); band is a rank
 *  decile. Anything else is a 400 — the vocabulary is closed and a typo must not read as absence. */
const CELL_KEY = /^([a-z0-9][a-z0-9_-]{0,63}):(\d{1,3})$/;

interface ParsedCells {
  keys: Array<{ vendor: string; band: number }>;
}

type ParseResult = ParsedCells | { error: string };

// ⚠ `string | string[]`, NOT `string`. Fastify's default query parser hands back an ARRAY the
// moment a key repeats (`?cells=a&cells=b`), and a `Querystring` generic saying `string` is an
// assertion the parser never promised to honour — the compiler believes it, `raw.trim()` throws
// `raw.trim is not a function`, and a caller who repeated a parameter gets a 500 where the honest
// answers are 200 or 400. A repeat is treated as one more comma-separated group rather than
// last-wins: the two spellings mean the same thing to anyone writing the URL by hand, and silently
// dropping the earlier keys would be the truncation the cap below refuses to perform.
function parseCells(raw: string | string[] | undefined): ParseResult | null {
  const groups = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const parts = groups
    .flatMap((g) => (typeof g === 'string' ? g.split(',') : []))
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parts.length === 0) return null;
  // ⚠ A 400, NEVER A SILENT TRUNCATION. A truncated cell list reads to the consumer as "those
  // cohorts do not exist", which is the one claim this whole feature must never make by accident.
  if (parts.length > MAX_CELLS) {
    return {
      error: `at most ${MAX_CELLS} cells per request (asked for ${parts.length})`,
    };
  }
  const keys: Array<{ vendor: string; band: number }> = [];
  for (const part of parts) {
    const m = CELL_KEY.exec(part);
    if (!m) return { error: `malformed cell selector "${part}" — expected vendor:band` };
    keys.push({ vendor: m[1] as string, band: Number.parseInt(m[2] as string, 10) });
  }
  return { keys };
}

export function registerBotBenchmarkRoutes(app: FastifyInstance, _ctx: ProContext): void {
  type Q = { Querystring: { cells?: string | string[] } };
  app.get<Q>('/api/pro/bot-benchmark', async (req, reply) => {
    const parsed = parseCells(req.query.cells);
    if (parsed != null && 'error' in parsed) {
      return reply.code(400).send({ error: parsed.error });
    }

    const loaded = loadBenchmarkArtifact();
    if (!loaded.ok) {
      // ⚠ 200, NOT 500. "No corpus is bundled in this build" is a build-configuration fact, not a
      // server fault: a 500 pages someone, and the SPA's sentence here ("peer benchmarking isn't
      // available in this build") is a DIFFERENT sentence from "there isn't enough peer data yet".
      const body: BotBenchmarkResponse = {
        available: false,
        reason: loaded.reason,
        message: loaded.message,
      };
      return body;
    }

    const body: BotBenchmarkResponse = {
      available: true,
      manifest: mapManifest(loaded, Date.now()),
    };
    if (parsed != null) body.cells = parsed.keys.map((k) => resolveCell(loaded, k.vendor, k.band));
    return body;
  });
}

/**
 * One requested key → a cell, a refusal, or a STATED ABSENCE.
 *
 * ⚠ THE THREE ABSENT REASONS ARE THREE DIFFERENT SENTENCES, and collapsing them into one empty
 * answer is the failure this arm exists to prevent. "Your bot's cohort is structurally impossible"
 * (`in_house` is a catch-all over three unrelated reviewers plus everything fronted by
 * `github-actions[bot]`), "this stratum is empty", and "we have never seen this vendor" are not
 * the same claim — and the last one is REACHABLE FROM A VOCABULARY MISMATCH, not from a gap in the
 * data: the host's `AutomatedReviewerKind` and the fitter's vendor set overlap but are not equal
 * (the host knows `github_code_quality`, `pierre`, `vendor`; the fitter knows `codeant`). A naive
 * join renders "no peer data" where the truth is "these are different vocabularies".
 */
function resolveCell(
  loaded: LoadedArtifactOk,
  vendor: string,
  band: number,
): BotBenchmarkCellEntry {
  const unfittable = loaded.unfittable.get(vendor);
  if (unfittable != null) {
    return {
      status: 'absent',
      vendor,
      activityBand: band,
      reason: 'vendor_unfittable',
      message:
        'No cohort is formed for this vendor string at any n — it names no product, so a cell ' +
        'keyed on it would pool unrelated reviewers.',
      unfittable: mapUnfittableVendor(vendor, unfittable),
    };
  }
  const bands = loaded.cells.get(vendor);
  if (bands == null) {
    return {
      status: 'absent',
      vendor,
      activityBand: band,
      reason: 'vendor_not_in_corpus_vocabulary',
      message:
        'This vendor does not appear in the corpus at all. It may be a reviewer the corpus walk ' +
        'has never observed, or a name this build spells differently from the fitter.',
    };
  }
  const cell = bands.get(band);
  if (cell == null) {
    return {
      status: 'absent',
      vendor,
      activityBand: band,
      reason: 'cell_not_in_corpus',
      message:
        'The corpus holds cells for this vendor, but none in this activity band — no repository ' +
        'running it landed in that stratum.',
    };
  }
  return mapCell(cell, vendor, band);
}
