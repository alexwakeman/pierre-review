// THE CODEX PROVIDER (ai/provider.ts; docs/CODEX-PLAN.md § 3.2–3.4, as corrected by CODEX-SPIKE.md).
// Runs the pinned Codex CLI DIRECTLY (`codex exec --json`, argv from ai/codex/config.ts) in Limn's OWN
// Codex home (ai/codex/home.ts — never ~/.codex), and turns what it prints into Limn's results.
//
//   complete(req)   one turn, READ-ONLY, no MCP server, in an EMPTY scratch directory (so there is
//                   nothing to read even in principle), the `fast` model at low effort unless told
//                   otherwise; `outputSchema` → `--output-schema` for a JSON caller. ⚠ It is fed
//                   UNTRUSTED text (a ticket, a PR), so it runs under the SAME trusted path-guard hook
//                   as an agent run, with EMPTY read and write roots — every tool call but `update_plan`
//                   is denied — and refuses (fails closed) unless `verifyHookTrusted` says Codex will
//                   run that hook.
//   runAgent(spec)  ⚠ ONLY for kinds in CODEX_AGENT_KINDS (every kind since Phase 3; anything else
//                   answers `codexKindNotAvailableMessage`). The run reads through Limn's workspace MCP server
//                   (its only way to see files), writes (if any) through `apply_patch` inside a
//                   `workspace-write` sandbox confined to the write roots, guarded by the PreToolUse
//                   hook. Its RESULT TOOL becomes a strict JSON Schema (ai/result-schemas.ts); the final
//                   answer is mapped back to the tool's arguments (`strictAnswerToToolArgs`), PARSED
//                   against the tool's own zod shape (exactly what Claude's MCP layer does before a
//                   handler runs — the handlers only cast their input), and only the parsed data is
//                   handed to the SAME handler the Claude tool calls, so no server-side check moves.
//                   A rejected answer (a shape issue or the handler's refusal) gets ONE retry on the
//                   same thread (`exec resume`, possible because the run is NOT ephemeral), then the
//                   run fails. Any throw after the first spawn is a FAILURE of the run, never an
//                   escape: the usage is still recorded and the writes still verified.
//
// ⚠ SESSION FILES AND ROWS. Not being ephemeral, every run leaves a rollout (the prompt, the PR's
// text, diffs) AND a second copy in Codex's own sqlite state in Limn's Codex home: when the run settles
// and its usage is RECORDED, its thread is queued (ai/codex/threads.ts, one batched app-server per
// drain, in the background) for Codex's `thread/delete` (rows + rollout) and its log rows go; older
// leftovers are swept every few hours; account erasure removes the files (rollouts.ts `eraseCodexHistory`).
//
// ⚠ WRITES ARE READ FROM GIT, NEVER FROM THE STREAM. A refused or failed patch emits no event (spike
// § 4), so the changed files are what `git status` shows changed in the write roots between the start
// and the end of the run; a changed path outside the write roots fails the run.
// ⚠ AN UNTRUSTED HOOK IS SKIPPED SILENTLY (spike § 5). EVERY run — complete() and every agent run,
// read-only or not — therefore refuses unless `verifyHookTrusted` says the guard will run.
// ⚠ USAGE: Codex reports tokens, never US$. On a ChatGPT login a run costs US$ 0 and its tokens are
// recorded (the budget's share is token-weighted, § 8.1). ⚠ THE API-KEY ROUTE IS REFUSED until
// CODEX_PRICES_PER_MTOK holds real prices (every entry is null): a run there would record US$ 0 and the
// api_key budget and every per-pass US$ cap would never trip. A resumed turn reports the thread's
// CUMULATIVE usage, so the retry adds only its delta; a retry whose usage is unknown keeps the first
// turn's known tokens, and only a first turn that was itself cancelled records NULL. ⚠ Reasoning
// tokens are a SUBSET of output tokens and are never added to them.
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AI_MODEL_FOR_ROLE } from '@pierre-review/shared';
import { promisify } from 'node:util';
import { config } from '../../config.js';
import { CODEX_DEFAULT_EFFORT_FOR_ROLE } from '../effort.js';
// db/usage.js is imported LAZILY (in `record`): db/client opens the database at import time, and the
// provider registry is imported by every runner and test that never writes a ledger row.
import { buildExecArgs, codexChildEnv, toResumeArgs } from '../codex/config.js';
import { confirmCodexAccount, recheckCodexAccount } from '../codex/app-server.js';
import {
  CODEX_API_KEY_NOT_AVAILABLE_MESSAGE,
  CODEX_SIGN_IN_UNCHECKED_MESSAGE,
  codexUsageSource,
  detectCodex,
} from '../codex/detect.js';
import {
  addUsage,
  cleanCodexError,
  codexTokensAsAgentTokens,
  progressFromEvent,
  stepFromEvent,
  stderrRefusals,
  stderrTail,
  usageDelta,
  type TokenUsage,
} from '../codex/events.js';
import { pathGuardHook, verifyHookTrusted } from '../codex/hook.js';
import { codexBinary, codexHome, ensureCodexHomeConfig } from '../codex/home.js';
import { armCodexThreadSweeps, queueCodexThreadCleanup } from '../codex/threads.js';
import { runCodexExec, type CodexExecResult } from '../codex/run.js';
import type { CodexHookConfig } from '../codex/types.js';
import { workspaceMcpConfig } from '../codex/workspace-mcp.js';
import type {
  AgentOutcome,
  AgentProvider,
  AgentResultTool,
  AgentRunResult,
  AgentRunSpec,
  AgentUsageRecord,
  CompleteRequest,
  CompleteResult,
  ModelChoice,
  ModelRole,
  ProviderStatus,
} from '../provider.js';
import {
  codexAuthFileAgreesWithCache,
  codexCredentialRunnable,
  codexRunEnv,
  resolveCodexCredential,
  type CodexCredential,
} from '../credentials.js';
import {
  CODEX_NOT_AVAILABLE_MESSAGE,
  codexKindNotAvailableMessage,
  codexKindReady,
  codexRunnable,
} from '../provider-setting.js';
import {
  RESULT_TOOL_NAMES,
  shapeToJsonSchema,
  strictAnswerToToolArgs,
  toStrictJsonSchema,
  type JsonSchema,
} from '../result-schemas.js';
import { AiRuntimeMissingError, loadZod } from '../runtime.js';

