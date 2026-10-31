#!/usr/bin/env node
// REVIEW EVAL — how many KNOWN issues does a review setup find, and how steadily?
//
// Runs N fresh AI reviews per pull request through the local Limn API (the dev server on :4000),
// waits for each, and scores its findings against a hand-written list of known issues. Nothing is
// posted to GitHub (a manual run never posts). Each run becomes that PR's latest review in the app.
//
//   node scripts/review-eval.mjs --cases ~/.limn/review-eval/cases.json --runs 3 \
//        --provider claude --model claude-opus-5-5 --label baseline
//   node scripts/review-eval.mjs --cases … --score ~/.limn/review-eval/results/<file>.json   # re-score only
//
// THE CASES FILE lives OUTSIDE the repo (it describes a team's private code):
//   { "cases": [ { "id": "564", "prId": 192207, "name": "bng-metric-backend#564",
//       "issues": [ { "id": "units-zero", "severity": "warning", "title": "…",
//                     "path": "recompute-created-hedgerow-edit",          // optional regex on the path
//                     "all": ["units", "\\b0\\b|zero", "null|incomplete"] } ] } ] }
// A finding MATCHES an issue when its path matches `path` (if given) and its title + body match EVERY
// regex in `all` (case-insensitive). Unmatched findings are listed, so the patterns can be refined
// and the saved results re-scored with --score.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (!a.startsWith('--')) return acc;
    const [k, v] = a.slice(2).split('=');
    acc.push([k, v ?? (all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true')]);
    return acc;
  }, []),
);
const expand = (p) => (p?.startsWith('~') ? join(homedir(), p.slice(1)) : p);
const BASE = args.base ?? 'http://localhost:4000';
const casesPath = expand(args.cases ?? '~/.limn/review-eval/cases.json');
const cases = JSON.parse(readFileSync(casesPath, 'utf8')).cases.filter(
  (c) => args.only == null || args.only.split(',').includes(c.id),
);

const words = (s) => (s ?? '').split(/\s+/).filter(Boolean).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function runOnce(c) {
  const body = { fresh: true, ...(args.provider ? { provider: args.provider } : {}), ...(args.model ? { model: args.model } : {}) };
  const { reviewId } = await api(`/api/prs/${c.prId}/claude-review`, { method: 'POST', body: JSON.stringify(body) });
  const started = Date.now();
  for (;;) {
    await sleep(10_000);
    const r = await api(`/api/claude-reviews/${reviewId}`);
    const rev = r.review ?? r;
    if (!['queued', 'running'].includes(rev.status)) {
      return {
        reviewId,
        status: rev.status,
        error: rev.error ?? null,
        provider: rev.provider,
        model: rev.model,
        scope: rev.scope,
        costUsd: rev.costUsd ?? null,
        outputTokens: rev.outputTokens ?? null,
        seconds: Math.round((Date.now() - started) / 1000),
        summary: rev.summary ?? '',
        findings: (rev.findings ?? []).map((f) => ({
          severity: f.severity,
          path: f.path,
          line: f.line ?? null,
          title: f.title ?? '',
          body: f.body ?? '',
        })),
      };
    }
    if (Date.now() - started > 45 * 60_000) throw new Error(`review ${reviewId} still running after 45 minutes`);
  }
}

function matches(issue, f) {
  if (issue.path && !new RegExp(issue.path, 'i').test(f.path ?? '')) return false;
  const text = `${f.title}\n${f.body}`;
  return issue.all.every((re) => new RegExp(re, 'i').test(text));
}

