import {
  STORY_BUILD_BRANCH_MAX,
  STORY_BUILD_MAX_REPOS,
  STORY_BUILD_MAX_RISKS,
  STORY_BUILD_MAX_STEPS_PER_REPO,
  STORY_BUILD_STEP_TITLE_MAX,
  STORY_BUILD_SUMMARY_MAX_SENTENCES,
  STORY_BUILD_SUMMARY_MIN_SENTENCES,
  storySummaryProse,
  type DesignDiagram,
  type StoryBuildCriterionHow,
  type StoryBuildPlan,
  type StoryBuildPlanCriterion,
  type StoryBuildPlanRepo,
} from '@pierre-review/shared';
import { validateDesign, type DesignContext } from '../../review/diagrams/validate.js';

// THE PLAN PASS'S PURE HALF ("Implement story", docs/STORY-BUILD.md § The plan): judging what the
// read-only `story_plan` agent hands `submit_story_plan`, normalising it for storage, and the branch
// names. No DB, no SDK — the unit tests import this file directly.
//
// THE JUDGE (inside the tool, up to MAX_PLAN_ATTEMPTS calls, each refusal saying WHAT TO FIX):
//   • repo refs are only the candidates shown, unique, and 1..STORY_BUILD_MAX_REPOS repositories CHANGE;
//   • every changed repository has 1..STORY_BUILD_MAX_STEPS_PER_REPO steps, each with a title (≤ the cap)
//     and a change; a step's refs are gap refs only;
//   • criteria refs only from the gap fold, and EVERY gap appears exactly once; a `planned` gap names a
//     changed repository with a step that cites it; `how` is existing | planned | not_planned;
//   • the summary is STORY_BUILD_SUMMARY_MIN..MAX sentences of prose (`storySummaryProse`); ≤ MAX_RISKS risks;
//   • the design (only when asked for) passes `validateDesign` as kind 'planned' (cells name repo refs).
//     A design that is still wrong on the LAST attempt does not cost the plan: it is kept with
//     `design: null` and the line "Couldn't draw the design".
// The model's text is untrusted: every string is clipped and whitespace-folded before it is stored.

export const MAX_PLAN_ATTEMPTS = 3;
export const STORY_PLAN_WHY_MAX = 300;
export const STORY_PLAN_CHANGE_MAX = 1_200;
export const STORY_PLAN_REASON_MAX = 400;
export const STORY_PLAN_RISK_MAX = 300;
export const STORY_PLAN_TEST_MAX = 200;
export const STORY_PLAN_TESTS_MAX = 10;
export const STORY_PLAN_FILES_PER_STEP = 20;
export const STORY_PLAN_PATH_MAX = 300;
export const STORY_PLAN_REPLY_MAX = 600;
export const STORY_PLAN_SLUG_MAX = 48;
/** The one line a plan carries when its design could not be drawn. */
export const DESIGN_NOT_DRAWN = "Couldn't draw the design.";

const HOWS: readonly StoryBuildCriterionHow[] = ['existing', 'planned', 'not_planned'];

/** What `submit_story_plan` receives, UNVALIDATED (the zod shape is lenient on purpose). */
export interface RawStoryPlan {
  summary?: unknown;
  repos?: unknown;
  readOnlyRepos?: unknown;
  criteria?: unknown;
  risks?: unknown;
  reply?: unknown;
  design?: unknown;
}

