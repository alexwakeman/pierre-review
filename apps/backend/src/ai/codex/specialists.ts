// SPECIALISTS ON CODEX — LIMN RUNS THEM, NOT CODEX (docs/CODEX-PLAN.md § 3.5). A deep Claude Review
// consults up to CLAUDE_REVIEW_MAX_SPECIALISTS specialist sub-agents through the Agent SDK's `agents`
// option, policed by a PreToolUse dispatch guard (review/claude-review/specialists.ts). Codex's own
// subagents are undocumented in `exec` and capped per SESSION, not per review, so on Codex Limn runs
// each specialist ITSELF: one read-only `codex exec` thread per specialist, in parallel, each with its
// own instructions and its own STRICT answer schema, and hands their answers to the main run (the
// review stream puts them in the lead's prompt). The Claude path is untouched.
//
// What stays in Limn's hands, in code:
//   • THE CAP — at most `cap` specialists per call (default CLAUDE_REVIEW_MAX_SPECIALISTS); the rest
//     are REFUSED by name, with the same sentence the dispatch guard uses. Only a name in `offered`
//     (the catalogue) may run, and a name runs once.
//   • THE BUDGET — `allowStart` (e.g. the spend-budget gate, ai/budget.ts) is asked before EACH start,
//     and `budget.usd` is the batch's total: each specialist's run gets an even share, and once the
//     finished runs' US$ reach it no further specialist starts. (On a ChatGPT sign-in a run costs
//     US$ 0, so there the share gate is the one that bites.)
//   • READ-ONLY — every run has `writeRoots: []` (Codex's `read-only` sandbox), reads through the
//     workspace MCP server confined to the given roots, under the trusted path-guard hook.
//   • ONE DOOR — each run goes through the Codex provider's `runAgent` (the kind's allow-list check
//     included), injectable for tests.
// A specialist that fails, is cancelled or answers outside its schema (after the provider's one
// retry) is reported as such; the others still answer.
import { CLAUDE_REVIEW_MAX_SPECIALISTS } from '@pierre-review/shared';
import type {
  AgentKind,
  AgentOutcome,
  AgentProgress,
  AgentRunResult,
  AgentRunSpec,
  AgentUsageRecord,
  ModelChoice,
} from '../provider.js';
import { codexProvider } from '../providers/codex.js';

/** One specialist to consult. */
export interface CodexSpecialistSpec {
  /** Its catalogue name (a review lens, say). Also names its result in the answers. */
  name: string;
  /** Its own instructions (the run's system prompt). */
  instructions: string;
  /** The brief: what to look at for THIS change. */
  prompt: string;
  /** The zod RAW SHAPE of its answer (from the AI runtime's zod), made strict for Codex. */
  shape: Record<string, unknown>;
  /** A server-side check of the parsed answer: a sentence to reject it (one retry), or null. */
  validate?(answer: unknown): string | null;
}

export interface CodexSpecialistsArgs {
  specialists: readonly CodexSpecialistSpec[];
  /** The catalogue: a name outside it is refused. Absent ⇒ every given name is in it. */
  offered?: readonly string[];
  /** At most this many run. Default CLAUDE_REVIEW_MAX_SPECIALISTS. */
  cap?: number;
  /** At most this many at once. Default: all of them (the plan's "in parallel"). */
  concurrency?: number;
  /** The kind they serve (the provider's allow-list is checked against it). Default 'review'. */
  kind?: AgentKind;
  model: ModelChoice;
  /** The checkout they read, and any more read-only roots (ticket peers, the reference library). */
  cwd: string;
  roots?: string[];
  readOnlyRoots?: string[];
  /** `usd`: the WHOLE batch's US$ (split evenly); `turns`: each run's turn cap. */
  budget: { usd: number | undefined; turns: number };
  abortController: AbortController;
  /** Asked before EACH specialist starts; false ⇒ it does not run (`skipped: 'budget'`). */
  allowStart?(name: string): boolean | Promise<boolean>;
  /** Who to bill: one ledger row per specialist, `feature` suffixed with its name. */
  usageRecord?: AgentUsageRecord;
  /** Each specialist's neutral progress, labelled with its name. */
  onProgress?(name: string, progress: AgentProgress): void;
  /** The run door (tests). Default: the Codex provider's `runAgent`. */
  run?(spec: AgentRunSpec): Promise<AgentRunResult>;
}

export interface CodexSpecialistAnswer {
  name: string;
  /** 'answered' ⇒ `answer` holds the parsed, checked answer. */
  status: 'answered' | 'failed' | 'cancelled' | 'skipped';
  answer: unknown | null;
  /** Why it did not answer (one sentence), else null. */
  error: string | null;
  /** How its run ended, or null when it never ran. */
  outcome: AgentOutcome | null;
}

export interface CodexSpecialistsResult {
  /** One per specialist that was allowed to run (or skipped for budget), in the order given. */
  answers: CodexSpecialistAnswer[];
  /** Names refused before running: outside the catalogue, a repeat, or over the cap — with why. */
  refused: Array<{ name: string; reason: string }>;
  /** The US$ the batch spent (0 on a ChatGPT sign-in). */
  costUsd: number;
}

