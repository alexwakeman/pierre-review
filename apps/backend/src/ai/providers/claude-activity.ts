// THE CLAUDE ACTIVITY LINES (ai/provider.ts "the neutral run stream"). Each runner used to turn every
// raw Agent SDK assistant message into a few short, human-readable progress lines itself; the Claude
// provider (providers/claude.ts) now does it, ONCE per message, and hands the runner a neutral `step`.
// MOVED here verbatim, not rewritten (the lines on screen are unchanged):
//   - `describeReviewBlocks`: from review/agent.ts `describeAssistantBlocks` (every read-only agent,
//     and Claude Review's specialists, whose own steps are prefixed with their name);
//   - `describeFixBlocks`: from coding/activity.ts (the fixer: the write tools too);
//   - `assistantText`: the text blocks of one message, joined (the review chat, the docs chat).
// Defensive throughout: the SDK content/tool-input shapes vary, so every access is guarded and none
// of these throws.
import { DISPATCH_TOOL_NAMES } from '../../review/claude-review/specialists.js';

/** The text blocks of one assistant message, joined and trimmed. */
export function assistantText(message: unknown): string {
  const content = (message as { message?: { content?: unknown } })?.message?.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

// ---- the read-only agents (was review/agent.ts) -------------------------------------------------

const TEXT_SNIPPET_CAP = 120;
const BASH_CMD_CAP = 80;

/**
 * Turn one assistant message into a few short, human-readable progress lines: a label per
 * tool_use block plus a clipped snippet of any assistant text. Defensive throughout — the
 * SDK content/tool-input shapes vary, so every access is guarded and this never throws.
 */
export function describeReviewBlocks(
  message: unknown,
  specialistByToolUse: Map<string, string> = new Map(),
): string[] {
  const lines: string[] = [];
  const m = message as { message?: { content?: unknown }; parent_tool_use_id?: unknown };
  const content = m?.message?.content;
  if (!Array.isArray(content)) return lines;
  // A message from inside a specialist carries the dispatch's tool_use id.
  const parent = typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : null;
  const owner = parent ? specialistByToolUse.get(parent) : undefined;
  const prefix = owner ? `${owner}: ` : '';

  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as { type?: unknown; name?: unknown; input?: unknown; text?: unknown };

    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : 'Tool';
      const input =
        block.input && typeof block.input === 'object'
          ? (block.input as Record<string, unknown>)
          : {};
      if (DISPATCH_TOOL_NAMES.includes(name) && typeof (block as { id?: unknown }).id === 'string') {
        const type = typeof input.subagent_type === 'string' ? input.subagent_type : 'specialist';
        specialistByToolUse.set((block as { id: string }).id, type);
      }
      lines.push(prefix + labelReviewToolUse(name, input));
    } else if (block.type === 'text' && typeof block.text === 'string') {
      const snippet = clip(block.text.replace(/\s+/g, ' ').trim(), TEXT_SNIPPET_CAP);
      if (snippet) lines.push(prefix + snippet);
    }
  }
  return lines;
}

/** Build a short label for a tool call from its name + a truncated first arg. */
function labelReviewToolUse(name: string, input: Record<string, unknown>): string {
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

  switch (name) {
    case 'Read': {
      const p = str(input.file_path) ?? str(input.path);
      return p ? `Read ${p}` : 'Read …';
    }
    case 'Glob': {
      const p = str(input.pattern);
      return p ? `Glob ${p}` : 'Glob …';
    }
    case 'Grep': {
      const p = str(input.pattern);
      return p ? `Grep "${clip(p, BASH_CMD_CAP)}"` : 'Grep …';
    }
    case 'Bash': {
      const c = str(input.command);
      return c ? `Bash ${clip(c, BASH_CMD_CAP)}` : 'Bash …';
    }
    case 'mcp__review__submit_review':
      return 'Submitting review…';
    case 'Agent':
    case 'Task': {
      const t = str(input.subagent_type);
      return t ? `Asking the ${t} specialist` : 'Asking a specialist';
    }
    default: {
      for (const key of Object.keys(input)) {
        const v = str(input[key]);
        if (v) return `${name} ${clip(v, BASH_CMD_CAP)}`;
      }
      return `${name} …`;
    }
  }
}

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---- the fixer (was coding/activity.ts) ----------------------------------------------------------

const ARG_CAP = 80;

export function describeFixBlocks(message: unknown): string[] {
  const lines: string[] = [];
  const content = (message as { message?: { content?: unknown } })?.message
    ?.content;
  if (!Array.isArray(content)) return lines;

  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as {
      type?: unknown;
      name?: unknown;
      input?: unknown;
      text?: unknown;
    };

    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : 'Tool';
      const input =
        block.input && typeof block.input === 'object'
          ? (block.input as Record<string, unknown>)
          : {};
      lines.push(labelFixToolUse(name, input));
    } else if (block.type === 'text' && typeof block.text === 'string') {
      const snippet = clip(
        block.text.replace(/\s+/g, ' ').trim(),
        TEXT_SNIPPET_CAP,
      );
      if (snippet) lines.push(snippet);
    }
  }
  return lines;
}

function labelFixToolUse(name: string, input: Record<string, unknown>): string {
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

  switch (name) {
    case 'Read': {
      const p = str(input.file_path) ?? str(input.path);
      return p ? `Read ${p}` : 'Read …';
    }
    case 'Write': {
      const p = str(input.file_path) ?? str(input.path);
      return p ? `Write ${p}` : 'Write …';
    }
    case 'Edit':
    case 'MultiEdit': {
      const p = str(input.file_path) ?? str(input.path);
      return p ? `Edit ${p}` : 'Edit …';
    }
    case 'Glob': {
      const p = str(input.pattern);
      return p ? `Glob ${p}` : 'Glob …';
    }
    case 'Grep': {
      const p = str(input.pattern);
      return p ? `Grep "${clip(p, ARG_CAP)}"` : 'Grep …';
    }
    // Unreachable as things stand — the fixer does not allow Bash (coding/agent.ts denies it
    // outright), so no such block arrives and the panel simply shows fewer lines. Kept because
    // this function's contract is "label whatever the SDK hands me", and the default branch
    // below would render this one worse.
    case 'Bash': {
      const c = str(input.command);
      return c ? `Bash ${clip(c, ARG_CAP)}` : 'Bash …';
    }
    case 'mcp__fix__submit_fix':
      return 'Recording fix summary…';
    default: {
      for (const key of Object.keys(input)) {
        const v = str(input[key]);
        if (v) return `${name} ${clip(v, ARG_CAP)}`;
      }
      return `${name} …`;
    }
  }
}
