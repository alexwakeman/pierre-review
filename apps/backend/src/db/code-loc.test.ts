import { describe, expect, it } from 'vitest';
import type { StoredPrFile } from '@pierre-review/shared';
import {
  PR_FILES_PAGE_CAP,
  codeLocFor,
  isNonCodeFile,
  resolveLargePrThreshold,
} from './code-loc.js';

// ---------------------------------------------------------------------------
// The classifier. A TABLE, not a handful of spot checks: this list is the
// feature's definition of "code", and every row here is a decision someone made.
// ---------------------------------------------------------------------------

const NON_CODE: string[] = [
  // docs — by extension
  'README.md',
  'docs/guide.mdx',
  'CHANGELOG.markdown',
  'notes.rst',
  'notes.txt',
  'manual.adoc',
  'paper.tex',
  'spec.pdf',
  // docs — by directory segment, anywhere in the path
  'docs/architecture/overview.ts',
  'apps/backend/docs/internal.ts',
  'doc/api.ts',
  'documentation/x.py',
  // docs — extensionless prose / project metadata
  'LICENSE',
  'licence',
  'COPYING',
  'NOTICE',
  'AUTHORS',
  'CONTRIBUTING',
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'readme',
  // config — by extension
  'package.json',
  'tsconfig.json',
  'settings.json5',
  'ci.yml',
  'compose.yaml',
  'Cargo.toml',
  'setup.cfg',
  'nginx.conf',
  'app.properties',
  'Info.plist',
  'pom.xml',
  'data.csv',
  'data.tsv',
  // dotfiles + dot-directories
  '.env',
  '.env.production',
  '.gitignore',
  '.eslintrc.js',
  '.prettierrc',
  '.github/workflows/ci.yml',
  '.vscode/settings.json',
  '.circleci/config.yml',
  'apps/frontend/.storybook/main.ts',
  // lockfiles
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'Cargo.lock',
  'go.sum',
  'Gemfile.lock',
  'ios/App/Package.resolved',
  'gradle/dependency-locks/compile.lockfile',
  'anything.lock',
  // generated / vendored / build output
  'node_modules/left-pad/index.js',
  'vendor/github.com/pkg/errors/errors.go',
  'third_party/zlib/zlib.c',
  'dist/bundle.js',
  'build/main.js',
  'out/app.js',
  'generated/api.ts',
  'coverage/lcov-report/index.html',
  'src/api.generated.ts',
  'internal/api.pb.go',
  'proto/thing_pb2.py',
  'lib/model.g.dart',
  // minified / maps / snapshots
  'public/vendor.min.js',
  'public/site.min.css',
  'public/app.js.map',
  'src/__snapshots__/App.test.tsx.snap',
  'src/components/__snapshots__/x.snap',
  // binary / media
  'assets/logo.png',
  'assets/icon.svg',
  'assets/font.woff2',
  'demo.mp4',
  'bin/tool.wasm',
];

const CODE: string[] = [
  'src/index.ts',
  'apps/backend/src/db/queries.ts',
  'src/App.tsx',
  'main.go',
  'lib/thing.rb',
  'app/models/user.py',
  'Main.java',
  'main.rs',
  'index.php',
  'query.sql',
  'apps/backend/src/db/migrations/0057_large_pr_threshold.sql',
  // markup + styles ARE hand-written source a reviewer must read
  'index.html',
  'src/styles.css',
  'src/theme.scss',
  // shell + build logic: not "config", even though it lives beside it
  'scripts/release.sh',
  'Makefile',
  'Dockerfile',
  'Dockerfile.prod',
  'scripts/build',
  // a prose-sounding NAME with a code extension is still code
  'src/changelog.ts',
  'src/security.ts',
  // a directory whose name merely CONTAINS a non-code word is untouched
  'src/documents/parse.ts',
  'src/docsite/render.ts',
  'src/building/plan.ts',
];

