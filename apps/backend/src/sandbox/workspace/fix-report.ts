// AN AI FIX'S CHANGE REPORT, INSIDE THE SANDBOX (docs/SANDBOX.md § AI Fix sessions). The agent writes ONE
// JSON file, `<root>/.limn/fix-report.json`, in the `submit_fix` shape (coding/schema.ts
// `buildSubmitFixShape`), and checks it with a script Limn copies in, `node ~/.limn/fix-report-check.cjs`.
// After every build turn the HOST reads the file out (`readFixReport`) and checks it AGAIN with the SAME
// validator, then normalises it against the diff it extracted (review-seed.ts `normalizeChangeReport`).
//
// WHY A FILE, NOT A TOOL: the sandbox drivers run Claude with no MCP server and refuse every Codex server
// request, and nothing on the host listens for the sandbox (invariant 6). A file leaves the sandbox the
// way the patches do (the host pulls it), and it is the same for both providers.
//
// ⚠ ONE VALIDATOR: `FIX_REPORT_VALIDATOR_SOURCE` is plain JavaScript text. The checker script embeds it
// as it is, and the host compiles the SAME text (`validateFixReport`), so the two can never disagree.
// It is our own constant, never data. Keep it ES2019 and free of anything outside its own body.
// The report is a SELF-REPORT: the patch (extracted from git by the host) stays authoritative, and a
// missing or broken report only means every shown item reads "not reported", never a blocked push.
import { posix } from 'node:path';
import type { SandboxRuntime } from '../runtime/types.js';

/** The report file, relative to the layout root. */
export const FIX_REPORT_FILE = '.limn/fix-report.json';
/** The refs the agent was shown + the repository, relative to the layout root (the checker reads it). */
export const FIX_REFS_FILE = '.limn/fix-refs.json';
/** The checker script, as the agent's own file (under seed.ts `SANDBOX_HOME`; seed.ts imports this module). */
export const FIX_REPORT_CHECKER = '/home/agent/.limn/fix-report-check.cjs';
/** The largest report Limn reads. */
export const FIX_REPORT_MAX_BYTES = 256 * 1024;

export interface FixReportPayload {
  summary: string;
  commitMessage: string;
  changes?: Array<{ path: string; summary: string; refs?: string[] }>;
  unaddressed?: Array<{ ref: string; reason: string }>;
}

export interface FixReportCheck {
  /** The report when its SHAPE is right (content problems do not drop it: the normaliser does). */
  report: FixReportPayload | null;
  /** The shape is wrong: the report cannot be used. */
  shapeProblems: string[];
  /** Refs not shown, paths not changed, items not cited: the normaliser drops or names them. */
  contentProblems: string[];
}

