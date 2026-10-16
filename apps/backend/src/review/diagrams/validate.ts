import {
  SEQUENCE_DIAGRAM_MAX_CHARS,
  SEQUENCE_DIAGRAM_TYPES,
  type SequenceDiagramType,
} from '@pierre-review/shared';

// THE DIAGRAM VALIDATOR — every Mermaid answer passes through here TWICE: inside the agent's
// `submit_diagram` tool (a refusal is answered with what to fix, so the model can call again) and
// again before the row is stored. PURE, no I/O.
//
// The model read attacker-authored code and PR text, so its answer is untrusted too. The SPA renders
// with Mermaid's securityLevel 'strict' (which sanitises labels and disables click handlers), and
// this is the FIRST line, not the only one:
//
//   REFUSED outright   <script, javascript:/vbscript:, data:text/html, <iframe/<object/<embed/
//                      <foreignObject anywhere; more than one ``` block; no allowed type on the first
//                      line; more than SEQUENCE_DIAGRAM_MAX_CHARS characters or MAX_LINES lines.
//   STRIPPED           %%{init …}%% directives and a leading YAML front-matter block (both can change
//                      Mermaid's config, securityLevel included); `click` / `link` / `links` / `href` /
//                      `callback` lines (handlers and links); `style` / `classDef` / `linkStyle` lines
//                      (raw CSS); control characters.
//   NEUTRALISED        any HTML tag in a label: `<br>` becomes a space, every other tag becomes
//                      Mermaid's `#lt;…#gt;` entity text, so it shows as text and never as markup.
//
// ⚠ One block, one diagram. A second fenced block, or prose around the fence, is refused rather than
// guessed at.

export const MAX_LINES = 600;

export type MermaidRefusal = 'empty' | 'too_large' | 'not_one_block' | 'unknown_type' | 'unsafe';

export type MermaidValidation =
  | { ok: true; source: string; diagramType: SequenceDiagramType; removed: string[] }
  | { ok: false; reason: MermaidRefusal; message: string };

const UNSAFE =
  /<\s*script|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html|<\s*(?:iframe|object|embed|foreignobject)\b/i;
const DROP_LINE = /^(?:click|link|links|href|callback|style|classdef|linkstyle)\b/i;
// A tag-like run: `<` then a letter, `/` or `!`. Mermaid arrows (`->>`, `<<->>`, `-->`) never match.
const TAG = /<\/?[a-z!][^<>\n]*>/gi;
const BR = /<br\s*\/?>/gi;
const HAS_TAG = /<\/?[a-z!][^<>\n]*>/i;
const HAS_BR = /<br\s*\/?>/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const TYPE_LINE = new RegExp(
  `^(${[...SEQUENCE_DIAGRAM_TYPES].sort((a, b) => b.length - a.length).map((t) => t.replace(/-/g, '\\-')).join('|')})(?=\\s|$)`,
);

const refuse = (reason: MermaidRefusal, message: string): MermaidValidation => ({ ok: false, reason, message });

/** Validate and sanitise one Mermaid answer. */
export function validateMermaid(raw: unknown): MermaidValidation {
  if (typeof raw !== 'string') return refuse('empty', 'The diagram is empty.');
  let text = raw.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim();
  if (text === '') return refuse('empty', 'The diagram is empty.');

  // One optional surrounding fence; anything else carrying a fence is not ONE block.
  const fenced = /^```[ \t]*(?:mermaid)?[ \t]*\n([\s\S]*?)\n?```$/i.exec(text);
  if (fenced) text = fenced[1]!.trim();
  if (text.includes('```')) {
    return refuse('not_one_block', 'Send exactly one Mermaid diagram, with no other text or code blocks.');
  }
  if (text.length > SEQUENCE_DIAGRAM_MAX_CHARS) {
    return refuse('too_large', `The diagram is longer than ${SEQUENCE_DIAGRAM_MAX_CHARS} characters. Draw fewer steps.`);
  }
  if (UNSAFE.test(text)) {
    return refuse('unsafe', 'The diagram contains script, an embedded document or a javascript: link. Remove it.');
  }

  const removed = new Set<string>();
  // A leading YAML front-matter block (`---\nconfig: …\n---`) sets Mermaid config: drop it.
  const front = /^---\n[\s\S]*?\n---\n?/.exec(text);
  if (front) {
    text = text.slice(front[0].length);
    removed.add('front matter');
  }
  // %%{init: …}%% directives, possibly spanning lines.
  if (/%%\{[\s\S]*?\}%%/.test(text)) {
    text = text.replace(/%%\{[\s\S]*?\}%%/g, '');
    removed.add('directives');
  }

  const out: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('%%{')) {
      removed.add('directives');
      continue;
    }
    if (DROP_LINE.test(t)) {
      removed.add(t.split(/\s/)[0]!.toLowerCase());
      continue;
    }
    let l = line;
    if (HAS_BR.test(l)) {
      l = l.replace(BR, ' ');
      removed.add('html');
    }
    if (HAS_TAG.test(l)) {
      l = l.replace(TAG, (m) => `#lt;${m.slice(1, -1)}#gt;`);
      removed.add('html');
    }
    out.push(l.replace(/\s+$/, ''));
  }
  while (out.length > 0 && out[0]!.trim() === '') out.shift();
  while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
  if (out.length > MAX_LINES) {
    return refuse('too_large', `The diagram has more than ${MAX_LINES} lines. Draw fewer steps.`);
  }

  // The first line that is not a comment declares the type.
  const head = out.findIndex((l) => l.trim() !== '' && !l.trim().startsWith('%%'));
  const m = head >= 0 ? TYPE_LINE.exec(out[head]!.trim()) : null;
  if (m == null) {
    return refuse(
      'unknown_type',
      `Start the diagram with one of: ${SEQUENCE_DIAGRAM_TYPES.join(', ')}. Prefer sequenceDiagram.`,
    );
  }
  const body = out.slice(head + 1).filter((l) => l.trim() !== '' && !l.trim().startsWith('%%'));
  if (body.length === 0) return refuse('empty', 'The diagram has no steps.');

  return { ok: true, source: out.join('\n'), diagramType: m[1] as SequenceDiagramType, removed: [...removed] };
}

/** One line of plain text, at most `max` characters (the title). */
export function cleanTitle(raw: unknown, max = 120): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Plain text, at most three sentences and `max` characters (the caption). */
export function cleanCaption(raw: unknown, max = 600): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  const sentences = t.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [t];
  const three = sentences.slice(0, 3).join('').trim();
  return three.length > max ? `${three.slice(0, max - 1).trimEnd()}…` : three;
}