const execFileP = promisify(execFile);

// ---- models ------------------------------------------------------------------------------------

/**
 * Codex's model per role (CODEX-SPIKE.md § 8, pinned for @openai/codex 0.164.0) — the shared table's
 * (packages/shared `AI_MODEL_FOR_ROLE`, which the SPA's run labels and model pickers read too).
 */
export const CODEX_MODEL_FOR_ROLE: Readonly<Record<ModelRole, string>> = AI_MODEL_FOR_ROLE.codex;

/**
 * Reasoning effort per role (spike § 8) — Codex's DEFAULT depth, the one table in ai/effort.ts. A run
 * that reads Settings → AI → Effort (the review, AI Fix, Plan first) sends its own `spec.codex.effort`.
 * Never the `fast` service tier: it costs more of the plan.
 */
export const CODEX_EFFORT_FOR_ROLE: Readonly<Record<ModelRole, string>> = CODEX_DEFAULT_EFFORT_FOR_ROLE;

/**
 * A role (or an explicit id) → a Codex model. ⚠ An explicit CLAUDE id (every call site passes one
 * through `claudeModelChoice`, and `cheapComplete` defaults to Haiku) is NOT a Codex model, so it
 * falls back to the role's model; any other explicit id is kept.
 */
export function resolveCodexModel(choice: ModelChoice): string {
  if (choice.id && !choice.id.startsWith('claude-')) return choice.id;
  return CODEX_MODEL_FOR_ROLE[choice.role];
}

// ---- prices (the API-key route only) ------------------------------------------------------------

/**
 * US$ per million tokens, for the OPENAI_API_KEY route. ⚠ TODO: the gpt-6 family's API prices were not
 * published where the spike looked (2026-10-25), so every entry is null and an API-key run records
 * US$ 0 with its tokens (and logs once). Fill these in from OpenAI's price list; a ChatGPT login is
 * never priced (its budget is a share of the plan's windows, not dollars).
 */
export const CODEX_PRICES_PER_MTOK: Readonly<
  Record<string, { input: number; cachedInput: number; output: number } | null>
> = {
  'gpt-6-astra': null,
  'gpt-6.1-sol': null,
  'gpt-6-sol': null,
  'gpt-6-luna': null,
};

let warnedUnpriced = false;

