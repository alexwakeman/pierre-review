// Backfill the VENDOR'S OWN severity badge onto already-labelled bot text — and nothing else.
//
//   pnpm ml:reparse-badges              # fill in every missing badge
//   pnpm ml:reparse-badges --dry-run    # report what WOULD change, write nothing
//   pnpm ml:reparse-badges --all        # also re-parse rows that already carry a badge
//
// This is the SAFE half of `pnpm ml:enrich --reset`. A reset re-scores the whole corpus against
// whatever artifact is served today, which moves every number on screen (severities, category
// mix, Bots verdicts, the agreement matrix) as a side effect of wanting one missing badge. This
// command calls the marker-only endpoint — no model, no inference, no GPU — and writes exactly
// `vendor_severity` + `vendor_severity_confidence`. See sync/reparse-vendor-badges.ts for the
// rules it holds to (never clears an existing badge, idempotent, resumable) and
// docs/ML-SEVERITY.md for the coverage gap it closes.
//
// Needs SEVERITY_API_URL pointing at a running severity-api; needs no GitHub token.
import { config } from '../src/config.js';
import { runMigrations } from '../src/db/run-migrations.js';
import { closeDb } from '../src/db/client.js';
import { reparseVendorBadges } from '../src/sync/reparse-vendor-badges.js';
import { isSeverityApiConfigured } from '../src/ml/severity-client.js';

const log = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(msg),
};

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const includeBadged = args.has('--all');

  if (!isSeverityApiConfigured()) {
    console.error(
      'SEVERITY_API_URL is not set (or ML_SEVERITY_DISABLED=true), so there is nothing to run.\n' +
        'Start the sibling service and export the URL:\n' +
        '  SEVERITY_API_PORT=8799 packages/ml/scripts/serve_local.sh &\n' +
        '  export SEVERITY_API_URL=http://127.0.0.1:8799\n' +
        'See docs/ML-SEVERITY.md.',
    );
    process.exit(1);
  }

  // No /health probe on purpose: this endpoint answers from the deterministic marker parser and
  // takes no model dependency at all, so `models_loaded.taxonomy:false` — the thing that health
  // check exists to report — has no bearing on whether the sweep is trustworthy. A service that
  // is not there fails the first batches and the sweep says so.
  await runMigrations();

  console.log(
    `Re-parsing vendor badges against ${config.severityApiUrl}` +
      (includeBadged ? ' (including rows that already carry one)' : ' (rows with none)') +
      (dryRun ? ' — DRY RUN, nothing will be written' : ''),
  );

  const startedAt = Date.now();
  const stats = await reparseVendorBadges({ dryRun, includeBadged, log });
  const elapsed = Math.round((Date.now() - startedAt) / 1000);

  console.log('');
  console.log(
    `${dryRun ? 'Would badge' : 'Badged'} ${stats.updated} row(s) of ${stats.scanned} scanned ` +
      `in ${stats.requests} request(s), ${elapsed}s` +
      (stats.failures > 0 ? ` — ${stats.failures} failure(s)` : ''),
  );
  console.log(
    `  gained ${stats.gained} · changed ${stats.changed} · unchanged ${stats.unchanged} · ` +
      `no claim ${stats.noClaim} · no text ${stats.skipped}`,
  );

  if (stats.byVendor.length > 0) {
    console.log('');
    console.log('Per vendor (gained = a row that had no badge and now has one):');
    const width = Math.max(...stats.byVendor.map((v) => v.vendor.length));
    for (const v of stats.byVendor) {
      console.log(
        `  ${v.vendor.padEnd(width)}  ${pad(v.scanned, 6)} scanned  ${pad(v.gained, 6)} gained  ` +
          `${pad(v.changed, 6)} changed  ${pad(v.unchanged, 6)} unchanged  ` +
          `${pad(v.noClaim, 6)} no claim`,
      );
    }
    // The honest reading of a big "no claim" column: those vendors genuinely declare no
    // severity, or those particular comments carry no badge (a review summary, a prose reply).
    // Nothing here synthesizes one — see the module docstring.
  }

  if (stats.failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
