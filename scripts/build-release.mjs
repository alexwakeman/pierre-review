#!/usr/bin/env node
// Assemble a clean ./release/ directory ready for `npm publish`.
//
// Builds the frontend + backend, copies the compiled backend JS, the drizzle
// migration .sql files + meta journal, and the built SPA into ./release/, then
// writes a generated package.json (curated deps: drops the types-only workspace
// `@pierre-review/shared` — which is instead VENDORED at dist/shared and reached by relative
// path — and adds `@fastify/static`).
//
// This script NEVER publishes. Publishing is the user's job (`cd release &&
// npm publish`). It does build, assemble, and verify only.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const backendDir = join(repoRoot, 'apps', 'backend');
const frontendDir = join(repoRoot, 'apps', 'frontend');
const backendDist = join(backendDir, 'dist');
const frontendDist = join(frontendDir, 'dist');
const sharedDir = join(repoRoot, 'packages', 'shared');
const sharedDist = join(sharedDir, 'dist');
const migrationsSrc = join(backendDir, 'src', 'db', 'migrations');
// The platform modules' own migrations (bookkept in `pro_migrations`) and the bundled peer-benchmark
// corpus. Both are read relative to the compiled module (`new URL('./migrations', import.meta.url)`
// in platform/index.js, `../../data/benchmark/…` from platform/bots/benchmark/artifact.js), so
// they are copied to the SAME place under release/dist/platform.
const platformSrc = join(backendDir, 'src', 'platform');
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

// 3b. Build @pierre-review/shared to JS. THE PACKAGE IS STILL NOT A PUBLISHED DEPENDENCY — it is
// VENDORED into release/dist/shared and every bare `@pierre-review/shared` specifier in the
// emitted JS is rewritten to a relative path (near the end of this file), so nothing resolves it
// by name at runtime and the curated manifest stays as it was.
//
// WHY, given "shared is types-only": that rule is mechanical, not architectural — an unshipped
// package cannot be imported by name from npm. It held for as long as shared carried only types,
// and the in-app conflict resolver ended that: `foldFile`/`foldToText`/`CONFLICT_MODEL_VERSION`
// are REAL CODE that the SPA's centre pane and the server's land path must agree on to the byte,
// because one previews what the other pushes. Duplicating them so the emitted backend would stop
// referencing shared is the one outcome that feature cannot survive (see the header of
// apps/frontend/src/lib/mergeResolver.ts). Vendoring keeps the single implementation and still
// ships a package that requires nothing it does not carry.
run('pnpm', ['--filter', '@pierre-review/shared', 'build']);

if (!existsSync(backendDist)) fail('backend dist/ missing after build');
if (!existsSync(sharedDist)) fail('shared dist/ missing after build');
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

// 4b. Vendor the compiled shared package → release/dist/shared. It lives UNDER `dist`, which is
//     already in the manifest's `files`, so it ships with the npm package without the list
//     having to learn about it.
log('vendoring shared → release/dist/shared');
const sharedReleaseDir = join(releaseDist, 'shared');
cpSync(sharedDist, sharedReleaseDir, { recursive: true });
pruneDist(sharedReleaseDir);
const sharedEntry = join(sharedReleaseDir, 'index.js');
if (!existsSync(sharedEntry)) fail('release/dist/shared/index.js missing after vendoring');

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

// 6. Copy built SPA → release/public (served under /app). The npm package ships the app only;
//    the marketing site is a separate static service (apps/site).
log('copying SPA → release/public');
cpSync(frontendDist, join(releaseDir, 'public'), { recursive: true });

// 6c. Copy the platform's migrations + bundled data → release/dist/platform/{migrations,data},
//     beside the compiled platform modules that read them. ⚠ Forgetting
//     `data` fails ONLY IN THE RELEASE: dev reads the file straight out of src/ and looks perfect,
//     while the package answers the benchmark with `available:false`. Hence the mustExist below.
log('copying platform migrations + data → release/dist/platform');
for (const sub of ['migrations', 'data']) {
  cpSync(join(platformSrc, sub), join(releaseDir, 'dist', 'platform', sub), { recursive: true });
}