function score(results) {
  const out = [];
  for (const c of cases) {
    const runs = results.filter((r) => r.caseId === c.id && r.status === 'succeeded');
    const perIssue = c.issues.map((iss) => ({
      id: iss.id,
      severity: iss.severity,
      title: iss.title,
      hits: runs.filter((r) => r.findings.some((f) => matches(iss, f))).length,
    }));
    const perRun = runs.map((r) => {
      const found = c.issues.filter((iss) => r.findings.some((f) => matches(iss, f))).map((i) => i.id);
      const unmatched = r.findings.filter((f) => !c.issues.some((iss) => matches(iss, f)));
      return {
        reviewId: r.reviewId,
        found,
        recall: c.issues.length ? found.length / c.issues.length : 0,
        findings: r.findings.length,
        unmatched: unmatched.map((f) => `${f.severity} ${f.path}:${f.line ?? ''} ${f.title}`),
        findingWords: r.findings.reduce((n, f) => n + words(f.body), 0),
        summaryWords: words(r.summary),
        costUsd: r.costUsd,
        seconds: r.seconds,
      };
    });
    out.push({ case: c, runs: runs.length, failed: results.filter((r) => r.caseId === c.id && r.status !== 'succeeded').length, perIssue, perRun });
  }
  return out;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x) => `${Math.round(x * 100)}%`;

function report(scored, meta) {
  const lines = [`# Review eval — ${meta.label} (${meta.provider ?? 'default'} ${meta.model ?? ''}, ${meta.runs} run(s) per PR)`, ''];
  const allRecall = [];
  let cost = 0;
  for (const s of scored) {
    const rec = s.perRun.map((r) => r.recall);
    allRecall.push(...rec);
    cost += s.perRun.reduce((n, r) => n + (r.costUsd ?? 0), 0);
    lines.push(`## ${s.case.name}  — recall ${pct(mean(rec))} (runs: ${rec.map(pct).join(', ') || 'none'})${s.failed ? `, ${s.failed} failed` : ''}`);
    for (const i of s.perIssue) lines.push(`- ${i.hits}/${s.runs}  ${i.severity.padEnd(7)} ${i.id} — ${i.title}`);
    for (const r of s.perRun) {
      lines.push(`  run #${r.reviewId}: ${r.found.length}/${s.case.issues.length} known, ${r.findings} findings, ${r.findingWords} words, $${(r.costUsd ?? 0).toFixed(2)}, ${r.seconds}s`);
      for (const u of r.unmatched) lines.push(`    unmatched: ${u}`);
    }
    lines.push('');
  }
  const stable = scored.flatMap((s) => s.perIssue);
  const everyRun = scored.reduce((n, s) => n + s.perIssue.filter((i) => s.runs > 0 && i.hits === s.runs).length, 0);
  const never = scored.reduce((n, s) => n + s.perIssue.filter((i) => s.runs > 0 && i.hits === 0).length, 0);
  lines.push(`OVERALL: mean recall ${pct(mean(allRecall))}; issues found in EVERY run ${everyRun}/${stable.length}, in NO run ${never}/${stable.length}; cost $${cost.toFixed(2)}`);
  return lines.join('\n');
}

const outDir = expand('~/.limn/review-eval/results');
mkdirSync(outDir, { recursive: true });

if (args.score) {
  const saved = JSON.parse(readFileSync(expand(args.score), 'utf8'));
  console.log(report(score(saved.results), saved.meta));
} else {
  const runs = Number(args.runs ?? 1);
  const meta = { label: args.label ?? 'run', provider: args.provider ?? null, model: args.model ?? null, runs, startedAt: new Date().toISOString(), cases: casesPath };
  const file = join(outDir, `${meta.label}-${meta.startedAt.replace(/[:.]/g, '-')}.json`);
  const results = [];
  for (let i = 0; i < runs; i++) {
    for (const c of cases) {
      process.stdout.write(`run ${i + 1}/${runs} ${c.name} … `);
      try {
        const r = await runOnce(c);
        results.push({ caseId: c.id, ...r });
        console.log(`${r.status}, ${r.findings.length} findings, $${(r.costUsd ?? 0).toFixed(2)}, ${r.seconds}s`);
      } catch (e) {
        results.push({ caseId: c.id, status: 'error', error: String(e), findings: [] });
        console.log(`ERROR ${e}`);
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ meta, results }, null, 2));
    }
  }
  console.log(`\nSaved ${file}\n`);
  console.log(report(score(results), meta));
}
