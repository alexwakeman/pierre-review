#!/usr/bin/env node
// Move a backend test file from the `fast` project into the `slow` one (docs/TESTING.md).
//
//   pnpm --filter @pierre-review/backend test:move-slow src/foo/bar.test.ts "why: real git per case"
//
// Adds the path to SLOW_TESTS in vitest.workspace.ts, with the reason as a comment, and drops its
// time-budget allowlist entry if it had one. The test budget reporter prints this exact command for
// a file over budget. ⚠ A file belongs in `slow` only for a MEASURED reason (spawn-bound, seconds per
// case); a file slow because it seeds too much should be made faster instead.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [rawPath, ...why] = process.argv.slice(2);
if (!rawPath) {
  console.error('usage: test:move-slow <src/…/file.test.ts> "<the measured reason>"');
  process.exit(2);
}
// Accept a path relative to the backend, the repo root, or absolute.
const abs = [resolve(backend, rawPath), resolve(process.cwd(), rawPath), resolve(backend, '..', '..', rawPath)].find(existsSync);
if (!abs) {
  console.error(`no such file: ${rawPath}`);
  process.exit(2);
}
const rel = relative(backend, abs);
const reason = why.join(' ').trim() || 'over the fast project’s time budget (say what makes it slow)';

const wsPath = join(backend, 'vitest.workspace.ts');
const src = readFileSync(wsPath, 'utf8');
const start = src.indexOf('export const SLOW_TESTS = [');
const end = src.indexOf('\n];', start);
if (start < 0 || end < 0) {
  console.error('could not find SLOW_TESTS in vitest.workspace.ts');
  process.exit(1);
}
if (src.slice(start, end).includes(`'${rel}'`)) {
  console.log(`${rel} is already in SLOW_TESTS.`);
} else {
  const day = new Date().toISOString().slice(0, 10);
  const add = `\n  // Moved ${day} by the time budget: ${reason}\n  '${rel}',`;
  writeFileSync(wsPath, src.slice(0, end) + add + src.slice(end));
  console.log(`Added ${rel} to SLOW_TESTS (vitest.workspace.ts).`);
}

const allowPath = join(backend, 'test-budget', 'allowlist.json');
if (existsSync(allowPath)) {
  const allow = JSON.parse(readFileSync(allowPath, 'utf8'));
  if (allow.files && allow.files[rel]) {
    delete allow.files[rel];
    writeFileSync(allowPath, JSON.stringify(allow, null, 2) + '\n');
    console.log(`Removed its entry from test-budget/allowlist.json.`);
  }
}
console.log(`Next: run it where it now lives (pnpm --filter @pierre-review/backend exec vitest run --project slow ${rel}),`);
console.log('and add it to the slow list in docs/TESTING.md if it guards an invariant.');
