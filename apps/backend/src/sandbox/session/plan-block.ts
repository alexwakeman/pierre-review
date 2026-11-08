// THE PLAN BLOCK IN AN AGENT'S TEXT (docs/SANDBOX.md § The plan and its checks). Claude's chat mode is
// `--permission-mode plan`, which refuses every write, so the plan cannot be a file: it leaves the sandbox
// as the LAST fenced block whose info string is exactly `limn-plan` in the turn's FINAL agent texts (both
// providers). Pure.
//
//   extractPlanBlock   the block's body, or why there is none;
//   stripPlanBlock     the stored conversation item: the block replaced by one line, so the conversation
//                      never shows raw JSON and `session_json` does not store the plan twice.
//
// A ```limn-plan line INSIDE another fence (a longer ```` fence, or a ``` fence that is still open) is
// text, not the plan.
import { BUILD_PLAN_FENCE, BUILD_PLAN_MAX_BYTES } from '@pierre-review/shared';

interface Block {
  /** Character offsets of the whole block (opening fence to closing fence, inclusive) in the text. */
  from: number;
  to: number;
  info: string;
  body: string;
}

/** Every top-level fenced block of a markdown text (CommonMark fences: ``` or ~~~, 3+). */
function fencedBlocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.split('\n');
  let offset = 0;
  let open: { char: string; len: number; info: string; from: number; bodyFrom: number } | null = null;
  for (const line of lines) {
    const lineEnd = offset + line.length;
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open == null) {
      if (m && !(m[1]![0] === '`' && m[2]!.includes('`'))) {
        open = { char: m[1]![0]!, len: m[1]!.length, info: m[2]!.trim(), from: offset, bodyFrom: lineEnd + 1 };
      }
    } else if (m && m[1]![0] === open.char && m[1]!.length >= open.len && m[2]!.trim() === '') {
      out.push({ from: open.from, to: lineEnd, info: open.info, body: text.slice(open.bodyFrom, Math.max(open.bodyFrom, offset - 1)) });
      open = null;
    }
    offset = lineEnd + 1;
  }
  return out;
}

export type PlanBlockResult = { kind: 'found'; body: string } | { kind: 'none' } | { kind: 'too_large'; bytes: number };

/** The LAST `limn-plan` block across the turn's final texts (later texts win). */
export function extractPlanBlock(texts: readonly string[]): PlanBlockResult {
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    const blocks = fencedBlocks(texts[i] ?? '').filter((b) => b.info === BUILD_PLAN_FENCE);
    const last = blocks[blocks.length - 1];
    if (!last) continue;
    const bytes = Buffer.byteLength(last.body, 'utf8');
    if (bytes > BUILD_PLAN_MAX_BYTES) return { kind: 'too_large', bytes };
    return { kind: 'found', body: last.body };
  }
  return { kind: 'none' };
}

/** The text with every `limn-plan` block replaced by `line` (null: the text has none, unchanged). */
export function stripPlanBlock(text: string, line: string): string | null {
  const blocks = fencedBlocks(text).filter((b) => b.info === BUILD_PLAN_FENCE);
  if (blocks.length === 0) return null;
  let out = '';
  let at = 0;
  for (const b of blocks) {
    out += text.slice(at, b.from) + line;
    at = b.to;
  }
  out += text.slice(at);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
