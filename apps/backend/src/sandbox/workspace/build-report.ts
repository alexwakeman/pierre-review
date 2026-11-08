// A PLAN-FIRST BUILD'S REPORT, INSIDE THE SANDBOX (docs/SANDBOX.md § The plan and its checks → The build
// report). After Approve the agent builds the approved stack and ends every build turn with ONE JSON file,
// `<root>/.limn/build-report.json`: per planned PR its status, a short summary (the PR body's opening) and
// the checks it ran; per criterion met or not. It checks the file with `node ~/.limn/build-report-check.cjs`.
// After every build turn the HOST reads the file out and checks it AGAIN with the SAME validator text. The
// file is not removed between turns: a reader's follow-up message may leave it as it was, and the last
// report that passes stays the agent's word.
//
// ⚠ ONE VALIDATOR (the fix-report.ts pattern): `BUILD_REPORT_VALIDATOR_SOURCE` is plain JavaScript text the
// checker embeds as it is and the host compiles. Our own constant, never data; ES2019, nothing outside it.
// ⚠ A SELF-REPORT: shown as "The agent says", never a gate on Push. The patches the host extracted and
// verified stay authoritative; a missing or broken report only means "not reported".
import { posix } from 'node:path';
import type { SandboxRuntime } from '../runtime/types.js';

/** The report file and the checker's context, relative to the layout root. */
export const BUILD_REPORT_FILE = '.limn/build-report.json';
export const BUILD_CONTEXT_FILE = '.limn/build-context.json';
/** The checker script, as the agent's own file (seed.ts `SANDBOX_HOME`). */
export const BUILD_REPORT_CHECKER = '/home/agent/.limn/build-report-check.cjs';
export const BUILD_REPORT_MAX_BYTES = 128 * 1024;

export interface BuildReportPr {
  id: string;
  status: 'done' | 'partly' | 'not_done';
  summary: string;
  checks: Array<{ command: string; result: 'passed' | 'failed' | 'not_run'; note?: string }>;
}

export interface BuildReportPayload {
  prs: BuildReportPr[];
  criteria: Array<{ ref: string; status: 'met' | 'partly' | 'not_met'; how: string }>;
  openPoints?: Array<{ n: number; note: string }>;
}

/** `build-context.json`: the planned PR ids and the criteria refs the report must cover. */
export interface BuildContextFile {
  prs: string[];
  criteria: string[];
}

export interface BuildReportCheck {
  report: BuildReportPayload | null;
  problems: string[];
}

/** THE validator, as text. `(raw, ctx) → { report, problems }`: report null when the shape is wrong. */
export const BUILD_REPORT_VALIDATOR_SOURCE = String.raw`function validateBuildReport(raw, ctx) {
  var p = [];
  var isStr = function (v, max) { return typeof v === 'string' && v.trim() !== '' && v.length <= max; };
  var one = function (v, xs) { return xs.indexOf(v) >= 0; };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { report: null, problems: ['The report must be one JSON object.'] };
  if (!Array.isArray(raw.prs) || raw.prs.length > 6) p.push('"prs" must be a list of at most 6 entries.');
  if (!Array.isArray(raw.criteria) || raw.criteria.length > 60) p.push('"criteria" must be a list of at most 60 entries.');
  if (raw.openPoints !== undefined && (!Array.isArray(raw.openPoints) || raw.openPoints.length > 50)) p.push('"openPoints" must be a list of at most 50 entries.');
  if (p.length > 0) return { report: null, problems: p };
  var seen = Object.create(null);
  for (var i = 0; i < raw.prs.length; i++) {
    var pr = raw.prs[i];
    var at = '"prs"[' + i + ']';
    if (pr === null || typeof pr !== 'object' || Array.isArray(pr)) { p.push(at + ' must be an object.'); continue; }
    if (typeof pr.id !== 'string' || !one(pr.id, ctx.prs)) p.push(at + '.id must be one of ' + ctx.prs.join(', ') + ' (PLAN.md).');
    else if (seen[pr.id]) p.push(at + '.id ' + pr.id + ' is listed twice.');
    else seen[pr.id] = true;
    if (!one(pr.status, ['done', 'partly', 'not_done'])) p.push(at + '.status must be done, partly or not_done.');
    if (!isStr(pr.summary, 2000)) p.push(at + '.summary must be a non-empty string of at most 2000 characters.');
    if (!Array.isArray(pr.checks) || pr.checks.length > 20) { p.push(at + '.checks must be a list of at most 20 entries.'); continue; }
    for (var j = 0; j < pr.checks.length; j++) {
      var c = pr.checks[j];
      var cat = at + '.checks[' + j + ']';
      if (c === null || typeof c !== 'object' || Array.isArray(c)) { p.push(cat + ' must be an object.'); continue; }
      if (!isStr(c.command, 300)) p.push(cat + '.command must be a non-empty string of at most 300 characters.');
      if (!one(c.result, ['passed', 'failed', 'not_run'])) p.push(cat + '.result must be passed, failed or not_run.');
      if (c.note !== undefined && c.note !== null && (typeof c.note !== 'string' || c.note.length > 500)) p.push(cat + '.note must be a string of at most 500 characters.');
    }
  }
  for (var k = 0; k < ctx.prs.length; k++) if (!seen[ctx.prs[k]]) p.push(ctx.prs[k] + ' is not in "prs".');
  var refs = Object.create(null);
  for (var m = 0; m < raw.criteria.length; m++) {
    var cr = raw.criteria[m];
    var mat = '"criteria"[' + m + ']';
    if (cr === null || typeof cr !== 'object' || Array.isArray(cr)) { p.push(mat + ' must be an object.'); continue; }
    if (!isStr(cr.ref, 20)) p.push(mat + '.ref must be a criterion ref (AC1, …).');
    else refs[cr.ref.trim().toUpperCase()] = true;
    if (!one(cr.status, ['met', 'partly', 'not_met'])) p.push(mat + '.status must be met, partly or not_met.');
    if (!isStr(cr.how, 800)) p.push(mat + '.how must be a non-empty string of at most 800 characters.');
  }
  for (var n = 0; n < ctx.criteria.length; n++) if (!refs[ctx.criteria[n]]) p.push(ctx.criteria[n] + ' is not in "criteria".');
  var ops = raw.openPoints || [];
  for (var o = 0; o < ops.length; o++) {
    var op = ops[o];
    if (op === null || typeof op !== 'object' || typeof op.n !== 'number' || !isStr(op.note, 800)) p.push('"openPoints"[' + o + '] must be { "n": number, "note": text }.');
  }
  return { report: p.length > 0 ? null : raw, problems: p };
}`;

