// A HOTFIX BUILD'S PORT REPORT, INSIDE THE SANDBOX (docs/STORY-BUILD.md § Hotfix builds → The port report;
// docs/RELEASES.md § Port report). A hotfix build fixes each repository's release checkout, then ports the fix
// to its main checkout. Before porting the agent reads the main checkout, and it ends every build turn with
// ONE JSON file, `<root>/.limn/port-report.json`: per repository it changed, what the port came to —
//
//   { "repos": [ { "repo": "owner/name", "outcome": "same" | "adapted" | "not_needed",
//                  "reason": "one plain sentence", "evidence": ["path or commit", …] } ] }
//
// `reason` is required for `adapted` (what differs on main) and `not_needed` (why main does not need it).
// The agent checks the file with `node ~/.limn/port-report-check.cjs`; after every build turn the HOST reads it
// out and checks it AGAIN with the SAME validator text, against its own list of the build's hotfix
// repositories (never the sandbox's copy). The same file and checker for Claude and Codex.
//
// ⚠ ONE VALIDATOR (the build-report.ts pattern): `PORT_REPORT_VALIDATOR_SOURCE` is plain JavaScript text the
// checker embeds as it is and the host compiles. Our own constant, never data; ES2019, nothing outside it.
// ⚠ A SELF-REPORT and UNTRUSTED TEXT: an entry that fails the check is dropped (named in one notice), every
// kept reason is one clipped line (shared `hotfixPortClaimOf`), and the push defangs it for GitHub. The host
// checks the claim against the patches it extracted (shared `hotfixPortOf`); it never infers one.
import { posix } from 'node:path';
import {
  HOTFIX_PORT_EVIDENCE_ITEM_MAX,
  HOTFIX_PORT_EVIDENCE_MAX,
  HOTFIX_PORT_REASON_MAX,
  hotfixPortClaimOf,
  type HotfixPortClaim,
  type HotfixPortOutcome,
} from '@pierre-review/shared';
import type { SandboxRuntime } from '../runtime/types.js';

/** The report file and the checker's context, relative to the layout root. */
export const PORT_REPORT_FILE = '.limn/port-report.json';
export const PORT_CONTEXT_FILE = '.limn/port-context.json';
/** The checker script, as the agent's own file (seed.ts `SANDBOX_HOME`). */
export const PORT_REPORT_CHECKER = '/home/agent/.limn/port-report-check.cjs';
export const PORT_REPORT_MAX_BYTES = 64 * 1024;

/** `port-context.json`: the hotfix repositories (`owner/name`) an entry may name. */
export interface PortContextFile {
  repos: string[];
}

export interface PortReportEntry {
  repo: string;
  outcome: HotfixPortOutcome;
  reason?: string | null;
  evidence?: string[] | null;
}

export interface PortReportCheck {
  /** The entries that passed (an entry that fails is left out); null when the file's shape is wrong. */
  entries: PortReportEntry[] | null;
  problems: string[];
}

/** THE validator, as text. `(raw, ctx) → { entries, problems }`. */
export const PORT_REPORT_VALIDATOR_SOURCE = String.raw`function validatePortReport(raw, ctx) {
  var p = [];
  var REASON_MAX = ${HOTFIX_PORT_REASON_MAX};
  var EVIDENCE_MAX = ${HOTFIX_PORT_EVIDENCE_MAX};
  var ITEM_MAX = ${HOTFIX_PORT_EVIDENCE_ITEM_MAX};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { entries: null, problems: ['The report must be one JSON object.'] };
  if (!Array.isArray(raw.repos) || raw.repos.length > 50) return { entries: null, problems: ['"repos" must be a list of at most 50 entries.'] };
  var known = Object.create(null);
  for (var k = 0; k < ctx.repos.length; k++) known[ctx.repos[k]] = true;
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < raw.repos.length; i++) {
    var e = raw.repos[i];
    var at = '"repos"[' + i + ']';
    if (e === null || typeof e !== 'object' || Array.isArray(e)) { p.push(at + ' must be an object.'); continue; }
    var bad = false;
    if (typeof e.repo !== 'string' || !known[e.repo]) { p.push(at + '.repo must be one of ' + (ctx.repos.length > 0 ? ctx.repos.join(', ') : '(no repository)') + '.'); bad = true; }
    else if (seen[e.repo]) { p.push(at + '.repo ' + e.repo + ' is listed twice.'); bad = true; }
    if (['same', 'adapted', 'not_needed'].indexOf(e.outcome) < 0) { p.push(at + '.outcome must be same, adapted or not_needed.'); bad = true; }
    var hasReason = typeof e.reason === 'string' && e.reason.trim() !== '';
    if (e.reason !== undefined && e.reason !== null && (typeof e.reason !== 'string' || e.reason.length > REASON_MAX)) { p.push(at + '.reason must be a string of at most ' + REASON_MAX + ' characters.'); bad = true; }
    else if ((e.outcome === 'adapted' || e.outcome === 'not_needed') && !hasReason) { p.push(at + '.reason is required for ' + e.outcome + ': say in one sentence ' + (e.outcome === 'adapted' ? 'what is different on main.' : 'why main does not need the fix.')); bad = true; }
    if (e.evidence !== undefined && e.evidence !== null) {
      if (!Array.isArray(e.evidence) || e.evidence.length > EVIDENCE_MAX) { p.push(at + '.evidence must be a list of at most ' + EVIDENCE_MAX + ' entries.'); bad = true; }
      else for (var j = 0; j < e.evidence.length; j++) if (typeof e.evidence[j] !== 'string' || e.evidence[j].length > ITEM_MAX) { p.push(at + '.evidence[' + j + '] must be a path or commit of at most ' + ITEM_MAX + ' characters.'); bad = true; }
    }
    if (bad) continue;
    seen[e.repo] = true;
    out.push({ repo: e.repo, outcome: e.outcome, reason: hasReason ? e.reason : null, evidence: Array.isArray(e.evidence) ? e.evidence : [] });
  }
  return { entries: out, problems: p };
}`;

