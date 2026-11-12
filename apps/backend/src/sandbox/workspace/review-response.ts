// THE REVIEW LOOP'S RESPONSE REPORT, INSIDE THE SANDBOX (docs/SANDBOX.md § The review response;
// docs/STORY-BUILD.md § The review loop). After each review round Limn writes REVIEW.md (the items: findings
// F<n>, still-open earlier findings P<n>, open criteria AC<n> / missing items M<n>) and the build agent
// answers EVERY item in ONE JSON file, `<root>/.limn/review-response.json`, checked with a script Limn copies
// in, `node ~/.limn/review-response-check.cjs`. After the fix turn the HOST reads the file out
// (`readReviewResponse`) and checks it AGAIN with the SAME validator.
//
// It follows fix-report.ts exactly: a file, not a tool (the sandbox drivers have no MCP server); ONE
// validator text (`REVIEW_RESPONSE_VALIDATOR_SOURCE`) that the checker embeds and the host compiles, so the
// two never disagree. It is our own constant, never data. Keep it ES2019 and free of anything outside its body.
// The report is a SELF-REPORT: the code (extracted by the host) stays authoritative — a "fixed" on a target
// whose code did not change is stored as an answer; a missing or broken report reads "not answered".
import { posix } from 'node:path';
import type { SandboxRuntime } from '../runtime/types.js';

/** The report file, relative to the layout root. */
export const REVIEW_RESPONSE_FILE = '.limn/review-response.json';
/** The refs shown in REVIEW.md, relative to the layout root (the checker reads it). */
export const REVIEW_REFS_FILE = '.limn/review-refs.json';
/** The checker script, as the agent's own file. */
export const REVIEW_RESPONSE_CHECKER = '/home/agent/.limn/review-response-check.cjs';
/** The largest report Limn reads. */
export const REVIEW_RESPONSE_MAX_BYTES = 256 * 1024;
/** The longest reply. */
export const REVIEW_RESPONSE_REPLY_MAX = 600;

export type ReviewResponseAction = 'fixed' | 'answered' | 'pushed_back' | 'not_applicable';

export interface ReviewResponsePayload {
  items: Array<{ ref: string; action: ReviewResponseAction; reply: string }>;
}

export interface ReviewResponseCheck {
  /** The usable items (shape right; unknown refs and repeats dropped). null when the shape is wrong. */
  payload: ReviewResponsePayload | null;
  /** Everything the agent should fix (the checker prints them; the host logs them). */
  problems: string[];
  /** Shown refs with no answer. */
  notReported: string[];
}

/** THE validator, as text (see the header). `(raw, shown) → ReviewResponseCheck`. */
export const REVIEW_RESPONSE_VALIDATOR_SOURCE = String.raw`function validateReviewResponse(raw, shown) {
  var MAX = 600;
  var ACTIONS = { fixed: true, answered: true, pushed_back: true, not_applicable: true };
  var problems = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { payload: null, problems: ['The report must be one JSON object: {"items": [...]}.'], notReported: shown.slice() };
  }
  var items = raw.items;
  if (!Array.isArray(items) || items.length > 500) {
    return { payload: null, problems: ['"items" must be a list of at most 500 entries.'], notReported: shown.slice() };
  }
  var shownSet = Object.create(null);
  for (var i = 0; i < shown.length; i++) shownSet[shown[i]] = true;
  var seen = Object.create(null);
  var out = [];
  for (var k = 0; k < items.length; k++) {
    var it = items[k];
    var at = '"items"[' + k + ']';
    if (it === null || typeof it !== 'object' || Array.isArray(it)) { problems.push(at + ' must be an object.'); continue; }
    var ref = typeof it.ref === 'string' ? it.ref.trim().toUpperCase() : '';
    if (ref === '') { problems.push(at + '.ref must be the ref of an item in REVIEW.md.'); continue; }
    if (!shownSet[ref]) { problems.push(at + '.ref "' + ref + '" is not an item in REVIEW.md.'); continue; }
    if (seen[ref]) { problems.push(ref + ' is answered more than once; keep one answer.'); continue; }
    if (!ACTIONS[it.action]) { problems.push(at + '.action must be "fixed", "answered", "pushed_back" or "not_applicable".'); continue; }
    if (it.action === 'not_applicable' && !/^(AC|M)\d+$/.test(ref)) { problems.push(ref + ': "not_applicable" is only for a criterion (AC) or a missing item (M).'); continue; }
    if (typeof it.reply !== 'string' || it.reply.trim() === '') { problems.push(at + '.reply must say what you did, or why.'); continue; }
    if (it.reply.length > MAX) { problems.push(at + '.reply must be at most ' + MAX + ' characters.'); continue; }
    seen[ref] = true;
    out.push({ ref: ref, action: it.action, reply: it.reply.trim() });
  }
  var notReported = [];
  for (var s = 0; s < shown.length; s++) {
    if (!seen[shown[s]]) { notReported.push(shown[s]); problems.push(shown[s] + ' has no answer.'); }
  }
  return { payload: { items: out }, problems: problems, notReported: notReported };
}`;