/** US$ for one run's tokens on the given route. Unknown price or tokens ⇒ 0. Exported for the test. */
export function codexCostUsd(
  model: string,
  usage: TokenUsage | null,
  route: 'login' | 'api_key' | 'none',
  prices: typeof CODEX_PRICES_PER_MTOK = CODEX_PRICES_PER_MTOK,
): number {
  if (route !== 'api_key' || !usage) return 0;
  const p = prices[model];
  if (!p) {
    if (!warnedUnpriced) {
      warnedUnpriced = true;
      console.warn(`[codex] no API price for ${model} yet; recording its tokens at US$ 0`);
    }
    return 0;
  }
  // Cached input is a subset of input (Codex reports both).
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (fresh * p.input + usage.cachedInputTokens * p.cachedInput + usage.outputTokens * p.output) / 1_000_000;
}

// ---- the credential ------------------------------------------------------------------------------

/**
 * Which credential rung a Codex run would use — the ONE Codex ladder (ai/credentials.ts
 * `resolveCodexCredential`: Limn's own Codex sign-in first, else OPENAI_API_KEY). Cheap and sync.
 * ⚠ It says a sign-in was MADE, not that it still works — `detect()` asks the app-server for that.
 */
export function codexCredentialRoute(env: NodeJS.ProcessEnv = process.env): 'login' | 'api_key' | 'none' {
  return resolveCodexCredential(env).route;
}

/** The hook's diagnostic log (path-guard-hook-main.ts), forwarded only when set. */
const GUARD_LOG_ENV = 'LIMN_CODEX_GUARD_LOG';

/**
 * The `codex exec` process's WHOLE environment. The credential decision is `codexRunEnv`'s (CODEX_HOME
 * = Limn's home; on a sign-in every API-key variable removed, on the key rung CODEX_API_KEY = the key);
 * the result is then cut to the minimum `codexChildEnv` keeps (never Limn's whole environment, which
 * may carry ANTHROPIC_API_KEY, a GitHub token, the session secret…), and the hook's own environment
 * is merged LAST. ⚠ Without `hook.env` (`LIMN_CODEX_GUARD`, the run's roots) the hook denies every
 * call. Exported for the test.
 */
export function codexExecEnv(
  credential: CodexCredential,
  hook: CodexHookConfig | null,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const run = codexRunEnv(base, credential);
  const env = codexChildEnv(run.CODEX_HOME ?? codexHome(base), run, run.CODEX_API_KEY ?? null);
  const log = base[GUARD_LOG_ENV];
  if (hook && log) env[GUARD_LOG_ENV] = log;
  return hook ? { ...env, ...hook.env } : env;
}

// ---- shared run plumbing ------------------------------------------------------------------------

const DEFAULT_AGENT_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_COMPLETE_TIMEOUT_MS = 5 * 60_000;

/** Why a finished `codex exec` did not produce an answer, as one sentence; null when it did. */
export function execFailure(res: CodexExecResult): string | null {
  if (res.cancelled) return 'The run was cancelled.';
  if (res.timedOut) return 'Codex took too long and was stopped.';
  const failed = res.events.find((e) => e.type === 'turn.failed');
  if (failed && failed.type === 'turn.failed') return `Codex could not finish: ${cleanCodexError(failed.error.message)}`;
  if (res.exitCode !== 0) {
    const tail = stderrTail(res.stderr);
    return `Codex stopped with an error${tail ? `: ${tail}` : ` (exit ${res.exitCode ?? res.signal ?? 'unknown'})`}.`;
  }
  return null;
}

/** A Codex run that gave no accepted answer. `filesChanged`: what a WRITE run left on disk (read by Limn). */
export class CodexRunError extends Error {
  filesChanged: string[] | null = null;
  constructor(message: string, readonly cancelled = false) {
    super(message);
    this.name = cancelled ? 'AbortError' : 'CodexRunError';
  }
}

async function record(
  rec: AgentUsageRecord | undefined,
  model: string,
  usage: TokenUsage | null,
  costUsd: number,
): Promise<void> {
  if (!rec) return;
  try {
    const { recordAiUsage } = await import('../../db/usage.js');
    await recordAiUsage({
      accountId: rec.accountId,
      seam: rec.seam,
      feature: rec.feature,
      model,
      costUsd,
      inputTokens: usage ? usage.inputTokens : null,
      // ⚠ Reasoning tokens are a SUBSET of output tokens: never added on top.
      outputTokens: usage ? usage.outputTokens : null,
      prId: rec.prId ?? null,
      repoId: rec.repoId ?? null,
      provider: 'codex',
      // The token-weighted share is the budget's fold (ai/budget.ts), not a per-run figure.
      sharePct: null,
    });
  } catch (err) {
    // A ledger write must never break the feature that spent the tokens.
    console.warn('[codex] could not record usage:', (err as Error).message);
  }
}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'limn-codex-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- complete -----------------------------------------------------------------------------------

