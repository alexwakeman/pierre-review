// The three ways `pnpm dev:scratch` fills its database (docs/TESTING.md § Scratch stack).
//
//   demo   the fictional acme/* data of `pnpm demo` (apps/backend/scripts/seed-demo.ts).
//   copy   a consistent snapshot of the reader's REAL dev database, then scrubbed (below).
//          The source is opened READ-ONLY and copied with SQLite's online backup, so the running
//          Limn is never written to and a mid-sync copy is still consistent.
//   empty  nothing: the boot runs the migrations, and sync fills what you add.
//
// ⚠ THE SCRUB IS BELT AND BRACES. The real protection is the write guard in the backend
// (apps/backend/src/scratch-guard.ts): the scrub only stops a copied database from STARTING
// automatic work (auto review, auto post, auto fix, armed merges, Slack, dependency automation).
// Each statement runs on its own, so a column a newer or older schema lacks is skipped and named.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

/** Remove a SQLite file and its WAL siblings. */
export function removeDb(dbPath) {
  for (const s of ['', '-wal', '-shm', '-journal']) rmSync(dbPath + s, { force: true });
}

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : '';
}

/** The pid listening on a TCP port, or null. */
export function listenerPid(port) {
  const out = sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).trim().split('\n').filter(Boolean);
  return out.length > 0 ? Number(out[0]) : null;
}

/** A process's working directory (lsof), or null. */
export function processCwd(pid) {
  const line = sh('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    .split('\n')
    .find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

/** The main checkout (the first entry of `git worktree list`). */
export function mainCheckout(root) {
  const line = sh('git', ['-C', root, 'worktree', 'list', '--porcelain'])
    .split('\n')
    .find((l) => l.startsWith('worktree '));
  return line ? line.slice('worktree '.length) : root;
}

/**
 * The real dev database: the `.sqlite` the process serving :4000 has open, else the dev default of
 * the main checkout. Read-only discovery: lsof only lists files.
 */
export function discoverRealDb(root) {
  const pid = listenerPid(4000);
  if (pid) {
    const open = sh('lsof', ['-p', String(pid), '-Fn'])
      .split('\n')
      .filter((l) => l.startsWith('n') && /\.(sqlite|db)$/.test(l))
      .map((l) => l.slice(1));
    if (open.length > 0) return { path: open[0], from: `the Limn on :4000 (process ${pid})` };
  }
  return {
    path: join(mainCheckout(root), 'apps', 'backend', 'data', 'pierre-review.sqlite'),
    from: 'the main checkout',
  };
}

const SCRUB = [
  ['auto review, auto post, auto fix, diagrams, team claims off', `UPDATE workspaces SET
     auto_review_enabled = 0, auto_post_enabled = 0, auto_fix_enabled = 0,
     auto_diagrams_enabled = 0, team_claims_enabled = 0, withdraw_approval_on_push = 0`],
  ['push automatically off', `UPDATE workspaces SET
     auto_fix_settings = json_set(coalesce(auto_fix_settings, '{}'), '$.autoPush', json('false'))`],
  ['auto verdict and auto resolve off', `UPDATE workspaces SET
     auto_post_settings = json_set(coalesce(auto_post_settings, '{}'),
       '$.autoVerdict', json('false'), '$.autoResolve', json('false'))`],
  ['dependency automation off', `UPDATE workspaces SET
     dependency_auto_merge = 0, dependency_auto_approve = 0, dependency_auto_resolve = 0, dependency_auto_fix = 0`],
  ['platform auto review off', `UPDATE pro_workspace_settings SET auto_review_enabled = 0`],
  ['armed merges deleted', `DELETE FROM auto_merge_requests`],
  ['Slack targets deleted', `DELETE FROM workspace_slack_targets`],
  ['legacy Slack webhook and bot auto-resolve off', `UPDATE pro_settings SET
     slack_webhook_url = NULL, bot_slack_digest = 0, bot_auto_resolve = 0`],
];
const SCRUB_TOKENS = [
  ['tracker tokens removed', `UPDATE workspace_trackers SET auth_token = NULL`],
  ['SonarCloud tokens removed', `UPDATE workspace_sonar SET auth_token = NULL`],
  ['wiki tokens removed', `UPDATE workspace_wiki_credentials SET auth_token = NULL`],
];

/** Defang a copied database. Returns the lines to print. */
export function scrubCopiedDb(Database, dbPath, { keepTracker = false } = {}) {
  const db = new Database(dbPath);
  const report = [];
  try {
    for (const [label, sql] of [...SCRUB, ...(keepTracker ? [] : SCRUB_TOKENS)]) {
      try {
        const r = db.prepare(sql).run();
        report.push(`  ✓ ${label} (${r.changes} rows)`);
      } catch (err) {
        report.push(`  · skipped "${label}": ${err.message}`);
      }
    }
  } finally {
    db.close();
  }
  return report;
}

function backendRequire(backendDir) {
  return createRequire(join(backendDir, 'package.json'));
}

/** Snapshot the real dev database into `dest`, read-only on the source, then scrub it. */
export async function seedCopy({ root, backendDir, dest, keepTracker, refuse }) {
  const src = discoverRealDb(root);
  if (!existsSync(src.path)) refuse(`no database to copy at ${src.path} (${src.from})`);
  if (resolve(realpathSync(src.path)) === resolve(dest)) refuse('the copy would overwrite its own source');
  console.log(`\n▸ copying ${src.path}\n  (${src.from}; opened read-only, SQLite online backup)`);
  const Database = backendRequire(backendDir)('better-sqlite3');
  removeDb(dest);
  const source = new Database(src.path, { readonly: true, fileMustExist: true });
  try {
    await source.backup(dest);
  } finally {
    source.close();
  }
  chmodSync(dest, 0o600);
  console.log('▸ scrubbing the copy');
  for (const line of scrubCopiedDb(Database, dest, { keepTracker })) console.log(line);
}

/** The demo seed (apps/backend/scripts/seed-demo.ts) against the scratch env. */
export function seedDemo({ backendDir, env }) {
  console.log('\n▸ seeding the demo data (acme/*)');
  const r = spawnSync(join(backendDir, 'node_modules', '.bin', 'tsx'), ['scripts/seed-demo.ts'], {
    cwd: backendDir,
    stdio: 'inherit',
    env,
  });
  if (r.status !== 0) throw new Error('seed-demo.ts failed');
}

/** What the folder was seeded with last (`seed.json`), or null. */
export function readSeedMarker(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'seed.json'), 'utf8'));
  } catch {
    return null;
  }
}
