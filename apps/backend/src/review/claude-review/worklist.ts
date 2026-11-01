import type { ClaudeCoverageItem, ClaudeCoverageStatus } from '@pierre-review/shared';
import { splitDiffByFile } from '../../github/diff-anchor.js';
import { isTestFile, surfacesForPath } from '../../db/blast-radius.js';
import { isNonCodeFile } from '../../db/code-loc.js';

// THE REVIEW PLAN (docs/CLAUDE-REVIEW.md § The review plan, 2026-11-01). The review eval showed each
// model reliably finds its own kinds of issue and reliably misses others; part of that is WHAT it
// chooses to read. So CODE ranks the changed files by risk before the run — no model, no network,
// the same answer every time for the same diff — and the reviewer is shown the list in that order
// (W1…) and must report on EVERY item (`coverage`: issues / no_issues / not_reviewed). Both
// providers get the same plan.
//
// ⚠ LANGUAGE-AGNOSTIC BY DESIGN. Every signal reads only the diff text, the path and stored data:
//   • contract surface — the blast-radius classifier (`surfacesForPath`: migrations, schemas, API
//     definitions, IaC, auth paths)
//   • hub — the repo's co-change index (db/file-coupling.ts): files that historically change with
//     many others
//   • writes stored data — a changed line that inserts, updates, saves or deletes (SQL, ORM and
//     repository calls in any language)
//   • handles input — a route/controller/handler path, or a changed line that reads a request or
//     declares a validation schema
//   • new branches — added lines with a branch keyword or operator (if/else/case/catch/&&/||/?)
//   • size, and removed logic (deletion-heavy changes)
//   • no test changed — a code file with no changed test file sharing its name
//   • past findings — earlier review findings on the same path in this repo
// Each is a heuristic; the reviewer sees the REASONS, never a bare score, and may disagree.
// ⚠ PURE: the caller reads the hubs and past findings (manager.ts) and passes them in.

/** At most this many files are planned (and must be reported on); the rest are named only. */
export const WORKLIST_MAX = 15;
/** A coverage note is one line. */
export const COVERAGE_NOTE_CHARS = 200;

export interface WorklistItem {
  ref: string;
  path: string;
  score: number;
  reasons: string[];
}

export interface Worklist {
  items: WorklistItem[];
  /** Changed files left off the plan (lower risk, or over the cap), in rank order. */
  others: string[];
}

export interface WorklistInputs {
  /** The PR's diff with noise files stripped (prepare.ts `strippedDiff`). */
  diff: string;
  /** path → co-change degree, hubs only (db/file-coupling.ts `RepoCoupling.hubs`). */
  hubs?: ReadonlyMap<string, number> | null;
  /** path → earlier review findings on that path in this repo. */
  pastFindings?: ReadonlyMap<string, number> | null;
  max?: number;
}

