// THE BUILD TAB'S PURE HALF ("Implement story", docs/STORY-BUILD.md; docs/FRONTEND.md § The build tab):
// the step line, the status line, the repository words, the docs groups and their "not in the plan yet"
// count, the Accept body, and the push gating. React-free so test/storyBuild.test.ts pins it.
import {
  isStoryBuildRunning,
  STORY_BUILD_BRANCH_MAX,
  STORY_BUILD_REPO_RUNNING_STATUSES,
  storyBuildDocsDefaultDecision,
  type StoryBuild,
  type StoryBuildAcceptBody,
  type StoryBuildDocs,
  type StoryBuildDocsDecisions,
  type StoryBuildDocsItem,
  type StoryBuildErrorCode,
  type StoryBuildPhase,
  type StoryBuildRepo,
  type StoryBuildRepoStatus,
} from '@pierre-review/shared';
import { BRANCH_NAME_PATTERN } from './branchName.js';

// ── the step line: "Assess · Plan · Docs · Build · Push" ───────────────────────────────────────────

export type StoryBuildStepWord = 'Assess' | 'Plan' | 'Docs' | 'Build' | 'Push';
export type StoryBuildStepState = 'done' | 'current' | 'next';

export interface StoryBuildStep {
  word: StoryBuildStepWord;
  state: StoryBuildStepState;
}

const ASSESS_PHASES: ReadonlySet<StoryBuildPhase> = new Set(['reading_story', 'checking_coverage', 'picking_repos', 'checking_out']);

type BuildForSteps = Pick<StoryBuild, 'status' | 'phase' | 'planRevision' | 'wantDocs' | 'docsStatus' | 'docs' | 'pushedAll' | 'repos'>;

/** The step the session is on (an index into the words `storyBuildSteps` lists); -1 before a start. */
function currentStep(b: BuildForSteps | null, words: readonly StoryBuildStepWord[]): number {
  const at = (w: StoryBuildStepWord): number => words.indexOf(w);
  if (b == null) return -1;
  switch (b.status) {
    case 'assessing':
      return at('Assess');
    case 'planning':
      // The first pass reads the story, the PRs and the code before it plans.
      return b.planRevision === 0 && b.phase != null && ASSESS_PHASES.has(b.phase) ? at('Assess') : at('Plan');
    case 'plan_ready':
      return b.docsStatus === 'running' && at('Docs') >= 0 ? at('Docs') : at('Plan');
    case 'building':
      return at('Build');
    case 'ready':
      return words.length; // every step done once all is pushed; else Push is current (below)
    default:
      // failed / cancelled / discarded: where it stopped.
      return b.repos.some((r) => r.status !== 'planned') ? at('Build') : b.planRevision > 0 ? at('Plan') : at('Assess');
  }
}

/** The quiet step line in the header. Docs is a step only when the reader asked for it. */
export function storyBuildSteps(b: BuildForSteps | null, wantDocs?: boolean): StoryBuildStep[] {
  const docs = b != null ? b.wantDocs || b.docs != null || b.docsStatus !== 'none' : wantDocs === true;
  const words: StoryBuildStepWord[] = docs ? ['Assess', 'Plan', 'Docs', 'Build', 'Push'] : ['Assess', 'Plan', 'Build', 'Push'];
  let cur = currentStep(b, words);
  if (b != null && b.status === 'ready') cur = b.pushedAll ? words.length : words.indexOf('Push');
  return words.map((word, i) => ({ word, state: i < cur ? 'done' : i === cur ? 'current' : 'next' }));
}

// ── words ─────────────────────────────────────────────────────────────────────────────────────

export const STORY_BUILD_REPO_STATUS_WORDS: Record<StoryBuildRepoStatus, string> = {
  planned: 'Planned',
  queued: 'Waiting its turn',
  preparing: 'Preparing',
  building: 'Building',
  checking: 'Running tests',
  ready: 'Ready to push',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Left out',
  pushed: 'Pushed',
};