/** THE validator, as text (see the header). `(raw, shown, changed) → FixReportCheck`. */
export const FIX_REPORT_VALIDATOR_SOURCE = String.raw`function validateFixReport(raw, shown, changed) {
  var shape = [];
  var content = [];
  var isStr = function (v, max) { return typeof v === 'string' && v.trim() !== '' && v.length <= max; };
  var norm = function (p) { return String(p).replace(/^\.\//, '').replace(/\/+$/, ''); };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { report: null, shapeProblems: ['The report must be one JSON object.'], contentProblems: [] };
  }
  if (!isStr(raw.summary, 4000)) shape.push('"summary" must be a non-empty string of at most 4000 characters.');
  if (!isStr(raw.commitMessage, 2000)) shape.push('"commitMessage" must be a non-empty string of at most 2000 characters.');
  var changes = raw.changes === undefined ? [] : raw.changes;
  var unaddressed = raw.unaddressed === undefined ? [] : raw.unaddressed;
  if (!Array.isArray(changes) || changes.length > 200) shape.push('"changes" must be a list of at most 200 entries.');
  if (!Array.isArray(unaddressed) || unaddressed.length > 200) shape.push('"unaddressed" must be a list of at most 200 entries.');
  if (shape.length > 0) return { report: null, shapeProblems: shape, contentProblems: [] };
  var shownSet = Object.create(null);
  for (var i = 0; i < shown.length; i++) shownSet[shown[i]] = true;
  var changedSet = Object.create(null);
  for (var j = 0; j < changed.length; j++) changedSet[norm(changed[j])] = true;
  var cited = Object.create(null);
  var listed = Object.create(null);
  for (var c = 0; c < changes.length; c++) {
    var ch = changes[c];
    var at = '"changes"[' + c + ']';
    if (ch === null || typeof ch !== 'object' || Array.isArray(ch)) { shape.push(at + ' must be an object.'); continue; }
    if (!isStr(ch.path, 500)) shape.push(at + '.path must be a non-empty string.');
    if (!isStr(ch.summary, 2000)) shape.push(at + '.summary must be a non-empty string of at most 2000 characters.');
    if (ch.refs !== undefined && (!Array.isArray(ch.refs) || ch.refs.length > 50 || ch.refs.some(function (r) { return typeof r !== 'string'; }))) {
      shape.push(at + '.refs must be a list of strings.');
      continue;
    }
    if (typeof ch.path === 'string') {
      if (!changedSet[norm(ch.path)]) content.push(at + '.path "' + ch.path + '" is not a file you changed (paths are relative to the repository root).');
      listed[norm(ch.path)] = true;
    }
    var refs = ch.refs || [];
    for (var k = 0; k < refs.length; k++) {
      var ref = refs[k].trim();
      if (!shownSet[ref]) content.push(at + ' cites "' + ref + '", which is not an item in FIX.md.');
      else cited[ref] = true;
    }
  }
  for (var u = 0; u < unaddressed.length; u++) {
    var un = unaddressed[u];
    var uat = '"unaddressed"[' + u + ']';
    if (un === null || typeof un !== 'object' || Array.isArray(un)) { shape.push(uat + ' must be an object.'); continue; }
    if (!isStr(un.ref, 100)) shape.push(uat + '.ref must be a non-empty string.');
    if (!isStr(un.reason, 2000)) shape.push(uat + '.reason must be a non-empty string of at most 2000 characters.');
    if (typeof un.ref === 'string') {
      if (!shownSet[un.ref.trim()]) content.push(uat + '.ref "' + un.ref + '" is not an item in FIX.md.');
      else cited[un.ref.trim()] = true;
    }
  }
  if (shape.length > 0) return { report: null, shapeProblems: shape, contentProblems: [] };
  for (var s = 0; s < shown.length; s++) {
    if (!cited[shown[s]]) content.push(shown[s] + ' is in neither "changes" nor "unaddressed".');
  }
  var files = Object.keys(changedSet);
  for (var f = 0; f < files.length; f++) {
    if (!listed[files[f]]) content.push('You changed ' + files[f] + ' but "changes" has no entry for it.');
  }
  return { report: raw, shapeProblems: [], contentProblems: content };
}`;

type Validate = (raw: unknown, shown: readonly string[], changed: readonly string[]) => FixReportCheck;

let compiled: Validate | null = null;

/** The host's run of THE validator (the same text the checker embeds). Pure. */
export function validateFixReport(raw: unknown, shown: readonly string[], changed: readonly string[]): FixReportCheck {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- our own constant (see the header).
  compiled ??= new Function(`return (${FIX_REPORT_VALIDATOR_SOURCE});`)() as Validate;
  return compiled(raw, [...shown], [...changed]);
}

/**
 * The checker the agent runs (CommonJS, Node only, no dependency). It reads the report, works out the
 * changed files with git (`refs/limn/base` against the working tree, plus untracked files), runs THE
 * validator and prints `OK` or one line per problem (exit 0 / 1).
 */