describe('isNonCodeFile', () => {
  for (const p of NON_CODE) {
    it(`excludes ${p}`, () => expect(isNonCodeFile(p)).toBe(true));
  }
  for (const p of CODE) {
    it(`counts ${p}`, () => expect(isNonCodeFile(p)).toBe(false));
  }

  it('is case-insensitive — a Readme.MD is still prose', () => {
    expect(isNonCodeFile('Readme.MD')).toBe(true);
    expect(isNonCodeFile('DOCS/Guide.RST')).toBe(true);
    expect(isNonCodeFile('PNPM-LOCK.YAML')).toBe(true);
  });

  it('normalises windows separators and a leading ./', () => {
    expect(isNonCodeFile('docs\\guide.md')).toBe(true);
    expect(isNonCodeFile('./package.json')).toBe(true);
    expect(isNonCodeFile('./src/index.ts')).toBe(false);
  });

  it('treats an empty path as non-code rather than counting it', () => {
    expect(isNonCodeFile('')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The fold + the three data traps.
// ---------------------------------------------------------------------------

const f = (path: string, additions: number, deletions: number): StoredPrFile => ({
  path,
  additions,
  deletions,
});

describe('codeLocFor', () => {
  it('sums additions + deletions over code files only', () => {
    expect(
      codeLocFor({
        files: [
          f('src/a.ts', 100, 20),
          f('src/b.ts', 5, 5),
          f('pnpm-lock.yaml', 4000, 3800),
          f('README.md', 300, 10),
          f('package.json', 3, 1),
        ],
        additions: 4408,
        deletions: 3836,
        changedFiles: 5,
      }),
    ).toEqual({ codeLoc: 130, codeLocIsLowerBound: false });
  });

  it('can return 0 for a PR that is ALL non-code — that is a measurement, not a null', () => {
    expect(
      codeLocFor({
        files: [f('pnpm-lock.yaml', 4000, 3800), f('docs/x.md', 50, 2)],
        additions: 4050,
        deletions: 3802,
        changedFiles: 2,
      }),
    ).toEqual({ codeLoc: 0, codeLocIsLowerBound: false });
  });

  // ---- TRAP 1: files IS NULL (18.5% of the real corpus) --------------------
  it('TRAP 1 — a null files column is UNKNOWN, never 0', () => {
    expect(
      codeLocFor({ files: null, additions: 900, deletions: 100, changedFiles: 12 }),
    ).toEqual({ codeLoc: null, codeLocIsLowerBound: false });
    expect(
      codeLocFor({ files: undefined, additions: 900, deletions: 100, changedFiles: 12 }),
    ).toEqual({ codeLoc: null, codeLocIsLowerBound: false });
  });

  // ---- TRAP 2: a never-observed size (18.8%) ------------------------------
  it('TRAP 2 — additions/deletions/changedFiles all 0 is UNOBSERVED, never "not large"', () => {
    // The columns are NOT NULL with a 0 default, so an unhydrated PR and an empty one are the
    // same row. Even with a files array present, the size was never observed.
    expect(codeLocFor({ files: [], additions: 0, deletions: 0, changedFiles: 0 })).toEqual({
      codeLoc: null,
      codeLocIsLowerBound: false,
    });
    expect(codeLocFor({ files: null, additions: 0, deletions: 0, changedFiles: 0 })).toEqual({
      codeLoc: null,
      codeLocIsLowerBound: false,
    });
  });

  // ---- TRAP 3: files = [] is OVERLOADED ------------------------------------
  it('TRAP 3 — an empty files array with changedFiles > 0 is the "we tried" sentinel, not zero', () => {
    // sync/routing-files.ts persists [] on a failed fetch. Twenty real rows look like this;
    // reading them as "zero code lines" would mark real PRs as trivially small.
    expect(
      codeLocFor({ files: [], additions: 1200, deletions: 400, changedFiles: 37 }),
    ).toEqual({ codeLoc: null, codeLocIsLowerBound: false });
    // …and the cross-check is `changedFiles`, so the degenerate "size observed but no file
    // list" shape is unknown too rather than silently 0.
    expect(codeLocFor({ files: [], additions: 5, deletions: 0, changedFiles: 0 })).toEqual({
      codeLoc: null,
      codeLocIsLowerBound: false,
    });
  });

  // ---- TRAP 4 (the bound): files(first: 100) truncates the LARGEST PRs -----
  it('flags a lower bound when the stored list hit the 100-file page cap', () => {
    const files = Array.from({ length: PR_FILES_PAGE_CAP }, (_, i) => f(`src/f${i}.ts`, 30, 0));
    expect(
      codeLocFor({ files, additions: 9000, deletions: 200, changedFiles: 412 }),
    ).toEqual({ codeLoc: 3000, codeLocIsLowerBound: true });
  });

  it('flags a lower bound whenever changedFiles exceeds the files we hold', () => {
    expect(
      codeLocFor({
        files: [f('src/a.ts', 10, 0), f('src/b.ts', 10, 0)],
        additions: 5000,
        deletions: 0,
        changedFiles: 90,
      }),
    ).toEqual({ codeLoc: 20, codeLocIsLowerBound: true });
  });

  it('does NOT flag a lower bound on a complete file list', () => {
    expect(
      codeLocFor({
        files: [f('src/a.ts', 10, 0), f('src/b.ts', 10, 0)],
        additions: 20,
        deletions: 0,
        changedFiles: 2,
      }),
    ).toEqual({ codeLoc: 20, codeLocIsLowerBound: false });
  });

  it('a truncated PR already over the threshold is safe to assert as large', () => {
    // 65 of the 79 truncated PRs in the corpus clear 1500 on the truncated bound alone —
    // which is why the flag reads the bound asymmetrically.
    const files = Array.from({ length: PR_FILES_PAGE_CAP }, (_, i) => f(`src/f${i}.ts`, 40, 0));
    const r = codeLocFor({ files, additions: 20000, deletions: 0, changedFiles: 900 });
    expect(r.codeLocIsLowerBound).toBe(true);
    expect(r.codeLoc).toBeGreaterThan(1500);
  });
});

describe('resolveLargePrThreshold', () => {
  it('falls back to the 1500 product default', () => {
    expect(resolveLargePrThreshold(null)).toBe(1500);
    expect(resolveLargePrThreshold(undefined)).toBe(1500);
  });
  it('honours a stored positive integer', () => {
    expect(resolveLargePrThreshold(400)).toBe(400);
    expect(resolveLargePrThreshold(1)).toBe(1);
  });
  it('refuses nonsense rather than propagating it', () => {
    expect(resolveLargePrThreshold(0)).toBe(1500);
    expect(resolveLargePrThreshold(-5)).toBe(1500);
    expect(resolveLargePrThreshold(12.5)).toBe(1500);
  });
});
