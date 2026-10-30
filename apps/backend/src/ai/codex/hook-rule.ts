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
//     root (the server checks again) — except `mcp__workspace__run_check` (the project's own checks,
//     coding/checks/), allowed ONLY when the run carries checks (`roots.checks`) and the call names a
//     check by a plain string; the server runs only names from its frozen list.
//   • Any OTHER MCP tool is denied: only Limn's server may run (a user's own servers never load —
//     Limn's CODEX_HOME carries none — and this keeps it so).
//   • ⚠ AN ALLOW-LIST, NOT A DENY-LIST. The hook's matcher is `.*` (hook.ts), so it sees EVERY tool
//     call, and only the tools above plus the few known-harmless built-ins in `HARMLESS_TOOLS`
//     (`update_plan`: the agent's own to-do list, no input from or effect on disk) are allowed.
//     Everything else — a tool a future CLI adds, one a config switch was meant to remove (the shell,
//     `view_image`), the MCP resource readers — is DENIED, so a tool nobody listed here never runs.
// Paths are placed by `realPathFor` — the SAME rule the Claude hook (review/path-guard.ts) and the
// workspace server use — and tested with `isWithin`.
import { isAbsolute } from 'node:path';
import { isWithin, realPathFor, resolveReal } from '../../review/path-guard.js';

export const WRITE_TOOLS: ReadonlySet<string> = new Set(['apply_patch', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const WORKSPACE_TOOL_PREFIX = 'mcp__workspace__';
/** Built-ins that read and write nothing on disk; every other unlisted tool is denied. */
export const HARMLESS_TOOLS: ReadonlySet<string> = new Set(['update_plan']);
const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;
const PATCH_HEADER = /^\s*\*\*\*\s*(Add File|Update File|Delete File|Move to)\s*:\s*(.*?)\s*$/;

export interface GuardRoots {
  read: string[];
  write: string[];
  /** The run may call `mcp__workspace__run_check` (AI Fix with "Run tests"). Absent ⇒ never. */
  checks?: boolean;
}

export const RUN_CHECK_TOOL_NAME = 'mcp__workspace__run_check';

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

/**
 * The file paths one patch text names, read the way Codex's own apply_patch parser reads it: a header
 * counts ONLY in HEADER POSITION, never inside a file's body.
 *
 *   • header position: the line, TRIMMED, is `*** Add File:` / `*** Update File:` / `*** Delete File:`
 *     / `*** Move to:` (anything else there — Begin/End Patch, a stray line — names no path);
 *   • after `Add File`, every line starting `+` is the new file's content;
 *   • after `Update File`, every line is the hunk's body (` ` context, `+`, `-`, `@@`, a blank line,
 *     `*** End of File`) until one STARTS with `***` (untrimmed), which is header position again.
 *
 * So a context line ` *** Add File: x` (a file that happens to contain that text) is body, not a
 * header, and a valid patch is not refused for it. Over-matching stays the safe direction: a line the
 * parser is unsure of in header position is still read as a header.
 */
export function patchPaths(text: string): string[] {
  const paths: string[] = [];
  let state: 'header' | 'add' | 'update' = 'header';
  for (const line of text.split(/\r?\n/)) {
    if (state === 'add') {
      if (line.startsWith('+')) continue;
      state = 'header';
    } else if (state === 'update') {
      if (!line.startsWith('***') || line.trim() === '*** End of File') continue;
      state = 'header';
    }
    const m = PATCH_HEADER.exec(line);
    if (!m) continue;
    paths.push(m[2]!);
    if (m[1] === 'Add File') state = 'add';
    else if (m[1] === 'Update File' || m[1] === 'Move to') state = 'update';
    else state = 'header';
  }
  return paths;
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
    paths.push(...patchPaths(s));
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

  if (toolName === RUN_CHECK_TOOL_NAME) {
    if (roots.checks !== true) return deny('refused: this run may not run checks.');
    const name = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>).name : undefined;
    if (typeof name !== 'string' || name === '' || name.length > 120) return deny('refused: name the check to run.');
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

  if (HARMLESS_TOOLS.has(toolName)) return { allow: true };
  return deny(`refused: ${toolName || 'this tool'} is not one Limn allows.`);
}

/** The roots as they travel to the hook process (the `LIMN_CODEX_GUARD` environment variable). */
export const GUARD_ENV = 'LIMN_CODEX_GUARD';

export function encodeGuardRoots(roots: GuardRoots): string {
  return JSON.stringify({ read: roots.read, write: roots.write, ...(roots.checks ? { checks: true } : {}) });
}

/** Null when the variable is missing or malformed — the hook then denies everything it sees. */
export function decodeGuardRoots(raw: string | undefined): GuardRoots | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return null;
    const { read, write, checks } = v as { read?: unknown; write?: unknown; checks?: unknown };
    const ok = (a: unknown): a is string[] => Array.isArray(a) && a.every((x) => typeof x === 'string' && isAbsolute(x));
    if (!ok(read) || !ok(write)) return null;
    return checks === true ? { read, write, checks: true } : { read, write };
  } catch {
    return null;
  }
}