/**
 * The credential a run may use, or a throw with the one sentence: no credential, the API-key route
 * (refused until it can be priced — see the header), or a sign-in whose KIND is not known. Then the
 * program: a missing install throws `CodexNotInstalledError`, an AiRuntimeMissingError, so a cheap
 * caller stops its pass at once.
 *
 * ⚠ FAIL CLOSED: only a sign-in KNOWN to be ChatGPT runs (ai/credentials.ts `codexCredentialRunnable`).
 * Before the first `account/read` (boot, just after a sign-in or out, a probe that keeps failing) and
 * when auth.json does not say, the run waits for ONE fresh probe and decides again — never runs on a
 * guess, since a key stored in the home would otherwise run and be recorded at US$ 0. After the first
 * read, auth.json is still compared with the cache before EVERY run (`codexAuthFileAgreesWithCache`),
 * and Codex itself refuses a stored key (`forced_login_method = "chatgpt"`, ai/codex/config.ts).
 */
async function runnableCredential(): Promise<{ route: 'login'; method: 'chatgpt' }> {
  if (!config.aiEnabled) throw new Error('AI is switched off here.');
  // ⚠ The cache wins over auth.json once an `account/read` has answered, so compare the two FIRST: a
  // sign-out, or a key stored in the home by hand since the last probe, must not ride a cached
  // "ChatGPT". On a disagreement, forget the account and wait for a fresh probe; still disagreeing
  // afterwards ⇒ refused as not checked.
  if (!codexAuthFileAgreesWithCache()) {
    await codexBinary();
    await recheckCodexAccount();
    if (!codexAuthFileAgreesWithCache()) throw new Error(CODEX_SIGN_IN_UNCHECKED_MESSAGE);
  }
  let credential = resolveCodexCredential();
  if (credential.route === 'login' && credential.method === 'unconfirmed') {
    await codexBinary();
    await confirmCodexAccount();
    credential = resolveCodexCredential();
  }
  if (credential.route === 'none') throw new Error(CODEX_SIGN_IN_MESSAGE);
  if (credential.route === 'api_key') throw new Error(CODEX_API_KEY_NOT_AVAILABLE_MESSAGE);
  if (!codexCredentialRunnable(credential)) throw new Error(CODEX_SIGN_IN_UNCHECKED_MESSAGE);
  await codexBinary();
  return credential;
}

/** The guard's trust entry is written into Limn's home, then Codex must prove it will RUN it. */
async function trustedGuard(roots: { read: string[]; write: string[] }): Promise<{ hook: CodexHookConfig; home: string }> {
  const hook = pathGuardHook(roots);
  await ensureCodexHomeConfig(hook);
  const home = codexHome();
  if (!(await hookIfTrusted(home, hook))) throw new Error(HOOK_NOT_TRUSTED_MESSAGE);
  return { hook, home };
}