type Validate = (raw: unknown, ctx: BuildContextFile) => BuildReportCheck;
let compiled: Validate | null = null;

/** The host's run of THE validator (the same text the checker embeds). Pure. */
export function validateBuildReport(raw: unknown, ctx: BuildContextFile): BuildReportCheck {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- our own constant (see the header).
  compiled ??= new Function(`return (${BUILD_REPORT_VALIDATOR_SOURCE});`)() as Validate;
  return compiled(raw, { prs: [...ctx.prs], criteria: [...ctx.criteria] });
}

/** The checker the agent runs (CommonJS, Node only): reads the report and the context, prints OK or the problems. */
export function buildReportCheckerSource(o: { reportFile: string; contextFile: string }): string {
  return [
    '#!/usr/bin/env node',
    '// Limn: checks the build report. Run: node ~/.limn/build-report-check.cjs',
    "'use strict';",
    "const fs = require('fs');",
    `const REPORT = ${JSON.stringify(o.reportFile)};`,
    `const CONTEXT = ${JSON.stringify(o.contextFile)};`,
    `const MAX = ${BUILD_REPORT_MAX_BYTES};`,
    `const validateBuildReport = ${BUILD_REPORT_VALIDATOR_SOURCE};`,
    'function fail(lines) { for (const l of lines) console.log(l); process.exit(1); }',
    'let text;',
    "try { text = fs.readFileSync(REPORT, 'utf8'); } catch (e) { fail(['No report: write ' + REPORT + ' first.']); }",
    "if (Buffer.byteLength(text, 'utf8') > MAX) fail(['The report is larger than ' + MAX + ' bytes.']);",
    'let raw;',
    "try { raw = JSON.parse(text); } catch (e) { fail(['The report is not valid JSON: ' + e.message]); }",
    'let ctx = { prs: [], criteria: [] };',
    "try { ctx = JSON.parse(fs.readFileSync(CONTEXT, 'utf8')); } catch (e) { /* the shape rules still apply */ }",
    'const r = validateBuildReport(raw, ctx);',
    "if (r.problems.length > 0) fail(['Fix these problems, then run this check again:'].concat(r.problems.map((p) => '- ' + p)));",
    "console.log('OK');",
    '',
  ].join('\n');
}

/** What Approve copies in beside PLAN.md: the context and the checker. */
export function buildReportFiles(root: string, ctx: BuildContextFile): Array<{ path: string; content: string; mode?: number }> {
  const contextFile = posix.join(root, BUILD_CONTEXT_FILE);
  return [
    { path: contextFile, content: `${JSON.stringify(ctx)}\n` },
    { path: BUILD_REPORT_CHECKER, content: buildReportCheckerSource({ reportFile: posix.join(root, BUILD_REPORT_FILE), contextFile }), mode: 0o755 },
  ];
}

export type ReadBuildReportResult = { kind: 'ok'; check: BuildReportCheck } | { kind: 'missing' } | { kind: 'unreadable'; reason: string };

/** The report out of the sandbox (as the agent), parsed and checked. Never throws. */
export async function readBuildReport(runtime: SandboxRuntime, container: string, layoutRoot: string, ctx: BuildContextFile): Promise<ReadBuildReportResult> {
  const file = posix.join(layoutRoot, BUILD_REPORT_FILE);
  try {
    const r = await runtime.run(container, ['sh', '-c', 'test -f "$1" || exit 4; head -c "$2" "$1"', 'sh', file, String(BUILD_REPORT_MAX_BYTES + 1)], { timeoutMs: 30_000 });
    if (r.code === 4) return { kind: 'missing' };
    if (r.code !== 0) return { kind: 'unreadable', reason: 'The build report could not be read from the sandbox.' };
    const text = r.stdout.toString('utf8');
    if (Buffer.byteLength(text, 'utf8') > BUILD_REPORT_MAX_BYTES) return { kind: 'unreadable', reason: `The build report is larger than ${BUILD_REPORT_MAX_BYTES / 1024} KB.` };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { kind: 'unreadable', reason: 'The build report is not valid JSON.' };
    }
    return { kind: 'ok', check: validateBuildReport(raw, ctx) };
  } catch {
    return { kind: 'unreadable', reason: 'The build report could not be read from the sandbox.' };
  }
}