const STORE_WRITE =
  /\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|MERGE\s+INTO)\b|\b(insert|upsert|update|save|persist|delete|destroy|remove|store|write|put|patch|commit)[A-Z_]?\w*\s*\(|\.(insert|update|upsert|save|create|delete|destroy|remove|put|set)\w*\s*\(/i;
const INPUT_PATH = /(^|[/._-])(routes?|controllers?|handlers?|endpoints?|api|views?|resolvers?|middlewares?|forms?)([/._-]|$)/i;
const INPUT_LINE =
  /\b(req|request)\.(body|query|params|payload|form|args|json)\b|\brequest\.(get_json|POST|GET)\b|@(Get|Post|Put|Patch|Delete|Request)Mapping\b|@(app|router|bp)\.(get|post|put|patch|delete|route)\b|\b(router|app)\.(get|post|put|patch|delete)\s*\(|\bJoi\.|\bz\.object\s*\(|\bBaseModel\b|\bFormData\b|\bgetParameter\s*\(|\bvalidate\w*\s*\(/;
// Page templates render data; they never write it (a `.set(` or "update" there is markup or a filter).
const TEMPLATE = /\.(njk|nunjucks|html?|hbs|handlebars|mustache|erb|ejs|jinja2?|j2|liquid|twig|haml|slim|pug)$/i;
const BRANCH = /\b(if|else|elif|elsif|case|catch|except|rescue|switch|when|match|guard|unless)\b|&&|\|\||\?\?|\?(?![.:\]])\s/;

const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f`]/g, '').slice(0, 300);

function stemOf(path: string): string {
  const base = (path.split('/').pop() ?? path).toLowerCase();
  return base.replace(/\.[^.]+$/, '').replace(/[._-](test|spec|tests|specs)$/, '').replace(/^(test|spec)[._-]/, '');
}

interface Signals {
  path: string;
  additions: number;
  deletions: number;
  isTest: boolean;
  isCode: boolean;
  surfaces: string[];
  hub: boolean;
  storeWrite: boolean;
  input: boolean;
  branchLines: number;
}

function signalsOf(path: string, text: string, hubs: ReadonlyMap<string, number> | null | undefined): Signals {
  let additions = 0;
  let deletions = 0;
  let storeWrite = false;
  let input = INPUT_PATH.test(path);
  let branchLines = 0;
  let inHunk = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const m = line[0];
    if (m !== '+' && m !== '-') continue;
    const body = line.slice(1);
    if (m === '+') {
      additions += 1;
      if (BRANCH.test(body)) branchLines += 1;
    } else deletions += 1;
    if (!storeWrite && STORE_WRITE.test(body)) storeWrite = true;
    if (!input && INPUT_LINE.test(body)) input = true;
  }
  const isTest = isTestFile(path);
  return {
    path,
    additions,
    deletions,
    isTest,
    isCode: !isNonCodeFile(path),
    surfaces: surfacesForPath(path),
    hub: hubs?.has(path) ?? false,
    storeWrite: storeWrite && !isTest && !TEMPLATE.test(path),
    input: input && !isTest,
    branchLines,
  };
}

/** The ranked plan for one diff. Pure and deterministic (ties break on the path). */
export function buildWorklist(inp: WorklistInputs): Worklist {
  const max = inp.max ?? WORKLIST_MAX;
  const files = splitDiffByFile(inp.diff).map((seg) => signalsOf(seg.path, seg.text, inp.hubs));
  const testStems = new Set(files.filter((f) => f.isTest).map((f) => stemOf(f.path)));
  const scored = files.map((f) => {
    const reasons: string[] = [];
    let score = 0;
    if (f.surfaces.length > 0) {
      score += 6;
      reasons.push(`contract: ${f.surfaces.join(', ')}`);
    }
    if (f.hub) {
      score += 4;
      reasons.push('changes with many other files (hub)');
    }
    if (f.storeWrite) {
      score += 4;
      reasons.push('writes stored data');
    }
    if (f.input) {
      score += 3;
      reasons.push('handles input');
    }
    if (f.branchLines > 0) {
      score += Math.min(4, f.branchLines / 3);
      reasons.push(`${f.branchLines} new branch${f.branchLines === 1 ? '' : 'es'}`);
    }
    const lines = f.additions + f.deletions;
    score += Math.min(3, Math.log2(1 + lines) / 2);
    if (f.deletions >= 20 && f.deletions > f.additions) {
      score += 1;
      reasons.push('removes logic');
    }
    if (f.isCode && !f.isTest && f.surfaces.length === 0 && !testStems.has(stemOf(f.path))) {
      score += 1.5;
      reasons.push('no test changed');
    }
    const past = inp.pastFindings?.get(f.path) ?? 0;
    if (past > 0) {
      score += Math.min(3, past);
      reasons.push(`${past} past finding${past === 1 ? '' : 's'} here`);
    }
    reasons.push(`+${f.additions} −${f.deletions}`);
    // A test file is planned after the code it tests; a non-code file only when it is a contract.
    if (f.isTest) score *= 0.3;
    const planned = f.surfaces.length > 0 || f.isCode;
    return { path: f.path, score: Math.round(score * 100) / 100, reasons, planned };
  });
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const planned = scored.filter((s) => s.planned);
  const items = planned.slice(0, max).map((s, i) => ({ ref: `W${i + 1}`, path: s.path, score: s.score, reasons: s.reasons }));
  const inPlan = new Set(items.map((i) => i.path));
  return { items, others: scored.filter((s) => !inPlan.has(s.path)).map((s) => s.path) };
}

/** The user-prompt section. Empty when there is nothing to plan. Paths are cleaned (PR-authored). */
export function worklistPromptSection(w: Worklist): string {
  if (w.items.length === 0) return '';
  const lines = [
    '## Review plan',
    '',
    'Limn ranked the changed files by risk, from the code alone (no model). Review them in this order and spend most of your effort at the top. The reasons are heuristics: you can disagree.',
    '',
    ...w.items.map((i) => `${i.ref} \`${clean(i.path)}\` — ${i.reasons.map(clean).join(' · ')}`),
  ];
  if (w.others.length > 0) {
    const shown = w.others.slice(0, 30).map((p) => `\`${clean(p)}\``);
    lines.push('', `Also changed, lower risk: ${shown.join(', ')}${w.others.length > 30 ? `, and ${w.others.length - 30} more` : ''}.`);
  }
  lines.push(
    '',
    "For EACH W item, add one entry to `coverage`: its ref; status 'issues' when you raised a finding on that file, 'no_issues' when you checked it and found nothing, or 'not_reviewed' when you did not check it (never guess); and a short note on what you checked, or why you did not.",
  );
  return lines.join('\n');
}

export interface CoverageReport {
  ref: string;
  status: ClaudeCoverageStatus;
  note?: string | null;
}

/**
 * The stored coverage: ONE entry per planned item, in plan order. A ref the model did not report on
 * is 'not_reviewed' (never invented as checked). A file the run raised a finding on is 'issues',
 * whatever the model said.
 */
export function reconcileCoverage(
  w: Worklist,
  reported: readonly CoverageReport[] | null | undefined,
  findingPaths: readonly string[],
): ClaudeCoverageItem[] {
  const byRef = new Map<string, CoverageReport>();
  for (const r of reported ?? []) if (r && typeof r.ref === 'string' && !byRef.has(r.ref)) byRef.set(r.ref, r);
  const withFinding = new Set(findingPaths);
  return w.items.map((i) => {
    const r = byRef.get(i.ref);
    const said: ClaudeCoverageStatus =
      r?.status === 'issues' || r?.status === 'no_issues' || r?.status === 'not_reviewed' ? r.status : 'not_reviewed';
    const note = typeof r?.note === 'string' && r.note.trim() !== '' ? r.note.trim().slice(0, COVERAGE_NOTE_CHARS) : null;
    return {
      ref: i.ref,
      path: i.path,
      reasons: i.reasons,
      status: withFinding.has(i.path) ? 'issues' : said,
      note,
    };
  });
}
