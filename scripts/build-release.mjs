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
const landingDir = join(repoRoot, 'apps', 'landing');
const backendDist = join(backendDir, 'dist');
const frontendDist = join(frontendDir, 'dist');
const landingDist = join(landingDir, 'dist');
const migrationsSrc = join(backendDir, 'src', 'db', 'migrations');
const migrationsPgSrc = join(backendDir, 'src', 'db', 'migrations-pg');
const releaseDir = join(repoRoot, 'release');

// --with-pro (cloud image ONLY): additionally build the private @pierre/pro plugin into the
// release + ship the SUMMARY-AI runtime deps the OSS npm package deliberately omits. The public
// npm publish (release.yml) NEVER passes this, so its zero-AI-deps guarantee is unchanged.
const withPro = process.argv.includes('--with-pro');
const proDir = join(repoRoot, 'packages', 'pro');
const proDist = join(proDir, 'dist');

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

// 2b. Build the landing page (Vite → apps/landing/dist) — served at / in cloud.
run('pnpm', ['--filter', '@pierre-review/landing', 'build']);

// 3. Build backend (tsc → apps/backend/dist; picks up cli.ts via tsconfig.build).
run('pnpm', ['--filter', '@pierre-review/backend', 'build']);

if (!existsSync(backendDist)) fail('backend dist/ missing after build');
if (!existsSync(frontendDist)) fail('frontend dist/ missing after build');
if (!existsSync(landingDist)) fail('landing dist/ missing after build');

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

// 5b. Copy pg migrations (.sql + meta/*.json) → release/dist/db/migrations-pg.
log('copying pg migrations → release/dist/db/migrations-pg');
const migrationsPgDst = join(releaseDir, 'dist', 'db', 'migrations-pg');
mkdirSync(join(migrationsPgDst, 'meta'), { recursive: true });
for (const entry of readdirSync(migrationsPgSrc)) {
  if (entry.endsWith('.sql')) {
    cpSync(join(migrationsPgSrc, entry), join(migrationsPgDst, entry));
  }
}
const metaPgSrc = join(migrationsPgSrc, 'meta');
for (const entry of readdirSync(metaPgSrc)) {
  if (entry.endsWith('.json')) {
    cpSync(join(metaPgSrc, entry), join(migrationsPgDst, 'meta', entry));
  }
}

// 6. Copy built SPA → release/public (served under /app), and the landing page
//    → release/public-landing (served at / in cloud).
log('copying SPA → release/public');
cpSync(frontendDist, join(releaseDir, 'public'), { recursive: true });
log('copying landing → release/public-landing');
cpSync(landingDist, join(releaseDir, 'public-landing'), { recursive: true });

