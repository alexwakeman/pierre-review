import { describe, expect, it } from 'vitest';
import { SEQUENCE_DIAGRAM_MAX_CHARS } from '@pierre-review/shared';
import { MAX_LINES, cleanCaption, cleanTitle, validateMermaid } from './validate.js';

const OK = `sequenceDiagram
  participant U as User
  participant API as Orders API
  U->>API: POST /orders
  API-->>U: 201`;

describe('validateMermaid — accepts one allowed diagram', () => {
  it('accepts a plain sequence diagram and names its type', () => {
    const v = validateMermaid(OK);
    expect(v).toMatchObject({ ok: true, diagramType: 'sequenceDiagram', removed: [] });
    if (v.ok) expect(v.source).toBe(OK);
  });

  it('unwraps ONE surrounding ```mermaid fence', () => {
    const v = validateMermaid('```mermaid\n' + OK + '\n```');
    expect(v.ok && v.source).toBe(OK);
  });

  it('accepts the other allowed types (stateDiagram-v2 before stateDiagram)', () => {
    expect(validateMermaid('flowchart TD\n  A --> B')).toMatchObject({ ok: true, diagramType: 'flowchart' });
    expect(validateMermaid('stateDiagram-v2\n  [*] --> Open')).toMatchObject({ ok: true, diagramType: 'stateDiagram-v2' });
    expect(validateMermaid('erDiagram\n  ORDER ||--o{ LINE : has')).toMatchObject({ ok: true, diagramType: 'erDiagram' });
  });

  it('keeps arrows that contain < and > (they are not tags)', () => {
    const v = validateMermaid('sequenceDiagram\n  A<<->>B: sync\n  A-->>B: ok');
    expect(v.ok && v.source).toContain('A<<->>B: sync');
  });
});

describe('validateMermaid — refuses', () => {
  it('empty, a header with no steps, and non-strings', () => {
    expect(validateMermaid('')).toMatchObject({ ok: false, reason: 'empty' });
    expect(validateMermaid('sequenceDiagram\n')).toMatchObject({ ok: false, reason: 'empty' });
    expect(validateMermaid(42)).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('a type that is not on the list (pie, gantt, prose)', () => {
    expect(validateMermaid('pie\n  "a": 1')).toMatchObject({ ok: false, reason: 'unknown_type' });
    expect(validateMermaid('Here is the diagram:\nsequenceDiagram\n A->>B: x')).toMatchObject({
      ok: false,
      reason: 'unknown_type',
    });
  });

  it('more than one fenced block, or prose around a fence', () => {
    const two = '```mermaid\n' + OK + '\n```\n```mermaid\n' + OK + '\n```';
    expect(validateMermaid(two)).toMatchObject({ ok: false, reason: 'not_one_block' });
    expect(validateMermaid('Look:\n```mermaid\n' + OK + '\n```')).toMatchObject({ ok: false, reason: 'not_one_block' });
  });

  it('script, javascript: links and embedded documents, anywhere', () => {
    for (const bad of [
      'sequenceDiagram\n  A->>B: <script>alert(1)</script>',
      'sequenceDiagram\n  A->>B: JavaScript:alert(1)',
      'sequenceDiagram\n  A->>B: <iframe src=x>',
      'flowchart TD\n  A["<foreignObject>"] --> B',
      'sequenceDiagram\n  A->>B: data:text/html;base64,xx',
    ]) {
      expect(validateMermaid(bad)).toMatchObject({ ok: false, reason: 'unsafe' });
    }
  });

  it('over the size caps', () => {
    const big = 'sequenceDiagram\n' + '  A->>B: x\n'.repeat(Math.ceil(SEQUENCE_DIAGRAM_MAX_CHARS / 10));
    expect(validateMermaid(big)).toMatchObject({ ok: false, reason: 'too_large' });
    const long = 'sequenceDiagram\n' + 'A->>B:x\n'.repeat(MAX_LINES + 1);
    expect(validateMermaid(long)).toMatchObject({ ok: false, reason: 'too_large' });
  });
});

describe('validateMermaid — strips what could change config, link out or style', () => {
  it('drops %%{init}%% directives, even across lines, and front matter', () => {
    const v = validateMermaid(
      "%%{init: {'securityLevel': 'loose'}}%%\nsequenceDiagram\n  A->>B: x\n%%{\n  init: {}\n}%%",
    );
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.source).not.toContain('%%{');
      expect(v.source).not.toContain('securityLevel');
      expect(v.removed).toContain('directives');
    }
    const fm = validateMermaid('---\nconfig:\n  securityLevel: loose\n---\nsequenceDiagram\n  A->>B: x');
    expect(fm.ok && fm.source).toBe('sequenceDiagram\n  A->>B: x');
  });

  it('drops click, link, links, href, callback, style, classDef and linkStyle lines', () => {
    const v = validateMermaid(
      [
        'flowchart TD',
        '  A --> B',
        '  click A href "https://evil.example"',
        '  click B call alert()',
        '  style A fill:url(https://evil.example/x)',
        '  classDef red fill:#f00',
        '  linkStyle 0 stroke:red',
      ].join('\n'),
    );
    expect(v.ok && v.source).toBe('flowchart TD\n  A --> B');
    const s = validateMermaid('sequenceDiagram\n  participant A\n  link A: Docs @ https://x\n  links A: {"x":"https://y"}\n  A->>A: x');
    expect(s.ok && s.source).toBe('sequenceDiagram\n  participant A\n  A->>A: x');
  });

  it('neutralises HTML in labels: <br> to a space, other tags to entity text', () => {
    const v = validateMermaid('sequenceDiagram\n  A->>B: first<br/>second\n  A->>B: returns Map<string> <b>bold</b>');
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.source).toContain('first second');
      expect(v.source).toContain('Map#lt;string#gt;');
      expect(v.source).not.toMatch(/<b>|<\/b>/);
      expect(v.removed).toContain('html');
    }
  });

  it('strips control characters', () => {
    const v = validateMermaid('sequenceDiagram\n  A->>B: x\u0007y');
    expect(v.ok && v.source).toBe('sequenceDiagram\n  A->>B: xy');
  });
});

describe('cleanTitle / cleanCaption', () => {
  it('one line, clipped', () => {
    expect(cleanTitle('  Checkout\n  flow ')).toBe('Checkout flow');
    expect(cleanTitle('x'.repeat(200))?.length).toBe(120);
    expect(cleanTitle('   ')).toBeNull();
  });
  it('at most three sentences', () => {
    expect(cleanCaption('One. Two! Three? Four.')).toBe('One. Two! Three?');
    expect(cleanCaption('No full stop')).toBe('No full stop');
  });
});