// 7. Generate release/package.json (version copied from backend; curated deps).
log('generating release/package.json');
const backendPkg = JSON.parse(
  readFileSync(join(backendDir, 'package.json'), 'utf8'),
);
const staticVersion = backendPkg.dependencies['@fastify/static'] ?? '^9.1.3';

// ---- The AI runtime pins (`limnAiRuntime`) ----
//
// Claude Review, the review chat and AI Fix are FREE and ship in this package — but the four SDKs
// they run on do NOT. The Agent SDK carries a ~110 MB native binary per platform, so they are
// installed ON FIRST USE ("Set up AI" in the app, or `limn ai install`) into ~/.limn/ai-runtime
// by apps/backend/src/ai/runtime.ts, which reads the EXACT versions to download from this field.
//
// GENERATED, never typed: each pin is the version the workspace actually installed (what the test
// suite ran against), asserted to satisfy the range apps/backend/package.json declares. A range or
// a tag here would let two users download two different SDKs from the same release.
//
// ⚠ The field name is spelled once more in ai/runtime.ts (AI_RUNTIME_MANIFEST_FIELD); both must
// agree, and the assert at the bottom of this file reads it back from the written manifest.
const AI_RUNTIME_FIELD = 'limnAiRuntime';
const AI_RUNTIME_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@modelcontextprotocol/sdk',
  'zod',
  // The reference-docs converters (docs/REFERENCE-DOCS.md) ride the same first-use download: only
  // the agentic docs library uses them. ai/runtime.ts AI_RUNTIME_LATER_PACKAGES mirrors these three.
  'mammoth',
  'turndown',
  'turndown-plugin-gfm',
];
const DOC_CONVERTERS = ['mammoth', 'turndown', 'turndown-plugin-gfm'];
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function parseVersion(v) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v);
  if (!m) return null;
  return { parts: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], given: [m[1], m[2], m[3]].filter((x) => x !== undefined).length };
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
// The handful of range forms this repo's package.json actually uses: exact, ^, ~, >=.
function satisfies(version, range) {
  const v = parseVersion(version)?.parts;
  if (!v) return false;
  const r = range.trim();
  const op = /^(\^|~|>=)?/.exec(r)[1] ?? '';
  const base = parseVersion(r.slice(op.length));
  if (!base) return false;
  const b = base.parts;
  if (op === '>=') return cmp(v, b) >= 0;
  if (op === '') return base.given === 3 ? cmp(v, b) === 0 : v.slice(0, base.given).every((x, i) => x === b[i]);
  if (cmp(v, b) < 0) return false;
  if (op === '~') return v[0] === b[0] && (base.given < 2 || v[1] === b[1]);
  // ^: the left-most non-zero GIVEN part is fixed.
  if (b[0] !== 0 || base.given === 1) return v[0] === b[0];
  if (b[1] !== 0 || base.given === 2) return v[0] === 0 && v[1] === b[1];
  return v[0] === 0 && v[1] === 0 && v[2] === b[2];
}

const aiRuntimePins = {};
for (const name of AI_RUNTIME_PACKAGES) {
  const declared = backendPkg.dependencies?.[name];
  if (!declared) fail(`apps/backend/package.json does not declare ${name} — the AI runtime pins come from there`);
  const pkgJson = join(backendDir, 'node_modules', ...name.split('/'), 'package.json');
  if (!existsSync(pkgJson)) fail(`${name} is not installed in apps/backend/node_modules — run pnpm install`);
  const installed = JSON.parse(readFileSync(realpathSync(pkgJson), 'utf8')).version;
  if (!EXACT_VERSION.test(installed)) fail(`${name}: installed version ${installed} is not an exact version`);
  if (!satisfies(installed, declared)) {
    fail(`${name}: installed ${installed} does not satisfy apps/backend/package.json's ${declared}`);
  }
  aiRuntimePins[name] = installed;
}