type Validate = (raw: unknown, ctx: PortContextFile) => PortReportCheck;
let compiled: Validate | null = null;

/** The host's run of THE validator (the same text the checker embeds). Pure. */
export function validatePortReport(raw: unknown, ctx: PortContextFile): PortReportCheck {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- our own constant (see the header).
  compiled ??= new Function(`return (${PORT_REPORT_VALIDATOR_SOURCE});`)() as Validate;
  return compiled(raw, { repos: [...ctx.repos] });
}

/** The kept entries as the host stores them, by `owner/name` (pure): reason and evidence one clipped line each. */
export function portClaimsOf(check: PortReportCheck): Map<string, HotfixPortClaim> {
  const out = new Map<string, HotfixPortClaim>();
  for (const e of check.entries ?? []) out.set(e.repo, hotfixPortClaimOf({ outcome: e.outcome, reason: e.reason ?? null, evidence: e.evidence ?? [] }));
  return out;
}

/** The checker the agent runs (CommonJS, Node only): reads the report and the context, prints OK or the problems. */
export function portReportCheckerSource(o: { reportFile: string; contextFile: string }): string {
  return [
    '#!/usr/bin/env node',
    '// Limn: checks the hotfix port report. Run: node ~/.limn/port-report-check.cjs',
    "'use strict';",
    "const fs = require('fs');",
    `const REPORT = ${JSON.stringify(o.reportFile)};`,
    `const CONTEXT = ${JSON.stringify(o.contextFile)};`,
    `const MAX = ${PORT_REPORT_MAX_BYTES};`,
    `const validatePortReport = ${PORT_REPORT_VALIDATOR_SOURCE};`,
    'function fail(lines) { for (const l of lines) console.log(l); process.exit(1); }',
    'let text;',
    "try { text = fs.readFileSync(REPORT, 'utf8'); } catch (e) { fail(['No report: write ' + REPORT + ' first.']); }",
    "if (Buffer.byteLength(text, 'utf8') > MAX) fail(['The report is larger than ' + MAX + ' bytes.']);",
    'let raw;',
    "try { raw = JSON.parse(text); } catch (e) { fail(['The report is not valid JSON: ' + e.message]); }",
    'let ctx = { repos: [] };',
    "try { ctx = JSON.parse(fs.readFileSync(CONTEXT, 'utf8')); } catch (e) { /* the shape rules still apply */ }",
    'const r = validatePortReport(raw, ctx);',
    "if (r.problems.length > 0) fail(['Fix these problems, then run this check again:'].concat(r.problems.map((p) => '- ' + p)));",
    "console.log('OK');",
    '',
  ].join('\n');
}

/** What the hotfix seed copies in: the context (the hotfix repositories) and the checker. */
export function portReportFiles(root: string, ctx: PortContextFile): Array<{ path: string; content: string; mode?: number }> {
  const contextFile = posix.join(root, PORT_CONTEXT_FILE);
  return [
    { path: contextFile, content: `${JSON.stringify(ctx)}\n` },
    { path: PORT_REPORT_CHECKER, content: portReportCheckerSource({ reportFile: posix.join(root, PORT_REPORT_FILE), contextFile }), mode: 0o755 },
  ];
}

export type ReadPortReportResult = { kind: 'ok'; check: PortReportCheck } | { kind: 'missing' } | { kind: 'unreadable'; reason: string };

/** The report out of the sandbox (as the agent), parsed and checked against the HOST's context. Never throws. */
export async function readPortReport(runtime: SandboxRuntime, container: string, layoutRoot: string, ctx: PortContextFile): Promise<ReadPortReportResult> {
  const file = posix.join(layoutRoot, PORT_REPORT_FILE);
  const unreadable = { kind: 'unreadable' as const, reason: 'The port report could not be read from the sandbox.' };
  try {
    const r = await runtime.run(container, ['sh', '-c', 'test -f "$1" || exit 4; head -c "$2" "$1"', 'sh', file, String(PORT_REPORT_MAX_BYTES + 1)], { timeoutMs: 30_000 });
    if (r.code === 4) return { kind: 'missing' };
    if (r.code !== 0) return unreadable;
    const text = r.stdout.toString('utf8');
    if (Buffer.byteLength(text, 'utf8') > PORT_REPORT_MAX_BYTES) return { kind: 'unreadable', reason: `The port report is larger than ${PORT_REPORT_MAX_BYTES / 1024} KB.` };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { kind: 'unreadable', reason: 'The port report is not valid JSON.' };
    }
    return { kind: 'ok', check: validatePortReport(raw, ctx) };
  } catch {
    return unreadable;
  }
}

/** The build turn's line for a hotfix build (plan first or not): finish with the port report. */
export function portReportInstructionLine(root: string): string {
  return `Finish with the port report ("Hotfix" in CLAUDE.md and AGENTS.md): write \`${posix.join(root, PORT_REPORT_FILE)}\` with one entry per repository you fixed (outcome same / adapted / not_needed, and the reason for adapted or not_needed). Check it with \`node ${PORT_REPORT_CHECKER}\` until it prints OK.`;
}