async function complete(req: CompleteRequest): Promise<CompleteResult> {
  const credential = await runnableCredential();
  const route = credential.route;
  const role = req.role ?? 'fast';
  const model = resolveCodexModel({ role, ...(req.model ? { id: req.model } : {}) });
  // THE GUARD, with EMPTY roots: every tool call but `update_plan` is denied (hook-rule.ts). Fail
  // closed: an untrusted hook would be skipped silently, so the run never starts without proof.
  const { hook, home } = await trustedGuard({ read: [], write: [] });

  return withScratch(async (scratch) => {
    // An EMPTY working root: no MCP server, no shell, read-only — nothing to read, nothing to write.
    const cwd = join(scratch, 'work');
    await mkdir(cwd, { recursive: true });
    let schemaPath: string | null = null;
    if (req.outputSchema) {
      schemaPath = join(scratch, 'schema.json');
      await writeFile(schemaPath, JSON.stringify(req.outputSchema));
    }
    const args = buildExecArgs(
      { cwd, writeRoots: [], ...(req.system ? { system: req.system } : {}) },
      { home, mcp: null, hook, schemaPath, model, effort: CODEX_EFFORT_FOR_ROLE[role] },
    );
    armCodexThreadSweeps(home);
    const res = await runCodexExec(args, {
      cwd,
      env: codexExecEnv(credential, hook),
      stdin: req.prompt,
      timeoutMs: DEFAULT_COMPLETE_TIMEOUT_MS,
    });
    const costUsd = codexCostUsd(model, res.usage, route);
    // The usage row FIRST; then the settled run's thread (rows, session file, log rows — the prompt, in
    // full) is queued for removal in the background (threads.ts), never on the answer's path.
    try {
      await record(req.usageRecord, model, res.usage, costUsd);
    } finally {
      queueCodexThreadCleanup(home, res.threadId);
    }
    const failure = execFailure(res);
    if (failure) throw new CodexRunError(failure, res.cancelled);
    const text = res.finalResponse.trim();
    if (!text) throw new Error('Codex returned no text. Check the Codex sign-in: limn ai login codex');
    return {
      text,
      // ⚠ Reasoning tokens are a SUBSET of output tokens: never added on top.
      ...(res.usage ? { usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens } } : {}),
      provider: 'codex' as const,
      model,
      costUsd,
    };
  });
}

// ---- runAgent -----------------------------------------------------------------------------------

/** The result tool that ENDS the run: the named one, else the run's ONE result tool. */
export function pickResultTool(spec: Pick<AgentRunSpec, 'tools' | 'codex'>): AgentResultTool | null {
  const tools = spec.tools?.tools ?? [];
  if (tools.length === 0) return null;
  const named = spec.codex?.resultTool;
  if (named) {
    const t = tools.find((x) => x.name === named);
    if (!t) throw new Error(`The run has no result tool named ${named}.`);
    return t;
  }
  const results = tools.filter((t) => (RESULT_TOOL_NAMES as readonly string[]).includes(t.name));
  if (results.length !== 1) {
    throw new Error('A Codex run needs exactly one result tool (name it with spec.codex.resultTool).');
  }
  return results[0]!;
}

/** Every root, absolute and once, with the working directory first. */
export function runRoots(spec: Pick<AgentRunSpec, 'cwd' | 'roots' | 'readOnlyRoots' | 'writeRoots'>): {
  read: string[];
  write: string[];
} {
  const uniq = (xs: string[]): string[] => [...new Set(xs.map((x) => resolve(x)))];
  return {
    read: uniq([spec.cwd, ...spec.roots, ...spec.writeRoots, ...spec.readOnlyRoots]),
    write: uniq(spec.writeRoots),
  };
}

// Trust is read per (home, hash) once per process: the answer only changes when ensureCodexHomeConfig rewrites
// the home's config, which it does before the first run.
const trustCache = new Map<string, boolean>();
async function hookIfTrusted(home: string, hook: CodexHookConfig): Promise<boolean> {
  const key = `${home}\u0000${hook.trustedHash}`;
  const cached = trustCache.get(key);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    ok = await verifyHookTrusted(home, hook);
  } catch (err) {
    // A missing install is ITS OWN answer (an AiRuntimeMissingError stops a pass), never "untrusted".
    if (err instanceof AiRuntimeMissingError) throw err;
    ok = false;
  }
  if (ok) trustCache.set(key, ok); // never cache a "no": the next run re-checks after a fix
  return ok;
}
/** Test hook. */
export function _resetCodexTrustCacheForTest(): void {
  trustCache.clear();
}

export const HOOK_NOT_TRUSTED_MESSAGE =
  "Limn's path guard is not active for Codex, so Codex may not run here. Set up Codex again: limn ai install codex";

export const CODEX_SIGN_IN_MESSAGE = 'Codex is not signed in. Sign in with: limn ai login codex';

// ---- writes, from git ---------------------------------------------------------------------------

interface GitSnapshot {
  /** Repo top level, or null when the root is not in a repo. */
  top: string | null;
  /** Dirty path (absolute) → its content hash ('-' for a deletion). */
  dirty: Map<string, string>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', cwd, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** The dirty files under one root, each with its content hash. Exported for the test. */
export async function gitSnapshot(root: string): Promise<GitSnapshot> {
  let top: string;
  try {
    top = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return { top: null, dirty: new Map() };
  }
  const out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no']);
  const parts = out.split('\0');
  const dirty = new Map<string, string>();
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = resolve(top, entry.slice(3));
    // A rename/copy carries its SOURCE as the next NUL field: both paths count.
    if (xy[0] === 'R' || xy[0] === 'C') {
      const src = parts[++i];
      if (src) dirty.set(resolve(top, src), '-');
    }
    let hash = '-';
    try {
      hash = (await git(top, ['hash-object', '--', path])).trim();
    } catch {
      hash = '-';
    }
    dirty.set(path, hash);
  }
  return { top, dirty };
}

