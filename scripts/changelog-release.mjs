#!/usr/bin/env node
// Move CHANGELOG.md's "Unreleased" entries under a new release heading. Run by the release
// workflow (.github/workflows/release.yml) right after it computes the version, so the bump
// commit carries both: apps/backend/package.json AND the changelog (docs/RELEASE.md § The changelog).
//
//   node scripts/changelog-release.mjs <version> [YYYY-MM-DD]
//
// - The text under "## [Unreleased]" moves, as written, under "## [<version>] - <date>", and a
//   fresh empty "## [Unreleased]" stays on top.
// - An empty Unreleased still gets a heading, with "Maintenance release" under Changed, so the
//   changelog's newest release is always the npm package's version (the docs test checks it).
// - Idempotent: a version that already has a heading is left alone (a re-run of a release).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [version, dateArg] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node scripts/changelog-release.mjs <x.y.z> [YYYY-MM-DD]');
  process.exit(2);
}
const date = dateArg ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`bad date: ${date}`);
  process.exit(2);
}

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');
const text = readFileSync(file, 'utf8');

if (new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(text)) {
  console.log(`CHANGELOG.md already has ${version}; nothing to do.`);
  process.exit(0);
}

const head = /^## \[Unreleased\][^\n]*\n/m.exec(text);
if (!head) {
  console.error('CHANGELOG.md has no "## [Unreleased]" heading.');
  process.exit(1);
}
const start = head.index + head[0].length;
const nextRel = /^## \[/m.exec(text.slice(start));
const end = nextRel ? start + nextRel.index : text.length;
const body = text.slice(start, end).trim();

const released = body.length > 0 ? body : '### Changed\n\n- Maintenance release: no changes you would notice.';
const out =
  text.slice(0, head.index) +
  `## [Unreleased]\n\n## [${version}] - ${date}\n\n${released}\n\n` +
  text.slice(end).replace(/^\n+/, '');
writeFileSync(file, out);
console.log(`CHANGELOG.md: ${body.length > 0 ? 'Unreleased' : 'a maintenance entry'} → ${version} (${date}).`);
