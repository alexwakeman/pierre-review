// THE HOST'S CHECK OF A PLAN (docs/SANDBOX.md § The plan and its checks). ONE entry, `verifyBuildPlan`,
// after every chat turn of a plan-first session that produced a ```limn-plan block. Pure apart from the
// seams it is handed (a base-blob reader, the library snapshot, the service-run log), so it is tested
// without git or a DB.
//
//   1. JSON.parse, then THE validator text (sandbox/workspace/plan-check.ts). Shape problems ⇒ no revision.
//   2. Repository names → the session's repository ids.
//   3. EVERY evidence item verified HERE (the agent controls the sandbox, so its own checker and its quotes
//      count for nothing):
//        code / data_file  the blob at the repository's session base commit, read from Limn's clone cache;
//                          the quote (whitespace folded) must be in the stated lines ± 3, or EXACTLY once
//                          elsewhere (the lines are then corrected). The page shows the HOST's text.
//        docs              `validateDocReferences` against the FULL built library (the rules of every
//                          other doc reference: one candidate, the quote in that section).
//        data_run          a run in Limn's own `limn-svc run` log, from a service with no internet route;
//                          the quote must be in the output Limn recorded.
//      A failure drops the item; a contention left with none is dropped. Only counts and plain reasons are
//      kept for the ⓘ, never the dropped claims' text.
//   4. `storySays` must be in TICKET.md (the shared quote fold); not found ⇒ cleared, counted.
//   5. Host branch names, fingerprints.
// ⚠ Nothing from production systems can be evidence: the sandbox has no route out but the proxy's
//   allow-list, services run on the session's internal network, and a run from a service the reader opened
//   to the internet is refused.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import {
  BUILD_PLAN_LIMITS,
  foldForQuote,
  quoteAppearsIn,
  type BuildPlanContention,
  type BuildPlanCriterion,
  type BuildPlanDataKind,
  type BuildPlanEvidence,
  type BuildPlanEvidenceRaw,
  type BuildPlanPr,
  type BuildPlanRaw,
  type BuildPlanRevision,
} from '@pierre-review/shared';
import { validateDocReferences, type LibrarySnapshot } from '../../reference-docs/review-refs.js';
import type { ServiceRunRecord } from '../../sandbox/services/run-log.js';
import { findQuote, validateBuildPlan, type BuildPlanCheckContext } from '../../sandbox/workspace/plan-check.js';

/** The largest file Limn reads for a quote. */
export const EVIDENCE_BLOB_MAX_BYTES = 2 * 1024 * 1024;
/** What an excerpt shows at most. */
export const EVIDENCE_EXCERPT_MAX_LINES = 40;
export const EVIDENCE_EXCERPT_MAX_BYTES = 4 * 1024;

export interface PlanSessionRepo {
  repoId: number;
  fullName: string;
  baseSha: string;
}

export interface PlanVerifySeams {
  /** The file at `repo.baseSha:path` from Limn's clone cache, or null when it is not a file there. */
  readBlob(repo: PlanSessionRepo, path: string): Promise<Buffer | null>;
  /** The built library (docs sessions only), or null. */
  library: LibrarySnapshot | null;
  /** A recorded `limn-svc run`, or null. */
  run(id: string): ServiceRunRecord | null;
}

export interface PlanVerifyInput {
  body: string;
  check: BuildPlanCheckContext;
  repos: readonly PlanSessionRepo[];
  /** TICKET.md's text as the session last wrote it (description, criteria, open points). */
  ticketText: string;
  /** ref ('AC1', 'M1') → its text. */
  criteriaText: ReadonlyMap<string, string>;
  /** The session branch (`limn/<key>`): stack index k ≥ 2 gets `-k`. */
  branch: string;
  seams: PlanVerifySeams;
}

export type VerifiedPlan = Omit<BuildPlanRevision, 'revision' | 'createdAt' | 'source'>;