/** The paths whose state differs between two snapshots of the same root. */
export function snapshotChanges(before: GitSnapshot, after: GitSnapshot): string[] {
  const out = new Set<string>();
  for (const [p, h] of after.dirty) if (before.dirty.get(p) !== h) out.add(p);
  for (const p of before.dirty.keys()) if (!after.dirty.has(p)) out.add(p);
  return [...out].sort();
}

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const inside = (root: string, p: string): boolean => {
  const r = relative(root, p);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};

// ---- the one turn and its retry -----------------------------------------------------------------

function retryPrompt(reason: string): string {
  return [
    'Limn could not accept your final answer:',
    reason,
    '',
    'Answer again with ONE JSON object in the same shape, correcting only that. Do not repeat your work.',
  ].join('\n');
}

type Verdict = { ok: true } | { ok: false; reason: string };

type ZodNs = Awaited<ReturnType<typeof loadZod>>;

/** At most this many schema issues are named in the retry prompt (the rest are counted). */
const MAX_ISSUES_NAMED = 8;

/** Zod's issues as one plain reason for the retry prompt: `path: message`, a handful at most. */
export function issuesReason(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  const named = issues.slice(0, MAX_ISSUES_NAMED).map((i) => {
    const path = i.path.map((p) => (typeof p === 'number' ? `[${p}]` : String(p))).join('.').replace(/\.\[/g, '[');
    return `${path || '(the answer)'}: ${i.message}`;
  });
  const more = issues.length - named.length;
  return `The answer does not match the result's shape. ${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`;
}

/**
 * The final answer → the result handler, the way Claude's MCP layer does it: PARSED against the
 * tool's zod shape first (the handlers only cast their input — they trust the SDK to have parsed it),
 * and only the parsed data is handed on. A parse failure is a rejected answer with the issues as its
 * reason (so the one retry can correct exactly that); the handler never sees an unparsed object.
 * Exported for the test.
 */
export async function judge(z: ZodNs, tool: AgentResultTool, toolSchema: JsonSchema, text: string): Promise<Verdict> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'The final answer was not valid JSON.' };
  }
  const args = strictAnswerToToolArgs(toolSchema, parsed);
  const checked = z.object(tool.shape as Parameters<ZodNs['object']>[0]).safeParse(args);
  if (!checked.success) return { ok: false, reason: issuesReason(checked.error.issues) };
  const reply = await tool.handle(checked.data);
  return reply.isError ? { ok: false, reason: reply.text } : { ok: true };
}

async function runAgent(spec: AgentRunSpec): Promise<AgentRunResult> {
  if (!codexKindReady(spec.kind)) throw new Error(codexKindNotAvailableMessage(spec.kind));
  return runAgentUnchecked(spec);
}

/**
 * The Codex agent run itself, WITHOUT the allow-list check. Exported for the tests and the opt-in live
 * test only; `runAgent` (the provider's) is the one door, and it checks `CODEX_AGENT_KINDS` first.
 */