export function repoIsRunning(r: Pick<StoryBuildRepo, 'status'>): boolean {
  return STORY_BUILD_REPO_RUNNING_STATUSES.includes(r.status);
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The header's one status sentence. */
export function storyBuildStatusLine(b: Pick<StoryBuild, 'status' | 'repos' | 'pushedAll' | 'error'>): string {
  const included = b.repos.filter((r) => r.include);
  switch (b.status) {
    case 'assessing':
      return 'Reading the story and the code.';
    case 'planning':
      return 'Making the plan.';
    case 'plan_ready':
      return 'The plan is ready. Nothing is built until you accept it.';
    case 'building': {
      const done = included.filter((r) => r.status === 'ready' || r.status === 'pushed' || r.status === 'failed').length;
      return `Building ${plural(included.length, 'repository', 'repositories')}: ${done} done.`;
    }
    case 'ready': {
      if (b.pushedAll) return 'Pushed.';
      const ready = included.filter((r) => r.status === 'ready').length;
      const failed = included.filter((r) => r.status === 'failed').length;
      return `${plural(ready, 'repository', 'repositories')} ready to push${failed > 0 ? `, ${failed} failed` : ''}. Nothing is pushed until you press Push.`;
    }
    case 'failed':
      return b.error ?? 'The build failed.';
    case 'cancelled':
      return 'Cancelled.';
    case 'discarded':
      return 'Discarded.';
  }
}

/** A failed / cancelled / discarded session reads as history: the tab offers a new start. */
export function storyBuildClosed(b: Pick<StoryBuild, 'status'> | null | undefined): boolean {
  return b != null && (b.status === 'failed' || b.status === 'cancelled' || b.status === 'discarded');
}

/** The pass in flight, for the Cancel button. */
export function storyBuildCancellable(b: Pick<StoryBuild, 'status'>): boolean {
  return isStoryBuildRunning(b.status);
}

/** Discard is offered whenever nothing runs and something is left to throw away. */
export function storyBuildDiscardable(b: Pick<StoryBuild, 'status' | 'repos'>): boolean {
  if (isStoryBuildRunning(b.status)) return false;
  if (b.status !== 'plan_ready' && b.status !== 'ready') return false;
  return !b.repos.some(repoIsRunning);
}

// ── docs ──────────────────────────────────────────────────────────────────────────────────────

export interface StoryBuildDocsGroups {
  /** Things the docs require that the story is silent on — a checkbox, ticked by default. */
  suggestions: StoryBuildDocsItem[];
  /** Where the story changes what the docs say — a checkbox, unticked by default (the story wins). */
  superseded: StoryBuildDocsItem[];
  /** The docs agree — informational, no checkbox. */
  grounded: StoryBuildDocsItem[];
}

export function storyBuildDocsGroups(docs: StoryBuildDocs | null): StoryBuildDocsGroups {
  const items = docs?.items ?? [];
  return {
    suggestions: items.filter((i) => i.kind === 'suggestion'),
    superseded: items.filter((i) => i.kind === 'superseded'),
    grounded: items.filter((i) => i.kind === 'grounded'),
  };
}

/** Is this point going to the build? (its decision in force, else its default). */
export function docsItemIncluded(item: Pick<StoryBuildDocsItem, 'id' | 'kind'>, decisions: StoryBuildDocsDecisions): boolean {
  return (decisions[item.id] ?? storyBuildDocsDefaultDecision(item.kind)) === 'include';
}

/**
 * Ticked points the CURRENT plan has not seen: the docs were weighed against this plan revision (or a
 * later one), so no plan pass has had the reader's ticks yet. They still go to the build ("they go to
 * the build as they are"); "Update plan" folds them in.
 */
export function docsPointsNotInPlan(b: Pick<StoryBuild, 'docs' | 'docsDecisions' | 'planRevision'>): number {
  if (b.docs == null || b.docs.planRevision < b.planRevision) return 0;
  return b.docs.items.filter((i) => i.kind !== 'grounded' && docsItemIncluded(i, b.docsDecisions)).length;
}

// ── Accept: the reader's per-repository choices ─────────────────────────────────────────────────

export interface RepoChoice {
  include: boolean;
  branch: string;
  checks: string[];
}

/** The branch a repository card opens with: the stored one, else the ticket key + the plan's slug. */
export function defaultBranch(b: Pick<StoryBuild, 'ticketKey' | 'plan'>, r: Pick<StoryBuildRepo, 'branch' | 'repoId'>): string {
  if (r.branch != null && r.branch.trim() !== '') return r.branch;
  const slug = b.plan?.repos.find((p) => p.repoId === r.repoId)?.branchSlug ?? 'implementation';
  return `${b.ticketKey}-${slug}`.slice(0, STORY_BUILD_BRANCH_MAX);
}

/** What is wrong with a branch name, in a few words; null when it is fine. */
export function branchNameProblem(raw: string): string | null {
  const name = raw.trim();
  if (name === '') return 'Name the branch.';
  if (name.length > STORY_BUILD_BRANCH_MAX) return `Keep it under ${STORY_BUILD_BRANCH_MAX} characters.`;
  if (!BRANCH_NAME_PATTERN.test(name) || name.includes('..') || name.endsWith('/') || name.endsWith('.lock')) {
    return 'Use letters, digits, and . _ / - only.';
  }
  return null;
}

/** The repositories the plan changes, in build order (the plan's repos, as stored rows). */
export function plannedRepos(b: Pick<StoryBuild, 'repos' | 'plan'>): StoryBuildRepo[] {
  const planned = new Set((b.plan?.repos ?? []).map((r) => r.repoId));
  return b.repos.filter((r) => planned.has(r.repoId) || planned.size === 0).sort((x, y) => x.order - y.order);
}

/** The Accept body for the plan on screen, or the reason it cannot be sent. */
export function acceptBody(
  b: Pick<StoryBuild, 'planRevision' | 'plan' | 'repos' | 'ticketKey'>,
  choices: ReadonlyMap<number, Partial<RepoChoice>>,
): { body: StoryBuildAcceptBody } | { problem: string } {
  if (b.plan == null) return { problem: 'There is no plan yet.' };
  const repos = plannedRepos(b).map((r) => {
    const c = choices.get(r.repoId) ?? {};
    return {
      repoId: r.repoId,
      include: c.include ?? r.include,
      branch: (c.branch ?? defaultBranch(b, r)).trim(),
      checks: c.checks ?? [],
    };
  });
  if (!repos.some((r) => r.include)) return { problem: 'Include at least one repository.' };
  for (const r of repos) {
    if (!r.include) continue;
    const p = branchNameProblem(r.branch);
    if (p != null) return { problem: p };
  }
  return { body: { planRevision: b.planRevision, repos } };
}

// ── push ───────────────────────────────────────────────────────────────────────────────────────

/** Built, not pushed, with a change to push. Tests may be failing: the reader decides. */
export function canPushRepo(r: Pick<StoryBuildRepo, 'include' | 'status' | 'hasPatch'>): boolean {
  return r.include && r.status === 'ready' && r.hasPatch;
}

export function pushableRepos(b: Pick<StoryBuild, 'repos'>): StoryBuildRepo[] {
  return b.repos.filter(canPushRepo).sort((x, y) => x.order - y.order);
}

/** "Push all" sits in the header once two or more repositories are ready to push. */
export function pushAllOffered(b: Pick<StoryBuild, 'repos'>): boolean {
  return pushableRepos(b).length >= 2;
}

/** Retry is offered on a repository that failed or was cancelled, while nothing else runs. */
export function canRetryRepo(b: Pick<StoryBuild, 'status' | 'repos'>, r: Pick<StoryBuildRepo, 'include' | 'status'>): boolean {
  if (!r.include || (r.status !== 'failed' && r.status !== 'cancelled')) return false;
  return b.status === 'ready' || b.status === 'failed' || (b.status === 'building' && !b.repos.some(repoIsRunning));
}

// ── errors ─────────────────────────────────────────────────────────────────────────────────────

export const STORY_BUILD_ERROR_WORDS: Record<StoryBuildErrorCode, string> = {
  NoClaudeAuth: 'Sign in to the AI first.',
  ModelNotOnProvider: 'That model is not available on this provider.',
  NoStory: 'Could not read this ticket’s story.',
  Busy: 'Another build is running on this machine. Try again when it finishes.',
  NotReady: 'Wait for the current step to finish.',
  PlanRevisionCap: 'The plan cannot be changed again. Accept it, or discard it and start again.',
  PlanBudgetSpent: 'The planning budget is spent. Accept the plan, or discard it and start again.',
  SessionBudgetSpent: 'This build’s budget is spent.',
  PlanMoved: 'The plan changed. Read the new one, then accept it.',
  NotFound: 'This build no longer exists.',
};

/** An action's failure in words: the code's sentence when it is one we know, else the server's. */
export function storyBuildErrorText(err: { code?: string | null; message?: string } | null | undefined): string | null {
  if (err == null) return null;
  const code = err.code ?? null;
  if (code != null && code in STORY_BUILD_ERROR_WORDS) return STORY_BUILD_ERROR_WORDS[code as StoryBuildErrorCode];
  return err.message != null && err.message !== '' ? err.message : 'Something went wrong.';
}