// ---- The Codex CLI pin (`limnAiRuntime['@openai/codex']`) ----
//
// The Codex CLI (docs/CODEX-PLAN.md § 3.7) is NOT a workspace dependency — its native program is
// ~360 MB unpacked per platform, so no dev checkout carries it. Its pin is therefore DECLARED, exact,
// in apps/backend/package.json's own `limnAiRuntime` field (which ai/runtime.ts also reads in dev),
// and copied here. ai/runtime.ts installs it only when the reader asks ("Set up AI" with Codex,
// `limn ai install codex`) and NEVER imports it: it runs the native program.
const CODEX_RUNTIME_PACKAGES = ['@openai/codex'];
// Every AI package spelling that must never be a dependency or a value import: the CLI and its SDK.
const CODEX_SPECIFIERS = ['@openai/codex', '@openai/codex-sdk'];
const declaredAiRuntime = backendPkg[AI_RUNTIME_FIELD] ?? {};
for (const name of CODEX_RUNTIME_PACKAGES) {
  const v = declaredAiRuntime[name];
  if (typeof v !== 'string' || !EXACT_VERSION.test(v)) {
    fail(`apps/backend/package.json ${AI_RUNTIME_FIELD}.${name} must be an exact version, got ${JSON.stringify(v)}`);
  }
  aiRuntimePins[name] = v;
}
for (const name of Object.keys(declaredAiRuntime)) {
  if (!CODEX_RUNTIME_PACKAGES.includes(name)) {
    fail(`apps/backend/package.json ${AI_RUNTIME_FIELD} may only declare ${CODEX_RUNTIME_PACKAGES.join(', ')} (got ${name}) — the other pins come from the workspace install`);
  }
}

// ---- The local scoring runtime + model (`limnMlRuntime`, `limnMlModels`) ----
//
// Bot-comment severity runs in-process on onnxruntime-node (docs/ML-NODE-PORT.md). Same posture as
// the AI SDKs: onnxruntime-node is ~300 MB unpacked (every platform's binaries), so neither it nor
// the tokenizer is a dependency — apps/backend/src/ml/runtime.ts installs them ON FIRST USE at the
// exact versions GENERATED here, and downloads the model from the files `limnMlModels` lists.
// ⚠ Both field names are spelled once more in ml/runtime.ts; the asserts below read them back.
const ML_RUNTIME_FIELD = 'limnMlRuntime';
const ML_MODELS_FIELD = 'limnMlModels';
const ML_RUNTIME_PACKAGES = ['onnxruntime-node', '@huggingface/tokenizers'];
const mlRuntimePins = {};
for (const name of ML_RUNTIME_PACKAGES) {
  const declared = backendPkg.dependencies?.[name];
  if (!declared) fail(`apps/backend/package.json does not declare ${name} — the ML runtime pins come from there`);
  const pkgJson = join(backendDir, 'node_modules', ...name.split('/'), 'package.json');
  if (!existsSync(pkgJson)) fail(`${name} is not installed in apps/backend/node_modules — run pnpm install`);
  const installed = JSON.parse(readFileSync(realpathSync(pkgJson), 'utf8')).version;
  if (!EXACT_VERSION.test(installed)) fail(`${name}: installed version ${installed} is not an exact version`);
  if (!satisfies(installed, declared)) fail(`${name}: installed ${installed} does not satisfy ${declared}`);
  mlRuntimePins[name] = installed;
}
// The model's files are published separately, as assets of a `ml-models-<version>` GitHub release
// on this repo; scripts/ml-models-manifest.mjs writes this file from them (docs/ML-NODE-PORT.md,
// Phase 4). Without it the release lists no model and "Set up" says so.
const mlModelsPath = join(backendDir, 'ml-models.json');
const mlModels = existsSync(mlModelsPath) ? JSON.parse(readFileSync(mlModelsPath, 'utf8')) : null;
if (mlModels) {
  if (typeof mlModels.version !== 'string' || !Array.isArray(mlModels.files) || mlModels.files.length === 0) {
    fail('apps/backend/ml-models.json must carry a version and a non-empty files list');
  }
  for (const f of mlModels.files) {
    if (!/^[0-9a-f]{64}$/.test(f.sha256 ?? '') || !String(f.url ?? '').startsWith('https://') || typeof f.size !== 'number') {
      fail(`apps/backend/ml-models.json: ${f.path} needs an https url, a sha256 and a size`);
    }
  }
} else {
  log('no apps/backend/ml-models.json — this release will not list a model to download');
}