export function fixReportCheckerSource(o: { reportFile: string; refsFile: string; repoPath: string }): string {
  return [
    '#!/usr/bin/env node',
    '// Limn: checks the AI Fix report. Run: node ~/.limn/fix-report-check.cjs',
    "'use strict';",
    "const fs = require('fs');",
    "const cp = require('child_process');",
    `const REPORT = ${JSON.stringify(o.reportFile)};`,
    `const REFS = ${JSON.stringify(o.refsFile)};`,
    `const REPO = ${JSON.stringify(o.repoPath)};`,
    `const MAX = ${FIX_REPORT_MAX_BYTES};`,
    `const validateFixReport = ${FIX_REPORT_VALIDATOR_SOURCE};`,
    'function fail(lines) { for (const l of lines) console.log(l); process.exit(1); }',
    'let text;',
    "try { text = fs.readFileSync(REPORT, 'utf8'); } catch (e) { fail(['No report: write ' + REPORT + ' first.']); }",
    "if (Buffer.byteLength(text, 'utf8') > MAX) fail(['The report is larger than ' + MAX + ' bytes.']);",
    'let raw;',
    "try { raw = JSON.parse(text); } catch (e) { fail(['The report is not valid JSON: ' + e.message]); }",
    'let shown = [];',
    "try { shown = JSON.parse(fs.readFileSync(REFS, 'utf8')).shown || []; } catch (e) { shown = []; }",
    "const git = (args) => cp.execFileSync('git', ['-C', REPO].concat(args), { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });",
    'let changed = [];',
    'try {',
    "  changed = git(['diff', '--name-only', '-z', '--no-renames', 'refs/limn/base']).split('\\0')",
    "    .concat(git(['ls-files', '--others', '--exclude-standard', '-z']).split('\\0'))",
    "    .filter((p) => p !== '');",
    "} catch (e) { fail(['Could not read the changed files in ' + REPO + ': ' + e.message]); }",
    'changed = Array.from(new Set(changed));',
    'const r = validateFixReport(raw, shown, changed);',
    'const problems = r.shapeProblems.concat(r.contentProblems);',
    "if (problems.length > 0) fail(['Fix these problems, then run this check again:'].concat(problems.map((p) => '- ' + p)));",
    "console.log('OK');",
    '',
  ].join('\n');
}

export type ReadFixReportResult =
  | { kind: 'ok'; check: FixReportCheck }
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string };

/** The report out of the sandbox (as the agent), parsed and checked. Never throws. */
export async function readFixReport(
  runtime: SandboxRuntime,
  container: string,
  layoutRoot: string,
  shown: readonly string[],
  changed: readonly string[],
): Promise<ReadFixReportResult> {
  const file = posix.join(layoutRoot, FIX_REPORT_FILE);
  try {
    const r = await runtime.run(container, ['sh', '-c', 'test -f "$1" || exit 4; head -c "$2" "$1"', 'sh', file, String(FIX_REPORT_MAX_BYTES + 1)], { timeoutMs: 30_000 });
    if (r.code === 4) return { kind: 'missing' };
    if (r.code !== 0) return { kind: 'unreadable', reason: 'The report could not be read from the sandbox.' };
    const text = r.stdout.toString('utf8');
    if (Buffer.byteLength(text, 'utf8') > FIX_REPORT_MAX_BYTES) return { kind: 'unreadable', reason: `The report is larger than ${FIX_REPORT_MAX_BYTES / 1024} KB.` };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { kind: 'unreadable', reason: 'The report is not valid JSON.' };
    }
    return { kind: 'ok', check: validateFixReport(raw, shown, changed) };
  } catch {
    return { kind: 'unreadable', reason: 'The report could not be read from the sandbox.' };
  }
}

/** Before a build turn: the old report goes, so a report found after the turn is that turn's. */
export async function removeFixReport(runtime: SandboxRuntime, container: string, layoutRoot: string): Promise<void> {
  await runtime.run(container, ['rm', '-f', posix.join(layoutRoot, FIX_REPORT_FILE)], { timeoutMs: 30_000 }).catch(() => {});
}
