// Live progress derivation for the coding agent — turns each assistant turn into a
// few short, human-readable lines (tool labels + clipped text). Mirrors the private
// helpers in review/agent.ts but understands the WRITE tools (Write/Edit/MultiEdit)
// the fixer uses. Defensive throughout: the SDK content/tool-input shapes vary, so
// every access is guarded and this never throws.

const TEXT_SNIPPET_CAP = 120;
const ARG_CAP = 80;

export function describeAssistantBlocks(message: unknown): string[] {
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
      lines.push(labelToolUse(name, input));
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

function labelToolUse(name: string, input: Record<string, unknown>): string {
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
    case 'Bash': {
      const c = str(input.command);
      return c ? `Bash ${clip(c, ARG_CAP)}` : 'Bash …';
    }
    case 'mcp__fix__submit_fix':
      return 'Recording fix summary…';
    case 'mcp__resolve__submit_resolution':
      return 'Recording resolution…';
    default: {
      for (const key of Object.keys(input)) {
        const v = str(input[key]);
        if (v) return `${name} ${clip(v, ARG_CAP)}`;
      }
      return `${name} …`;
    }
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