export async function runAgentUnchecked(spec: AgentRunSpec): Promise<AgentRunResult> {
  const credential = await runnableCredential();
  const route = credential.route;
  const model = resolveCodexModel(spec.model);
  const effort = spec.codex?.effort ?? CODEX_EFFORT_FOR_ROLE[spec.model.role];
  const roots = runRoots(spec);
  const cwd = resolve(spec.cwd);
  const isWrite = roots.write.length > 0;

  const resultTool = pickResultTool(spec);
  let toolSchema: JsonSchema | null = null;
  const z = await loadZod();
  if (resultTool) toolSchema = shapeToJsonSchema(z, resultTool.shape);

  const mcp = workspaceMcpConfig(roots);
  // THE GUARD IS NOT OPTIONAL. Its trust entry is written into Limn's own home first, then Codex is
  // asked whether it will RUN the hook (and the hook must refuse a canary call). An untrusted hook is
  // skipped SILENTLY by Codex, so a run whose guard is not proven never starts — read-only or not.
  const { hook, home } = await trustedGuard({ read: roots.read, write: roots.write });
  armCodexThreadSweeps(home);

  const before = isWrite ? await Promise.all(roots.write.map(gitSnapshot)) : [];

  return withScratch(async (scratch) => {
    let schemaPath: string | null = null;
    if (toolSchema) {
      schemaPath = join(scratch, 'schema.json');
      await writeFile(schemaPath, JSON.stringify(toStrictJsonSchema(toolSchema)));
    }
    const args = buildExecArgs(
      { cwd, writeRoots: roots.write, ...(spec.system ? { system: spec.system } : {}) },
      { home, mcp, hook, schemaPath, model, effort },
    );
    const env = codexExecEnv(credential, hook);
    const timeoutMs = spec.codex?.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    // THE NEUTRAL STREAM (ai/provider.ts): the status-line kinds, then the step the event makes (its
    // activity line, its text, the run's tokens so far — turn.completed carries the thread's total,
    // which for a run and its retry is the run's own).
    const onEvent = (e: Parameters<NonNullable<Parameters<typeof runCodexExec>[1]['onEvent']>>[0]): void => {
      const p = progressFromEvent(e);
      if (p) spec.onProgress?.(p);
      const step = stepFromEvent(e);
      if (step) {
        spec.onProgress?.({
          kind: 'step',
          lines: step.lines,
          text: step.text,
          usage: step.usage ? codexTokensAsAgentTokens(step.usage) : null,
        });
      }
    };
    const signal = spec.abortController.signal;

    // ⚠ EVERYTHING AFTER THE FIRST SPAWN IS INSIDE ONE try. A throw there (a result handler that
    // throws, a retry that cannot start) becomes the run's FAILURE — never an escape that skips the
    // ledger row, the write verification or the session-file cleanup below.
    let first: CodexExecResult | null = null;
    let final: CodexExecResult | null = null;
    let usage: TokenUsage | null = null;
    let failure: string | null = null;
    try {
      first = await runCodexExec(args, { cwd, env, signal, onEvent, stdin: spec.prompt, timeoutMs });
      final = first;
      usage = first.usage;
      failure = execFailure(first);

      if (!failure && resultTool && toolSchema) {
        let verdict = await judge(z, resultTool, toolSchema, first.finalResponse);
        if (!verdict.ok) {
          if (!first.threadId) {
            failure = `Codex's answer did not pass Limn's checks: ${verdict.reason}`;
          } else {
            spec.onProgress?.({ kind: 'status', text: 'Correcting the answer', retry: true });
            const retry = await runCodexExec(toResumeArgs(args, first.threadId), {
              cwd,
              env,
              signal,
              onEvent,
              stdin: retryPrompt(verdict.reason),
              timeoutMs,
            });
            // ⚠ The resumed turn reports the THREAD's total: add only its own delta. A retry whose
            // usage is unknown (cancelled, no turn.completed) KEEPS the first turn's known tokens.
            if (retry.usage) usage = addUsage(usage, usageDelta(retry.usage, first.usage));
            final = retry;
            failure = execFailure(retry);
            if (!failure) {
              verdict = await judge(z, resultTool, toolSchema, retry.finalResponse);
              if (!verdict.ok) failure = `Codex's answer did not pass Limn's checks: ${verdict.reason}`;
            }
          }
        }
      }
    } catch (err) {
      failure = `Codex's run failed: ${(err as Error).message || 'unknown error'}`;
    }
    const cancelled = !!(first?.cancelled || final?.cancelled);
    // NULL only when the FIRST turn's own tokens are unknown (run.ts reports null for a stopped run).
    if (!first || first.cancelled || first.usage == null) usage = null;

    // The run is settled (its retry included). The usage row FIRST; then its thread — rows, session
    // file, log rows — is queued for removal in the background (threads.ts).
    const costUsd = codexCostUsd(model, usage, route);
    try {
      await record(spec.usageRecord, model, usage, costUsd);
    } finally {
      queueCodexThreadCleanup(home, first?.threadId ?? final?.threadId ?? null);
    }
    // The neutral outcome (ai/provider.ts), emitted once, before the run returns or throws.
    const settle = (subtype: string, text: string | null): AgentOutcome => {
      const outcome: AgentOutcome = {
        subtype,
        text,
        costUsd,
        numTurns: null,
        usage: usage ? codexTokensAsAgentTokens(usage) : null,
      };
      spec.onProgress?.({ kind: 'outcome', outcome });
      return outcome;
    };
    const failedOutcome = (): void => {
      settle(cancelled ? 'cancelled' : 'error', null);
    };

    // Writes, read from git — whatever the stream says, and even when the run failed (a partial
    // edit is still on disk and the caller must know).
    let filesChanged: string[] | null = null;
    if (isWrite) {
      let after: GitSnapshot[] | null = null;
      try {
        after = await Promise.all(roots.write.map(gitSnapshot));
      } catch (err) {
        // What Codex left on disk cannot be read, so the run cannot be trusted.
        failedOutcome();
        throw new CodexRunError(`Limn could not read what Codex changed (${(err as Error).message}); the run is not used.`, cancelled);
      }
      if (before.some((b) => b.top === null) || after.some((a) => a.top === null)) {
        filesChanged = null; // not a repo: cannot verify (a write run's worktree always is one)
      } else {
        filesChanged = [...new Set(before.flatMap((b, i) => snapshotChanges(b, after[i]!)))].sort();
        // git answers REAL paths (macOS: /var → /private/var), so the roots are compared real too.
        const writeReal = roots.write.map(realOr);
        const outside = filesChanged.filter((p) => !writeReal.some((r) => inside(r, p)));
        if (outside.length > 0) {
          failedOutcome();
          const err = new CodexRunError(`Codex changed files outside its folder (${outside.length}); the run is not used.`, cancelled);
          err.filesChanged = filesChanged;
          throw err;
        }
      }
      const claimed = new Set(
        [first, final].flatMap((r) =>
          (r?.events ?? []).flatMap((e) =>
            e.type === 'item.completed' && e.item.type === 'file_change' && e.item.status === 'completed'
              ? e.item.changes.map((c) => realOr(resolve(cwd, c.path)))
              : [],
          ),
        ),
      );
      const unreported = (filesChanged ?? []).filter((p) => !claimed.has(p));
      if (unreported.length > 0) console.warn(`[codex] ${unreported.length} changed file(s) the stream did not report`);
    }
    const refusals = [
      ...(first ? stderrRefusals(first.stderr) : []),
      ...(final && final !== first ? stderrRefusals(final.stderr) : []),
    ];
    if (refusals.length > 0) console.warn(`[codex] ${refusals.length} tool call(s) refused: ${refusals[0]}`);

    if (failure || !first || !final) {
      failedOutcome();
      const err = new CodexRunError(failure ?? 'Codex did not run.', cancelled);
      err.filesChanged = filesChanged;
      throw err;
    }
    return {
      outcome: settle('success', final.finalResponse),
      provider: 'codex',
      text: final.finalResponse,
      usage,
      costUsd,
      filesChanged,
      threadId: first.threadId,
    };
  });
}


