// THE FROZEN CHECK LIST and the `run_check` tool both providers expose (docs/SECURITY.md § Sandboxed
// checks). Limn decides EVERYTHING about a check before the agent starts — the sandbox-wrapped argv,
// the working folder, the scrubbed environment, the timeout, the output cap — and freezes it here. The
// agent's only input is a NAME from that list: an unknown name is refused, and nothing the agent sends
// reaches an argv.
//
//   Claude  the tool runs in Limn's own process (ai/providers/claude.ts, `mcp__checks__run_check`);
//   Codex   Limn's workspace MCP server (ai/codex/workspace-mcp.ts, `mcp__workspace__run_check`)
//           reads the frozen list from a file Limn wrote OUTSIDE every folder a check or the agent may
//           write, ONCE at start-up — so nothing that runs later can change what a name means.
// Both go through the same `CheckToolRunner`. Node built-ins and relative files only.
import { appendFileSync, readFileSync } from 'node:fs';
import { runProcess } from './spawn.js';
import type { CheckKind, CheckRunResult } from './types.js';

export interface FrozenCheck {
  name: string;
  kind: CheckKind;
  /** The display form of the check's own argv (what the reader reads), not the sandbox wrapper. */
  display: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  outputCap: number;
}

export interface CheckSpec {
  version: 1;
  checks: FrozenCheck[];
  /** How many run_check calls one agent run may make. */
  maxCalls: number;
  /** Where each call is logged (JSON lines), so Limn can show what the agent ran. Null ⇒ not logged. */
  log: string | null;
}

/** What the agent reads back from a run: a status line, then the (capped) output. */
export function checkResultText(r: CheckRunResult): string {
  const secs = (r.durationMs / 1000).toFixed(1);
  const head =
    r.status === 'passed'
      ? `${r.name} passed in ${secs}s.`
      : r.status === 'failed'
        ? `${r.name} FAILED (exit code ${r.exitCode ?? '?'}) in ${secs}s.`
        : r.status === 'timed_out'
          ? `${r.name} was stopped after ${secs}s (time limit).`
          : `${r.name} did not run: ${r.note ?? 'unknown error'}`;
  const out = r.output.trim();
  return out ? `${head}\n\nOutput${r.truncated ? ' (cut to fit)' : ''}:\n${out}` : head;
}

/** Run one frozen check. Never throws. */
export async function runFrozenCheck(c: FrozenCheck, signal?: AbortSignal): Promise<CheckRunResult> {
  const r = await runProcess({
    command: c.command,
    args: c.args,
    cwd: c.cwd,
    env: c.env,
    timeoutMs: c.timeoutMs,
    outputCap: c.outputCap,
    ...(signal ? { signal } : {}),
  });
  const status: CheckRunResult['status'] = r.spawnError
    ? 'error'
    : r.timedOut
      ? 'timed_out'
      : r.aborted
        ? 'error'
        : r.exitCode === 0
          ? 'passed'
          : 'failed';
  return {
    name: c.name,
    kind: c.kind,
    command: c.display,
    status,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    output: r.output,
    truncated: r.truncated,
    note: r.spawnError ? `It could not start: ${r.spawnError}` : r.aborted ? 'The run was cancelled.' : null,
  };
}

export interface CheckToolReply {
  text: string;
  isError?: boolean;
}

/** The run_check tool's behaviour, shared by both providers. */
export class CheckToolRunner {
  private calls = 0;
  readonly results: CheckRunResult[] = [];

  constructor(
    private readonly spec: CheckSpec,
    private readonly signal?: AbortSignal,
  ) {}

  get names(): string[] {
    return this.spec.checks.map((c) => c.name);
  }

  async call(args: unknown): Promise<CheckToolReply> {
    const name = args && typeof args === 'object' ? (args as { name?: unknown }).name : undefined;
    if (typeof name !== 'string') return { text: 'Give the check name, e.g. {"name":"test"}.', isError: true };
    const check = this.spec.checks.find((c) => c.name === name);
    if (!check) return { text: `No check is named ${JSON.stringify(name.slice(0, 80))}. You may run: ${this.names.join(', ')}.`, isError: true };
    if (this.calls >= this.spec.maxCalls) {
      return { text: `This run has used its ${this.spec.maxCalls} check runs. Finish with what you know.`, isError: true };
    }
    this.calls++;
    const result = await runFrozenCheck(check, this.signal);
    this.results.push(result);
    if (this.spec.log) {
      try {
        appendFileSync(this.spec.log, `${JSON.stringify({ name: result.name, status: result.status, durationMs: result.durationMs })}\n`);
      } catch {
        /* logging never breaks a call */
      }
    }
    return { text: checkResultText(result) };
  }
}

/** The tool's description, the same words on both providers. */
export function runCheckDescription(names: readonly string[]): string {
  return `Run one of this project's own checks by name, in a sandbox with no network, and read its output. You may run: ${names.join(', ')}. Use it to confirm your change; it cannot run anything else.`;
}

/** The JSON Schema of the tool's input (the MCP server's tools/list). */
export function runCheckInputSchema(names: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: { name: { type: 'string', enum: [...names], description: 'The check to run.' } },
    required: ['name'],
    additionalProperties: false,
  };
}

/** Parse and validate a frozen spec file. Throws on anything unexpected (the server then refuses). */
export function parseCheckSpec(text: string): CheckSpec {
  const v = JSON.parse(text) as Partial<CheckSpec>;
  const str = (x: unknown): x is string => typeof x === 'string';
  if (!v || v.version !== 1 || !Array.isArray(v.checks) || typeof v.maxCalls !== 'number') throw new Error('bad check spec');
  for (const c of v.checks) {
    if (
      !c ||
      !str(c.name) ||
      !str(c.kind) ||
      !str(c.display) ||
      !str(c.command) ||
      !Array.isArray(c.args) ||
      !c.args.every(str) ||
      !str(c.cwd) ||
      !c.env ||
      typeof c.env !== 'object' ||
      !Object.values(c.env).every(str) ||
      typeof c.timeoutMs !== 'number' ||
      typeof c.outputCap !== 'number'
    ) {
      throw new Error('bad check in spec');
    }
  }
  if (v.log != null && !str(v.log)) throw new Error('bad log path');
  return { version: 1, checks: v.checks, maxCalls: v.maxCalls, log: v.log ?? null };
}

/** Read the spec file ONCE (the MCP server, at start-up). */
export function loadCheckSpec(path: string): CheckSpec {
  return parseCheckSpec(readFileSync(path, 'utf8'));
}
