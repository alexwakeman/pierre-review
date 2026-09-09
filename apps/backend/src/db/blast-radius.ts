import type { BlastSignals, BlastSurface, StoredPrFile } from '@pierre-review/shared';
import { codeLocFor, isNonCodeFile, PR_FILES_PAGE_CAP } from './code-loc.js';

// ============================================================================
// BLAST RADIUS — how far a pull request can REACH, folded from its stored files
// ============================================================================
//
// The second, ORTHOGONAL reading beside the large-PR flag. Size is a weak proxy for risk: a
// 2,000-line lockfile bump is trivial and a four-line change to a database migration is not.
// This module produces the EVIDENCE VECTOR; it never decides a level. The level is decided by
// exactly one function, `blastRadius()` in the SPA's `lib/ui.ts`, so that changing the
// sensitivity dial in Settings repaints every surface with no cache invalidation anywhere.
//
// ---- WHY THIS IS NOT THE CLAUDE REVIEW ROUTER ------------------------------
//
// `decideReviewMode` (packages/pro/src/claude-review/routing.ts) asks a genuinely similar
// question — "can this be reviewed from the diff alone?" — and its SHAPE is the ancestor of the
// arms below (file / line / directory / subsystem ceilings, a contract-touch signal,
// `allFilesNew`). It cannot be CALLED here, for three structural reasons:
//
//   1. It runs on the DIFF BODY — `analyzeDiff` over the noise-stripped unified diff that
//      `review/prepare.ts` fetches through the `gh` CLI. That is a GitHub call per pull request,
//      and NOTHING ON THE PENDING BOARD MAY FETCH ON MOUNT (fifty cards would be ~150 calls to
//      paint a screen). This module reads columns that are already on the row.
//   2. Claude Review is LOCAL-ONLY and force-disabled in cloud. Blast radius works in both modes.
//   3. Its gate is deliberately OVER-conservative — any ambiguity routes to `worktree` — because
//      over-routing there only costs money. Over-routing HERE marks everything `high` and the
//      feature stops meaning anything.
//
// ⚠ FOR THE SAME REASONS IT MUST NOT IMPORT `NOISE_GLOBS` OR `API_PATH_PATTERNS`. Both live in
// `review/prepare.ts` and both are tuned for a paid agent's diff budget, where over-matching is
// SAFE. Over-matching here is a false claim on screen. Editing either to suit this feature would
// silently change what Claude Review reviews, with no test to catch it.
//
// ---- THE FOUR PATH CLASSIFIERS, AND WHY NONE MAY BE FOLDED INTO ANOTHER -----
//
// `db/code-loc.ts` documents the first three. This is the fourth, and the same rule applies:
// they answer four different questions and are NOT meant to agree.
//
//   1. `NOISE_GLOBS`   (review/prepare.ts)  — "strip this from the diff the paid AGENT reads?"
//   2. `isLockFile`    (frontend lib/diff)  — "start this file's diff COLLAPSED?"
//   3. `isNonCodeFile` (db/code-loc.ts)     — "does this churn count as CODE a human must read?"
//   4. `BLAST_SURFACES` + `isTestFile` (HERE) — "do this file's CONSUMERS LIVE OUTSIDE THE DIFF?"
//
// Number 4 is the only one asking about REACH rather than volume or presentation, which is why
// it is a list of contract shapes rather than a list of things to ignore. It sits ON TOP of
// number 3: `isNonCodeFile` is reused verbatim to split code from prose/config, and this file
// adds only the two judgements code-loc has no opinion about — is it a test, and is it a
// contract.
//
// ---- CALIBRATION -----------------------------------------------------------
//
// Measured over 1,405 open pull requests with a usable measurement, across 22 real repositories:
// low 34.3% / medium 35.1% / high 29.7% / unknown 0.8%. Arm fire counts: dirs 230, hub 174,
// files 165, lines 160, subsystems 57 — none redundant. Surface frequency: deps 222, schema 55,
// ci 43, dts 2, migration 2, sql 2. That last row is why `deps` and `ci` are carried but are NOT
// high arms (see `BlastSurface` in packages/shared for each one's argument), and why migrations
// and IDL are rare-but-decisive rather than common.

