// THE PLAN STAGE OF A STORY SESSION (docs/STORY-BUILD.md § Plan first; docs/SANDBOX.md § The plan and its
// checks). Every new Implement / Fill gaps session opens with a PLANNING turn Limn sends itself; the build
// waits until the reader has answered every point of contention and pressed "Approve and start".
//
//   opening   Limn's first turn (the reader's click, so no budget question): investigate, then ONE
//             ```limn-plan block at the end of the answer;
//   reply     the reader answered points (Agree / Keep the story are stored at once; Reply sends a turn):
//             the agent revises the plan;
//   message   a free message while a plan is open: a new revision only when the answer has a block;
//   repair    no usable plan after an opening or reply turn: ONE automatic turn listing the problems. It
//             is an AUTOMATIC model run, so it asks the ONE budget gate first; refused ⇒ no turn, one line.
//
// After every chat turn the block is checked on the HOST (coding/story-build/plan-verify.ts) and stored as
// a revision (plan-persist.ts); answers carry forward by contention id + fingerprint. Approve writes PLAN.md
// into the sandbox, records the approved revision and the planned PR rows in ONE transaction, and starts
// the ONE build turn. Nothing here writes to the tracker: a draft ticket update is text for the reader.
//
// The machine (manager.ts) hands this module what it needs (`PlanMachine`): it never imports the manager.
import { posix } from 'node:path';
import {
  BUILD_PLAN_MAX_REVISIONS,
  type BuildPlanDecision,
  type BuildPlanRevision,
  type BuildPlanSource,
  type BuildPlanView,
  type SandboxSessionPhase,
  type SandboxSessionRepo,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import {
  appendPlanReply,
  approvePlanRevision,
  getPlanRow,
  insertPlanRevision,
  latestPlanRow,
  listPlanRows,
  publicDecisions,
  setPlanDecision,
  toPlanRevision,
  toPlanView,
  type StoryBuildPlanRow,
} from '../../coding/story-build/plan-persist.js';
import { verifyBuildPlan, type PlanVerifySeams } from '../../coding/story-build/plan-verify.js';
import type { LibrarySnapshot } from '../../reference-docs/review-refs.js';
import type { ServiceRunRecord } from '../services/run-log.js';
import type { SandboxRuntime } from '../runtime/types.js';
import { BUILD_REPORT_CHECKER, BUILD_REPORT_FILE, buildReportFiles } from '../workspace/build-report.js';
import { PLAN_CONTEXT_FILE } from '../workspace/plan-check.js';
import { planContextFor, ticketLayoutFacts, ticketMarkdown } from '../workspace/seed.js';
import type { SessionTicket } from '../workspace/ticket.js';
import { extractPlanBlock } from './plan-block.js';
import type { SessionStateJson } from './state.js';
import type { AfterChatTurn, FirstTurn } from './subject.js';

// ---- words ------------------------------------------------------------------------------------------------

export const PLAN_READER_LINE = 'Plan';
export const PLAN_READER_LINE_DOCS = 'Plan with docs';
export const PLAN_SENT_LINE = '(The plan went to Limn to check.)';
export const PLAN_NOT_APPROVED_LINE = 'Approve the plan to start the build.';
export const NO_PLAN_LINE = 'The agent did not submit a plan.';
export const planReadyLine = (n: number, dropped: { contentions: number; evidence: number }): string => {
  const left = dropped.contentions > 0 ? ` Limn left out ${dropped.contentions} ${dropped.contentions === 1 ? 'point' : 'points'} it could not check.` : '';
  return `Plan revision ${n} is ready.${left}`;
};
export const planFailedLine = (problem: string): string => `The plan did not pass Limn's checks: ${problem} Send the agent a message to try again.`;

const LIMN_PLAN = '```limn-plan';

/** The opening planning turn (Limn sends it; the reader's line is "Plan"). */
export function planOpeningInstruction(o: { docsDir: string | null; fillGaps: boolean; root: string }): string {
  const ticket = posix.join(o.root, 'TICKET.md');
  const docs = o.docsDir ? ` Read \`${o.docsDir}/INDEX.md\`, the sections that apply, and \`${posix.join(o.root, 'DOCS.md')}\`.` : '';
  return [
    'Make the plan for this ticket now. Do not change any file.',
    '',
    `1. Read \`${ticket}\`, then every repository of this workspace that the ticket could touch.${docs} Look at the data the code uses: fixtures, seed data, schemas and migrations. If a service helps, start it with limn-svc and query it with \`limn-svc run\`.`,
    `2. Decide which repositories you will change, and how you will meet each acceptance criterion (AC1, AC2, … in TICKET.md's numbering).${o.fillGaps ? ' Build only the gaps that TICKET.md lists. For a criterion that is already met, say which pull request meets it.' : ''}`,
    `3. Find where the story is wrong: inaccurate, inconsistent, or in conflict with the code, ${o.docsDir ? 'the documents ' : ''}or the data. Give each point evidence that Limn can check: a code excerpt (repository, path, lines and the exact text),${o.docsDir ? ' a document section and the exact text,' : ''} a data file excerpt, or a \`limn-svc run\` output. A point you cannot show is not a point of contention: leave it out.`,
    '4. Propose the pull requests. One per repository, unless splitting clearly reduces risk or review size.',
    "5. If the story needs work (every point of contention and every criterion you do not plan says it does), write the updated description and acceptance criteria in `ticketUpdate`. Keep the ticket's layout: the same headings in the same order, the same list style and GIVEN / WHEN / THEN when it uses them. When the criteria live in the description, put them in `description`.",
    `6. Check the plan with \`node ~/.limn/plan-check.cjs\` until it prints OK, then end your answer with the plan in ONE ${LIMN_PLAN} block. Before the block, say the plan in at most five sentences.`,
  ].join('\n');
}

const fenceReader = (text: string): string => ['````text', text.trim(), '````'].join('\n');

/** A reply turn: every answer on the revision, the reader's words (fenced), then "revise". */
export function planReplyInstruction(o: {
  revision: number;
  decisions: Array<{ id: string; decision: BuildPlanDecision }>;
  reply: { contentionId: string | null; text: string } | null;
}): string {
  const out = [`The reader answered your plan (revision ${o.revision}):`, ''];
  for (const d of o.decisions) out.push(d.decision === 'agree' ? `- ${d.id}: agreed. Build your proposal.` : `- ${d.id}: keep the story. Build what the story says.`);
  if (o.decisions.length === 0) out.push('- No point is answered yet.');
  if (o.reply) {
    out.push('', o.reply.contentionId ? `About ${o.reply.contentionId}, the reader says (the reader's words):` : 'About the plan, the reader says (the reader\'s words):', fenceReader(o.reply.text));
  }
  out.push('', `Revise the plan. Keep the ids of points that did not change. End with the whole plan in one ${LIMN_PLAN} block.`);
  return out.join('\n');
}

/** A free message while the plan is open: the message as written, plus one line (no plan yet: ask for it). */
export const planMessageText = (text: string, hasPlan = true): string =>
  hasPlan
    ? `${text}\n\nIf this changes the plan, end your answer with the whole plan in one ${LIMN_PLAN} block.`
    : `${text}\n\nEnd your answer with the plan in one ${LIMN_PLAN} block, as CLAUDE.md and AGENTS.md describe.`;

/** The ONE repair turn: the problems (≤ 20 lines), then "the whole plan again". */
export function planRepairInstruction(problems: readonly string[]): string {
  const shown = problems.slice(0, 20);
  return [
    "Limn could not use your plan. Fix these problems:",
    '',
    ...shown.map((p) => `- ${p}`),
    ...(problems.length > shown.length ? [`- …and ${problems.length - shown.length} more.`] : []),
    '',
    `Then send the WHOLE plan again in one ${LIMN_PLAN} block. Do not change any file.`,
  ].join('\n');
}

/** The build turn after Approve. */
export function planBuildInstruction(o: {
  revision: number;
  root: string;
  ticketChanged: boolean;
  extra: string | null;
  /** The approved stack, for the branch lines (PLAN.md has the same). */
  stack?: ReadonlyArray<Pick<BuildPlanRevision['stack'][number], 'key' | 'fullName' | 'branch' | 'stackIndex'>>;
  fillGaps?: boolean;
}): string {
  const stack = o.stack ?? [];
  const split = stack.some((p) => p.stackIndex > 1);
  const branchLines = stack.map((p) => `  - ${p.key}: \`${p.branch}\` in ${p.fullName}${p.stackIndex > 1 ? `, made from the branch of the pull request before it` : ''}`);
  const lines = [
    `The reader approved the plan (revision ${o.revision}). Build it now. \`${posix.join(o.root, 'PLAN.md')}\` has the plan and the reader's decisions.`,
    '',
    '- Where the reader agreed with a point, build your proposal. Where the reader kept the story, build what the story says.',
    ...(o.fillGaps ? ['- Build only the gaps PLAN.md plans. Do not redo what the existing pull requests deliver.'] : []),
    '- Build the pull requests in PLAN.md\'s order. Commit each one on its own branch:',
    ...branchLines,
    ...(split
      ? ['- In a repository with more than one pull request, make each branch from the previous one (`git checkout -b <next branch>` on the previous branch). Do not merge branches. Leave the LAST branch of each repository checked out when you finish.']
      : []),
    '- Each pull request must build and pass its repository\'s checks on its own: check out its branch and run them before you go on. If you change an earlier pull request, rebase the later branches onto it.',
    '- Do not stop to ask. If something blocks a pull request, do what you can and say why in the report.',
    `- Finish with the build report: write \`${posix.join(o.root, BUILD_REPORT_FILE)}\` (per pull request: id, status done / partly / not_done, a summary of at most 2,000 characters for its description, the checks you ran with passed / failed / not_run; per acceptance criterion: ref, status met / partly / not_met, how). Check it with \`node ${BUILD_REPORT_CHECKER}\` until it prints OK.`,
    '- Then end with one line per acceptance criterion: done, partly done or not done, and why.',
  ];
  if (o.ticketChanged) lines.unshift('TICKET.md was read again just now and the acceptance criteria changed. Build the approved plan; say at the end what the change means.', '');
  if (o.extra) lines.push('', 'The reader adds:', fenceReader(o.extra));
  return lines.join('\n');
}

/** PLAN.md: the plan in words, with the reader's decisions (approved, or "not approved yet" on a Resume). */
export function planMarkdown(rev: BuildPlanRevision, decisions: Readonly<Record<string, { decision: BuildPlanDecision }>>, o: { approved: boolean }): string {
  const out: string[] = [`# The plan (revision ${rev.revision})`, ''];
  out.push(o.approved ? 'The reader APPROVED this plan. Build it.' : 'The reader has NOT approved this plan yet. Do not build: answer the reader, and send a revised plan when it changes.', '');
  out.push(rev.summary, '', '## Repositories', '');
  for (const r of rev.repos) out.push(`- ${r.fullName}: ${r.why}`);
  out.push('', '## Acceptance criteria', '');
  for (const c of rev.criteria) out.push(`- ${c.ref} (${c.status.replace('_', ' ')}${c.prs.length > 0 ? `, in ${c.prs.join(', ')}` : ''}): ${c.how}`);
  out.push('', '## Points of contention and the reader\'s decisions', '');
  if (rev.contentions.length === 0) out.push('None.');
  for (const c of rev.contentions) {
    const d = decisions[c.id]?.decision;
    const what = d === 'agree' ? `AGREED: build this instead: ${c.proposal}` : d === 'keep_story' ? `KEEP THE STORY: ${c.ifKept}` : 'Not answered yet.';
    out.push(`- ${c.id} (${c.about.join(', ')}): ${c.problem}`, `  ${what}`);
  }
  out.push('', '## Pull requests, in order', '');
  for (const p of rev.stack) {
    out.push(`${rev.stack.indexOf(p) + 1}. ${p.key} in ${p.fullName}, branch \`${p.branch}\`${p.dependsOn.length > 0 ? `, after ${p.dependsOn.join(', ')}` : ''}: ${p.title}. ${p.contains}${p.criteria.length > 0 ? ` Criteria: ${p.criteria.join(', ')}.` : ''}`);
  }
  if (rev.stackReason) out.push('', `Why the work is split: ${rev.stackReason}`);
  out.push('');
  return out.join('\n');
}

// ---- the stage ------------------------------------------------------------------------------------------------

/** What the machine hands the stage (manager.ts). */
export interface PlanMachine {
  notice(text: string): void;
  emitPlan(view: BuildPlanView): void;
  scheduleSave(): void;
}

/** The live session as the stage reads it. */
export interface PlanLive {
  readonly accountId: number;
  readonly workspaceId: number;
  readonly container: string | null;
  readonly layoutRoot: string | null;
  readonly state: SessionStateJson;
  readonly runtime: SandboxRuntime;
  readonly choice: { provider: 'claude' | 'codex' };
  readonly planSource: BuildPlanSource | null;
  readonly services: { controller: { runs: { list(): ServiceRunRecord[] } } } | null;
}

const runsOf = (l: PlanLive): ServiceRunRecord[] => l.services?.controller.runs.list() ?? [];

export interface PlanStageSeams {
  readBlob(accountId: number, fullName: string, sha: string, path: string): Promise<Buffer | null>;
  library(accountId: number, workspaceId: number): Promise<LibrarySnapshot | null>;
  /** The ONE budget gate, for the automatic repair turn. */
  automaticAllowed(ctx: AgentContext, accountId: number, provider: 'claude' | 'codex'): Promise<boolean>;
  now(): number;
}

export const defaultPlanStageSeams: PlanStageSeams = {
  async readBlob(accountId, fullName, sha, path) {
    const { readSessionBaseBlob } = await import('../../coding/story-build/plan-blobs.js');
    return readSessionBaseBlob(accountId, fullName, sha, path);
  },
  async library(accountId, workspaceId) {
    const { loadLibrarySnapshot } = await import('../../reference-docs/context.js');
    return loadLibrarySnapshot(accountId, workspaceId).catch(() => null);
  },
  async automaticAllowed(ctx, accountId, provider) {
    const { automaticRunAllowed } = await import('../../review/budget-gate.js');
    return automaticRunAllowed(ctx, accountId, 'story_plan_repair', provider);
  },
  now: () => Date.now(),
};

let seams: PlanStageSeams = defaultPlanStageSeams;
/** Test seam (null restores the real ones). */
export function setPlanStageSeamsForTests(s: Partial<PlanStageSeams> | null): void {
  seams = s == null ? defaultPlanStageSeams : { ...defaultPlanStageSeams, ...s };
}

export interface PlanStageOpts {
  ctx: AgentContext;
  accountId: number;
  buildId: number;
  /** The ticket as TICKET.md last told it, and the mode. */
  ticket: () => SessionTicket | null;
  mode: () => 'implement' | 'fill_gaps';
  approvedPlanId: () => Promise<number | null>;
}

export type ApproveCheck = { ok: true; plan: StoryBuildPlanRow } | { ok: false; code: 'PlanStale' | 'PlanUnanswered' | 'NoPlan' | 'NotFound'; message: string };

export class PlanStage {
  private repairUsed = false;
  private hasPlan: boolean | null = null;
  /** The build row names an approved revision (read once at the start, set by approveNow). */
  private approvedFlag: boolean | null = null;
  /** Approve's plan, held from the route's check to the build turn's instruction. */
  pendingApprove: StoryBuildPlanRow | null = null;

  constructor(private readonly o: PlanStageOpts) {}

  private docsDir(l: PlanLive): string | null {
    return l.state.withDocs && l.state.docs ? '/home/agent/.limn/docs' : null;
  }

  /** The opening turn, when the agent is ready. */
  firstTurn(l: PlanLive): FirstTurn {
    l.state.planStage = 'planning';
    l.state.planProblem = null;
    return {
      build: false,
      readerText: l.state.withDocs && l.state.docs ? PLAN_READER_LINE_DOCS : PLAN_READER_LINE,
      planSource: 'opening',
      text: async () => planOpeningInstruction({ docsDir: this.docsDir(l), fillGaps: this.o.mode() === 'fill_gaps', root: l.layoutRoot ?? '/workspace' }),
    };
  }

  private async approved(): Promise<boolean> {
    if (this.approvedFlag == null) this.approvedFlag = (await this.o.approvedPlanId()) != null;
    return this.approvedFlag;
  }

  /** Read the stored facts once (the subject's boot): approved, and whether a plan exists. */
  async load(): Promise<void> {
    await this.approved();
    await this.planExists();
  }

  /** The approval as last read (load() first). */
  isApproved(): boolean {
    return this.approvedFlag === true;
  }

  /** A usable revision is stored (load() first). */
  hasRevision(): boolean {
    return this.hasPlan === true;
  }

  private async planExists(): Promise<boolean> {
    if (this.hasPlan == null) this.hasPlan = (await latestPlanRow(this.o.ctx, this.o.accountId, this.o.buildId)) != null;
    return this.hasPlan;
  }

  /** The running chat turn's phase. */
  chatPhase(): SandboxSessionPhase {
    return this.hasPlan ? 'revising' : 'planning';
  }

  /** A reader's press: the repair is available again. */
  readerActed(): void {
    this.repairUsed = false;
  }

  /** The wire view. */
  async view(l: Pick<PlanLive, 'state'>): Promise<BuildPlanView> {
    const rows = await listPlanRows(this.o.ctx, this.o.accountId, this.o.buildId);
    return planViewOf(this.o.ctx, this.o.accountId, this.o.buildId, rows, l.state);
  }

  /** After every chat turn: check the block, store a revision, or start the ONE repair. */
  async afterChatTurn(l: PlanLive, texts: readonly string[], m: PlanMachine): Promise<AfterChatTurn> {
    if (await this.approved()) return { nextPhase: null };
    const source = l.planSource ?? 'message';
    const has = await this.planExists();
    const idle: SandboxSessionPhase = has ? 'plan_ready' : 'ready';
    const block = extractPlanBlock(texts);
    let problems: string[] | null = null;
    if (block.kind === 'none') {
      // A message on an open plan may be a question: no block, no revision. With no usable plan yet, a
      // message is a request for one (the repair is available again).
      if (source === 'message' && has) {
        l.state.planStage = has ? 'ready' : l.state.planStage ?? 'failed';
        return { nextPhase: idle };
      }
      problems = [`${NO_PLAN_LINE} End the answer with the plan in one ${LIMN_PLAN} block.`];
    } else if (block.kind === 'too_large') {
      problems = [`The plan block is ${Math.round(block.bytes / 1024)} KB: keep it under 128 KB (shorter quotes and fewer points).`];
    } else {
      const r = await this.verify(l, block.body);
      if (r.ok) {
        const latest = await latestPlanRow(this.o.ctx, this.o.accountId, this.o.buildId);
        if (latest && latest.rawSha === r.rawSha) {
          m.notice('The plan did not change.');
        } else if ((latest?.revision ?? 0) >= BUILD_PLAN_MAX_REVISIONS) {
          m.notice(`The plan has ${BUILD_PLAN_MAX_REVISIONS} revisions, the most a session keeps. Approve one, or discard and start again.`);
        } else {
          const row = await insertPlanRevision(this.o.ctx, { accountId: this.o.accountId, buildId: this.o.buildId, source, plan: r.plan, rawSha: r.rawSha, now: new Date(seams.now()) });
          this.hasPlan = true;
          m.notice(planReadyLine(row.revision, r.plan.dropped));
        }
        l.state.planStage = 'ready';
        l.state.planProblem = null;
        m.scheduleSave();
        m.emitPlan(await this.view(l));
        return { nextPhase: 'plan_ready' };
      }
      problems = r.problems;
    }
    // No usable plan from this turn.
    const first = problems[0] ?? NO_PLAN_LINE;
    if (source !== 'repair' && !this.repairUsed) {
      this.repairUsed = true;
      // An AUTOMATIC run: the gate failing to answer is a refusal (fail closed, as the build continuation).
      if (await seams.automaticAllowed(this.o.ctx, this.o.accountId, l.choice.provider).catch(() => false)) {
        m.notice('Limn could not use the plan, so it asked the agent to fix it.');
        return { nextPhase: null, followUp: { text: planRepairInstruction(problems), planSource: 'repair' } };
      }
    }
    l.state.planStage = 'failed';
    l.state.planProblem = first.slice(0, 400);
    m.notice(planFailedLine(first));
    m.scheduleSave();
    m.emitPlan(await this.view(l));
    return { nextPhase: idle };
  }

  private async verify(l: PlanLive, body: string): ReturnType<typeof verifyBuildPlan> {
    const ticket = this.o.ticket();
    const mode = this.o.mode();
    if (ticket == null) return { ok: false, problems: ['Limn has no copy of the ticket to check the plan against.'] };
    const docsDir = this.docsDir(l);
    const layout = { repos: l.state.repos.map((r) => ({ fullName: r.fullName, path: r.path })) };
    const check = planContextFor({ ticket, mode, layout: layout as never, docs: docsDir ? { dir: docsDir } : null }, runsOf(l).map((r) => r.id));
    const criteriaText = new Map<string, string>([
      ...ticket.criteria.map((c) => [`AC${c.n}`, c.text] as [string, string]),
      ...(ticket.gaps?.missing ?? []).map((m) => [m.ref.toUpperCase(), m.text] as [string, string]),
    ]);
    const runs = runsOf(l);
    const library = docsDir ? await seams.library(this.o.accountId, l.workspaceId) : null;
    const verifySeams: PlanVerifySeams = {
      readBlob: (repo, path) => seams.readBlob(this.o.accountId, repo.fullName, repo.baseSha, path),
      library,
      run: (id) => runs.find((r) => r.id === id.trim()) ?? null,
    };
    return verifyBuildPlan({
      body,
      check: { criteria: check.criteria, gaps: check.gaps, repos: check.repos, runs: check.runs, docs: check.docs, fillGaps: check.fillGaps, ticket: check.ticket ?? null },
      repos: l.state.repos.map((r: SandboxSessionRepo) => ({ repoId: r.repoId, fullName: r.fullName, baseSha: r.baseSha })),
      ticketText: ticketMarkdown(ticket, mode, docsDir),
      criteriaText,
      branch: l.state.repos[0]?.branch ?? 'ticket',
      seams: verifySeams,
      ticketLayout: (() => {
        const f = ticketLayoutFacts(ticket);
        return { description: f.description, criteria: f.criteria, acLocation: f.acLocation };
      })(),
    });
  }

  /** A `limn-svc run` was recorded: the checker's context names it. */
  async writeContext(l: PlanLive): Promise<void> {
    const ticket = this.o.ticket();
    if (!ticket || !l.container || !l.layoutRoot) return;
    const docsDir = this.docsDir(l);
    const layout = { repos: l.state.repos.map((r) => ({ fullName: r.fullName, path: r.path })) };
    const ctx = planContextFor({ ticket, mode: this.o.mode(), layout: layout as never, docs: docsDir ? { dir: docsDir } : null }, runsOf(l).map((r) => r.id));
    await l.runtime.copyIn(l.container, [{ path: posix.join(l.layoutRoot, PLAN_CONTEXT_FILE), content: `${JSON.stringify(ctx)}\n` }]).catch(() => {});
  }

  /** Start build (the button) before approval is refused. */
  buildRefused(): { code: string; message: string } | null {
    return this.approvedFlag === true ? null : { code: 'PlanNotApproved', message: PLAN_NOT_APPROVED_LINE };
  }

  // ---- the reader's answers ----

  async setDecision(l: PlanLive, revision: number, contentionId: string, decision: BuildPlanDecision | null): Promise<{ ok: true; view: BuildPlanView } | { ok: false; code: 'PlanStale' | 'NotFound' | 'NotOpen'; message: string }> {
    if (await this.approved()) return { ok: false, code: 'NotOpen', message: 'The plan is approved: it cannot change now.' };
    const latest = await latestPlanRow(this.o.ctx, this.o.accountId, this.o.buildId);
    if (!latest || latest.revision !== revision) return { ok: false, code: 'PlanStale', message: latest ? `The plan changed. Look at revision ${latest.revision}.` : 'There is no plan yet.' };
    const c = toPlanRevision(latest).contentions.find((x) => x.id === contentionId);
    if (!c) return { ok: false, code: 'NotFound', message: `Revision ${revision} has no point ${contentionId}.` };
    await setPlanDecision(this.o.ctx, this.o.accountId, latest.id, contentionId, decision ? { decision, fingerprint: c.fingerprint, at: new Date(seams.now()).toISOString() } : null);
    return { ok: true, view: await this.view(l) };
  }

  /** A Reply: stored on the revision, then the revision turn's text. */
  async replyText(revision: number, contentionId: string | null, text: string): Promise<{ ok: true; text: string } | { ok: false; code: 'PlanStale' | 'NotFound' | 'NotOpen'; message: string }> {
    if (await this.approved()) return { ok: false, code: 'NotOpen', message: 'The plan is approved. Send the agent a message instead.' };
    const latest = await latestPlanRow(this.o.ctx, this.o.accountId, this.o.buildId);
    if (!latest || latest.revision !== revision) return { ok: false, code: 'PlanStale', message: latest ? `The plan changed. Look at revision ${latest.revision}.` : 'There is no plan yet.' };
    const rev = toPlanRevision(latest);
    if (contentionId != null && !rev.contentions.some((c) => c.id === contentionId)) return { ok: false, code: 'NotFound', message: `Revision ${revision} has no point ${contentionId}.` };
    await appendPlanReply(this.o.ctx, this.o.accountId, latest.id, { contentionId, text, at: new Date(seams.now()).toISOString() });
    this.readerActed();
    const decisions = Object.entries(publicDecisions(latest.decisionsJson)).map(([id, d]) => ({ id, decision: d.decision }));
    return { ok: true, text: planReplyInstruction({ revision, decisions, reply: { contentionId, text } }) };
  }

  /** Approve's checks before the claim (the route): the LATEST revision, every point answered. */
  async approveCheck(revision: number): Promise<ApproveCheck> {
    if (await this.approved()) return { ok: false, code: 'PlanStale', message: 'The plan is already approved.' };
    const latest = await latestPlanRow(this.o.ctx, this.o.accountId, this.o.buildId);
    if (!latest) return { ok: false, code: 'NoPlan', message: 'There is no usable plan to approve yet.' };
    if (latest.revision !== revision) return { ok: false, code: 'PlanStale', message: `The plan changed. Look at revision ${latest.revision}.` };
    const rev = toPlanRevision(latest);
    const answered = latest.decisionsJson ?? {};
    const open = rev.contentions.filter((c) => answered[c.id] == null).length;
    if (open > 0) return { ok: false, code: 'PlanUnanswered', message: `${open} ${open === 1 ? 'point' : 'points'} still to answer.` };
    return { ok: true, plan: latest };
  }

  /**
   * Inside the build turn (after the claim): record the approval and the planned PRs together, write PLAN.md
   * into the sandbox. Returns the revision approved. Throws when the plan moved meanwhile.
   */
  async approveNow(l: PlanLive, m: PlanMachine): Promise<BuildPlanRevision> {
    const held = this.pendingApprove;
    this.pendingApprove = null;
    if (!held) throw new Error('There is no plan to approve.');
    const again = await this.approveCheck(held.revision);
    if (!again.ok) throw new Error(again.message);
    const ok = await approvePlanRevision(this.o.ctx, { accountId: this.o.accountId, buildId: this.o.buildId, plan: again.plan, now: new Date(seams.now()) });
    if (!ok) throw new Error('The plan is already approved.');
    this.approvedFlag = true;
    const rev = toPlanRevision(again.plan);
    if (l.container && l.layoutRoot) {
      await l.runtime.copyIn(l.container, [
        { path: posix.join(l.layoutRoot, 'PLAN.md'), content: planMarkdown(rev, publicDecisions(again.plan.decisionsJson), { approved: true }) },
        // The build report's checker and its context (the planned PRs, the criteria).
        ...buildReportFiles(l.layoutRoot, { prs: rev.stack.map((p) => p.key), criteria: rev.criteria.map((c) => c.ref) }),
      ]);
    }
    l.state.planStage = 'approved';
    l.state.planProblem = null;
    m.scheduleSave();
    m.emitPlan(await this.view(l));
    return rev;
  }

  /** Resume in the plan stage: the latest revision as PLAN.md, marked "not approved yet". */
  async restorePlan(l: PlanLive): Promise<boolean> {
    const latest = await latestPlanRow(this.o.ctx, this.o.accountId, this.o.buildId);
    if (!latest || !l.container || !l.layoutRoot) return false;
    this.hasPlan = true;
    const rev = toPlanRevision(latest);
    await l.runtime.copyIn(l.container, [{ path: posix.join(l.layoutRoot, 'PLAN.md'), content: planMarkdown(rev, publicDecisions(latest.decisionsJson), { approved: false }) }]);
    return true;
  }

  /** One older revision (the history list). */
  async revision(n: number): Promise<{ revision: BuildPlanRevision; decisions: BuildPlanView['decisions'] } | null> {
    const row = await getPlanRow(this.o.ctx, this.o.accountId, this.o.buildId, n);
    return row ? { revision: toPlanRevision(row), decisions: publicDecisions(row.decisionsJson) } : null;
  }
}

/** The wire view for a session (live or not): rows + the session's stage words + the build row. */
export async function planViewOf(
  ctx: Pick<AgentContext, 'db' | 'schema'>,
  accountId: number,
  buildId: number,
  rows: readonly StoryBuildPlanRow[],
  state: Pick<SessionStateJson, 'planStage' | 'planProblem' | 'withDocs' | 'action'>,
): Promise<BuildPlanView> {
  const { getStoryBuildRow } = await import('../../coding/story-build/persist.js');
  const row = await getStoryBuildRow(ctx, accountId, buildId);
  return toPlanView(rows, {
    stage: state.planStage ?? (rows.length > 0 ? 'ready' : 'planning'),
    problem: state.planProblem ?? null,
    withDocs: state.withDocs === true,
    fillGaps: state.action === 'fill_gaps',
    approvedPlanId: row?.approvedPlanId ?? null,
    approvedAt: row?.approvedAt ?? null,
  });
}