const manifest = {
  // Renamed from `pierre-review` (same release that made Claude Review and AI Fix free). The old
  // package gets a deprecation stub — scripts/deprecated-pierre-review/ — published by hand.
  name: 'limn-review',
  version: backendPkg.version,
  description:
    "Dashboard for tracking your team's GitHub PR activity across repos. Runs on your machine with your gh login.",
  type: 'module',
  author: 'Alex Wakeman',
  repository: {
    type: 'git',
    url: 'git+https://github.com/alexwakeman/pierre-review.git',
  },
  homepage: 'https://github.com/alexwakeman/pierre-review#readme',
  bugs: { url: 'https://github.com/alexwakeman/pierre-review/issues' },
  bin: {
    limn: 'dist/cli.js',
    // ⚠ LOAD-BEARING FOR `npx limn-review`. With more than one bin, npx runs the one named after
    // the PACKAGE and errors ("could not determine executable to run") when none is — so the
    // README's `npx limn-review` needs this entry, not just `limn`.
    'limn-review': 'dist/cli.js',
    // ⚠ NO `pierre-review` BIN HERE. The deprecated alias lives in the forwarding stub
    // (scripts/deprecated-pierre-review/), which still owns that name. Declaring it here too made
    // `npm install -g limn-review` fail with EEXIST for everyone who had installed pierre-review
    // globally: npm refuses to link a global bin another package owns. The CLI still prints the
    // rename notice when the stub starts it under the old name.
  },
  files: ['dist', 'public', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
  engines: { node: '>=20' },
  // NO AI SDK IS A DEPENDENCY. The agentic features ship as code, but the four SDKs they run on
  // (@anthropic-ai/claude-agent-sdk, @anthropic-ai/sdk, @modelcontextprotocol/sdk, zod) are
  // installed ON FIRST USE into ~/.limn/ai-runtime, at the exact versions in `limnAiRuntime`
  // below, and loaded ONLY through dist/ai/runtime.js. See the AI_DEPS and dist-grep guardrails
  // at the bottom of this file and CLAUDE.md "Packaging & publishing".
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
  // Source-available under the Limn License 1.0: free for individuals and for organisations
  // where at most 3 people use it, a commercial licence above that, no competing product, and
  // no conversion to MIT. The full text ships as LICENSE (copied below). npm's
  // documented form for a non-SPDX license is "SEE LICENSE IN <file>".
  license: 'SEE LICENSE IN LICENSE',
  // Not a dependency field: npm ignores it. ai/runtime.ts reads it to know what to download.
  [AI_RUNTIME_FIELD]: aiRuntimePins,
  // Not dependency fields either: ml/runtime.ts reads them to install / download on first use.
  [ML_RUNTIME_FIELD]: mlRuntimePins,
  ...(mlModels ? { [ML_MODELS_FIELD]: mlModels } : {}),
};

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
// Third-party notices: the SPA bundle carries vendored MIT material (the Changes tab's file-type
// icons), whose licence requires the notice to travel with every copy.
const noticesSrc = join(repoRoot, 'THIRD_PARTY_NOTICES.md');
if (!existsSync(noticesSrc)) fail('THIRD_PARTY_NOTICES.md missing at repo root');
cpSync(noticesSrc, join(releaseDir, 'THIRD_PARTY_NOTICES.md'));

// 9. Sanity asserts.
log('verifying release contents');
const mustExist = [
  'dist/cli.js',
  'dist/index.js',
  'dist/app.js',
  'dist/config.js',
  'dist/db/client.js',
  'dist/db/schema.sqlite.js',
  'dist/db/migrations/meta/_journal.json',
  'dist/db/migrations/0008_multitenant_accounts.sql',
  'dist/auth/account.js',
  'dist/auth/crypto.js',
  'dist/review/agent.js',
  'dist/ai/runtime.js',
  'dist/data-dir.js',
  'public/index.html',
];
// The platform entry, its first migration and the peer-benchmark corpus it reads. A missing copy
// step is silent everywhere else: the route answers 200 with `available:false`.
mustExist.push(
  'dist/platform/index.js',
  'dist/platform/migrations/0001_init.sql',
  'dist/platform/data/benchmark/benchmark-fit.json',
);
// Codex's two helper processes (apps/backend/src/ai/codex/): the workspace MCP server and the
// path-guard hook. Codex starts them by FILE PATH (ai/codex/entry.ts picks the compiled `.js`
// sibling in a release), so a missing file only shows when a Codex run starts.
const CODEX_HELPER_ENTRIES = ['dist/ai/codex/workspace-mcp-main.js', 'dist/ai/codex/path-guard-hook-main.js'];
mustExist.push(...CODEX_HELPER_ENTRIES);
for (const rel of mustExist) {
  if (!existsSync(join(releaseDir, rel))) fail(`missing required file: ${rel}`);
}

// The helpers must load from a release install that carries NO AI package (and start fast, once
// per run / per tool call): everything they import, transitively, is a `node:` built-in or a
// relative file. A bare specifier here would be ERR_MODULE_NOT_FOUND inside Codex — where the only
// symptom is an agent that cannot read code, or a hook that exits 1 and so lets every call through.
{
  const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)(['"])([^'"]+)\1/gm;
  for (const entry of CODEX_HELPER_ENTRIES) {
    const seen = new Set();
    const queue = [join(releaseDir, entry)];
    while (queue.length > 0) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      if (!existsSync(file)) fail(`${entry} imports a missing file: ${relative(releaseDir, file)}`);
      for (const m of readFileSync(file, 'utf8').matchAll(SPEC)) {
        const spec = m[2];
        if (spec.startsWith('node:')) continue;
        if (spec.startsWith('./') || spec.startsWith('../')) queue.push(resolve(dirname(file), spec));
        else fail(`${entry} must import only node: built-ins and relative files, but ${relative(releaseDir, file)} imports '${spec}'`);
      }
    }
  }
}

// …and both actually RUN from the release tree: the server answers tools/list, and the hook
// denies a call to a foreign MCP server with exit 2 (a hook that crashes exits 1 = allowed).
{
  const mcp = spawnSync(process.execPath, [join(releaseDir, 'dist/ai/codex/workspace-mcp-main.js'), '--read', releaseDir], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
    encoding: 'utf8',
    timeout: 20_000,
  });
  const listed = (mcp.stdout ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2);
  const names = listed?.result?.tools?.map((t) => t.name).join(',');
  if (names !== 'read_file,list_files,search') fail(`release workspace MCP server did not list its tools: ${mcp.stderr || names}`);
  const hook = spawnSync(process.execPath, [join(releaseDir, 'dist/ai/codex/path-guard-hook-main.js')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'mcp__other__x', tool_input: {}, cwd: releaseDir }),
    env: { ...process.env, LIMN_CODEX_GUARD: JSON.stringify({ read: [releaseDir], write: [] }) },
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (hook.status !== 2 || !/Limn path guard/.test(hook.stderr ?? '')) {
    fail(`release path-guard hook did not deny a foreign MCP call (exit ${hook.status}): ${hook.stderr}`);
  }
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

// Point every emitted `@pierre-review/shared` specifier at the vendored copy. The package name
// never survives into the shipped JS, so the release resolves nothing by a name its manifest does
// not carry — which is what the guardrail below now proves, rather than forbidding the import in
// the first place.
//
// ⚠ ONLY A SPECIFIER POSITION IS TOUCHED — `from '…'`, `import('…')`, `require('…')`. The name
// also appears in comments and in a couple of error strings, and rewriting those would turn the
// guardrail's own explanation into a path.
const SHARED_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])@pierre-review\/shared\2/g;

