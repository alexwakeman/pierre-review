import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Tone } from '../../mock/acme';
import './mock.css';
import './live.css';

// ---------------------------------------------------------------------------
// THE MOCK KIT: small pieces of the app's own screens, drawn in HTML.
//
// Every product picture on the site is built from these, with the words and
// numbers from src/mock/acme.ts. They are real text, so the prerendered HTML
// carries them and a crawler can read them.
//
// TWO KINDS OF MOCK.
//  - A STILL mock is ONE image to assistive technology: MockFrame sets role="img"
//    and its `label` is the summary a screen reader hears.
//  - A LIVE mock (`live`) can be clicked like the app: tabs switch (MockTabs, a
//    real tablist), buttons run (Act, through useLater), rows open (PrRow with
//    onToggle). It is role="group" with the same `label`, so its controls stay
//    reachable. Its FIRST state is what the prerendered HTML shows, complete
//    without JS; the client render (main.tsx, createRoot — no hydration) starts
//    from that same state and adds the "Try it" hint, which never appears in the
//    static HTML because nothing there can be clicked yet.
//
// LAYOUT: below 961px every multi-column piece restacks (mock.css) rather than
// shrinking; text never drops under 11px (labels) or 12px (sentences).
//
// MOTION: a button's "working…" step lasts under a second, and is skipped under
// prefers-reduced-motion (useLater runs the next state at once).
// ---------------------------------------------------------------------------

/** True in the browser, false in the prerender (renderToStaticMarkup runs in Node). */
const IN_BROWSER = typeof window !== 'undefined';

function prefersReducedMotion(): boolean {
  return IN_BROWSER && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Run a state change after a short pause, as the app would after a request.
 * Under reduced motion the pause is skipped. Pending timers clear on unmount.
 */
export function useLater(): (fn: () => void, ms?: number) => void {
  const timers = useRef<number[]>([]);
  useEffect(
    () => () => {
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
    },
    [],
  );
  return useCallback((fn: () => void, ms = 700) => {
    if (prefersReducedMotion()) {
      fn();
      return;
    }
    timers.current.push(window.setTimeout(fn, ms));
  }, []);
}

/**
 * A three-step action: idle → busy → done. `run()` moves it on; `reset()` puts it
 * back. The words come from acme.ts (ACTIONS and friends).
 */
export function useAction(ms = 700): {
  phase: 'idle' | 'busy' | 'done';
  run: (after?: () => void) => void;
  reset: () => void;
} {
  const [phase, setPhase] = useState<'idle' | 'busy' | 'done'>('idle');
  const later = useLater();
  const run = useCallback(
    (after?: () => void) => {
      setPhase('busy');
      later(() => {
        setPhase('done');
        after?.();
      }, ms);
    },
    [later, ms],
  );
  const reset = useCallback(() => setPhase('idle'), []);
  return { phase, run, reset };
}

export function MockFrame({
  label,
  title,
  meta,
  right,
  dots = false,
  live = false,
  onReset,
  className = '',
  children,
}: {
  label: string;
  title?: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
  dots?: boolean;
  /** Clickable: role="group", a "Try it" hint in the browser. */
  live?: boolean;
  /** Shown as a "Reset" button once the reader has changed something. */
  onReset?: (() => void) | null;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const hint = live && IN_BROWSER;
  const bar = title !== undefined || meta !== undefined || right !== undefined || hint;
  return (
    <div
      className={`mk-frame${live ? ' live' : ''} ${className}`.trim()}
      role={live ? 'group' : 'img'}
      aria-label={label}
    >
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
          {hint ? (
            <span className="mk-try">
              {onReset ? (
                <button type="button" className="mk-reset" onClick={onReset}>
                  Reset
                </button>
              ) : (
                <span aria-hidden="true">Try it</span>
              )}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="mk-body">{children}</div>
    </div>
  );
}

export function Chip({ tone = 'grey', children }: { tone?: Tone; children: ReactNode }): JSX.Element {
  return <span className={`mk-chip c-${tone}`}>{children}</span>;
}

/** A button as the app draws it, in a STILL mock: part of a picture, not interactive. */
export function Btn({ tone, children }: { tone?: 'go' | 'gold'; children: ReactNode }): JSX.Element {
  return <span className={tone ? `mk-btn ${tone}` : 'mk-btn'}>{children}</span>;
}

/** A real button inside a LIVE mock, drawn like the app's. */
export function Act({
  tone,
  onClick,
  disabled = false,
  pressed,
  label,
  children,
}: {
  tone?: 'go' | 'gold';
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  label?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className={tone ? `mk-btn ${tone}` : 'mk-btn'}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={label}
    >
      {children}
    </button>
  );
}

/** A still tab strip (no state): a picture of the app's tabs. */
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

/**
 * A real tab set: the strip (role="tablist", roving focus, arrow keys, Home/End)
 * and ONE panel whose content follows the selected tab.
 */
export function MockTabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  children,
  boxed = false,
}: {
  label: string;
  tabs: ReadonlyArray<{ id: T; label: string; count?: number }>;
  value: T;
  onChange: (id: T) => void;
  children: ReactNode;
  /** The app's button tabs (`Tabs variant="boxed"`): PR detail and Pending. */
  boxed?: boolean;
}): JSX.Element {
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabId = (id: string): string => `${base}t-${id}`;
  const panelId = `${base}p`;

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = tabs.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const t = tabs[next];
    if (!t) return;
    onChange(t.id);
    refs.current[next]?.focus();
  };

  return (
    <>
      <div className={boxed ? 'mk-tabs boxed' : 'mk-tabs'} role="tablist" aria-label={label} onKeyDown={onKey}>
        {tabs.map((t, i) => {
          const on = t.id === value;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={tabId(t.id)}
              aria-selected={on}
              aria-controls={panelId}
              tabIndex={on ? 0 : -1}
              className={on ? 'on' : undefined}
              onClick={() => onChange(t.id)}
            >
              {t.label}
              {t.count !== undefined ? <em>{t.count}</em> : null}
            </button>
          );
        })}
      </div>
      <div className="mk-panel" role="tabpanel" id={panelId} aria-labelledby={tabId(value)}>
        {children}
      </div>
    </>
  );
}

