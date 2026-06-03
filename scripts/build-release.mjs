#!/usr/bin/env node
// Assemble a clean ./release/ directory ready for `npm publish`.
//
// Builds the frontend + backend, copies the compiled backend JS, the drizzle
// migration .sql files + meta journal, and the built SPA into ./release/, then
// writes a generated package.json (curated deps: drops the types-only workspace
// `@pierre-review/shared`, adds `@fastify/static`).
//
// This script NEVER publishes. Publishing is the user's job (`cd release &&
// npm publish`). It does build, assemble, and verify only.

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const backendDir = join(repoRoot, 'apps', 'backend');
const frontendDir = join(repoRoot, 'apps', 'frontend');
const backendDist = join(backendDir, 'dist');
const frontendDist = join(frontendDir, 'dist');
const migrationsSrc = join(backendDir, 'src', 'db', 'migrations');
const releaseDir = join(repoRoot, 'release');

const log = (msg) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
};

function run(cmd, args) {
  log(`${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: repoRoot });
}

// 1. Clean the release dir.
log('cleaning release/');
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

// 2. Build frontend (Vite → apps/frontend/dist).
run('pnpm', ['--filter', '@pierre-review/frontend', 'build']);

// 3. Build backend (tsc → apps/backend/dist; picks up cli.ts via tsconfig.build).
run('pnpm', ['--filter', '@pierre-review/backend', 'build']);

if (!existsSync(backendDist)) fail('backend dist/ missing after build');
if (!existsSync(frontendDist)) fail('frontend dist/ missing after build');

// 4. Copy compiled backend → release/dist, then prune non-artifact files
//    (sourcemaps + any stray compiled tests) so only production JS ships.
log('copying backend dist → release/dist');
const releaseDist = join(releaseDir, 'dist');
cpSync(backendDist, releaseDist, { recursive: true });
pruneDist(releaseDist);

function pruneDist(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) pruneDist(full);
    else if (entry.endsWith('.js.map') || entry.endsWith('.test.js')) {
      rmSync(full);
    }
  }
}

// 5. Copy migrations (.sql + meta/*.json only) → release/dist/db/migrations.
log('copying migrations → release/dist/db/migrations');
const migrationsDst = join(releaseDir, 'dist', 'db', 'migrations');
mkdirSync(join(migrationsDst, 'meta'), { recursive: true });
for (const entry of readdirSync(migrationsSrc)) {
  if (entry.endsWith('.sql')) {
    cpSync(join(migrationsSrc, entry), join(migrationsDst, entry));
  }
}
const metaSrc = join(migrationsSrc, 'meta');
for (const entry of readdirSync(metaSrc)) {
  if (entry.endsWith('.json')) {
    cpSync(join(metaSrc, entry), join(migrationsDst, 'meta', entry));
  }
}

// 6. Copy built SPA → release/public.
log('copying SPA → release/public');
cpSync(frontendDist, join(releaseDir, 'public'), { recursive: true });

// 7. Generate release/package.json (version copied from backend; curated deps).
log('generating release/package.json');
const backendPkg = JSON.parse(
  readFileSync(join(backendDir, 'package.json'), 'utf8'),
);
const staticVersion = backendPkg.dependencies['@fastify/static'] ?? '^9.1.3';

const manifest = {
  name: 'pierre-review',
  version: backendPkg.version,
  description:
    "Local-only dashboard for tracking your team's GitHub PR activity across repos.",
  type: 'module',
  bin: {
    pierre: 'dist/cli.js',
    'pierre-review': 'dist/cli.js',
  },
  files: ['dist', 'public', 'README.md'],
  engines: { node: '>=20' },
  dependencies: {
    '@fastify/cors': backendPkg.dependencies['@fastify/cors'],
    '@fastify/static': staticVersion,
    '@octokit/graphql': backendPkg.dependencies['@octokit/graphql'],
    'better-sqlite3': backendPkg.dependencies['better-sqlite3'],
    'drizzle-orm': backendPkg.dependencies['drizzle-orm'],
    fastify: backendPkg.dependencies['fastify'],
    'node-cron': backendPkg.dependencies['node-cron'],
  },
  keywords: [
    'github',
    'pull-requests',
    'code-review',
    'dashboard',
    'cli',
    'team',
  ],
  license: 'MIT',
};
writeFileSync(
  join(releaseDir, 'package.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);

// 8. Copy the packaging README.
log('copying README.md');
cpSync(join(scriptDir, 'release-README.md'), join(releaseDir, 'README.md'));

// 9. Sanity asserts.
log('verifying release contents');
const mustExist = [
  'dist/cli.js',
  'dist/index.js',
  'dist/app.js',
  'dist/config.js',
  'dist/db/migrations/meta/_journal.json',
  'public/index.html',
];
for (const rel of mustExist) {
  if (!existsSync(join(releaseDir, rel))) fail(`missing required file: ${rel}`);
}

// No .ts files anywhere under release/.
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry.endsWith('.ts')) {
      fail(`TypeScript source leaked into release: ${relative(releaseDir, full)}`);
    }
  }
}
walk(releaseDir);

// No real runtime reference to the unshipped shared package (catches a regression
// where a value import sneaks back in). Comments mentioning the name are fine; we
// match actual import/require statements only.
function grepSharedImports(dir) {
  const hits = [];
  const importRe =
    /(from\s+['"]@pierre-review\/shared['"]|require\(\s*['"]@pierre-review\/shared['"]\s*\))/;
  const scan = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) scan(full);
      else if (entry.endsWith('.js')) {
        const text = readFileSync(full, 'utf8');
        for (const line of text.split('\n')) {
          if (importRe.test(line)) hits.push(`${relative(releaseDir, full)}: ${line.trim()}`);
        }
      }
    }
  };
  scan(dir);
  return hits;
}
const sharedHits = grepSharedImports(join(releaseDir, 'dist'));
if (sharedHits.length > 0) {
  console.error('Runtime import of @pierre-review/shared found in release/dist:');
  for (const h of sharedHits) console.error(`  ${h}`);
  fail('shared package would be required at runtime but is not shipped');
}

log(`release assembled at ${releaseDir}`);
console.log('');
console.log('Next steps (run these yourself — this script never publishes):');
console.log('  cd release');
console.log('  npm pack --dry-run   # inspect the tarball contents');
console.log('  npm publish          # public by default for the unscoped name');
