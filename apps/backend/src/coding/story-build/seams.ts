import type {
  AiFixChangeReport,
  CheckRunReport,
  StoryBuildProgress,
  StoryBuildRepoPushResult,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import { buildRepo } from './build.js';
import { docsBlocksFor, runBuildDocs } from './docs.js';
import { pushRepo } from './push.js';
import type { StoryBuildRepoRow, StoryBuildRow } from './persist.js';

// THE WORK-PACKAGE SEAMS (docs/STORY-BUILD.md § Work packages). The session manager (WP1) reaches the
// per-repository build and push (WP2) and the docs consideration (WP3) ONLY through these signatures, so
// the three are built in parallel and each WP owns ONE file:
//
//   build.ts  buildRepo      — WP2   (the `story_build` agent in its kept worktree, checks, hook repair)
//   push.ts   pushRepo       — WP2   (no-PR applyAndPush variant, draft flag, tracker manual link)
//   docs.ts   runBuildDocs   — WP3   (the story-docs pipeline's `build` mode; stores docs_json)
//             docsBlocksFor  — WP3   (the two fenced prompt blocks from the decisions in force)
//
// The manager takes `storyBuildDeps()`; a test passes fakes through `setStoryBuildDepsForTests`. Until a
// WP lands, its stub answers a plain refusal (build/push/docs) or empty blocks (docsBlocksFor), never a
// throw that would wedge a session.

// ---- build (WP2) ----------------------------------------------------------------------------------

/** A repository built EARLIER in this session (plan order): read-only context for a later one. */
export interface EarlierRepoContext {
  repo: StoryBuildRepoRow;
  /** owner/name. */
  fullName: string;
  /** Its kept worktree, mounted READ-ONLY for the later build; null when it was swept (the change report
   *  still reaches the prompt). */
  worktreePath: string | null;
}

export interface RepoBuildArgs {
  accountId: number;
  /** The session row (status `building`; `acceptedRevision` + `acceptedDocsJson` frozen). */
  build: StoryBuildRow;
  /** This repository's row (status `queued`; `branch`, `checksWantedJson`, base set at Accept). */
  repo: StoryBuildRepoRow;
  /** owner/name of `repo`. */
  fullName: string;
  /** Repositories already built in this session, in plan order (status `ready`). */
  earlier: EarlierRepoContext[];
  /** The two fenced docs blocks for the prompt (`docsBlocksFor(build, {frozen: true, nonce})`). */
  docs: StoryBuildDocsBlocks;
  /** The prompt's fence nonce (pickReviewNonce over every untrusted text) — ONE per pass. */
  nonce: string;
  /** What remains of the SESSION budget, US$ (the pass caps itself at min(this, repo budget)). */
  budgetLeftUsd: number;
  onProgress(p: StoryBuildProgress): void;
  signal: AbortSignal;
}

/**
 * One repository's build. The worktree is KEPT (ledgered `story_build`, runId = repo.id) for Retry /
 * Re-run checks; the patch is captured after every pass. `ok:false` ⇒ the repo row goes `failed` with
 * `error`; `cancelled` ⇒ `cancelled`. A checks session that cannot start does NOT fail the build
 * (`checks.note` says why).
 */
export interface RepoBuildResult {
  ok: boolean;
  cancelled?: boolean;
  error: string | null;
  worktreePath: string | null;
  patch: string | null;
  filesChanged: string[];
  summary: string | null;
  commitMessage: string | null;
  changeReport: AiFixChangeReport | null;
  checks: CheckRunReport | null;
  /** What ran (`ranOn`): stored on the repo row and shown through `aiRunLabel`. */
  provider: 'claude' | 'codex' | null;
  model: string | null;
  effort: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}

export type BuildRepoFn = (ctx: AgentContext, args: RepoBuildArgs) => Promise<RepoBuildResult>;

// ---- push (WP2) -----------------------------------------------------------------------------------

export interface PushRepoArgs {
  accountId: number;
  buildId: number;
  /** The REPO id (the route's `:repoId`). */
  repoId: number;
  /** Open the PR as a draft (owner decision 2: default true). */
  draft: boolean;
  /** Bodies link sibling PRs already pushed in this session (Push all runs in plan order). */
  signal?: AbortSignal;
}

/** Push one ready repository: a NEW branch, a new PR (stacked repos target the PR they stack on). The
 *  outcome is recorded on the repo row by the implementation; the result is also returned to the route. */
export type PushRepoFn = (ctx: AgentContext, args: PushRepoArgs) => Promise<StoryBuildRepoPushResult>;

// ---- docs (WP3) -----------------------------------------------------------------------------------

/**
 * The docs points for a prompt, already FENCED with the pass's nonce (empty strings when none):
 *   included    "DOCS POINTS THE READER INCLUDED"            — suggestion items decided `include`
 *   superseded  "DOCS THE STORY SUPERSEDES (acknowledged)"   — superseded items (the story wins)
 * `pending` counts decisions changed since the plan revision ("n docs points aren't in the plan yet").
 */
export interface StoryBuildDocsBlocks {
  included: string;
  superseded: string;
  pending: number;
}

export interface DocsBlocksOpts {
  nonce: string;
  /** true ⇒ read the decisions frozen at Accept (`acceptedDocsJson`); false ⇒ the decisions in force. */
  frozen: boolean;
}

export type DocsBlocksFn = (build: StoryBuildRow, opts: DocsBlocksOpts) => StoryBuildDocsBlocks;

export interface RunBuildDocsArgs {
  accountId: number;
  buildId: number;
  force: boolean;
  onProgress(p: StoryBuildProgress): void;
  signal: AbortSignal;
}

/** Weigh the plan against the workspace docs; writes `docs_status` / `docs_json` / `docs_cost_usd`. */
export type RunBuildDocsFn = (ctx: AgentContext, args: RunBuildDocsArgs) => Promise<void>;

// ---- the manager's lane (WP1 registers it; WP2's retry route calls it) ------------------------------

/** Why a retry was refused: an HTTP status, a shared error code, and one plain sentence. */
export interface StoryBuildLaneRefusal {
  ok: false;
  status: number;
  error: string;
  message: string;
}

/**
 * THE BUILD LANE's entry points the build-side routes need (owner decision 3: ONE build at a time per
 * machine, sequential, owned by the manager). The manager (WP1) registers it at route registration;
 * until it does, the retry route answers 503 with a plain sentence. Retry puts ONE repository back to
 * `queued` and runs it through the same lane (and the same `buildRepo`) as Accept did.
 */
export interface StoryBuildLane {
  retryRepo(ctx: AgentContext, a: { accountId: number; buildId: number; repoId: number }): Promise<{ ok: true } | StoryBuildLaneRefusal>;
}

let lane: StoryBuildLane | null = null;

/** The manager registers its lane (once, from routes.ts); `null` unregisters (tests). */
export function registerStoryBuildLane(l: StoryBuildLane | null): void {
  lane = l;
}

/** The lane in force, or null when no manager registered one. */
export function storyBuildLane(): StoryBuildLane | null {
  return lane;
}

// ---- the bundle -------------------------------------------------------------------------------------

export interface StoryBuildDeps {
  buildRepo: BuildRepoFn;
  pushRepo: PushRepoFn;
  runBuildDocs: RunBuildDocsFn;
  docsBlocksFor: DocsBlocksFn;
}

let override: Partial<StoryBuildDeps> | null = null;

/** The implementations in force (the WP files, or a test's fakes over them). */
export function storyBuildDeps(): StoryBuildDeps {
  return {
    buildRepo: override?.buildRepo ?? buildRepo,
    pushRepo: override?.pushRepo ?? pushRepo,
    runBuildDocs: override?.runBuildDocs ?? runBuildDocs,
    docsBlocksFor: override?.docsBlocksFor ?? docsBlocksFor,
  };
}

/** Tests only: replace some implementations; `null` restores the real ones. */
export function setStoryBuildDepsForTests(deps: Partial<StoryBuildDeps> | null): void {
  override = deps;
}

/** The empty docs blocks (no docs run, or nothing decided). */
export const NO_DOCS_BLOCKS: StoryBuildDocsBlocks = Object.freeze({ included: '', superseded: '', pending: 0 });
