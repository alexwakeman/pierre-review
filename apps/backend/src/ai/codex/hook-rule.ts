// The decision Limn's Codex PreToolUse hook makes for ONE tool call (the entry is
// `path-guard-hook-main.ts`; the config and trust are `hook.ts`). Pure, Node built-ins only.
//
// RULES (docs/CODEX-PLAN.md § 3.3 — the SECOND guard; the first is the OS sandbox for writes and the
// workspace MCP server's own check for reads):
//   • A WRITE tool (`apply_patch`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`) may touch only
//     paths inside the run's WRITE roots. A read-only run has none, so every write is denied. A patch
//     is read for its `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:`
//     headers; a write naming NO path we can find is denied (fail closed).
//   • `mcp__workspace__*` (Limn's own server) is allowed when every `path` it names is inside a READ
//     root (the server checks again).
//   • Any OTHER MCP tool is denied: only Limn's server may run (a user's own servers never load —
//     Limn's CODEX_HOME carries none — and this keeps it so).
//   • Anything else is allowed (the hook's matcher only sends the tools above anyway).
// Paths are placed by `realPathFor` — the SAME rule the Claude hook (review/path-guard.ts) and the
// workspace server use — and tested with `isWithin`.
import { isAbsolute } from 'node:path';
import { isWithin, realPathFor, resolveReal } from '../../review/path-guard.js';

export const WRITE_TOOLS: ReadonlySet<string> = new Set(['apply_patch', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const WORKSPACE_TOOL_PREFIX = 'mcp__workspace__';
const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;
const PATCH_HEADER = /^\s*\*\*\*\s*(?:Add File|Update File|Delete File|Move to)\s*:\s*(.*?)\s*$/;

export interface GuardRoots {
  read: string[];
  write: string[];
}

export type HookDecision = { allow: true } | { allow: false; reason: string };

const deny = (reason: string): HookDecision => ({ allow: false, reason: `Limn path guard: ${reason}` });

/** Every string anywhere in `v` (the patch text may sit under any key, or be the input itself). */
function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out, depth + 1);
  return out;
}

/** The paths a write call names: the path keys, plus every patch header in any string. */
export function writePaths(toolInput: unknown): string[] {
  const paths: string[] = [];
  if (toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
    for (const key of PATH_KEYS) {
      const v = (toolInput as Record<string, unknown>)[key];
      if (typeof v === 'string' && v !== '') paths.push(v);
    }
  }
  for (const s of strings(toolInput)) {
    if (!s.includes('***')) continue;
    for (const line of s.split('\n')) {
      const m = PATCH_HEADER.exec(line);
      if (m) paths.push(m[1]!);
    }
  }
  return paths;
}

/** Decide one call. `cwd` is the payload's (Codex's own) working directory, for relative paths. */
export function decideCodexToolCall(toolName: string, toolInput: unknown, roots: GuardRoots, cwd: string | null): HookDecision {
  const realRoots = (list: string[]) => list.filter((r) => typeof r === 'string' && isAbsolute(r)).map(resolveReal);
  const writeRoots = realRoots(roots.write);
  const readRoots = realRoots(roots.read);

  if (WRITE_TOOLS.has(toolName)) {
    if (writeRoots.length === 0) return deny('this run is read-only; no file may be written.');
    const from = cwd && isAbsolute(cwd) ? cwd : writeRoots[0]!;
    const paths = writePaths(toolInput);
    if (paths.length === 0) return deny(`refused: no file path found in the ${toolName} call.`);
    for (const raw of paths) {
      if (raw === '') return deny('refused: an empty file path.');
      const real = realPathFor(raw, from);
      if (real == null || !writeRoots.some((r) => isWithin(r, real))) {
        return deny(`refused: ${raw} is outside the folders this run may change.`);
      }
    }
    return { allow: true };
  }

  if (toolName.startsWith('mcp__')) {
    if (!toolName.startsWith(WORKSPACE_TOOL_PREFIX)) return deny(`refused: only Limn's workspace tools may run, not ${toolName}.`);
    if (readRoots.length === 0) return deny('refused: this run has no readable folders.');
    const input = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
    const v = input.path;
    if (v != null && v !== '') {
      if (typeof v !== 'string') return deny('refused: "path" must be a string.');
      const real = realPathFor(v, readRoots[0]!);
      if (real == null || !readRoots.some((r) => isWithin(r, real))) return deny(`refused: ${v} is outside the workspace.`);
    }
    return { allow: true };
  }

  return { allow: true };
}

/** The roots as they travel to the hook process (the `LIMN_CODEX_GUARD` environment variable). */
export const GUARD_ENV = 'LIMN_CODEX_GUARD';

export function encodeGuardRoots(roots: GuardRoots): string {
  return JSON.stringify({ read: roots.read, write: roots.write });
}

/** Null when the variable is missing or malformed — the hook then denies everything it sees. */
export function decodeGuardRoots(raw: string | undefined): GuardRoots | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return null;
    const { read, write } = v as { read?: unknown; write?: unknown };
    const ok = (a: unknown): a is string[] => Array.isArray(a) && a.every((x) => typeof x === 'string' && isAbsolute(x));
    return ok(read) && ok(write) ? { read, write } : null;
  } catch {
    return null;
  }
}
