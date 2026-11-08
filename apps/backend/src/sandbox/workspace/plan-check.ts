// A STORY SESSION'S PLAN, ITS ONE VALIDATOR (docs/SANDBOX.md § The plan and its checks). The agent ends its
// planning turn with ONE fenced ```limn-plan block (sandbox/session/plan-block.ts takes it out of the turn's
// final text). The block is checked twice with the SAME text:
//
//   in the sandbox  `node ~/.limn/plan-check.cjs` (advice, never authority): the agent pipes its plan in;
//                   the checker also tries each code / data-file quote against `refs/limn/base` and each
//                   docs quote against the copied sections, so the agent can fix its evidence first;
//   on the host     `validateBuildPlan` (shape + references), then coding/story-build/plan-verify.ts
//                   verifies every piece of evidence itself (the checker's word counts for nothing).
//
// ⚠ ONE VALIDATOR: `BUILD_PLAN_CHECK_SOURCE` is plain JavaScript text (ES2019, nothing outside its own
// body). The checker embeds it as it is and the host compiles the SAME text, so the two never disagree —
// the `FIX_REPORT_VALIDATOR_SOURCE` pattern (fix-report.ts). It is our own constant, never data.
//
// SHAPE problems make the plan unusable (one repair turn, sandbox/session/plan.ts). CONTENT problems are
// named and the item is dropped (an evidence item that names an unknown run, a docs item outside a docs
// session); the plan stays usable.
import { BUILD_PLAN_LIMITS, BUILD_PLAN_MAX_BYTES, BUILD_PLAN_SCHEMA, type BuildPlanRaw } from '@pierre-review/shared';

/** The context file the checker reads, relative to the layout root. */
export const PLAN_CONTEXT_FILE = '.limn/plan-context.json';
/** The checker script, as the agent's own file. */
export const PLAN_CHECKER = '/home/agent/.limn/plan-check.cjs';

export interface BuildPlanCheckContext {
  /**
   * Every ref the plan must cover: 'AC1'…, and in Fill gaps the missing items 'M1'…. null: the ticket has no
   * numbered list, so the agent numbers the criteria itself (any `AC<n>` is accepted, none is required).
   */
  criteria: string[] | null;
  /** Fill gaps: the refs the story check found NOT delivered (each must be planned or not_planned). */
  gaps: string[] | null;
  /** The session's repositories, `owner/name`. */
  repos: string[];
  /** The `limn-svc run` ids Limn recorded so far ('svc-3'). */
  runs: string[];
  /** Reference documents were copied in (a docs item is allowed). */
  docs: boolean;
  fillGaps: boolean;
}

export interface BuildPlanCheck {
  /** The plan when its SHAPE is right. */
  plan: BuildPlanRaw | null;
  shapeProblems: string[];
  /** Named items the host drops; keyed so the host can find them (`C1.e2`, `P2.criteria`). */
  contentProblems: string[];
  /** Evidence items refused by the shape-free checks: `C<n>` → the 0-based indexes dropped. */
  droppedEvidence: Record<string, number[]>;
}

/**
 * THE validator, as text: an expression that evaluates to `{ validateBuildPlan, foldCode, findQuote,
 * letters }`. `foldCode`: whitespace runs → one space (code is compared folded, nothing else).
 * `findQuote(text, quote, start, end)`: where a quote is in a file's text, by line:
 * `{ at: 'in' | 'moved' | 'none' | 'ambiguous', start, end }` — 'in' within the stated lines ± 3,
 * 'moved' when it is not there but appears EXACTLY once elsewhere.
 */