function rewriteSharedSpecifiers(dir) {
  let rewritten = 0;
  const scan = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        scan(full);
        continue;
      }
      if (!entry.endsWith('.js')) continue;
      const text = readFileSync(full, 'utf8');
      if (!text.includes('@pierre-review/shared')) continue;
      // POSIX separators, and always explicitly relative — Node reads a bare `shared/index.js`
      // as a package name, not a sibling directory.
      let rel = relative(dirname(full), sharedEntry).split(sep).join('/');
      if (!rel.startsWith('.')) rel = `./${rel}`;
      const next = text.replace(SHARED_SPECIFIER, (_m, lead, q) => `${lead}${q}${rel}${q}`);
      if (next === text) continue;
      writeFileSync(full, next);
      rewritten += 1;
    }
  };
  scan(dir);
  return rewritten;
}

log('rewriting @pierre-review/shared imports → ./dist/shared');
let rewrittenFiles = rewriteSharedSpecifiers(releaseDist);
log(`  ${rewrittenFiles} file(s) repointed at the vendored shared`);

// Nothing may still reach the shared package BY NAME — every specifier should have been
// repointed above, and one that was not would resolve against a manifest that does not list it.
// Comments mentioning the name are fine; we match actual import/require statements only.
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
  console.error('Unrewritten @pierre-review/shared import left in the release:');
  for (const h of sharedHits) console.error(`  ${h}`);
  fail('shared is vendored at dist/shared and resolved relatively — these would resolve by name');
}