/** What the pass was shown — what the judge checks against. */
export interface StoryPlanContext {
  /** The candidates, in shown order (`R1`…). */
  candidates: ReadonlyArray<{ ref: string; repoId: number }>;
  /** The gap refs (AC… / M…) the plan must account for, in order. */
  gapRefs: readonly string[];
  /** The reader asked for a design ("Draw a design"). */
  wantDiagram: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Control characters out, whitespace folded, clipped (marked …). Non-strings read as ''. */
export function clean(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const t = v.replace(CONTROL, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

const refOf = (v: unknown): string => (typeof v === 'string' ? v.trim().toUpperCase() : '');

/** The sentences of a prose paragraph (a version number like "v1.2" does not end one). */
export function sentencesOf(text: string): string[] {
  return (text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? []).map((s) => s.trim()).filter((s) => s !== '');
}

export interface PlanJudgement {
  /** What to fix; [] when the plan is acceptable. */
  problems: string[];
  /** The design's own problems (only when one was asked for and sent). Not in `problems`. */
  designProblems: string | null;
}

/**
 * What is wrong with a `submit_story_plan` call, as sentences the TOOL answers with. Pure.
 * `designProblems` is kept apart so the last attempt can drop a bad design and keep the plan.
 */
export function checkStoryPlanSubmission(raw: RawStoryPlan, ctx: StoryPlanContext): PlanJudgement {
  const problems: string[] = [];
  const add = (p: string): void => {
    if (!problems.includes(p)) problems.push(p);
  };
  const shown = new Map(ctx.candidates.map((c) => [c.ref.toUpperCase(), c]));
  const shownList = [...shown.keys()].join(', ');
  const gaps = new Set(ctx.gapRefs.map((r) => r.toUpperCase()));
  const gapList = ctx.gapRefs.join(', ');

  // ---- summary ----
  const prose = storySummaryProse(typeof raw.summary === 'string' ? raw.summary : null, 2_000);
  if (prose == null) add('`summary` is empty; write 2 or 3 plain sentences (no list).');
  else {
    const n = sentencesOf(prose).length;
    if (n < STORY_BUILD_SUMMARY_MIN_SENTENCES || n > STORY_BUILD_SUMMARY_MAX_SENTENCES) {
      add(`\`summary\` has ${n} sentence${n === 1 ? '' : 's'}; write ${STORY_BUILD_SUMMARY_MIN_SENTENCES} or ${STORY_BUILD_SUMMARY_MAX_SENTENCES} plain sentences.`);
    }
  }

  // ---- repos that change ----
  const repos = arr(raw.repos);
  if (repos.length === 0) add(`\`repos\` is empty; name at least one repository that changes (${shownList}).`);
  if (repos.length > STORY_BUILD_MAX_REPOS) {
    add(`${repos.length} repositories change; at most ${STORY_BUILD_MAX_REPOS} may. Fold the work into fewer.`);
  }
  const changed = new Map<string, Set<string>>();
  repos.forEach((r, i) => {
    const o = isObj(r) ? r : {};
    const ref = refOf(o.ref);
    const where = ref !== '' ? `repo ${ref}` : `repos[${i}]`;
    if (!shown.has(ref)) add(`${where}: "${clean(o.ref, 20)}" is not one of the repositories shown; use one of ${shownList}.`);
    else if (changed.has(ref)) add(`${where} is listed twice; list each repository once.`);
    if (clean(o.why, STORY_PLAN_WHY_MAX) === '') add(`${where}: \`why\` is empty; say in one sentence why it changes.`);
    const steps = arr(o.steps);
    if (steps.length === 0) add(`${where} has no steps; give at least one.`);
    if (steps.length > STORY_BUILD_MAX_STEPS_PER_REPO) {
      add(`${where} has ${steps.length} steps; merge them so there are at most ${STORY_BUILD_MAX_STEPS_PER_REPO}.`);
    }
    const cited = new Set<string>();
    steps.forEach((s, j) => {
      const so = isObj(s) ? s : {};
      const sw = `${where} step ${j + 1}`;
      const title = clean(so.title, 10_000);
      if (title === '') add(`${sw}: \`title\` is empty.`);
      else if (title.length > STORY_BUILD_STEP_TITLE_MAX) add(`${sw}: \`title\` is ${title.length} characters; keep it under ${STORY_BUILD_STEP_TITLE_MAX}.`);
      if (clean(so.change, STORY_PLAN_CHANGE_MAX) === '') add(`${sw}: \`change\` is empty; say what changes.`);
      for (const x of arr(so.refs)) {
        const r = refOf(x);
        if (r === '') continue;
        if (!gaps.has(r)) {
          add(
            gaps.size === 0
              ? `${sw} cites "${r}"; this story has no gap refs, so every step's \`refs\` is [].`
              : `${sw} cites "${r}", which is not a gap; use only ${gapList}.`,
          );
        } else cited.add(r);
      }
    });
    if (shown.has(ref) && !changed.has(ref)) changed.set(ref, cited);
  });

  // ---- read-only repos ----
  for (const r of arr(raw.readOnlyRepos)) {
    const ref = refOf(isObj(r) ? r.ref : null);
    if (!shown.has(ref)) add(`readOnlyRepos: "${ref.slice(0, 20)}" is not one of the repositories shown.`);
    else if (changed.has(ref)) add(`readOnlyRepos: ${ref} also changes; list it in one place only.`);
  }

  // ---- criteria: every gap once ----
  const seen = new Set<string>();
  for (const c of arr(raw.criteria)) {
    const o = isObj(c) ? c : {};
    const ref = refOf(o.ref);
    if (!gaps.has(ref)) {
      add(gaps.size === 0 ? '`criteria` must be [] — this story has no gap refs.' : `criteria: "${ref.slice(0, 20)}" is not a gap; use only ${gapList}.`);
      continue;
    }
    if (seen.has(ref)) {
      add(`criteria: ${ref} appears twice; give each gap once.`);
      continue;
    }
    seen.add(ref);
    const how = typeof o.how === 'string' ? o.how.trim().toLowerCase() : '';
    if (!HOWS.includes(how as StoryBuildCriterionHow)) {
      add(`criteria ${ref}: \`how\` "${clean(o.how, 20)}" must be one of: ${HOWS.join(', ')}.`);
      continue;
    }
    if (how === 'planned') {
      const repo = refOf(o.repo);
      if (!changed.has(repo)) add(`criteria ${ref} is planned; set \`repo\` to the changed repository whose steps close it.`);
      else if (!changed.get(repo)!.has(ref)) add(`criteria ${ref} is planned in ${repo}, but no ${repo} step cites ${ref}; add it to that step's \`refs\`.`);
    } else if (clean(o.reason, STORY_PLAN_REASON_MAX) === '') {
      add(`criteria ${ref} is ${how}; give a one-sentence \`reason\`.`);
    }
  }
  const missing = ctx.gapRefs.filter((r) => !seen.has(r.toUpperCase()));
  if (missing.length > 0) add(`\`criteria\` is missing ${missing.join(', ')}; every gap belongs there exactly once.`);

  // ---- risks ----
  const risks = arr(raw.risks).filter((r) => clean(r, STORY_PLAN_RISK_MAX) !== '');
  if (risks.length > STORY_BUILD_MAX_RISKS) add(`${risks.length} risks; keep the ${STORY_BUILD_MAX_RISKS} that matter most.`);

  // ---- design (only when asked for) ----
  let designProblems: string | null = null;
  if (ctx.wantDiagram) {
    if (raw.design == null) designProblems = '- `design` is missing; draw the planned design.';
    else {
      const v = validateDesign(raw.design, designContextOf(raw, ctx));
      if (!v.ok) designProblems = v.message;
    }
  }
  return { problems, designProblems };
}

/** The design's context: the changed repositories' refs and the files their steps name. */
export function designContextOf(raw: RawStoryPlan, ctx: StoryPlanContext): DesignContext {
  const shown = new Set(ctx.candidates.map((c) => c.ref.toUpperCase()));
  const prs: Array<{ ref: string; changedFiles: string[] }> = [];
  for (const r of arr(raw.repos)) {
    const o = isObj(r) ? r : {};
    const ref = refOf(o.ref);
    if (!shown.has(ref) || prs.some((p) => p.ref === ref)) continue;
    const files = arr(o.steps).flatMap((s) => arr(isObj(s) ? s.files : null)).filter((f): f is string => typeof f === 'string');
    prs.push({ ref, changedFiles: files });
  }
  return { kind: 'planned', prs };
}

/** The design to keep: the validated one, or null (not asked for, missing, or still wrong). */
export function acceptedDesignOf(raw: RawStoryPlan, ctx: StoryPlanContext): DesignDiagram | null {
  if (!ctx.wantDiagram || raw.design == null) return null;
  const v = validateDesign(raw.design, designContextOf(raw, ctx));
  return v.ok ? v.value.design : null;
}

/** A branch-name slug: lower-case words joined by hyphens, never empty. */
export function slugify(v: unknown, max = STORY_PLAN_SLUG_MAX): string {
  const s = (typeof v === 'string' ? v : '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s === '' ? 'change' : s;
}

/** The proposed branch: `limn/<ticket key>-<slug>` (the reader edits it at Accept). */
export function proposedBranch(ticketKey: string, slug: string): string {
  const key = slugify(ticketKey, 40);
  return `limn/${key}-${slugify(slug)}`.slice(0, STORY_BUILD_BRANCH_MAX).replace(/[-/.]+$/g, '');
}

/** A branch name git and GitHub both accept (the reader's edit at Accept). Pure. */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > STORY_BUILD_BRANCH_MAX) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.startsWith('-') || name.endsWith('.')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{') || name.endsWith('.lock')) return false;
  return !name.split('/').some((part) => part === '' || part.startsWith('.') || part.endsWith('.lock'));
}

/**
 * An ACCEPTED submission → the stored plan (the judge already passed it). Order is the model's (the
 * BUILD order); repo ids come from the candidates; every string is clipped.
 */
export function normalizeStoryPlan(raw: RawStoryPlan, ctx: StoryPlanContext, revision: number): StoryBuildPlan {
  const byRef = new Map(ctx.candidates.map((c) => [c.ref.toUpperCase(), c]));
  const gaps = new Set(ctx.gapRefs.map((r) => r.toUpperCase()));
  const repos: StoryBuildPlanRepo[] = [];
  for (const r of arr(raw.repos)) {
    const o = isObj(r) ? r : {};
    const ref = refOf(o.ref);
    const cand = byRef.get(ref);
    if (cand == null || repos.some((x) => x.ref === ref)) continue;
    repos.push({
      ref,
      repoId: cand.repoId,
      why: clean(o.why, STORY_PLAN_WHY_MAX),
      branchSlug: slugify(o.branchSlug),
      steps: arr(o.steps)
        .slice(0, STORY_BUILD_MAX_STEPS_PER_REPO)
        .map((s) => {
          const so = isObj(s) ? s : {};
          return {
            title: clean(so.title, STORY_BUILD_STEP_TITLE_MAX),
            files: [...new Set(arr(so.files).map((f) => clean(f, STORY_PLAN_PATH_MAX)).filter((f) => f !== ''))].slice(0, STORY_PLAN_FILES_PER_STEP),
            change: clean(so.change, STORY_PLAN_CHANGE_MAX),
            refs: [...new Set(arr(so.refs).map(refOf).filter((x) => gaps.has(x)))],
          };
        }),
      tests: arr(o.tests)
        .map((t) => clean(t, STORY_PLAN_TEST_MAX))
        .filter((t) => t !== '')
        .slice(0, STORY_PLAN_TESTS_MAX),
    });
    if (repos.length >= STORY_BUILD_MAX_REPOS) break;
  }
  const changed = new Set(repos.map((r) => r.ref));
  const readOnlyRepos = arr(raw.readOnlyRepos)
    .map((r) => (isObj(r) ? r : {}))
    .map((o) => ({ ref: refOf(o.ref), why: clean(o.why, STORY_PLAN_WHY_MAX) }))
    .filter((o, i, all) => byRef.has(o.ref) && !changed.has(o.ref) && all.findIndex((x) => x.ref === o.ref) === i)
    .map((o) => ({ ...o, repoId: byRef.get(o.ref)!.repoId }));
  const byGap = new Map<string, StoryBuildPlanCriterion>();
  for (const c of arr(raw.criteria)) {
    const o = isObj(c) ? c : {};
    const ref = refOf(o.ref);
    if (!gaps.has(ref) || byGap.has(ref)) continue;
    const how = (typeof o.how === 'string' ? o.how.trim().toLowerCase() : '') as StoryBuildCriterionHow;
    if (!HOWS.includes(how)) continue;
    const repo = how === 'planned' && changed.has(refOf(o.repo)) ? refOf(o.repo) : null;
    const reason = clean(o.reason, STORY_PLAN_REASON_MAX);
    byGap.set(ref, { ref, how, repo, reason: reason === '' ? null : reason });
  }
  // Gap order, not the model's.
  const criteria = ctx.gapRefs.map((r) => byGap.get(r.toUpperCase())).filter((c): c is StoryBuildPlanCriterion => c != null);
  const summary = storySummaryProse(typeof raw.summary === 'string' ? raw.summary : null, 2_000) ?? '';
  return {
    revision,
    summary: clean(summary, 1_200),
    repos,
    readOnlyRepos,
    criteria,
    risks: arr(raw.risks)
      .map((r) => clean(r, STORY_PLAN_RISK_MAX))
      .filter((r) => r !== '')
      .slice(0, STORY_BUILD_MAX_RISKS),
  };
}

/** The pass's one-line answer to the latest steering message, or null. */
export function planReplyOf(raw: RawStoryPlan): string | null {
  const t = clean(raw.reply, STORY_PLAN_REPLY_MAX);
  return t === '' ? null : t;
}

/** A stored plan as plain text — the "previous plan" of a re-plan and the build's agreed brief. */
export function renderStoryPlanText(plan: StoryBuildPlan, names: ReadonlyMap<number, string> = new Map()): string {
  const lines: string[] = [`Summary: ${plan.summary}`];
  plan.repos.forEach((r, i) => {
    const name = names.get(r.repoId);
    lines.push('', `${i + 1}. ${r.ref}${name ? ` (${name})` : ''} changes: ${r.why}`, `   Branch slug: ${r.branchSlug}`);
    r.steps.forEach((s, j) => {
      const files = s.files.length > 0 ? ` (${s.files.join(', ')})` : '';
      const refs = s.refs.length > 0 ? ` [${s.refs.join(', ')}]` : '';
      lines.push(`   ${j + 1}) ${s.title}${files}${refs}`, `      ${s.change.replace(/\n/g, '\n      ')}`);
    });
    if (r.tests.length > 0) lines.push(`   Tests: ${r.tests.join('; ')}`);
  });
  if (plan.readOnlyRepos.length > 0) {
    lines.push('', 'Read only:');
    for (const r of plan.readOnlyRepos) lines.push(`- ${r.ref}: ${r.why}`);
  }
  if (plan.criteria.length > 0) {
    lines.push('', 'Gaps:');
    for (const c of plan.criteria) {
      lines.push(`- ${c.ref}: ${c.how}${c.repo ? ` in ${c.repo}` : ''}${c.reason ? ` — ${c.reason}` : ''}`);
    }
  }
  if (plan.risks.length > 0) {
    lines.push('', 'Risks:');
    for (const r of plan.risks) lines.push(`- ${r}`);
  }
  return lines.join('\n');
}