export const BUILD_PLAN_CHECK_SOURCE = String.raw`(function () {
  var L = ${JSON.stringify(BUILD_PLAN_LIMITS)};
  var SCHEMA = ${JSON.stringify(BUILD_PLAN_SCHEMA)};
  function foldCode(s) { return String(s).replace(/\s+/g, ' ').trim(); }
  function letters(s) { var m = String(s).match(/[\p{L}\p{N}]/gu); return m ? m.length : 0; }
  function findQuote(text, quote, start, end) {
    var q = foldCode(quote);
    if (q === '') return { at: 'none', start: start, end: end };
    var lines = String(text).split('\n');
    var F = '';
    var lineStart = [];
    for (var i = 0; i < lines.length; i++) {
      var f = foldCode(lines[i]);
      if (f === '') { lineStart.push(F.length); continue; }
      if (F !== '') F += ' ';
      lineStart.push(F.length);
      F += f;
    }
    var lineOf = function (off) {
      var lo = 0;
      var hi = lineStart.length - 1;
      while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (lineStart[mid] <= off) lo = mid; else hi = mid - 1; }
      return lo + 1;
    };
    var hits = [];
    var from = 0;
    while (hits.length < 50) {
      var at = F.indexOf(q, from);
      if (at < 0) break;
      hits.push({ start: lineOf(at), end: lineOf(at + q.length - 1) });
      from = at + 1;
    }
    for (var h = 0; h < hits.length; h++) {
      if (hits[h].start >= start - 3 && hits[h].end <= end + 3) return { at: 'in', start: Math.min(start, hits[h].start), end: Math.max(end, hits[h].end) };
    }
    if (hits.length === 1) return { at: 'moved', start: hits[0].start, end: hits[0].end };
    return { at: hits.length === 0 ? 'none' : 'ambiguous', start: start, end: end };
  }
  function validateBuildPlan(raw, ctx) {
    var shape = [];
    var content = [];
    var droppedEvidence = {};
    var str = function (v, max, allowEmpty) { return typeof v === 'string' && (allowEmpty || v.trim() !== '') && v.length <= max; };
    var obj = function (v) { return v !== null && typeof v === 'object' && !Array.isArray(v); };
    var strList = function (v, max, each) { return Array.isArray(v) && v.length <= max && v.every(function (x) { return typeof x === 'string' && x.length <= each; }); };
    var low = function (s) { return String(s).trim().toLowerCase(); };
    var out = function () { return { plan: null, shapeProblems: shape, contentProblems: [], droppedEvidence: {} }; };
    if (!obj(raw)) { shape.push('The plan must be one JSON object.'); return out(); }
    if (raw.schema !== SCHEMA) shape.push('"schema" must be "' + SCHEMA + '".');
    if (!str(raw.summary, L.summary)) shape.push('"summary" must be a non-empty string of at most ' + L.summary + ' characters.');
    ['repos', 'criteria', 'contentions', 'stack'].forEach(function (k) { if (!Array.isArray(raw[k])) shape.push('"' + k + '" must be a list.'); });
    if (shape.length > 0) return out();

    // ---- repos ----
    var sessionRepos = Object.create(null);
    for (var i = 0; i < ctx.repos.length; i++) sessionRepos[low(ctx.repos[i])] = true;
    var planRepos = Object.create(null);
    if (raw.repos.length === 0) shape.push('"repos" must name at least one repository you will change.');
    for (var r = 0; r < raw.repos.length; r++) {
      var rp = raw.repos[r];
      var rat = '"repos"[' + r + ']';
      if (!obj(rp) || !str(rp.repo, 200) || !str(rp.why, L.repoWhy)) { shape.push(rat + ' must be { "repo": "owner/name", "why": "…" } (why at most ' + L.repoWhy + ' characters).'); continue; }
      if (!sessionRepos[low(rp.repo)]) shape.push(rat + ': "' + rp.repo + '" is not a repository of this session. Use one of: ' + ctx.repos.join(', ') + '.');
      else if (planRepos[low(rp.repo)]) shape.push(rat + ': "' + rp.repo + '" is listed twice.');
      planRepos[low(rp.repo)] = true;
    }

    // ---- stack ----
    var prIds = Object.create(null);
    var prOrder = [];
    var perRepo = Object.create(null);
    if (raw.stack.length === 0) shape.push('"stack" must have at least one pull request.');
    if (raw.stack.length > L.stackTotal) shape.push('"stack" has ' + raw.stack.length + ' pull requests: at most ' + L.stackTotal + '.');
    for (var p = 0; p < raw.stack.length; p++) {
      var pr = raw.stack[p];
      var pat = '"stack"[' + p + ']';
      if (!obj(pr)) { shape.push(pat + ' must be an object.'); continue; }
      if (typeof pr.id !== 'string' || !/^P[1-9][0-9]?$/.test(pr.id)) { shape.push(pat + '.id must be "P1", "P2", … .'); continue; }
      if (prIds[pr.id]) { shape.push(pat + ': the id ' + pr.id + ' is used twice.'); continue; }
      if (!str(pr.repo, 200) || !planRepos[low(pr.repo)]) shape.push(pr.id + ': "repo" must be one of the repositories in "repos".');
      if (!str(pr.title, L.prTitle)) shape.push(pr.id + ': "title" must be a non-empty string of at most ' + L.prTitle + ' characters.');
      if (!str(pr.contains, L.prContains)) shape.push(pr.id + ': "contains" must be a non-empty string of at most ' + L.prContains + ' characters.');
      if (!strList(pr.criteria, L.criteria, 20)) shape.push(pr.id + ': "criteria" must be a list of criterion refs.');
      if (!strList(pr.dependsOn, L.stackTotal, 4)) { shape.push(pr.id + ': "dependsOn" must be a list of earlier pull request ids.'); }
      else {
        for (var d = 0; d < pr.dependsOn.length; d++) if (!prIds[pr.dependsOn[d]]) shape.push(pr.id + ': "dependsOn" names ' + pr.dependsOn[d] + ', which is not an EARLIER pull request.');
      }
      var key = typeof pr.repo === 'string' ? low(pr.repo) : '';
      var line = perRepo[key] || [];
      if (line.length > 0 && Array.isArray(pr.dependsOn) && pr.dependsOn.indexOf(line[line.length - 1]) < 0) {
        shape.push(pr.id + ' is the next pull request in ' + pr.repo + ', so "dependsOn" must include ' + line[line.length - 1] + ' (the stack in one repository is one line).');
      }
      line.push(pr.id);
      perRepo[key] = line;
      prIds[pr.id] = true;
      prOrder.push(pr.id);
    }
    Object.keys(perRepo).forEach(function (k) { if (perRepo[k].length > L.stackPerRepo) shape.push(k + ' has ' + perRepo[k].length + ' pull requests: at most ' + L.stackPerRepo + ' per repository.'); });
    Object.keys(planRepos).forEach(function (k) { if (!perRepo[k]) shape.push(k + ' is in "repos" but has no pull request in "stack".'); });
    var reasonNeeded = raw.stack.length > raw.repos.length;
    if (raw.stackReason !== null && raw.stackReason !== undefined && !str(raw.stackReason, L.stackReason)) shape.push('"stackReason" must be null or a string of at most ' + L.stackReason + ' characters.');
    if (reasonNeeded && !str(raw.stackReason, L.stackReason)) shape.push('"stackReason" must say why the work is split into more pull requests than repositories.');

    // ---- criteria ----
    var fixed = Object.create(null);
    var wantList = ctx.criteria || [];
    for (var c0 = 0; c0 < wantList.length; c0++) fixed[wantList[c0].toUpperCase()] = true;
    var isWanted = function (k) { return ctx.criteria === null ? /^AC[1-9][0-9]?$/.test(k) : fixed[k] === true; };
    var gaps = Object.create(null);
    if (ctx.gaps) for (var g = 0; g < ctx.gaps.length; g++) gaps[ctx.gaps[g].toUpperCase()] = true;
    var seenRef = Object.create(null);
    if (raw.criteria.length > L.criteria) shape.push('"criteria" has more than ' + L.criteria + ' entries.');
    for (var c = 0; c < raw.criteria.length; c++) {
      var cr = raw.criteria[c];
      var cat = '"criteria"[' + c + ']';
      if (!obj(cr) || typeof cr.ref !== 'string') { shape.push(cat + ' must be an object with a "ref".'); continue; }
      var ref = cr.ref.trim().toUpperCase();
      if (!isWanted(ref)) { shape.push(cat + ': "' + cr.ref + '" is not a criterion of TICKET.md. Use: ' + (ctx.criteria === null ? 'AC1, AC2, … in the order of the ticket\'s text' : wantList.join(', ')) + '.'); continue; }
      if (seenRef[ref]) { shape.push(cat + ': ' + ref + ' is listed twice.'); continue; }
      seenRef[ref] = true;
      if (cr.status !== 'planned' && cr.status !== 'met' && cr.status !== 'not_planned') shape.push(ref + ': "status" must be "planned", "met" or "not_planned".');
      if (!str(cr.how, L.criterionHow)) shape.push(ref + ': "how" must be a non-empty string of at most ' + L.criterionHow + ' characters.');
      if (!strList(cr.prs, L.stackTotal, 4)) shape.push(ref + ': "prs" must be a list of pull request ids.');
      else {
        if (cr.status === 'planned' && cr.prs.length === 0) shape.push(ref + ' is planned, so "prs" must name the pull request that delivers it.');
        for (var k = 0; k < cr.prs.length; k++) if (!prIds[cr.prs[k]]) shape.push(ref + ': "prs" names ' + cr.prs[k] + ', which is not in "stack".');
      }
      if (cr.openPoints !== undefined && !(Array.isArray(cr.openPoints) && cr.openPoints.length <= 50 && cr.openPoints.every(function (n) { return typeof n === 'number' && n >= 1 && Math.floor(n) === n; }))) shape.push(ref + ': "openPoints" must be a list of open point numbers.');
      if (ctx.fillGaps && gaps[ref] && cr.status === 'met') shape.push(ref + ' is a gap the story check found: plan it, or say why not ("not_planned").');
    }
    for (var w = 0; w < wantList.length; w++) if (!seenRef[wantList[w].toUpperCase()]) shape.push('"criteria" has no entry for ' + wantList[w] + '.');
    for (var p2 = 0; p2 < raw.stack.length; p2++) {
      var sp = raw.stack[p2];
      if (!obj(sp) || !Array.isArray(sp.criteria)) continue;
      for (var q = 0; q < sp.criteria.length; q++) if (!isWanted(String(sp.criteria[q]).toUpperCase())) content.push(sp.id + '.criteria: "' + sp.criteria[q] + '" is not a criterion of TICKET.md.');
    }

    // ---- contentions ----
    var ids = Object.create(null);
    if (raw.contentions.length > L.contentions) shape.push('"contentions" has more than ' + L.contentions + ' points.');
    for (var t = 0; t < raw.contentions.length; t++) {
      var ct = raw.contentions[t];
      var tat = '"contentions"[' + t + ']';
      if (!obj(ct)) { shape.push(tat + ' must be an object.'); continue; }
      if (typeof ct.id !== 'string' || !/^C[1-9][0-9]?$/.test(ct.id)) { shape.push(tat + '.id must be "C1", "C2", … .'); continue; }
      if (ids[ct.id]) { shape.push(tat + ': the id ' + ct.id + ' is used twice.'); continue; }
      ids[ct.id] = true;
      if (!strList(ct.about, 10, 60) || ct.about.length === 0) shape.push(ct.id + ': "about" must list what it is about ("AC2", "description", "open point 3").');
      if (!str(ct.storySays, L.storySays)) shape.push(ct.id + ': "storySays" must quote TICKET.md (at most ' + L.storySays + ' characters).');
      if (!str(ct.problem, L.problem)) shape.push(ct.id + ': "problem" must be a non-empty string of at most ' + L.problem + ' characters.');
      if (!str(ct.proposal, L.proposal)) shape.push(ct.id + ': "proposal" must be a non-empty string of at most ' + L.proposal + ' characters.');
      if (!str(ct.ifKept, L.ifKept)) shape.push(ct.id + ': "ifKept" must be a non-empty string of at most ' + L.ifKept + ' characters.');
      if (!Array.isArray(ct.evidence) || ct.evidence.length < L.evidenceMin || ct.evidence.length > L.evidenceMax) {
        shape.push(ct.id + ': "evidence" must have ' + L.evidenceMin + ' to ' + L.evidenceMax + ' items. A point you cannot show is not a point of contention: leave it out.');
        continue;
      }
      var bad = [];
      for (var e = 0; e < ct.evidence.length; e++) {
        var ev = ct.evidence[e];
        var eat = ct.id + '.evidence[' + e + ']';
        var drop = function (why) { content.push(eat + ': ' + why); bad.push(e); };
        if (!obj(ev) || typeof ev.kind !== 'string') { shape.push(eat + ' must be an object with a "kind".'); continue; }
        if (typeof ev.quote !== 'string' || ev.quote.length > L.quoteMax) { shape.push(eat + ': "quote" must be a string of at most ' + L.quoteMax + ' characters.'); continue; }
        if (letters(ev.quote) < L.quoteMinLetters) { drop('the quote is too short to check (at least ' + L.quoteMinLetters + ' letters or digits).'); continue; }
        if (ev.kind === 'code' || ev.kind === 'data_file') {
          var linesOk = Array.isArray(ev.lines) && ev.lines.length === 2 && ev.lines.every(function (n) { return typeof n === 'number' && Math.floor(n) === n; });
          if (!str(ev.repo, 200) || !str(ev.path, 500) || !linesOk) { shape.push(eat + ' must be { "kind": "' + ev.kind + '", "repo", "path", "lines": [start, end], "quote" }.'); continue; }
          if (ev.kind === 'data_file' && ['fixture', 'seed', 'schema', 'migration', 'other'].indexOf(ev.what) < 0) { shape.push(eat + ': "what" must be "fixture", "seed", "schema", "migration" or "other".'); continue; }
          if (!sessionRepos[low(ev.repo)]) { drop('"' + ev.repo + '" is not a repository of this session.'); continue; }
          if (/^\//.test(ev.path) || ev.path.split('/').indexOf('..') >= 0 || /(^|\/)\.git(\/|$)/.test(ev.path)) { drop('"path" must be relative to the repository root, without "..", and not under .git.'); continue; }
          if (ev.lines[0] < 1 || ev.lines[1] < ev.lines[0] || ev.lines[1] - ev.lines[0] + 1 > L.lineSpan) { drop('"lines" must be [start, end] with 1 <= start <= end and at most ' + L.lineSpan + ' lines.'); continue; }
        } else if (ev.kind === 'docs') {
          if (!str(ev.link, 600)) { shape.push(eat + ' must be { "kind": "docs", "link", "quote" }.'); continue; }
          if (!ctx.docs) { drop('no reference documents are in this session.'); continue; }
          if (ev.quote.length > L.docsQuoteMax) { drop('a docs quote must be at most ' + L.docsQuoteMax + ' characters.'); continue; }
        } else if (ev.kind === 'data_run') {
          if (!str(ev.run, 20)) { shape.push(eat + ' must be { "kind": "data_run", "run": "svc-<n>", "quote" }.'); continue; }
          if (ctx.runs.indexOf(ev.run.trim()) < 0) { drop('"' + ev.run + '" is not a run Limn recorded. Run the query with limn-svc run and cite the svc-<n> id it prints.'); continue; }
        } else {
          shape.push(eat + ': "kind" must be "code", "docs", "data_file" or "data_run".');
          continue;
        }
      }
      if (bad.length > 0) droppedEvidence[ct.id] = bad;
      if (bad.length === ct.evidence.length) content.push(ct.id + ' has no evidence left that Limn can check, so it is dropped.');
    }

    // ---- ticket update ----
    var tu = raw.ticketUpdate;
    // A point of contention says the story is wrong: the reader gets the draft to fix it (owner, 2026-11-07).
    if ((tu === null || tu === undefined) && raw.contentions.length > 0) shape.push('"ticketUpdate" is null, but "contentions" says the story is wrong: give the updated "description" and/or "acceptanceCriteria" in the ticket\'s own format.');
    if (tu !== null && tu !== undefined) {
      if (!obj(tu)) shape.push('"ticketUpdate" must be null or an object.');
      else {
        var fieldOk = function (v) { return v === null || v === undefined || str(v, L.ticketField); };
        if (!fieldOk(tu.description) || !fieldOk(tu.acceptanceCriteria)) shape.push('"ticketUpdate": "description" and "acceptanceCriteria" must each be null or the WHOLE new text (at most ' + L.ticketField + ' characters).');
        if (!str(tu.description, L.ticketField) && !str(tu.acceptanceCriteria, L.ticketField)) shape.push('"ticketUpdate" must have a new "description" or new "acceptanceCriteria" (or be null).');
        if (!str(tu.why, L.ticketWhy)) shape.push('"ticketUpdate.why" must be a non-empty string of at most ' + L.ticketWhy + ' characters.');
        if (!strList(tu.contentions, L.contentions, 4)) shape.push('"ticketUpdate.contentions" must be a list of contention ids.');
        else for (var u = 0; u < tu.contentions.length; u++) if (!ids[tu.contentions[u]]) content.push('ticketUpdate.contentions: ' + tu.contentions[u] + ' is not a point of contention.');
      }
    }
    if (shape.length > 0) return out();
    return { plan: raw, shapeProblems: [], contentProblems: content, droppedEvidence: droppedEvidence };
  }
  return { validateBuildPlan: validateBuildPlan, foldCode: foldCode, findQuote: findQuote, letters: letters };
})()`;