// 6c. (cloud image only) Copy the built @pierre/pro plugin + its migrations → release/pro,
//     PRESERVING the dist↔migrations sibling layout so the plugin's `new URL('../migrations',
//     import.meta.url)` resolves to /app/pro/migrations at runtime. The image sets
//     PRO_PLUGIN_PATH=/app/pro/dist/index.js so bind.ts loads it directly (the repo-relative
//     fallback paths don't exist in the flattened release layout).
if (withPro) {
  if (!existsSync(proDist)) {
    fail(
      '--with-pro: packages/pro/dist missing — run `pnpm --filter @pierre/pro build` first ' +
        '(and check the submodule is initialized: `git submodule update --init`).',
    );
  }
  log('copying @pierre/pro (dist + migrations) → release/pro');
  cpSync(proDist, join(releaseDir, 'pro', 'dist'), { recursive: true });
  for (const sub of ['migrations', 'migrations-pg']) {
    const src = join(proDir, sub);
    if (existsSync(src)) cpSync(src, join(releaseDir, 'pro', sub), { recursive: true });
  }
}

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
    "Dashboard for tracking your team's GitHub PR activity across repos — local (SQLite + gh) or self-hosted multi-tenant cloud (Postgres + GitHub App).",
  type: 'module',
  author: 'Alex Wakeman',
  repository: {
    type: 'git',
    url: 'git+https://github.com/alexwakeman/pierre-review.git',
  },
  homepage: 'https://github.com/alexwakeman/pierre-review#readme',
  bugs: { url: 'https://github.com/alexwakeman/pierre-review/issues' },
  bin: {
    pierre: 'dist/cli.js',
    'pierre-review': 'dist/cli.js',
  },
  files: ['dist', 'public', 'public-landing', 'README.md', 'LICENSE'],
  engines: { node: '>=20' },
  // NO AI runtime deps ship in the npm package. Every module that pulls an
  // Anthropic/MCP SDK (@anthropic-ai/claude-agent-sdk, @anthropic-ai/sdk,
  // @modelcontextprotocol/sdk, and zod — used only by the AI tools' submit-review
  // schemas) is reached ONLY through a dynamic `await import()` in the private
  // @pierre/pro plugin's seams (review/agent, coding/agent, coding/merge,
  // review/prepare, review/post-seam) or lazily inside review/llm.ts. The plugin
  // is never in this release (author/dev checkout only), so those imports never
  // execute from npm and their deps are not required. The compiled-but-inert AI
  // .js files still ship as dead code — that's fine; nothing loads them. See the
  // AI_DEPS guardrail assert below and CLAUDE.md "Packaging & publishing".
  dependencies: {
    '@fastify/cookie': backendPkg.dependencies['@fastify/cookie'],
    '@fastify/cors': backendPkg.dependencies['@fastify/cors'],
    '@fastify/secure-session': backendPkg.dependencies['@fastify/secure-session'],
    '@fastify/static': staticVersion,
    '@octokit/graphql': backendPkg.dependencies['@octokit/graphql'],
    'better-sqlite3': backendPkg.dependencies['better-sqlite3'],
    'drizzle-orm': backendPkg.dependencies['drizzle-orm'],
    fastify: backendPkg.dependencies['fastify'],
    'node-cron': backendPkg.dependencies['node-cron'],
    // Postgres driver — only loaded in cloud mode (dynamic import in client.ts).
    pg: backendPkg.dependencies['pg'],
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

// --with-pro: the cloud image runs the @pierre/pro summary-AI plugin, so it needs the runtime
// deps the OSS package omits. The plugin itself only imports drizzle-orm (already present); the
// ONE genuinely-new dep is @anthropic-ai/sdk — CORE's review/llm.ts uses it on the raw metered
// path (SUMMARY_ANTHROPIC_API_KEY, always set in cloud). The AGENTIC SDKs stay out (agentic AI
// is off in cloud). Pro's declared `dependencies` are merged dynamically (no Pro internals are
// hardcoded here), minus any unpublishable workspace specifier.
if (withPro) {
  const proPkg = JSON.parse(readFileSync(join(proDir, 'package.json'), 'utf8'));
  const anthropicVersion =
    proPkg.devDependencies?.['@anthropic-ai/sdk'] ??
    proPkg.dependencies?.['@anthropic-ai/sdk'] ??
    '>=0.93.0';
  manifest.dependencies['@anthropic-ai/sdk'] = anthropicVersion;
  for (const [name, version] of Object.entries(proPkg.dependencies ?? {})) {
    if (String(version).startsWith('workspace:')) continue; // @pierre-review/shared etc.
    manifest.dependencies[name] = version;
  }
  manifest.files = [...manifest.files, 'pro'];
}

writeFileSync(
  join(releaseDir, 'package.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);

// 8. Copy the packaging README + the LICENSE (npm always ships LICENSE, but it
//    must physically sit in release/ since that's what gets published).
log('copying README.md + LICENSE');
cpSync(join(scriptDir, 'release-README.md'), join(releaseDir, 'README.md'));
const licenseSrc = join(repoRoot, 'LICENSE');
if (!existsSync(licenseSrc)) fail('LICENSE missing at repo root');
cpSync(licenseSrc, join(releaseDir, 'LICENSE'));

// 9. Sanity asserts.
log('verifying release contents');
const mustExist = [
  'dist/cli.js',
  'dist/index.js',
  'dist/app.js',
  'dist/config.js',
  'dist/db/client.js',
  'dist/db/schema.sqlite.js',
  'dist/db/schema.pg.js',
  'dist/db/migrations/meta/_journal.json',
  'dist/db/migrations/0008_multitenant_accounts.sql',
  'dist/db/migrations-pg/meta/_journal.json',
  'dist/auth/account.js',
  'dist/auth/crypto.js',
  'dist/api/routes/auth.js',
  'dist/review/agent.js',
  'public/index.html',
  'public-landing/index.html',
];
// The cloud image must actually contain the plugin entry it points PRO_PLUGIN_PATH at.
if (withPro) mustExist.push('pro/dist/index.js');
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
// The plugin imports @pierre-review/shared as `import type` only (stripped at emit), but guard
// the copied-in plugin too so a future value-import can't ship a broken runtime require.
if (withPro) sharedHits.push(...grepSharedImports(join(releaseDir, 'pro')));
if (sharedHits.length > 0) {
  console.error('Runtime import of @pierre-review/shared found in release/dist:');
  for (const h of sharedHits) console.error(`  ${h}`);
  fail('shared package would be required at runtime but is not shipped');
}

// No AI runtime dep in the OSS manifest. The npm package must ship zero Anthropic/MCP SDK
// deps — AI loads only when the private @pierre/pro plugin is present, never from npm. Under
// --with-pro (cloud image ONLY) we DELIBERATELY ship @anthropic-ai/sdk for the summary raw-
// metered path, so it's removed from the forbidden list there — but the AGENTIC SDKs
// (@anthropic-ai/claude-agent-sdk, @modelcontextprotocol/sdk) and zod stay forbidden even in
// cloud, since agentic AI is off there and shipping them would be dead bloat.
const AI_DEPS = withPro
  ? ['@anthropic-ai/claude-agent-sdk', '@modelcontextprotocol/sdk', 'zod']
  : ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'zod'];
const leakedAiDeps = AI_DEPS.filter((d) => d in manifest.dependencies);
if (leakedAiDeps.length > 0) {
  fail(`AI runtime dep(s) leaked into release/package.json: ${leakedAiDeps.join(', ')}`);
}

log(`release assembled at ${releaseDir}`);
console.log('');
console.log('Next steps (run these yourself — this script never publishes):');
console.log('  cd release');
console.log('  npm pack --dry-run   # inspect the tarball contents');
console.log('  npm publish          # public by default for the unscoped name');