/** The result tool every specialist answers through (named so the provider never guesses). */
export const SPECIALIST_RESULT_TOOL = 'submit_specialist';

/** The cap's refusal, in the dispatch guard's own words (review/claude-review/specialists.ts). */
export const capRefusal = (cap: number): string =>
  `The limit of ${cap} specialists for this review is reached. Finish the review with what you have.`;

/** Which specialists may run, and which are refused before anything starts. Pure. */
export function planSpecialists(
  specialists: readonly CodexSpecialistSpec[],
  offered: readonly string[] | undefined,
  cap: number,
): { run: CodexSpecialistSpec[]; refused: Array<{ name: string; reason: string }> } {
  const allowed = offered ? new Set(offered) : null;
  const seen = new Set<string>();
  const run: CodexSpecialistSpec[] = [];
  const refused: Array<{ name: string; reason: string }> = [];
  for (const s of specialists) {
    if (allowed && !allowed.has(s.name)) {
      refused.push({ name: s.name, reason: `Only these specialists can be consulted: ${[...allowed].join(', ') || 'none'}.` });
    } else if (seen.has(s.name)) {
      refused.push({ name: s.name, reason: 'This specialist was already consulted for this review.' });
    } else if (run.length >= cap) {
      refused.push({ name: s.name, reason: capRefusal(cap) });
    } else {
      seen.add(s.name);
      run.push(s);
    }
  }
  return { run, refused };
}

export async function runCodexSpecialists(args: CodexSpecialistsArgs): Promise<CodexSpecialistsResult> {
  const cap = Math.max(0, args.cap ?? CLAUDE_REVIEW_MAX_SPECIALISTS);
  const { run: toRun, refused } = planSpecialists(args.specialists, args.offered, cap);
  const door = args.run ?? ((spec: AgentRunSpec) => codexProvider.runAgent(spec));
  const share = args.budget.usd != null && toRun.length > 0 ? args.budget.usd / toRun.length : undefined;
  const answers: CodexSpecialistAnswer[] = new Array(toRun.length);
  let costUsd = 0;
  let next = 0;

  const one = async (s: CodexSpecialistSpec): Promise<CodexSpecialistAnswer> => {
    const base = { name: s.name, answer: null, outcome: null } as const;
    if (args.abortController.signal.aborted) return { ...base, status: 'cancelled', error: 'The review was cancelled.' };
    if (args.budget.usd != null && costUsd >= args.budget.usd) {
      return { ...base, status: 'skipped', error: 'The review’s budget is spent.' };
    }
    if (args.allowStart && !(await args.allowStart(s.name))) {
      return { ...base, status: 'skipped', error: 'The spend budget does not allow another run now.' };
    }
    let answer: unknown = null;
    let outcome: AgentOutcome | null = null;
    try {
      const res = await door({
        kind: args.kind ?? 'review',
        model: args.model,
        effort: 'worktree',
        prompt: s.prompt,
        system: s.instructions,
        cwd: args.cwd,
        roots: args.roots ?? [],
        readOnlyRoots: args.readOnlyRoots ?? [],
        // ⚠ READ-ONLY: no write root, so Codex runs in its read-only sandbox.
        writeRoots: [],
        tools: {
          server: 'specialist',
          tools: [
            {
              name: SPECIALIST_RESULT_TOOL,
              description: `Your report as the ${s.name} specialist.`,
              shape: s.shape,
              handle: (a: unknown) => {
                const reason = s.validate?.(a) ?? null;
                if (reason) return { text: reason, isError: true };
                answer = a;
                return { text: 'Report recorded.' };
              },
            },
          ],
        },
        budget: { usd: share, turns: args.budget.turns },
        abortController: args.abortController,
        ...(args.usageRecord ? { usageRecord: { ...args.usageRecord, feature: `${args.usageRecord.feature}:${s.name}` } } : {}),
        onProgress: (p) => {
          if (p.kind === 'outcome') outcome = p.outcome;
          args.onProgress?.(s.name, p);
        },
        // Unused by Codex; the spec's shape needs it. A specialist reads, nothing more.
        claude: { allowedTools: [], disallowedTools: ['Bash'] },
        codex: { resultTool: SPECIALIST_RESULT_TOOL },
      });
      outcome = res.outcome ?? outcome;
      costUsd += outcome?.costUsd ?? 0;
      return { name: s.name, status: 'answered', answer, error: null, outcome };
    } catch (err) {
      const o = outcome as AgentOutcome | null;
      costUsd += o?.costUsd ?? 0;
      const cancelled = args.abortController.signal.aborted || (err as Error)?.name === 'AbortError';
      return {
        name: s.name,
        status: cancelled ? 'cancelled' : 'failed',
        answer: null,
        error: (err as Error)?.message || 'The specialist did not answer.',
        outcome: o,
      };
    }
  };

  const width = Math.max(1, Math.min(args.concurrency ?? toRun.length, toRun.length));
  const worker = async (): Promise<void> => {
    while (next < toRun.length) {
      const i = next++;
      answers[i] = await one(toRun[i]!);
    }
  };
  await Promise.all(Array.from({ length: toRun.length === 0 ? 0 : width }, worker));
  return { answers, refused, costUsd };
}
