// MERMAID'S CONFIG for the <SequenceDiagram> renderer — PURE, so the security settings are pinned by
// a test (test/sequenceDiagram.test.ts) without loading Mermaid.
//
// ⚠ securityLevel 'strict' is the point: Mermaid then sanitises every label (DOMPurify), refuses
// `click` handlers and never runs script. The SERVER already validated and stripped the source
// (review/diagrams/validate.ts); this is the second line, not the first.
//
// The THEME follows the app's own light/dark tokens (index.css `--ai-*`, space-separated RGB
// channels) through Mermaid's 'base' theme, so a diagram reads as part of the page in both themes.

export type MermaidTokens = {
  surface: string;
  surface2: string;
  border: string;
  ink: string;
  muted: string;
  signal: string;
};

/** "250 250 248" (an `--ai-*` token) → "#fafaf8". A token that does not parse → the fallback. */
export function channelsToHex(channels: string, fallback: string): string {
  const parts = channels.trim().split(/[\s,/]+/).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return fallback;
  return `#${parts
    .slice(0, 3)
    .map((n) => Math.round(n).toString(16).padStart(2, '0'))
    .join('')}`;
}

const LIGHT: MermaidTokens = {
  surface: '#fafaf8',
  surface2: '#f4f4ef',
  border: '#e2e2dc',
  ink: '#16161a',
  muted: '#5a5a5e',
  signal: '#b53621',
};
const DARK: MermaidTokens = {
  surface: '#16161a',
  surface2: '#1c1c21',
  border: '#3a3a3e',
  ink: '#dcdcd6',
  muted: '#9a9a94',
  signal: '#f26b4e',
};

/** The tokens off a computed style (the document root), falling back per theme. */
export function readMermaidTokens(read: (name: string) => string, dark: boolean): MermaidTokens {
  const fb = dark ? DARK : LIGHT;
  return {
    surface: channelsToHex(read('--ai-surface'), fb.surface),
    surface2: channelsToHex(read('--ai-surface-2'), fb.surface2),
    border: channelsToHex(read('--ai-border'), fb.border),
    ink: channelsToHex(read('--ai-ink'), fb.ink),
    muted: channelsToHex(read('--ai-muted'), fb.muted),
    signal: channelsToHex(read('--ai-signal'), fb.signal),
  };
}

/** The ONE initialize() config. */
export function mermaidConfig(t: MermaidTokens, dark: boolean) {
  return {
    startOnLoad: false,
    securityLevel: 'strict' as const,
    // Labels as plain SVG text — no HTML labels inside <foreignObject>.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: 'base' as const,
    darkMode: dark,
    fontFamily: 'inherit',
    themeVariables: {
      darkMode: dark,
      background: t.surface,
      fontFamily: 'inherit',
      primaryColor: t.surface2,
      primaryTextColor: t.ink,
      primaryBorderColor: t.border,
      secondaryColor: t.surface2,
      tertiaryColor: t.surface,
      lineColor: t.muted,
      textColor: t.ink,
      actorBkg: t.surface2,
      actorBorder: t.muted,
      actorTextColor: t.ink,
      actorLineColor: t.border,
      signalColor: t.ink,
      signalTextColor: t.ink,
      labelBoxBkgColor: t.surface2,
      labelBoxBorderColor: t.border,
      labelTextColor: t.ink,
      loopTextColor: t.ink,
      noteBkgColor: t.surface,
      noteTextColor: t.ink,
      noteBorderColor: t.signal,
      activationBkgColor: t.surface2,
      activationBorderColor: t.muted,
      sequenceNumberColor: t.surface,
    },
  };
}