/** Path shapes whose consumers live OUTSIDE the diff. Ordered most-consequential first; the
 *  emitted `surfaces[]` preserves this order so a rendered list needs no client-side sort.
 *
 *  ⚠ Matched CASE-INSENSITIVELY on the normalised path, like `isNonCodeFile` and unlike the
 *  agent's `NOISE_GLOBS` — a `Migrations/` directory is still a migrations directory. */
const BLAST_SURFACES: readonly (readonly [BlastSurface, RegExp])[] = [
  // A migrations directory. The one change on this list that is genuinely hard to undo.
  ['db_migration', /(^|\/)migrations?\//],
  // A schema or models tree, or a `schema.*` module. ⚠ THE KNOWN FALSE-POSITIVE SHAPE: in a repo
  // whose PRODUCT is an ORM, its own `src/**/schema/**` source tree trips a rule that means
  // "this pull request changes the database". Measured: 55 hits, almost all one such repo. That
  // is what `surfacesOff` in the account's config exists to switch off, and it is why the chip
  // always NAMES the surface rather than asserting a bare level.
  ['db_schema', /(^|\/)(schema|schemas|models)\/|(^|\/)schemas?\.[a-z0-9]+$/],
  ['sql', /\.sql$/],
  ['public_types', /\.d\.ts$/],
  ['idl', /\.(proto|thrift|graphql|gql)$/],
  ['openapi', /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/],
  ['infra', /\.(tf|tfvars)$|(^|\/)(helm|charts|k8s|kubernetes)\//],
  ['auth', /(^|\/)(auth|authz|authn|security|permissions?|acl|crypto)\//],
  // MEDIUM, never high — see the BlastSurface doc.
  ['ci', /(^|\/)\.github\/workflows\//],
  // Narration only, never an arm — see the BlastSurface doc.
  [
    'deps',
    /(^|\/)(package\.json|requirements\.txt|go\.mod|go\.sum|cargo\.toml|gemfile|pyproject\.toml|build\.gradle|pom\.xml|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|poetry\.lock|composer\.json)$/,
  ],
];

function normalize(path: string): string {
  let p = path.replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/')) p = p.slice(1);
  return p.toLowerCase();
}

/**
 * Is this path a TEST?
 *
 * Tests are code — `isNonCodeFile` correctly counts them, because a reviewer does read them —
 * but they are code whose blast radius is bounded by construction: a broken test fails CI rather
 * than production. So they are counted APART, and "every code file here is a test" is one of the
 * two ways a pull request earns `low`.
 *
 * ⚠ Deliberately does NOT match a bare `test`/`tests` BASENAME, only a directory segment or a
 * conventional suffix. `scripts/test` is an executable and `test.go` in a package root is
 * ambiguous enough to leave counted — the same "directory segments only" trap `isNonCodeFile`
 * documents, where treating a basename as a directory silently uncounts a hand-written file.
 */
export function isTestFile(path: string): boolean {
  const p = normalize(path);
  if (/(^|\/)(tests?|__tests__|specs?|e2e|testing)\//.test(p)) return true;
  if (/\.(test|spec)\.[a-z0-9]+$/.test(p)) return true;
  if (/_test\.[a-z0-9]+$/.test(p)) return true;
  if (/(^|\/)test_[^/]+\.py$/.test(p)) return true;
  return false;
}

/** The contract surfaces this path matches, if any. Exported for the fixture tests. */
export function surfacesForPath(path: string): BlastSurface[] {
  const p = normalize(path);
  const out: BlastSurface[] = [];
  for (const [surface, re] of BLAST_SURFACES) if (re.test(p)) out.push(surface);
  return out;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
}

function subsystemOf(path: string): string {
  const i = path.indexOf('/');
  return i === -1 ? path : path.slice(0, i);
}

/** What the hub index contributes for one pull request, when it has anything to say.
 *  P2 supplies this; P1 passes nothing and every field lands null. */
export interface HubReading {
  /** The highest co-change degree among the pull request's files. */
  degree: number;
  /** The bar it cleared — `max(repo p90, HUB_MIN_DEGREE)`. Not a p90; see `db/file-coupling.ts`
   *  rule 4 for why a p90 alone manufactures hubs in an uncoupled repository. */
  bar: number;
  /** Which file it was, so the chip's sentence can name it. */
  path: string;
}

/**
 * Fold one stored pull-request row into its blast-radius signal vector.
 *
 * Returns `null` for every UNKNOWN — and it does not re-derive what "unknown" means, it calls
 * `codeLocFor` and inherits all four of its data traps (`files IS NULL` at 18.5% of the corpus,
 * a never-observed size at 18.8%, the overloaded `files = []` sentinel, and the page cap). One
 * definition of "we did not measure this pull request", used by both features.
 *
 * ⚠ `null` IS NOT "low". Roughly a tenth of open pull requests land here and every surface must
 * render nothing for them — a reader who can tell an unmeasured pull request from a small one is
 * reading a claim we did not make.
 */
export function blastSignalsFor(
  pr: {
    files: StoredPrFile[] | null | undefined;
    additions: number;
    deletions: number;
    changedFiles: number;
  },
  hub?: HubReading | null,
): BlastSignals | null {
  const { codeLoc, codeLocIsLowerBound } = codeLocFor(pr);
  // Unknown size or no per-file breakdown → nothing honest to say about reach either.
  if (codeLoc == null) return null;

  const files = pr.files ?? [];
  let testFiles = 0;
  let nonCodeFiles = 0;
  let allNew = true;
  const codePaths: string[] = [];
  const surfaces = new Set<BlastSurface>();

  for (const f of files) {
    if (typeof f?.path !== 'string') continue;
    // ⚠ SURFACES ARE COLLECTED OVER EVERY FILE, code or not. An OpenAPI document and a Terraform
    // plan are `isNonCodeFile` (structured config, correctly excluded from the LINE count) and
    // are exactly the contracts this feature exists to catch. Restricting the scan to code files
    // would make `openapi` and half of `infra` unreachable.
    for (const s of surfacesForPath(f.path)) surfaces.add(s);
    if (isNonCodeFile(f.path)) {
      nonCodeFiles += 1;
      continue;
    }
    if (isTestFile(f.path)) {
      testFiles += 1;
      continue;
    }
    codePaths.push(normalize(f.path));
    // A file with no additions and no deletions is a pure rename/mode change; it cannot be the
    // reason a PR is "all new", so it does not vote either way.
    if (f.deletions > 0) allNew = false;
  }

  // ⚠ `allNew` is only meaningful when there IS code. An empty code list would otherwise report
  // `true` and claim "nothing existing can break" about a pull request with nothing in it.
  if (codePaths.length === 0) allNew = false;

  return {
    codeFiles: codePaths.length,
    testFiles,
    nonCodeFiles,
    dirs: new Set(codePaths.map(dirOf)).size,
    subsystems: new Set(codePaths.map(subsystemOf)).size,
    // Emitted in BLAST_SURFACES order (most-consequential first) rather than insertion order, so
    // the chip's sentence leads with the migration and not with whichever file GitHub listed first.
    surfaces: BLAST_SURFACES.map(([s]) => s).filter((s) => surfaces.has(s)),
    allNew,
    hubDegree: hub?.degree ?? null,
    hubBar: hub?.bar ?? null,
    hubPath: hub?.path ?? null,
    // The same fact `codeLocIsLowerBound` reports, re-stated for the reach vector because it
    // governs a DIFFERENT rule here: over there it forbids asserting "small", here it forbids
    // asserting "low". Both come from the one page-cap test in `codeLocFor`.
    truncated: codeLocIsLowerBound,
  };
}

/** Re-exported so a caller folding both features reads one import. The page cap is the single
 *  fact behind `codeLocIsLowerBound` and `BlastSignals.truncated` alike. */
export { PR_FILES_PAGE_CAP };
