// THE CODEX PROVIDER (ai/provider.ts; docs/CODEX-PLAN.md § 3.2–3.4, as corrected by CODEX-SPIKE.md).
// Runs the pinned Codex CLI DIRECTLY (`codex exec --json`, argv from ai/codex/config.ts) in Limn's OWN
// Codex home (ai/codex/home.ts — never ~/.codex), and turns what it prints into Limn's results.
//
//   complete(req)   one turn, READ-ONLY, no MCP server, no hook, in an EMPTY scratch directory (so
//                   there is nothing to read even in principle), the `fast` model at low effort
//                   unless told otherwise; `outputSchema` → `--output-schema` for a JSON caller.
//   runAgent(spec)  ⚠ ONLY for kinds in CODEX_AGENT_KINDS (EMPTY in Phase 2 — every kind answers
//                   `codexKindNotAvailableMessage`). The run reads through Limn's workspace MCP server
//                   (its only way to see files), writes (if any) through `apply_patch` inside a
//                   `workspace-write` sandbox confined to the write roots, guarded by the PreToolUse
//                   hook. Its RESULT TOOL becomes a strict JSON Schema (ai/result-schemas.ts); the final
//                   answer is mapped back to the tool's arguments (`strictAnswerToToolArgs`) and handed
//                   to the SAME handler the Claude tool calls — the handler is the validator, so no
//                   server-side check moves. A rejected answer gets ONE retry on the same thread
//                   (`exec resume`, possible because the run is NOT ephemeral), then the run fails.
//
// ⚠ WRITES ARE READ FROM GIT, NEVER FROM THE STREAM. A refused or failed patch emits no event (spike
// § 4), so the changed files are what `git status` shows changed in the write roots between the start
// and the end of the run; a changed path outside the write roots fails the run.
// ⚠ AN UNTRUSTED HOOK IS SKIPPED SILENTLY (spike § 5). A WRITE run therefore refuses unless
// `verifyHookTrusted` says the guard will run; a READ-ONLY run goes without it (the MCP server is the
// read guard, the read-only sandbox the write guard).
// ⚠ USAGE: Codex reports tokens, never US$. On a ChatGPT login a run costs US$ 0 and its tokens are
// recorded (the budget's share is token-weighted, § 8.1); on an API key the tokens are priced from
// CODEX_PRICES_PER_MTOK. A resumed turn reports the thread's CUMULATIVE usage, so the retry adds only
// its delta; a cancelled run records NULL tokens.
import type { AiUsageReading } from '@pierre-review/shared';
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../../config.js';
// db/usage.js is imported LAZILY (in `record`): db/client opens the database at import time, and the
// provider registry is imported by every runner and test that never writes a ledger row.
import { codexAccount, codexRateLimits } from '../codex/app-server.js';
import { buildExecArgs, codexChildEnv, toResumeArgs } from '../codex/config.js';
import {
  addUsage,
  cleanCodexError,
  progressFromEvent,
  stderrRefusals,
  stderrTail,
  usageDelta,
  type TokenUsage,
} from '../codex/events.js';
import { pathGuardHook, verifyHookTrusted } from '../codex/hook.js';
import { codexBinary, codexHome, ensureCodexHomeConfig } from '../codex/home.js';
import { runCodexExec, type CodexExecResult } from '../codex/run.js';
import type { CodexHookConfig } from '../codex/types.js';
import { workspaceMcpConfig } from '../codex/workspace-mcp.js';
import type {
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
import { codexKindNotAvailableMessage, codexKindReady } from '../provider-setting.js';
import {
  RESULT_TOOL_NAMES,
  shapeToJsonSchema,
  strictAnswerToToolArgs,
  toStrictJsonSchema,
  type JsonSchema,
} from '../result-schemas.js';
import { loadZod } from '../runtime.js';

const execFileP = promisify(execFile);

// ---- models ------------------------------------------------------------------------------------

/** Codex's model per role (CODEX-SPIKE.md § 8, pinned for @openai/codex 0.164.0). */
export const CODEX_MODEL_FOR_ROLE: Readonly<Record<ModelRole, string>> = {
  deep: 'gpt-6-astra',
  standard: 'gpt-6.1-sol',
  fast: 'gpt-6-luna',
};

/** Reasoning effort per role (spike § 8). Never the `fast` service tier: it costs more of the plan. */
export const CODEX_EFFORT_FOR_ROLE: Readonly<Record<ModelRole, string>> = {
  deep: 'high',
  standard: 'medium',
  fast: 'low',
};

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
 * Which credential a Codex run would use, cheaply and synchronously: Limn's own Codex sign-in (an
 * `auth.json` in Limn's Codex home) first, else OPENAI_API_KEY. ⚠ The file says a sign-in was MADE,
 * not that it still works — `detect()` asks the app-server (`account/read`) for that.
 */
export function codexCredentialRoute(env: NodeJS.ProcessEnv = process.env): 'login' | 'api_key' | 'none' {
  if (existsSync(join(codexHome(), 'auth.json'))) return 'login';
  if (env.OPENAI_API_KEY?.trim()) return 'api_key';
  return 'none';
}

const apiKeyFor = (route: 'login' | 'api_key' | 'none'): string | null =>
  route === 'api_key' ? (process.env.OPENAI_API_KEY?.trim() ?? null) : null;

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
      outputTokens: usage ? usage.outputTokens + usage.reasoningOutputTokens : null,
      prId: rec.prId ?? null,
      repoId: rec.repoId ?? null,
      provider: 'codex',
      // The token-weighted share is the budget's fold (stream C), not a per-run figure.
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

async function complete(req: CompleteRequest): Promise<CompleteResult> {
  if (!config.aiEnabled) throw new Error('AI is switched off here.');
  const route = codexCredentialRoute();
  if (route === 'none') throw new Error(CODEX_SIGN_IN_MESSAGE);
  const role = req.role ?? 'fast';
  const model = resolveCodexModel({ role, ...(req.model ? { id: req.model } : {}) });
  await ensureCodexHomeConfig(null);
  const home = codexHome();

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
      { home, mcp: null, hook: null, schemaPath, model, effort: CODEX_EFFORT_FOR_ROLE[role] },
    );
    const res = await runCodexExec(args, {
      cwd,
      env: codexChildEnv(home, process.env, apiKeyFor(route)),
      stdin: req.prompt,
      timeoutMs: DEFAULT_COMPLETE_TIMEOUT_MS,
    });
    const costUsd = codexCostUsd(model, res.usage, route);
    await record(req.usageRecord, model, res.usage, costUsd);
    const failure = execFailure(res);
    if (failure) throw new CodexRunError(failure, res.cancelled);
    const text = res.finalResponse.trim();
    if (!text) throw new Error('Codex returned no text. Check the Codex sign-in: limn ai login codex');
    return {
      text,
      ...(res.usage
        ? { usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens + res.usage.reasoningOutputTokens } }
        : {}),
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

// Trust is read per (home, hash) once per process: the answer only changes when stream C rewrites
// the home's config, which it does before the first run.
const trustCache = new Map<string, boolean>();
async function hookIfTrusted(home: string, hook: CodexHookConfig): Promise<boolean> {
  const key = `${home}\u0000${hook.hash}`;
  const cached = trustCache.get(key);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    ok = await verifyHookTrusted(home, hook);
  } catch {
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
  "Limn's path guard is not active for Codex yet, so Codex may not change files. Set up AI again: limn ai install";

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

async function judge(tool: AgentResultTool, toolSchema: JsonSchema, text: string): Promise<Verdict> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'The final answer was not valid JSON.' };
  }
  const reply = await tool.handle(strictAnswerToToolArgs(toolSchema, parsed));
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
  if (!config.aiEnabled) throw new Error('AI is switched off here.');
  const route = codexCredentialRoute();
  if (route === 'none') throw new Error(CODEX_SIGN_IN_MESSAGE);
  const model = resolveCodexModel(spec.model);
  const effort = spec.codex?.effort ?? CODEX_EFFORT_FOR_ROLE[spec.model.role];
  const roots = runRoots(spec);
  const cwd = resolve(spec.cwd);
  const isWrite = roots.write.length > 0;

  const resultTool = pickResultTool(spec);
  let toolSchema: JsonSchema | null = null;
  if (resultTool) toolSchema = shapeToJsonSchema(await loadZod(), resultTool.shape);

  const mcp = workspaceMcpConfig(roots);
  const guard = pathGuardHook(roots);
  await ensureCodexHomeConfig(guard);
  const home = codexHome();
  const trusted = await hookIfTrusted(home, guard);
  if (isWrite && !trusted) throw new Error(HOOK_NOT_TRUSTED_MESSAGE);
  const hook = trusted ? guard : null;

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
    const env = codexChildEnv(home, process.env, apiKeyFor(route));
    const timeoutMs = spec.codex?.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const onEvent = (e: Parameters<NonNullable<Parameters<typeof runCodexExec>[1]['onEvent']>>[0]): void => {
      const p = progressFromEvent(e);
      if (p) spec.onProgress?.(p);
    };
    const signal = spec.abortController.signal;

    const first = await runCodexExec(args, { cwd, env, signal, onEvent, stdin: spec.prompt, timeoutMs });
    let usage: TokenUsage | null = first.usage;
    let final = first;
    let failure = execFailure(first);

    let verdict: Verdict = { ok: true };
    if (!failure && resultTool && toolSchema) {
      verdict = await judge(resultTool, toolSchema, first.finalResponse);
      if (!verdict.ok) {
        if (!first.threadId) {
          failure = `Codex's answer did not pass Limn's checks: ${verdict.reason}`;
        } else {
          spec.onProgress?.({ kind: 'status', text: 'Correcting the answer' });
          const retry = await runCodexExec(toResumeArgs(args, first.threadId), {
            cwd,
            env,
            signal,
            onEvent,
            stdin: retryPrompt(verdict.reason),
            timeoutMs,
          });
          // ⚠ The resumed turn reports the THREAD's total: add only its own delta.
          usage = addUsage(usage, retry.usage ? usageDelta(retry.usage, first.usage) : null);
          final = retry;
          failure = execFailure(retry);
          if (!failure) {
            verdict = await judge(resultTool, toolSchema, retry.finalResponse);
            if (!verdict.ok) failure = `Codex's answer did not pass Limn's checks: ${verdict.reason}`;
          }
        }
      }
    }
    if (final.cancelled || first.cancelled) usage = null;

    const costUsd = codexCostUsd(model, usage, route);
    await record(spec.usageRecord, model, usage, costUsd);

    // Writes, read from git — whatever the stream says, and even when the run failed (a partial
    // edit is still on disk and the caller must know).
    let filesChanged: string[] | null = null;
    if (isWrite) {
      const after = await Promise.all(roots.write.map(gitSnapshot));
      if (before.some((b) => b.top === null) || after.some((a) => a.top === null)) {
        filesChanged = null; // not a repo: cannot verify (a write run's worktree always is one)
      } else {
        filesChanged = [...new Set(before.flatMap((b, i) => snapshotChanges(b, after[i]!)))].sort();
        // git answers REAL paths (macOS: /var → /private/var), so the roots are compared real too.
        const writeReal = roots.write.map(realOr);
        const outside = filesChanged.filter((p) => !writeReal.some((r) => inside(r, p)));
        if (outside.length > 0) {
          const err = new CodexRunError(`Codex changed files outside its folder (${outside.length}); the run is not used.`);
          err.filesChanged = filesChanged;
          throw err;
        }
      }
      const claimed = new Set(
        [first, final].flatMap((r) =>
          r.events.flatMap((e) =>
            e.type === 'item.completed' && e.item.type === 'file_change' && e.item.status === 'completed'
              ? e.item.changes.map((c) => realOr(resolve(cwd, c.path)))
              : [],
          ),
        ),
      );
      const unreported = (filesChanged ?? []).filter((p) => !claimed.has(p));
      if (unreported.length > 0) console.warn(`[codex] ${unreported.length} changed file(s) the stream did not report`);
    }
    const refusals = [...stderrRefusals(first.stderr), ...(final !== first ? stderrRefusals(final.stderr) : [])];
    if (refusals.length > 0) console.warn(`[codex] ${refusals.length} tool call(s) refused: ${refusals[0]}`);

    if (failure) {
      const err = new CodexRunError(failure, final.cancelled || first.cancelled);
      err.filesChanged = filesChanged;
      throw err;
    }
    return {
      result: null,
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

async function detect(): Promise<ProviderStatus> {
  if (!config.aiEnabled) return { id: 'codex', available: false, route: 'none', message: 'AI is switched off here.' };
  try {
    await codexBinary();
  } catch (err) {
    return { id: 'codex', available: false, route: 'none', message: (err as Error).message };
  }
  let signedIn = false;
  try {
    signedIn = (await codexAccount()).signedIn;
  } catch {
    signedIn = false;
  }
  if (signedIn) return { id: 'codex', available: true, route: 'login', message: null };
  if (process.env.OPENAI_API_KEY?.trim()) return { id: 'codex', available: true, route: 'api_key', message: null };
  return { id: 'codex', available: false, route: 'none', message: CODEX_SIGN_IN_MESSAGE };
}

export const codexProvider: AgentProvider = {
  id: 'codex',
  resolveModel: resolveCodexModel,
  runAgent,
  complete,
  detect,
  credentialRoute: () => codexCredentialRoute(),
  usage: {
    // `exec --json` carries no rate-limit data (spike § 6): the windows come from the app-server.
    readingFromMessage: () => null,
    probe: () => codexRateLimits(),
    // codexRateLimits already answers a normalised reading (or null).
    readingFromProbe: (raw) => (raw && typeof raw === 'object' ? (raw as AiUsageReading) : null),
    probeReady: () => codexCredentialRoute() === 'login',
  },
};
