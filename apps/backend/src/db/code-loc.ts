import type { StoredPrFile } from '@pierre-review/shared';

// ============================================================================
// Code-only lines-of-change for a pull request — the input to the LARGE-PR FLAG.
// ============================================================================
//
// "Large" is a claim about how much CODE a reviewer has to read, so a 2,000-line
// lockfile bump, a regenerated OpenAPI schema or a docs rewrite must not trip it.
// `codeLocFor` folds the PR's stored `files[]` (additions + deletions per file),
// dropping everything `isNonCodeFile` classifies as prose, structured config,
// generated/vendored output or binary payload.
//
// ---- RELATIONSHIP TO THE TWO CLASSIFIERS THAT ALREADY EXIST -----------------
//
// There are now THREE path classifiers in this repo and they answer three
// different questions. They are NOT meant to agree, and none may be folded into
// another:
//
//   1. `NOISE_GLOBS` — apps/backend/src/review/prepare.ts
//      "Which files should be stripped from the diff the Claude Review AGENT
//      sees?" A BUDGET decision on a paid feature: lockfiles, minified bundles,
//      dist/build output, snapshots. It deliberately keeps `.md`, `.yml`, `.json`
//      and `docs/` IN the diff, because a review agent reading a config change is
//      doing its job. ⚠ Widening it to satisfy THIS feature would silently change
//      what a paid agent reviews, with no test to catch it.
//
//   2. `isLockFile` — apps/frontend/src/lib/diff.ts
//      "Should this file's diff start COLLAPSED in the Changes tab?" Lockfiles
//      only, by exact basename, case-sensitively (matching what git records).
//      A narrow presentation heuristic; far too narrow to answer "is this code".
//
//   3. `isNonCodeFile` — HERE
//      "Does this file's churn count toward how much CODE this PR asks a human to
//      read?" The broadest of the three, and the only one that excludes prose and
//      structured config. Case-INSENSITIVE (a `Readme.MD` is still prose), and
//      the only one whose answer is a number a user compares against a threshold
//      they configured.
//
// ---- THE THREE DATA TRAPS (all measured on the real corpus) -----------------
//
// See `codeLocFor` for how each is handled. In one line each:
//   * 18.5% of PRs have `files IS NULL`, and 18.8% carry a never-observed size —
//     `codeLoc` is NULL there, never 0. "Not large" about a PR nobody measured is
//     a false claim (the same rule `lib/botVolume.ts`'s `formatLoc` states).
//   * `files(first: 100)` truncates, and it truncates EXACTLY the largest PRs —
//     so `codeLocIsLowerBound` rides alongside and the reading is ASYMMETRIC:
//     over-threshold is safe to assert, under-threshold is not.
//   * `files = []` is OVERLOADED: it is also `sync/routing-files.ts`'s "we tried
//     and failed" sentinel. It never means "zero code lines".

/** The page size of the `files(first: 100)` connection in `github/queries.ts`. A PR whose
 *  stored `files[]` is at this length was (or may have been) truncated by that cap. */
export const PR_FILES_PAGE_CAP = 100;

// ---- the classifier ---------------------------------------------------------

function normalize(path: string): string {
  let p = path.replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/')) p = p.slice(1);
  return p;
}

/** Prose. Extensions whose content is written for humans, not machines. */
const DOC_EXTENSIONS = new Set([
  'md',
  'mdx',
  'markdown',
  'mdown',
  'rst',
  'txt',
  'adoc',
  'asciidoc',
  'org',
  'tex',
  'pdf',
]);

/** Structured configuration + data. NOT `.html`/`.css`/`.scss`/`.sql`, which are hand-written
 *  source a reviewer must actually read. `.xml` is here because in practice it is manifests,
 *  poms and layouts — data with a schema, not logic. */
const CONFIG_EXTENSIONS = new Set([
  'json',
  'json5',
  'jsonc',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'properties',
  'plist',
  'xml',
  'csv',
  'tsv',
  'lock',
  'lockfile',
]);

/** Binary / media payloads. Their "additions" are a diff artefact, not lines anyone reads. */
const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'ico',
  'icns',
  'webp',
  'avif',
  'svg',
  'tiff',
  'psd',
  'mp3',
  'mp4',
  'mov',
  'webm',
  'wav',
  'ogg',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'zip',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'jar',
  'war',
  'so',
  'dylib',
  'dll',
  'exe',
  'bin',
  'wasm',
  'pyc',
  'class',
  'pdb',
  'db',
  'sqlite',
  'parquet',
]);