// ---- No AI SDK in the manifest; installed on first use ----
//
// The npm package must carry ZERO AI SDKs in anything npm installs (`dependencies`,
// `optionalDependencies` — npm installs optional ones by default, and a dependent package cannot
// switch off its dependency's platform binary under `npx`). They arrive on first use instead, at
// the pins in `limnAiRuntime`.
const AI_DEPS = [
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@modelcontextprotocol/sdk',
  'zod',
  ...DOC_CONVERTERS,
  // The Codex CLI (and its platform packages, all named `@openai/codex-<platform>`) and its SDK.
  ...CODEX_SPECIFIERS,
];
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  const leaked = Object.keys(manifest[field] ?? {}).filter(
    (d) => AI_DEPS.includes(d) || d.startsWith('@openai/codex'),
  );
  if (leaked.length > 0) fail(`AI SDK(s) leaked into release/package.json ${field}: ${leaked.join(', ')}`);
}

// The pins must exist, be exact, cover all of them (the Codex CLI's included), and be what the
// written manifest actually says.
const writtenManifest = JSON.parse(readFileSync(join(releaseDir, 'package.json'), 'utf8'));
const writtenPins = writtenManifest[AI_RUNTIME_FIELD] ?? {};
for (const name of [...AI_RUNTIME_PACKAGES, ...CODEX_RUNTIME_PACKAGES]) {
  const v = writtenPins[name];
  if (typeof v !== 'string' || !EXACT_VERSION.test(v)) {
    fail(`${AI_RUNTIME_FIELD}.${name} must be an exact version, got ${JSON.stringify(v)}`);
  }
  if (v !== aiRuntimePins[name]) fail(`${AI_RUNTIME_FIELD}.${name} does not match the installed (or declared) version`);
}
const runtimeSrc = readFileSync(join(backendDir, 'src', 'ai', 'runtime.ts'), 'utf8');
if (!runtimeSrc.includes(`AI_RUNTIME_MANIFEST_FIELD = '${AI_RUNTIME_FIELD}'`)) {
  fail(`apps/backend/src/ai/runtime.ts no longer reads the '${AI_RUNTIME_FIELD}' field this script writes`);
}

