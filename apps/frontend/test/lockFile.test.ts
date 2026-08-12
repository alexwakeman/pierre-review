// The Changes tab's lock-file recognizer: files whose diff is machine-generated dependency
// noise (pnpm-lock.yaml, Cargo.lock, …) ALWAYS start collapsed in FileDiffView, regardless
// of size or attached threads. Matching is by exact BASENAME (case-sensitive, as git records
// it) plus the Gradle `*.lockfile` suffix — deliberately NOT a broad `*.lock` suffix.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { isLockFile } from '../src/lib/diff.js';

describe('isLockFile', () => {
  it('matches plain lockfile basenames at the repo root', () => {
    expect(isLockFile('pnpm-lock.yaml')).toBe(true);
    expect(isLockFile('package-lock.json')).toBe(true);
    expect(isLockFile('yarn.lock')).toBe(true);
    expect(isLockFile('go.sum')).toBe(true);
    expect(isLockFile('flake.lock')).toBe(true);
    expect(isLockFile('mix.lock')).toBe(true);
  });

  it('matches capitalized names as git records them', () => {
    expect(isLockFile('Cargo.lock')).toBe(true);
    expect(isLockFile('Gemfile.lock')).toBe(true);
    expect(isLockFile('Pipfile.lock')).toBe(true);
    expect(isLockFile('MyApp.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved')).toBe(true);
  });

  it('matches on basename, so nested paths work', () => {
    expect(isLockFile('apps/frontend/package-lock.json')).toBe(true);
    expect(isLockFile('crates/core/Cargo.lock')).toBe(true);
    expect(isLockFile('services/api/poetry.lock')).toBe(true);
  });

  it('normalizes Windows backslashes before taking the basename', () => {
    expect(isLockFile('apps\\frontend\\pnpm-lock.yaml')).toBe(true);
    expect(isLockFile('crates\\core\\Cargo.lock')).toBe(true);
  });

  it("matches Gradle's per-project *.lockfile suffix", () => {
    expect(isLockFile('gradle.lockfile')).toBe(true);
    expect(isLockFile('gradle/dependency-locks/compileClasspath.lockfile')).toBe(true);
    expect(isLockFile('foo.lockfile')).toBe(true);
  });

  it('rejects near-misses: sources and non-suffix .lockfile mentions', () => {
    expect(isLockFile('src/lockfile.ts')).toBe(false);
    expect(isLockFile('my.lockfile.txt')).toBe(false);
    expect(isLockFile('foo.lockfile.txt')).toBe(false);
    // No broad *.lock suffix: an unknown .lock basename is not a lockfile.
    expect(isLockFile('src/editor/scroll.lock')).toBe(false);
    // Case-sensitive, like git: a differently-cased basename is a different file.
    expect(isLockFile('cargo.lock')).toBe(false);
    expect(isLockFile('yarn.LOCK')).toBe(false);
    // A lockfile NAME buried mid-path is not the file itself.
    expect(isLockFile('docs/pnpm-lock.yaml/notes.md')).toBe(false);
  });
});