/** Machine-generated language lock files, by exact (lower-cased) basename. Deliberately a
 *  SUPERSET of the frontend's `isLockFile` list — this one also has the `*.lock` /
 *  `*.lockfile` extension arms above, which that one refuses on purpose. */
const LOCK_BASENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'cargo.lock',
  'poetry.lock',
  'uv.lock',
  'pipfile.lock',
  'gemfile.lock',
  'composer.lock',
  'go.sum',
  'flake.lock',
  'package.resolved',
  'gradle.lockfile',
  'mix.lock',
  'pubspec.lock',
  'packages.lock.json',
]);

/** Extensionless files that are prose or project metadata rather than source. Matched on the
 *  lower-cased basename with any doc extension already stripped. */
const DOC_BASENAMES = new Set([
  'readme',
  'license',
  'licence',
  'copying',
  'notice',
  'authors',
  'contributors',
  'changelog',
  'changes',
  'history',
  'contributing',
  'code_of_conduct',
  'security',
  'codeowners',
  'owners',
  'maintainers',
  'patents',
  'acknowledgements',
  'acknowledgments',
]);

/** Directory names whose whole subtree is prose or generated/vendored output. Matched as a
 *  WHOLE path segment, anywhere in the path, so `apps/backend/docs/x.ts` counts too. */
const NON_CODE_DIRS = new Set([
  'docs',
  'doc',
  'documentation',
  'node_modules',
  'vendor',
  'vendored',
  'third_party',
  'thirdparty',
  '3rdparty',
  'dist',
  'build',
  'out',
  'generated',
  'gen',
  'autogen',
  'coverage',
  '__snapshots__',
  '__pycache__',
  'fixtures',
  '__fixtures__',
  'testdata',
  'golden',
  'snapshots',
]);

function lastSegment(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function extensionOf(basename: string): string {
  const idx = basename.lastIndexOf('.');
  // A leading dot is a DOTFILE marker, not an extension (`.eslintrc` has no extension).
  if (idx <= 0) return '';
  return basename.slice(idx + 1);
}

/**
 * Does this path's churn count as CODE for the large-PR flag?
 *
 * Returns true for documentation, structured configuration, dotfiles, lockfiles, binary/media
 * payloads and anything living under a generated / vendored / docs directory.
 *
 * ⚠ Read the "relationship to the two classifiers that already exist" block at the top of this
 * file before widening it — and in particular do NOT reach for `review/prepare.ts`'s
 * `NOISE_GLOBS` instead: that list is a paid agent's diff budget and answers a different
 * question.
 */
export function isNonCodeFile(path: string): boolean {
  const p = normalize(path).toLowerCase();
  if (p === '') return true;

  const segments = p.split('/');
  const base = lastSegment(p);

  // Dot-directories are tooling/config trees in their entirety (.github/, .vscode/, .circleci/,
  // .idea/, .storybook/), and so is everything under a docs / generated / vendored directory.
  //
  // ⚠ DIRECTORY SEGMENTS ONLY — `segments.length - 1`, never the whole array. A file named
  // `build` (as in `scripts/build`, a shell entrypoint) is source code; only a DIRECTORY called
  // `build` is output. Testing the basename against the directory list is how a hand-written
  // script gets silently uncounted.
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (seg.startsWith('.')) return true;
    if (NON_CODE_DIRS.has(seg)) return true;
  }

  // A dotfile basename (.env, .env.local, .gitignore, .eslintrc.js, .prettierrc) is
  // configuration whatever extension it carries.
  if (base.startsWith('.')) return true;

  if (LOCK_BASENAMES.has(base)) return true;

  // Minified / sourcemap / snapshot artefacts, by compound suffix (a plain extension set can't
  // express `.min.js`, whose extension is `js`).
  if (
    base.endsWith('.min.js') ||
    base.endsWith('.min.css') ||
    base.endsWith('.min.mjs') ||
    base.endsWith('.map') ||
    base.endsWith('.snap')
  ) {
    return true;
  }

  // Conventional "this file was generated" markers, which no reviewer reads line by line.
  if (
    base.includes('.generated.') ||
    base.endsWith('.gen.go') ||
    base.endsWith('.pb.go') ||
    base.endsWith('_pb2.py') ||
    base.endsWith('_pb2.pyi') ||
    base.endsWith('.pb.cc') ||
    base.endsWith('.pb.h') ||
    base.endsWith('.g.dart') ||
    base.endsWith('.freezed.dart')
  ) {
    return true;
  }

  const ext = extensionOf(base);
  if (ext === '') {
    // No extension at all: prose/metadata by name (README, LICENSE, CODEOWNERS), otherwise a
    // script or a Dockerfile/Makefile — hand-written logic, which COUNTS.
    return DOC_BASENAMES.has(base);
  }
  if (DOC_EXTENSIONS.has(ext)) return true;
  if (CONFIG_EXTENSIONS.has(ext)) return true;
  if (BINARY_EXTENSIONS.has(ext)) return true;

  // A prose basename that carries a doc-ish extension is already caught above; one carrying a
  // code extension (e.g. `changelog.ts`) is real source and must not be excluded — hence no
  // DOC_BASENAMES check down here.
  return false;
}

