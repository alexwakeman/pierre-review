import type { CSSProperties, ReactNode } from 'react';
import type { Tone } from '../../mock/acme';
import './mock.css';

// ---------------------------------------------------------------------------
// THE MOCK KIT: small pieces of the app's own screens, drawn in HTML.
//
// Every product picture on the site is built from these, with the words and
// numbers from src/mock/acme.ts. They are real text, so the prerendered HTML
// carries them and a crawler can read them. Each mock is ONE image to assistive
// technology: MockFrame takes a `label` (the aria-label summary) and sets
// role="img", so a screen reader hears the summary, not every chip.
//
// LAYOUT: below 961px every multi-column piece restacks (mock.css) rather than
// shrinking; text never drops under 11px (labels) or 12px (sentences).
//
// MOTION: at most ONE change per mock, and only through <Swap>. The markup's own
// state is the FINAL one; the earlier state is shown only once useReveal has put
// `js-rise` on the page (never with reduced motion), and the change runs when the
// mock's `.rise` ancestor is revealed. No JS, or reduced motion: final state.
// ---------------------------------------------------------------------------

export function MockFrame({
  label,
  title,
  meta,
  right,
  dots = false,
  className = '',
  children,
}: {
  label: string;
  title?: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
  dots?: boolean;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const bar = title !== undefined || meta !== undefined || right !== undefined;
  return (
    <div className={`mk-frame ${className}`.trim()} role="img" aria-label={label}>
      {bar ? (
        <div className="mk-bar">
          {dots ? (
            <span className="mk-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          ) : null}
          {title !== undefined ? <b>{title}</b> : null}
          {meta !== undefined ? <span className="mk-meta">{meta}</span> : null}
          {right !== undefined ? <span className="mk-right">{right}</span> : null}
        </div>
      ) : null}
      <div className="mk-body">{children}</div>
    </div>
  );
}

export function Chip({ tone = 'grey', children }: { tone?: Tone; children: ReactNode }): JSX.Element {
  return <span className={`mk-chip c-${tone}`}>{children}</span>;
}

/** A button as the app draws it. Not interactive: it is part of a picture. */
export function Btn({ tone, children }: { tone?: 'go' | 'gold'; children: ReactNode }): JSX.Element {
  return <span className={tone ? `mk-btn ${tone}` : 'mk-btn'}>{children}</span>;
}

export function Tabs({ tabs }: { tabs: ReadonlyArray<{ label: string; count?: number; on?: boolean }> }): JSX.Element {
  return (
    <div className="mk-tabs">
      {tabs.map((t) => (
        <span key={t.label} className={t.on ? 'on' : undefined}>
          {t.label}
          {t.count !== undefined ? <em>{t.count}</em> : null}
        </span>
      ))}
    </div>
  );
}

/** A small uppercase group heading inside a mock. */
export function Group({ children, first = false }: { children: ReactNode; first?: boolean }): JSX.Element {
  return <div className={first ? 'mk-grp first' : 'mk-grp'}>{children}</div>;
}

/** One pull request: title, repository, a status on the right, a line of facts, optional detail. */
export function PrRow({
  title,
  repo,
  status,
  why,
  open = false,
  className = '',
  children,
}: {
  title: ReactNode;
  repo?: string;
  status?: ReactNode;
  why?: ReactNode;
  open?: boolean;
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className={`mk-pr${open ? ' open' : ''} ${className}`.trim()}>
      <div className="t">
        {title}
        {repo ? <small>{repo}</small> : null}
      </div>
      {status !== undefined ? <div className="s">{status}</div> : null}
      {why !== undefined ? <div className="why">{why}</div> : null}
      {children ? <div className="more">{children}</div> : null}
    </div>
  );
}

/** A finding, criterion or step: a chip, then the sentence. */
export function FindingRow({ chip, tone = 'grey', children }: { chip: ReactNode; tone?: Tone; children: ReactNode }): JSX.Element {
  return (
    <div className="mk-find">
      <Chip tone={tone}>{chip}</Chip>
      <span>{children}</span>
    </div>
  );
}

/** A CI check or a branch: name on the left, state on the right, an optional note under it. */
export function CheckRow({
  name,
  state,
  tone,
  note,
}: {
  name: ReactNode;
  state: ReactNode;
  tone: Tone;
  note?: ReactNode;
}): JSX.Element {
  return (
    <div className="mk-check">
      <span className={`dot d-${tone}`} aria-hidden="true" />
      <span className="n">{name}</span>
      <Chip tone={tone}>{state}</Chip>
      {note ? <span className="note">{note}</span> : null}
    </div>
  );
}

/** Chronology's one stacked bar with its legend. Each segment's width is its share. */
export function CourtBar({
  segments,
  showPct = false,
}: {
  segments: ReadonlyArray<{ label: string; color: string; pct: number; value?: string }>;
  showPct?: boolean;
}): JSX.Element {
  return (
    <div className="mk-court">
      <div className="bar">
        {segments.map((s) => (
          <i key={s.label} style={{ width: `${s.pct}%`, background: s.color }} />
        ))}
      </div>
      <div className="mk-legend">
        {segments.map((s) => (
          <span key={s.label}>
            <b style={{ background: s.color }} />
            {showPct ? <strong>{s.pct}%</strong> : null}
            {s.label}
            {s.value ? ` ${s.value}` : null}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A horizontal bar inside a table cell. `parts` are percentages of the cell; colours in order. */
export function HBar({ parts, colors }: { parts: number[]; colors: string[] }): JSX.Element {
  return (
    <span className="mk-hbar">
      {parts.map((p, i) => (
        <i key={i} style={{ width: `${p}%`, background: colors[i % colors.length] }} />
      ))}
    </span>
  );
}

export type Col = { key: string; label: string; num?: boolean };

/**
 * A small table. Below 961px each row restacks into labelled lines (mock.css,
 * via data-label) instead of squeezing its columns.
 */
export function MiniTable({
  cols,
  rows,
  className = '',
}: {
  cols: Col[];
  rows: Array<Record<string, ReactNode> & { _key: string }>;
  className?: string;
}): JSX.Element {
  return (
    <table className={`mk-tbl ${className}`.trim()}>
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c.key} className={c.num ? 'r' : undefined}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r._key}>
            {cols.map((c, i) => (
              <td key={c.key} className={c.num ? 'r' : undefined} data-label={i === 0 ? undefined : c.label}>
                {r[c.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A diff: the file name, then removed and added lines. Lines wrap rather than scroll. */
export function Diff({ file, lines }: { file: string; lines: ReadonlyArray<{ k: '-' | '+' | ' '; t: string }> }): JSX.Element {
  return (
    <pre className="mk-diff">
      <span className="f">{file}</span>
      {lines.map((l, i) => (
        <span key={i} className={l.k === '-' ? 'del' : l.k === '+' ? 'add' : 'ctx'}>
          {l.k}
          {l.t}
        </span>
      ))}
    </pre>
  );
}

/** A few lines of a failing log. */
export function Log({ lines }: { lines: readonly string[] }): JSX.Element {
  return <pre className="mk-log">{lines.join('\n')}</pre>;
}

/** A big figure with a small label over it, as Reports' tiles draw one. */
export function Stat({ k, v, d, tone }: { k: string; v: string; d?: string; tone?: Tone }): JSX.Element {
  return (
    <div className="mk-stat">
      <span className="k">{k}</span>
      <b>{v}</b>
      {d ? <span className={tone ? `d t-${tone}` : 'd'}>{d}</span> : null}
    </div>
  );
}

/**
 * The one motion a mock may have: `from` is shown first, then `to`. The markup's
 * state is `to` (see the note at the top of this file).
 */
export function Swap({ from, to, style }: { from: ReactNode; to: ReactNode; style?: CSSProperties }): JSX.Element {
  return (
    <span className="mk-swap" style={style}>
      <span className="a">{from}</span>
      <span className="b">{to}</span>
    </span>
  );
}
