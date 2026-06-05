// One-off full sync of a single repo, no server. Usage:
//   pnpm sync:once owner/repo
import { config } from '../src/config.js';
import { runMigrations } from '../src/db/run-migrations.js';
import { closeDb } from '../src/db/client.js';
import { getAccessToken, LOCAL_ACCOUNT_ID } from '../src/auth/account.js';
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

  await runMigrations();

  const since = new Date(Date.now() - config.backfillDays * 24 * 60 * 60 * 1000);
  console.log(`Backfilling ${owner}/${name} since ${since.toISOString()} …`);

  const result = await syncRepo({
    owner,
    name,
    accountId: LOCAL_ACCOUNT_ID,
    token: await getAccessToken(LOCAL_ACCOUNT_ID),
    mode: 'full',
    since,
  });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