type Validate = (raw: unknown, shown: readonly string[]) => ReviewResponseCheck;

let compiled: Validate | null = null;

/** The host's run of THE validator (the same text the checker embeds). Pure. */
export function validateReviewResponse(raw: unknown, shown: readonly string[]): ReviewResponseCheck {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- our own constant (see the header).
  compiled ??= new Function(`return (${REVIEW_RESPONSE_VALIDATOR_SOURCE});`)() as Validate;
  return compiled(raw, [...shown]);
}

/** The checker the agent runs (CommonJS, Node only, no dependency): `OK` or one line per problem. */
export function reviewResponseCheckerSource(o: { reportFile: string; refsFile: string }): string {
  return [
    '#!/usr/bin/env node',
    '// Limn: checks your answers to the review. Run: node ~/.limn/review-response-check.cjs',
    "'use strict';",
    "const fs = require('fs');",
    `const REPORT = ${JSON.stringify(o.reportFile)};`,
    `const REFS = ${JSON.stringify(o.refsFile)};`,
    `const MAX = ${REVIEW_RESPONSE_MAX_BYTES};`,
    `const validateReviewResponse = ${REVIEW_RESPONSE_VALIDATOR_SOURCE};`,
    'function fail(lines) { for (const l of lines) console.log(l); process.exit(1); }',
    'let text;',
    "try { text = fs.readFileSync(REPORT, 'utf8'); } catch (e) { fail(['No report: write ' + REPORT + ' first.']); }",
    "if (Buffer.byteLength(text, 'utf8') > MAX) fail(['The report is larger than ' + MAX + ' bytes.']);",
    'let raw;',
    "try { raw = JSON.parse(text); } catch (e) { fail(['The report is not valid JSON: ' + e.message]); }",
    'let shown = [];',
    "try { shown = JSON.parse(fs.readFileSync(REFS, 'utf8')).shown || []; } catch (e) { shown = []; }",
    'const r = validateReviewResponse(raw, shown);',
    "if (r.problems.length > 0) fail(['Fix these problems, then run this check again:'].concat(r.problems.map((p) => '- ' + p)));",
    "console.log('OK');",
    '',
  ].join('\n');
}

export type ReadReviewResponseResult =
  | { kind: 'ok'; check: ReviewResponseCheck }
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string };

/** The report out of the sandbox, parsed and checked. Never throws. */
export async function readReviewResponse(
  runtime: SandboxRuntime,
  container: string,
  layoutRoot: string,
  shown: readonly string[],
): Promise<ReadReviewResponseResult> {
  const file = posix.join(layoutRoot, REVIEW_RESPONSE_FILE);
  try {
    const r = await runtime.run(container, ['sh', '-c', 'test -f "$1" || exit 4; head -c "$2" "$1"', 'sh', file, String(REVIEW_RESPONSE_MAX_BYTES + 1)], { timeoutMs: 30_000 });
    if (r.code === 4) return { kind: 'missing' };
    if (r.code !== 0) return { kind: 'unreadable', reason: 'The answers could not be read from the sandbox.' };
    const text = r.stdout.toString('utf8');
    if (Buffer.byteLength(text, 'utf8') > REVIEW_RESPONSE_MAX_BYTES) return { kind: 'unreadable', reason: `The answers are larger than ${REVIEW_RESPONSE_MAX_BYTES / 1024} KB.` };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { kind: 'unreadable', reason: 'The answers are not valid JSON.' };
    }
    return { kind: 'ok', check: validateReviewResponse(raw, shown) };
  } catch {
    return { kind: 'unreadable', reason: 'The answers could not be read from the sandbox.' };
  }
}

/** Before a fix turn: the old report goes, so a report found after the turn is that turn's. */
export async function removeReviewResponse(runtime: SandboxRuntime, container: string, layoutRoot: string): Promise<void> {
  await runtime.run(container, ['rm', '-f', posix.join(layoutRoot, REVIEW_RESPONSE_FILE)], { timeoutMs: 30_000 }).catch(() => {});
}