/** A row of toggle buttons (aria-pressed), as the app draws a "Grain: Sprint · Month" choice. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
}): JSX.Element {
  return (
    <div className="mk-seg" role="group" aria-label={label}>
      <span aria-hidden="true">{label}</span>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A small uppercase group heading inside a mock. */
export function Group({ children, first = false }: { children: ReactNode; first?: boolean }): JSX.Element {
  return <div className={first ? 'mk-grp first' : 'mk-grp'}>{children}</div>;
}

/**
 * One pull request: title, repository, a status on the right, a line of facts,
 * optional detail. With `onToggle` the title is a button that opens and closes
 * the detail (`children`), as a Pending card does.
 */
export function PrRow({
  title,
  repo,
  status,
  why,
  open = false,
  onToggle,
  className = '',
  children,
}: {
  title: ReactNode;
  repo?: string;
  status?: ReactNode;
  why?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  const showMore = children ? (onToggle ? open : true) : false;
  const head = (
    <>
      {title}
      {repo ? <small>{repo}</small> : null}
    </>
  );
  return (
    <div className={`mk-pr${open ? ' open' : ''} ${className}`.trim()}>
      {onToggle ? (
        <button type="button" className="t" aria-expanded={open} onClick={onToggle}>
          {head}
        </button>
      ) : (
        <div className="t">{head}</div>
      )}
      {status !== undefined ? <div className="s">{status}</div> : null}
      {why !== undefined ? <div className="why">{why}</div> : null}
      {showMore ? <div className="more">{children}</div> : null}
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

/**
 * A CI check or a branch: name on the left, state on the right, an optional note
 * under it. With `onToggle` the row opens and closes its note.
 */
export function CheckRow({
  name,
  state,
  tone,
  note,
  open,
  onToggle,
}: {
  name: ReactNode;
  state: ReactNode;
  tone: Tone;
  note?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
}): JSX.Element {
  const showNote = note ? (onToggle ? open : true) : false;
  return (
    <div className={`mk-check${onToggle && open ? ' open' : ''}`}>
      <span className={`dot d-${tone}`} aria-hidden="true" />
      {onToggle ? (
        <button type="button" className="n" aria-expanded={open} onClick={onToggle}>
          {name}
        </button>
      ) : (
        <span className="n">{name}</span>
      )}
      <Chip tone={tone}>{state}</Chip>
      {showNote ? <span className="note">{note}</span> : null}
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
 * via data-label) instead of squeezing its columns. With `selected` and
 * `onSelect`, each row's first cell is a button that picks the row (the detail
 * the mock shows for it is the caller's).
 */
export function MiniTable({
  cols,
  rows,
  className = '',
  selected,
  onSelect,
}: {
  cols: Col[];
  rows: Array<Record<string, ReactNode> & { _key: string }>;
  className?: string;
  selected?: string | null;
  onSelect?: (key: string) => void;
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
        {rows.map((r) => {
          const on = selected === r._key;
          return (
            <tr key={r._key} className={on ? 'sel' : undefined}>
              {cols.map((c, i) => (
                <td key={c.key} className={c.num ? 'r' : undefined} data-label={i === 0 ? undefined : c.label}>
                  {i === 0 && onSelect ? (
                    <button type="button" className="mk-rowbtn" aria-expanded={on} onClick={() => onSelect(r._key)}>
                      {r[c.key]}
                    </button>
                  ) : (
                    r[c.key]
                  )}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** A diff: the file name, then removed and added lines. Lines wrap rather than scroll. */
export function Diff({
  file,
  lines,
  after,
}: {
  file: string;
  lines: ReadonlyArray<{ k: '-' | '+' | ' '; t: string }>;
  /** Shown under the last line, e.g. a review thread pinned to it. */
  after?: ReactNode;
}): JSX.Element {
  return (
    <div className="mk-diffwrap">
      <pre className="mk-diff">
        <span className="f">{file}</span>
        {lines.map((l, i) => (
          <span key={i} className={l.k === '-' ? 'del' : l.k === '+' ? 'add' : 'ctx'}>
            {l.k}
            {l.t}
          </span>
        ))}
      </pre>
      {after}
    </div>
  );
}

/** A few lines of a failing log. */
export function Log({ lines }: { lines: readonly string[] }): JSX.Element {
  return <pre className="mk-log">{lines.join('\n')}</pre>;
}

/** A big figure with a small label over it, as Reports' tiles draw one. With `onClick` it opens its list. */
export function Stat({
  k,
  v,
  d,
  tone,
  onClick,
  pressed,
}: {
  k: string;
  v: string;
  d?: string;
  tone?: Tone;
  onClick?: () => void;
  pressed?: boolean;
}): JSX.Element {
  const inner = (
    <>
      <span className="k">{k}</span>
      <b>{v}</b>
      {d ? <span className={tone ? `d t-${tone}` : 'd'}>{d}</span> : null}
    </>
  );
  return onClick ? (
    <button type="button" className="mk-stat" aria-expanded={pressed} onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div className="mk-stat">{inner}</div>
  );
}

// ---- settings controls (the docs) ---------------------------------------------
//
// The app's Settings sections, drawn with real controls. A select and a checkbox
// change the mock's state; a text box is a still picture of what is typed there
// (the site never takes input it would have to explain).

/** A settings section: its title, one-line description, then the fields. */
export function Section({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="mk-sec">
      <div className="mk-sec-h">
        <b>{title}</b>
        {desc ? <p>{desc}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** A labelled field with an optional hint under it. */
export function Field({ label, hint, children, id }: { label: string; hint?: ReactNode; id?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="mk-field">
      {id ? <label htmlFor={id}>{label}</label> : <span className="lbl">{label}</span>}
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/** What is typed in a text box, drawn as one. */
export function TextBox({ value, mono = false }: { value: string; mono?: boolean }): JSX.Element {
  return <span className={mono ? 'mk-input mono' : 'mk-input'}>{value}</span>;
}

/** A real select. */
export function SelectBox<T extends string>({
  id,
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  id?: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
  label?: string;
}): JSX.Element {
  return (
    <select
      id={id}
      className="mk-select"
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A real checkbox with the app's bold label and its muted line under it. */
export function CheckLine({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
}): JSX.Element {
  return (
    <label className="mk-checkline">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <b>{label}</b>
        {hint ? <span>{hint}</span> : null}
      </span>
    </label>
  );
}