export interface QuoteHit {
  at: 'in' | 'moved' | 'none' | 'ambiguous';
  start: number;
  end: number;
}

interface Compiled {
  validateBuildPlan(raw: unknown, ctx: BuildPlanCheckContext): BuildPlanCheck;
  foldCode(s: string): string;
  findQuote(text: string, quote: string, start: number, end: number): QuoteHit;
  letters(s: string): number;
}

let compiled: Compiled | null = null;

function lib(): Compiled {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- our own constant (see the header).
  compiled ??= new Function(`return ${BUILD_PLAN_CHECK_SOURCE};`)() as Compiled;
  return compiled;
}

/** The host's run of THE validator. Pure. */
export function validateBuildPlan(raw: unknown, ctx: BuildPlanCheckContext): BuildPlanCheck {
  return lib().validateBuildPlan(raw, { ...ctx, criteria: ctx.criteria ? [...ctx.criteria] : null, gaps: ctx.gaps ? [...ctx.gaps] : null, repos: [...ctx.repos], runs: [...ctx.runs] });
}

/** Whitespace runs → one space (code quotes are compared this way, and nothing else is folded). */
export const foldCode = (s: string): string => lib().foldCode(s);

/** Where a quote is in a file's text (see the source's header). */
export const findQuote = (text: string, quote: string, start: number, end: number): QuoteHit => lib().findQuote(text, quote, start, end);

