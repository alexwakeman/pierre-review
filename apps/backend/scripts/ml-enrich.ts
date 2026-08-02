// Drain the ML severity/category enrichment backlog from the command line, no server.
//
//   pnpm ml:enrich              # keep running ticks until the backlog is drained
//   pnpm ml:enrich --reset      # DELETE every stored label first (a full re-label)
//   pnpm ml:enrich --once       # one tick, then exit
//
// The same worker the scheduler runs (sync/ml-enrichment.ts) — this just drives it in a loop
// so a first-time backfill of a large history finishes in one sitting instead of two minutes
// at a time. `--reset` is the "full refresh" lever: labels have no other invalidation path
// (a stored label is never re-scored on its own), so re-labelling after a model upgrade means
// clearing them and letting the worker refill.
//
// Needs SEVERITY_API_URL pointing at a running severity-api — see docs/ML-SEVERITY.md.
import { config } from '../src/config.js';
import { runMigrations } from '../src/db/run-migrations.js';
import { closeDb, db, schema } from '../src/db/client.js';
import { runMlEnrichmentTick } from '../src/sync/ml-enrichment.js';
import { isSeverityApiConfigured, severityHealth } from '../src/ml/severity-client.js';

const log = {
  info: (...a: unknown[]) => console.log(...a),
  warn: (...a: unknown[]) => console.warn(...a),
  error: (...a: unknown[]) => console.error(...a),
  // The worker takes a FastifyBaseLogger; only these three are ever called on this path.
} as unknown as Parameters<typeof runMlEnrichmentTick>[0];

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  if (!isSeverityApiConfigured()) {
    console.error(
      'SEVERITY_API_URL is not set (or ML_SEVERITY_DISABLED=true), so there is nothing to run.\n' +
        'Start the sibling service and export the URL:\n' +
        '  SEVERITY_API_PORT=8799 ../pierre-ml/scripts/serve_local.sh &\n' +
        '  export SEVERITY_API_URL=http://127.0.0.1:8799\n' +
        'See docs/ML-SEVERITY.md.',
    );
    process.exit(1);
  }

  await runMigrations();

  const health = await severityHealth();
  if (!health) {
    console.error(`severity-api at ${config.severityApiUrl} did not answer /health.`);
    process.exit(1);
  }
  if (!health.taxonomyLoaded) {
    // Not fatal — the service still answers — but labelling a whole corpus with the marker
    // heuristic and only noticing later is worse than being told now.
    console.warn(
      'WARNING: severity-api is on the MARKER FALLBACK (models_loaded.taxonomy=false). ' +
        'Labels will be low quality. Run `git lfs pull` in pierre-ml and restart it.',
    );
  }

  if (args.has('--reset')) {
    const removed = await db
      .delete(schema.mlCommentLabels)
      .returning({ id: schema.mlCommentLabels.id })
      .execute();
    console.log(`Cleared ${removed.length} stored label(s).`);
  }

  const startedAt = Date.now();
  let total = 0;
  for (let pass = 1; ; pass += 1) {
    const stats = await runMlEnrichmentTick(log);
    total += stats.labelled;
    console.log(
      `pass ${pass}: +${stats.labelled} labelled (${stats.batches} batch(es), ` +
        `${stats.failures} failure(s)) — ${total} total, ` +
        `${Math.round((Date.now() - startedAt) / 1000)}s elapsed`,
    );
    // A pass that labelled nothing means either the backlog is empty or the service is failing;
    // both are reasons to stop rather than spin.
    if (args.has('--once') || stats.labelled === 0) break;
  }
  console.log(`Done. ${total} label(s) written.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