// ONE module may import an AI SDK: dist/ai/runtime.js. Anywhere else, a value import fails with
// ERR_MODULE_NOT_FOUND on an npm install — and only when somebody clicks the feature. Type-only
// imports are erased at emit, so any specifier left in the JS is a real one. Subpaths
// (`zod/v4`, `@anthropic-ai/sdk/resources`) count.
const AI_SPECIFIER = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s*)(['"])(?:@anthropic-ai\/claude-agent-sdk|@anthropic-ai\/sdk|@modelcontextprotocol\/sdk|zod|mammoth|turndown|turndown-plugin-gfm|@openai\/codex(?:-[a-z0-9-]+)?)(?:\/[^'"]*)?\1`,
  'm',
);
// ⚠ The Codex CLI is never imported AT ALL — not even by dist/ai/runtime.js, which only locates its
// native program on disk. So a Codex specifier in an import is refused EVERYWHERE, the loader
// included.
const CODEX_IMPORT = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s*)(['"])@openai\/codex(?:-[a-z0-9-]+)?(?:\/[^'"]*)?\1`,
  'm',
);
{
  const text = readFileSync(join(releaseDist, 'ai', 'runtime.js'), 'utf8');
  for (const line of text.split('\n')) {
    if (CODEX_IMPORT.test(line)) fail(`dist/ai/runtime.js imports the Codex CLI — it must only run its program: ${line.trim()}`);
  }
}
const runtimeJs = join(releaseDist, 'ai', 'runtime.js');
const aiImportHits = [];
const scanAiImports = (d) => {
  for (const entry of readdirSync(d)) {
    const full = join(d, entry);
    if (statSync(full).isDirectory()) {
      scanAiImports(full);
      continue;
    }
    if (!entry.endsWith('.js') || full === runtimeJs) continue;
    const text = readFileSync(full, 'utf8');
    for (const line of text.split('\n')) {
      if (AI_SPECIFIER.test(line)) aiImportHits.push(`${relative(releaseDir, full)}: ${line.trim()}`);
    }
  }
};
scanAiImports(releaseDist);
if (aiImportHits.length > 0) {
  console.error('AI SDK imported outside dist/ai/runtime.js:');
  for (const h of aiImportHits) console.error(`  ${h}`);
  fail('load AI SDKs through apps/backend/src/ai/runtime.ts (loadAgentSdk / loadAnthropicSdk / loadZod)');
}
// …and the loader itself must still be the thing that imports them, or the grep proves nothing.
if (!/import\(specifierFor\(spec\)\)/.test(readFileSync(runtimeJs, 'utf8'))) {
  fail('dist/ai/runtime.js no longer loads packages the way this guardrail expects — re-check it');
}

// ---- No model runtime in the manifest either; ONE module imports it ----
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  const leaked = ML_RUNTIME_PACKAGES.filter((d) => d in (manifest[field] ?? {}));
  if (leaked.length > 0) fail(`ML runtime package(s) leaked into release/package.json ${field}: ${leaked.join(', ')}`);
}
for (const name of ML_RUNTIME_PACKAGES) {
  if (writtenManifest[ML_RUNTIME_FIELD]?.[name] !== mlRuntimePins[name]) {
    fail(`${ML_RUNTIME_FIELD}.${name} does not match the installed workspace version`);
  }
}
const mlRuntimeSrc = readFileSync(join(backendDir, 'src', 'ml', 'runtime.ts'), 'utf8');
for (const field of [ML_RUNTIME_FIELD, ML_MODELS_FIELD]) {
  if (!mlRuntimeSrc.includes(`'${field}'`)) fail(`apps/backend/src/ml/runtime.ts no longer reads the '${field}' field`);
}
const ML_SPECIFIER = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s*)(['"])(?:onnxruntime-node|onnxruntime-common|@huggingface\/tokenizers)(?:\/[^'"]*)?\1`,
  'm',
);
const mlRuntimeJs = join(releaseDist, 'ml', 'runtime.js');
const mlImportHits = [];
const scanMlImports = (d) => {
  for (const entry of readdirSync(d)) {
    const full = join(d, entry);
    if (statSync(full).isDirectory()) {
      scanMlImports(full);
      continue;
    }
    if (!entry.endsWith('.js') || full === mlRuntimeJs) continue;
    for (const line of readFileSync(full, 'utf8').split('\n')) {
      if (ML_SPECIFIER.test(line)) mlImportHits.push(`${relative(releaseDir, full)}: ${line.trim()}`);
    }
  }
};
scanMlImports(releaseDist);
if (mlImportHits.length > 0) {
  console.error('Model runtime imported outside dist/ml/runtime.js:');
  for (const h of mlImportHits) console.error(`  ${h}`);
  fail('load onnxruntime-node and the tokenizer through apps/backend/src/ml/runtime.ts');
}

log(`release assembled at ${releaseDir}`);
console.log('');
console.log('Next steps (run these yourself — this script never publishes):');
console.log('  cd release');
console.log('  npm pack --dry-run   # inspect the tarball contents');
console.log('  npm publish          # public by default for the unscoped name (limn-review)');