/** What `plan-context.json` holds (the checker's `ctx`, plus where each repository and the docs are). */
export interface PlanContextFile extends BuildPlanCheckContext {
  repoPaths: Record<string, string>;
  docsDir: string | null;
}

/**
 * The checker the agent runs (CommonJS, Node only, no dependency). It reads a plan from STDIN (the JSON,
 * or the whole ```limn-plan block), runs THE validator against `plan-context.json`, then tries each code
 * and data-file quote against `refs/limn/base` and each docs quote against the copied sections. Prints
 * `OK` or one line per problem (exit 0 / 1). Advice only: the host checks everything again.
 */
export function planCheckerSource(o: { contextFile: string }): string {
  return [
    '#!/usr/bin/env node',
    "// Limn: checks a plan. Run: node ~/.limn/plan-check.cjs <<'EOF' … EOF",
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    "const cp = require('child_process');",
    `const CONTEXT = ${JSON.stringify(o.contextFile)};`,
    `const MAX = ${BUILD_PLAN_MAX_BYTES};`,
    `const LIB = ${BUILD_PLAN_CHECK_SOURCE};`,
    'function fail(lines) { for (const l of lines) console.log(l); process.exit(1); }',
    "let text = '';",
    "try { text = fs.readFileSync(0, 'utf8'); } catch (e) { fail(['Pipe the plan in: node ~/.limn/plan-check.cjs <<\\'EOF\\' … EOF']); }",
    "if (Buffer.byteLength(text, 'utf8') > MAX) fail(['The plan is larger than ' + MAX + ' bytes.']);",
    "const fenced = /```limn-plan[^\\n]*\\n([\\s\\S]*?)\\n```/.exec(text);",
    'if (fenced) text = fenced[1];',
    'let raw;',
    "try { raw = JSON.parse(text); } catch (e) { fail(['The plan is not valid JSON: ' + e.message]); }",
    'let ctx;',
    "try { ctx = JSON.parse(fs.readFileSync(CONTEXT, 'utf8')); } catch (e) { fail(['Limn\\'s plan context is missing: ' + CONTEXT]); }",
    'const r = LIB.validateBuildPlan(raw, ctx);',
    'const problems = r.shapeProblems.concat(r.contentProblems);',
    'if (r.plan) {',
    '  const repoPath = (name) => ctx.repoPaths[String(name).trim().toLowerCase()];',
    '  for (const c of r.plan.contentions) {',
    '    const dropped = r.droppedEvidence[c.id] || [];',
    '    c.evidence.forEach((e, i) => {',
    '      if (dropped.indexOf(i) >= 0) return;',
    "      const at = c.id + '.evidence[' + i + ']';",
    "      if (e.kind === 'code' || e.kind === 'data_file') {",
    '        const dir = repoPath(e.repo);',
    '        if (!dir) return;',
    '        let file;',
    "        try { file = cp.execFileSync('git', ['-C', dir, 'show', 'refs/limn/base:' + e.path], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }",
    "        catch (x) { problems.push(at + ': ' + e.path + ' is not a file at the base commit (refs/limn/base). Cite code as it is at the base, not your changes.'); return; }",
    '        const hit = LIB.findQuote(file, e.quote, e.lines[0], e.lines[1]);',
    "        if (hit.at === 'moved') problems.push(at + ': the quote is at lines ' + hit.start + '-' + hit.end + ', not ' + e.lines[0] + '-' + e.lines[1] + '.');",
    "        else if (hit.at === 'none') problems.push(at + ': the quote is not in ' + e.path + ' at the base commit. Copy the exact text.');",
    "        else if (hit.at === 'ambiguous') problems.push(at + ': the quote is in ' + e.path + ' more than once and not at the lines you gave.');",
    "      } else if (e.kind === 'docs' && ctx.docsDir) {",
    "        const rel = String(e.link).replace(/^\\[[^\\]]*\\]\\(|\\)$/g, '').split('#')[0].replace(/^\\.\\//, '');",
    "        const file = path.isAbsolute(rel) ? rel : path.join(ctx.docsDir, rel);",
    '        let t;',
    "        try { t = fs.readFileSync(file, 'utf8'); } catch (x) { problems.push(at + ': ' + e.link + ' is not a copied section. Link a file under ' + ctx.docsDir + '.'); return; }",
    "        const fold = (s) => String(s).toLowerCase().replace(/[*_`]/g, '').replace(/\\s+/g, ' ').trim();",
    "        if (fold(t).indexOf(fold(e.quote)) < 0) problems.push(at + ': the quote is not in ' + e.link + '. Copy the exact text.');",
    '      }',
    '    });',
    '  }',
    '}',
    "if (problems.length > 0) fail(['Fix these problems, then run this check again:'].concat(problems.map((p) => '- ' + p)));",
    "console.log('OK');",
    '',
  ].join('\n');
}