export type PlanVerifyResult = { ok: true; plan: VerifiedPlan; rawSha: string } | { ok: false; problems: string[] };

/** The branch of the k-th PR of a repository (1-based): `limn/<key>`, `limn/<key>-2`, `limn/<key>-3`. */
export const stackBranch = (branch: string, k: number): string => (k <= 1 ? branch : `${branch}-${k}`);

const DATA_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(__)?fixtures(__)?\//i,
  /(^|\/)seeds?\//i,
  /(^|\/)seed[^/]*\/|(^|\/)[^/]*seed[^/]*\.[^/]+$/i,
  /(^|\/)migrations?\//i,
  /\.sql$/i,
  /(^|\/)schema[^/]*\.[^/]+$/i,
  /\.prisma$/i,
  /(^|\/)testdata\//i,
  /(^|\/)(tests?|spec|__tests__)\/.*\.(json|csv|ya?ml)$/i,
];

/** The agent's label, kept only when the path looks like data. */
export function dataLabelFor(path: string, what: BuildPlanDataKind): BuildPlanDataKind {
  if (what === 'other') return 'other';
  return DATA_PATH_PATTERNS.some((re) => re.test(path)) ? what : 'other';
}

/** A safe repository-relative path, or null. */
export function cleanRepoPath(raw: string): string | null {
  if (raw.includes('\0') || raw.includes('\\') || posix.isAbsolute(raw)) return null;
  const n = posix.normalize(raw.replace(/^\.\//, ''));
  if (n === '.' || n.startsWith('../') || n === '..' || n.split('/').includes('..')) return null;
  if (n.split('/').some((s) => s.toLowerCase() === '.git')) return null;
  return n;
}

/** Lines [start, end] of a text, cut at the excerpt limits. */
export function excerptOf(text: string, start: number, end: number): string {
  const lines = text.split('\n').slice(Math.max(0, start - 1), Math.max(start, end));
  let out = lines.slice(0, EVIDENCE_EXCERPT_MAX_LINES).join('\n');
  let cut = lines.length > EVIDENCE_EXCERPT_MAX_LINES;
  if (Buffer.byteLength(out, 'utf8') > EVIDENCE_EXCERPT_MAX_BYTES) {
    out = Buffer.from(out, 'utf8').subarray(0, EVIDENCE_EXCERPT_MAX_BYTES).toString('utf8').replace(/�$/, '');
    cut = true;
  }
  return cut ? `${out}\n…` : out;
}

const sha = (algo: 'sha1' | 'sha256', s: string): string => createHash(algo).update(s).digest('hex');

function evidenceKey(e: BuildPlanEvidence): string {
  switch (e.kind) {
    case 'code':
    case 'data_file':
      return `${e.kind}:${e.repoId}:${e.path}:${e.startLine}-${e.endLine}`;
    case 'docs':
      return `docs:${e.path}#${e.anchor ?? ''}`;
    case 'data_run':
      return `run:${e.run}`;
  }
}

/** A contention's fingerprint: its problem (folded) and its sorted evidence keys. */
export function contentionFingerprint(problem: string, evidence: readonly BuildPlanEvidence[]): string {
  return sha('sha1', `${foldForQuote(problem)}\n${evidence.map(evidenceKey).sort().join('\n')}`);
}

const looksBinary = (b: Buffer): boolean => b.subarray(0, 8192).includes(0);
const clipText = (s: string | null | undefined, max: number): string => (s ?? '').trim().slice(0, max);

type Verdict = { ok: true; evidence: BuildPlanEvidence } | { ok: false; reason: string };

async function verifyFileEvidence(
  e: Extract<BuildPlanEvidenceRaw, { kind: 'code' | 'data_file' }>,
  repos: ReadonlyMap<string, PlanSessionRepo>,
  seams: PlanVerifySeams,
): Promise<Verdict> {
  const repo = repos.get(e.repo.trim().toLowerCase());
  if (!repo) return { ok: false, reason: 'cited a repository that is not in this session' };
  const path = cleanRepoPath(e.path);
  if (!path) return { ok: false, reason: 'cited a path outside the repository' };
  const [s0, e0] = e.lines;
  if (!(s0 >= 1 && e0 >= s0 && e0 - s0 + 1 <= BUILD_PLAN_LIMITS.lineSpan)) return { ok: false, reason: 'cited lines Limn could not read' };
  let blob: Buffer | null;
  try {
    blob = await seams.readBlob(repo, path);
  } catch {
    blob = null;
  }
  if (blob == null) return { ok: false, reason: 'cited a file that is not in the repository at the base commit' };
  if (blob.length > EVIDENCE_BLOB_MAX_BYTES || looksBinary(blob)) return { ok: false, reason: 'cited a file that is too large or not text' };
  const text = blob.toString('utf8');
  const hit = findQuote(text, e.quote, s0, e0);
  if (hit.at === 'none' || hit.at === 'ambiguous') return { ok: false, reason: 'quoted code that is not at the lines it cited' };
  const startLine = hit.start;
  const endLine = Math.min(hit.end, startLine + BUILD_PLAN_LIMITS.lineSpan - 1);
  const common = { repoId: repo.repoId, fullName: repo.fullName, path, startLine, endLine, baseSha: repo.baseSha, excerpt: excerptOf(text, startLine, endLine), linesCorrected: hit.at === 'moved' };
  return e.kind === 'code'
    ? { ok: true, evidence: { kind: 'code', ...common } }
    : { ok: true, evidence: { kind: 'data_file', what: dataLabelFor(path, e.what), ...common } };
}

function verifyRunEvidence(e: Extract<BuildPlanEvidenceRaw, { kind: 'data_run' }>, seams: PlanVerifySeams): Verdict {
  const rec = seams.run(e.run);
  if (!rec) return { ok: false, reason: 'cited a service run Limn did not record' };
  if (rec.egress) return { ok: false, reason: 'cited a service that can reach the internet' };
  const lines = rec.output.split('\n');
  const hit = findQuote(rec.output, e.quote, 1, lines.length);
  if (hit.at === 'none') return { ok: false, reason: 'quoted output that is not in the run Limn recorded' };
  // In the whole output, 'in' and 'ambiguous' cannot both be wrong: any place will do; show the first.
  const from = Math.max(1, hit.start - 3);
  const to = Math.min(lines.length, hit.end + 3, from + EVIDENCE_EXCERPT_MAX_LINES - 1);
  return {
    ok: true,
    evidence: { kind: 'data_run', run: rec.id, stack: rec.stack, service: rec.service, command: rec.command, exitCode: rec.exitCode, at: rec.startedAt, excerpt: excerptOf(rec.output, from, to) },
  };
}

function verifyDocsEvidence(e: Extract<BuildPlanEvidenceRaw, { kind: 'docs' }>, about: string, seams: PlanVerifySeams): Verdict {
  if (!seams.library) return { ok: false, reason: 'cited a document, but no reference documents are in this session' };
  const r = validateDocReferences([{ link: e.link, quote: e.quote, verdict: 'contradicts', note: '', about }], seams.library);
  const ref = r.references[0];
  if (!ref) return { ok: false, reason: 'quoted a document section Limn could not find the text in' };
  return { ok: true, evidence: { kind: 'docs', ...ref } };
}

/** THE entry (see the header). */
export async function verifyBuildPlan(input: PlanVerifyInput): Promise<PlanVerifyResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(input.body);
  } catch (err) {
    return { ok: false, problems: [`The plan is not valid JSON: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300)] };
  }
  const check = validateBuildPlan(raw, input.check);
  if (check.plan == null) return { ok: false, problems: check.shapeProblems };
  const plan: BuildPlanRaw = check.plan;
  const byName = new Map(input.repos.map((r) => [r.fullName.toLowerCase(), r] as const));
  const reasons = new Set<string>();
  let droppedEvidence = 0;
  let droppedContentions = 0;
  const contentions: BuildPlanContention[] = [];
  for (const c of plan.contentions) {
    const skip = new Set(check.droppedEvidence[c.id] ?? []);
    const evidence: BuildPlanEvidence[] = [];
    const seen = new Set<string>();
    for (const [i, e] of c.evidence.entries()) {
      if (skip.has(i)) {
        droppedEvidence += 1;
        reasons.add('cited evidence Limn could not check');
        continue;
      }
      let v: Verdict;
      if (e.kind === 'code' || e.kind === 'data_file') v = await verifyFileEvidence(e, byName, input.seams);
      else if (e.kind === 'data_run') v = verifyRunEvidence(e, input.seams);
      else v = verifyDocsEvidence(e, c.about.join(', '), input.seams);
      if (!v.ok) {
        droppedEvidence += 1;
        reasons.add(v.reason);
        continue;
      }
      const key = evidenceKey(v.evidence);
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push(v.evidence);
    }
    if (evidence.length === 0) {
      droppedContentions += 1;
      continue;
    }
    const storySays = quoteAppearsIn(input.ticketText, c.storySays) ? c.storySays.trim() : null;
    if (storySays == null) reasons.add('quoted the story with words that are not in the ticket');
    contentions.push({
      id: c.id,
      fingerprint: contentionFingerprint(c.problem, evidence),
      about: c.about.map((a) => a.trim()).filter(Boolean),
      storySays,
      problem: c.problem.trim(),
      proposal: c.proposal.trim(),
      ifKept: c.ifKept.trim(),
      evidence,
    });
  }
  const kept = new Set(contentions.map((c) => c.id));
  const repoOf = (name: string): PlanSessionRepo => byName.get(name.trim().toLowerCase())!;
  const perRepo = new Map<number, number>();
  const stack: BuildPlanPr[] = plan.stack.map((p) => {
    const r = repoOf(p.repo);
    const k = (perRepo.get(r.repoId) ?? 0) + 1;
    perRepo.set(r.repoId, k);
    const criteria = p.criteria.map((x) => x.trim().toUpperCase()).filter((x) => input.check.criteria === null || input.check.criteria.map((y) => y.toUpperCase()).includes(x));
    return { key: p.id, repoId: r.repoId, fullName: r.fullName, stackIndex: k, title: p.title.trim(), contains: p.contains.trim(), criteria, dependsOn: [...p.dependsOn], branch: stackBranch(input.branch, k) };
  });
  const criteria: BuildPlanCriterion[] = plan.criteria.map((c) => {
    const ref = c.ref.trim().toUpperCase();
    return { ref, text: input.criteriaText.get(ref) ?? '', status: c.status, how: c.how.trim(), prs: [...c.prs], openPoints: c.openPoints ? [...c.openPoints] : [] };
  });
  const tu = plan.ticketUpdate;
  return {
    ok: true,
    rawSha: sha('sha256', input.body),
    plan: {
      summary: plan.summary.trim(),
      repos: plan.repos.map((r) => ({ repoId: repoOf(r.repo).repoId, fullName: repoOf(r.repo).fullName, why: r.why.trim() })),
      criteria,
      contentions,
      stack,
      stackReason: plan.stackReason?.trim() || null,
      ticketUpdate: tu
        ? {
            description: tu.description?.trim() ? tu.description : null,
            acceptanceCriteria: tu.acceptanceCriteria?.trim() ? tu.acceptanceCriteria : null,
            why: clipText(tu.why, BUILD_PLAN_LIMITS.ticketWhy),
            contentions: tu.contentions.filter((id) => kept.has(id)),
          }
        : null,
      dropped: { contentions: droppedContentions, evidence: droppedEvidence, reasons: [...reasons] },
    },
  };
}

