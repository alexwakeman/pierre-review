// A SESSION'S SUBJECT (docs/SANDBOX.md § Sessions). ONE session machine (manager.ts: the caps, the ONE
// build slot, boot, turns, idle close, the stream, restart) serves two subjects:
//
//   story   Implement — a `story_builds` row; the ticket; patches per repository (manager.ts `storySubject`);
//   fix     AI Fix — an `ai_fixes` row; the PR's task; the PR repository's patch only (fix.ts).
//
// A subject is made per session and holds what is only its own (its row id, its bases, its ticket or
// task); the machine calls it at fixed points and never reads a subject's table itself.
import type { BuildPlanSource, SandboxAgentMode, SandboxSessionPhase, SandboxTurnUsage } from '@pierre-review/shared';
import type { SandboxUsageAccount } from '../drivers/index.js';
import type { RepoBaseRequest, MirrorResult, FixSeedInput, SessionTicket, WorkspaceLayout } from '../workspace/index.js';

/** The registry key: ids of two tables never collide. */
export type SessionKey = `story:${number}` | `fix:${number}`;

/** What the machine writes to the subject's row. `sessionJson: true` ⇒ the live state as it is now. */
export interface SessionRowPatch {
  phase?: SandboxSessionPhase;
  sessionJson?: true;
  error?: string | null;
  sandboxRef?: string | null;
  agentRef?: string | null;
  runtime?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  lastActiveAt?: Date;
}

export interface SessionRepoInfo {
  repoId: number;
  owner: string;
  name: string;
  defaultBranch: string | null;
}

export interface SubjectBases {
  bases: Map<number, RepoBaseRequest>;
  labels: Map<number, { label: string; note: string | null }>;
}

/** One turn the machine starts by itself the moment the agent is ready (an AI Fix: the reader's Start; a
 *  plan-first story: the planning turn). */
export interface FirstTurn {
  build: boolean;
  /** Plan first: the turn is a plan turn of this source. */
  planSource?: BuildPlanSource;
  /** The conversation's reader line ("Start fix"). */
  readerText: string;
  text: () => Promise<string>;
}

/** The machine's view of a live session, as a subject sees it (manager.ts `Live`). */
export interface SubjectLive {
  readonly key: SessionKey;
  readonly accountId: number;
  readonly workspaceId: number;
  readonly resume: boolean;
  readonly container: string | null;
  readonly layoutRoot: string | null;
  readonly lastAgentText: string;
  /** The FINAL agent texts of the running (or last) turn, in order (partial deltas are not in it). */
  readonly turnTexts: readonly string[];
}

/** After a chat turn (plan first): the phase it ends in, and an automatic follow-up turn (the repair). */
export interface AfterChatTurn {
  nextPhase: SandboxSessionPhase | null;
  followUp?: { text: string; planSource: BuildPlanSource } | null;
}

export interface SessionSubject {
  readonly kind: 'story' | 'fix';
  readonly rowId: number;
  /** The sandbox label prefix: story `sb<id>-…`, fix `fx<id>-…`. */
  readonly idPrefix: 'sb' | 'fx';
  /** The boot step that reads what the agent is told. */
  readonly bootStep: 'ticket' | 'task';
  /** Who to bill and under which ledger feature (accountId is the session's). */
  readonly usage: Omit<SandboxUsageAccount, 'accountId'>;
  readonly maxTurns: number;
  /** Nobody is watching (an auto fix, dependency automation): "Stop all" closes it as discarded. */
  readonly unattended?: boolean;
  /** Claude's process-wide US$ cap (`--max-budget-usd`): an UNATTENDED fix only. Absent ⇒ none. */
  readonly maxBudgetUsd?: number;
  save(l: SubjectLive, patch: SessionRowPatch): Promise<void>;
  addSpend(l: SubjectLive, mode: SandboxAgentMode, usage: SandboxTurnUsage | null): Promise<void>;
  /** A closed session keeps something to push or resume. */
  hasStoredWork(): Promise<boolean>;
  /** The subject boot step: read the ticket / the task. Throws SessionFail to stop. Returns its detail. */
  readSubject(l: SubjectLive): Promise<string | null>;
  /** The repositories to mirror (the workspace's, plus a resumed session's own). */
  repoIds(memberRepoIds: readonly number[]): Promise<number[]>;
  bases(l: SubjectLive, repos: readonly SessionRepoInfo[]): Promise<SubjectBases>;
  branch(): string;
  /** What the seed fold gets (the layout says where each repository will be). */
  seed(layout: WorkspaceLayout): { ticket: SessionTicket; mode: 'implement' | 'fill_gaps'; planFirst?: boolean } | { fix: FixSeedInput };
  /** The mirror is in: record where each repository is (and fail when the one that matters is missing). */
  afterMirror(l: SubjectLive, mirror: MirrorResult, bases: ReadonlyMap<number, RepoBaseRequest>): Promise<void>;
  /** Resume: put the stored work back. Returns how many repositories. */
  restore(l: SubjectLive, mirror: MirrorResult): Promise<number>;
  /** The driver's mode at start. */
  startMode(l: SubjectLive): SandboxAgentMode;
  firstTurn?(l: SubjectLive): FirstTurn | null;
  /** The phase a running chat turn shows (plan first: planning / revising). Absent ⇒ chatting. */
  chatPhase?(l: SubjectLive): SandboxSessionPhase;
  /** A reader's message in chat mode: the text the agent gets (plan first adds one line). */
  chatText?(l: SubjectLive, text: string): string;
  /** After every chat turn, with the turn's final agent texts (plan first: the plan check). */
  afterChatTurn?(l: SubjectLive, texts: readonly string[]): Promise<AfterChatTurn>;
  /** Start build (the button) is refused now: plan first before approval. */
  buildRefused?(l: SubjectLive): { code: string; message: string } | null;
  /** The phase a CLOSED session with stored work keeps (plan first: plan_ready before approval). */
  keptPhase?(phase: SandboxSessionPhase): Promise<SandboxSessionPhase | null>;
  /** The phase after a boot with no first turn (a resumed plan: plan_ready). Absent ⇒ built / ready. */
  bootedPhase?(l: SubjectLive): SandboxSessionPhase | null;
  /** "with docs": copy the reference documents in after the mirror. null ⇒ none (the step says why). */
  prepareDocs?(l: SubjectLive): Promise<{ dir: string | null; detail: string | null }>;
  /** A `limn-svc run` was recorded. */
  onServiceRun?(l: SubjectLive): void;
  /** Start build (the button): switch the driver first (the machine does), then this is the instruction. */
  buildInstruction(l: SubjectLive, extra: string | null): Promise<string>;
  /** A reader's message in build mode: the text the agent gets (story: the message as written). */
  followUpText?(l: SubjectLive, text: string): string;
  /** Refuse a reader's action now (an AI Fix being pushed). */
  busyReason?(): string | null;
  beforeBuildTurn?(l: SubjectLive): Promise<void>;
  /** After every build-mode turn: store the work. 'close' ends the session (an unattended fix). */
  afterBuildTurn(l: SubjectLive): Promise<'keep' | 'close'>;
  /** After a kept build turn: an AUTOMATIC continuation's text (plan first: the turn cap hit with work
   *  unfinished; the subject asks the budget gate), or null. The machine claims it in the same tick. */
  buildFollowUp?(l: SubjectLive): Promise<string | null>;
  onPhase?(l: SubjectLive, phase: SandboxSessionPhase): void;
  onClosed?(l: SubjectLive, phase: SandboxSessionPhase): Promise<void>;
}