// ---- detect -------------------------------------------------------------------------------------

/**
 * Installed, signed in (a real `account/read` in Limn's own home), plan, rung — ai/codex/detect.ts.
 * ⚠ `available` means "can run AGENTS", the same answer `/api/me` gives (`providers.codex.available`):
 * false while any agent kind is not ported (`codexRunnable`; all are since Phase 3), with
 * CODEX_NOT_AVAILABLE_MESSAGE. The
 * one-shot `complete()` runs on Codex regardless, once installed and signed in.
 */
async function detect(): Promise<ProviderStatus> {
  if (!config.aiEnabled) return { id: 'codex', available: false, route: 'none', message: 'AI is switched off here.' };
  const d = await detectCodex();
  const runnable = codexRunnable();
  return {
    id: 'codex',
    // ⚠ Only a sign-in KNOWN to be ChatGPT can run: never the refused key route, never an unknown kind.
    available: runnable && d.runnable,
    route: d.route,
    message: d.message ?? (runnable ? null : CODEX_NOT_AVAILABLE_MESSAGE),
    installed: d.installed,
    signedIn: d.signedIn,
    plan: d.plan,
  };
}

export const codexProvider: AgentProvider = {
  id: 'codex',
  resolveModel: resolveCodexModel,
  runAgent,
  complete,
  detect,
  credentialRoute: () => codexCredentialRoute(),
  // `exec --json` carries no rate-limit data (spike § 6): the windows come from the app-server.
  usage: codexUsageSource,
};