// ---- the fold ---------------------------------------------------------------

export interface CodeLocResult {
  /** additions + deletions over the PR's CODE files, or null when it cannot be known. */
  codeLoc: number | null;
  /** True when `codeLoc` is a FLOOR, not the figure — the PR's file list was truncated.
   *  Read asymmetrically: over-threshold is safe to assert, under-threshold is not. */
  codeLocIsLowerBound: boolean;
}

/** The one honest "we don't know". Never `{codeLoc: 0}` — see the trap notes above. */
const UNKNOWN: CodeLocResult = { codeLoc: null, codeLocIsLowerBound: false };

/**
 * Fold a stored PR row into its code-only line count.
 *
 * The three data traps, each handled explicitly:
 *
 * 1. **`files IS NULL`** (18.5% of the real corpus) — the per-file breakdown was never stored
 *    for this PR. Nothing to fold → `null`.
 *
 * 2. **A never-observed size** (18.8%) — `additions`, `deletions` and `changedFiles` are all 0.
 *    Those columns are NOT NULL with a 0 default, so "we never saw this PR's size" and "this PR
 *    genuinely changed nothing" are the SAME row. `lib/botVolume.ts` states the rule for the
 *    total-LoC label and it holds identically here: send null, never a fabricated 0, because
 *    rendering "not large" about a PR nobody measured is a false claim.
 *
 * 3. **`files = []` is OVERLOADED** — `sync/routing-files.ts` persists `[]` as a "we tried and
 *    failed" sentinel, which is byte-identical to a PR that really touched nothing. The
 *    cross-check is `changedFiles`: a PR with `changedFiles > 0` and an empty `files` array is
 *    the sentinel, and treating it as zero code lines would mark real PRs as trivially small.
 *    We go further and return null for EVERY empty array, because the only remaining case —
 *    `changedFiles === 0` — has already been answered by trap 2.
 *
 * 4. (Not a trap so much as a bound.) `files(first: 100)` truncates. `codeLocIsLowerBound` is
 *    set when the stored list hit the page cap OR when `changedFiles` exceeds what we hold —
 *    both mean files are missing, and a missing file can only ADD lines.
 */
export function codeLocFor(pr: {
  files: StoredPrFile[] | null | undefined;
  additions: number;
  deletions: number;
  changedFiles: number;
}): CodeLocResult {
  // Trap 2 first: it subsumes the "genuinely empty PR" reading of trap 3, and it is true
  // regardless of what `files` holds.
  if (pr.additions === 0 && pr.deletions === 0 && pr.changedFiles === 0) return UNKNOWN;
  // Trap 1.
  if (pr.files == null) return UNKNOWN;
  // Trap 3: an empty array with a non-zero size is the routing-files sentinel (or a partial
  // write); either way we hold no per-file breakdown to classify.
  if (pr.files.length === 0) return UNKNOWN;

  let codeLoc = 0;
  for (const f of pr.files) {
    if (typeof f?.path !== 'string') continue;
    if (isNonCodeFile(f.path)) continue;
    codeLoc += (f.additions ?? 0) + (f.deletions ?? 0);
  }
  const codeLocIsLowerBound =
    pr.files.length >= PR_FILES_PAGE_CAP || pr.changedFiles > pr.files.length;
  return { codeLoc, codeLocIsLowerBound };
}

/**
 * The product default when an account has stored no threshold of its own. Mirrors
 * `LARGE_PR_CODE_LOC_DEFAULT` in `@pierre-review/shared` — one number, spelled in the two
 * places that need it without the backend importing a value from a types-only package at
 * runtime (`shared` is `import type` only on this side; see PACKAGING).
 */
export function resolveLargePrThreshold(stored: number | null | undefined): number {
  return stored != null && Number.isInteger(stored) && stored > 0 ? stored : 1500;
}
