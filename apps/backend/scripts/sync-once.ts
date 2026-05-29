// One-off full sync of a single repo, no server. Usage:
//   pnpm sync:once owner/repo
import { config } from '../src/config.js';
import { runMigrations } from '../src/db/run-migrations.js';
import { sqlite } from '../src/db/client.js';
import { syncRepo } from '../src/sync/sync-repo.js';

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg || !arg.includes('/')) {
    console.error('Usage: pnpm sync:once owner/repo');
    process.exit(1);
  }
  const [owner, name] = arg.split('/');
  if (!owner || !name) {
    console.error('Usage: pnpm sync:once owner/repo');
    process.exit(1);
  }

  runMigrations();

  const since = new Date(Date.now() - config.backfillDays * 24 * 60 * 60 * 1000);
  console.log(`Backfilling ${owner}/${name} since ${since.toISOString()} …`);

  const result = await syncRepo({ owner, name, mode: 'full', since });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => sqlite.close());
