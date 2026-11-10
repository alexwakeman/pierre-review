import type { ReactNode } from 'react';
import { Link } from '../router';
import { docHref } from './routes';
import {
  Btn,
  CheckRow,
  Chip,
  CourtBar,
  Diff,
  Field,
  FindingRow,
  Group,
  Log,
  MiniTable,
  MockFrame,
  PrRow,
  Section,
  Stat,
  Tabs,
  TextBox,
} from '../components/mock/kit';
import type { Tone } from '../mock/acme';

// ---------------------------------------------------------------------------
// THE DOCS KIT: what a docs page is written with. See CONTRIBUTING.md.
//
//  Structure   H2 (with an id: it goes in "On this page"), H3, Steps, Ui (an app label),
//              Kbd, DocLink, Callout (Note / Tip / Warning), Stub.
//  Pictures    Illustration wraps a small HTML mock of a screen, captioned "Illustration".
//              NEVER a screenshot or an <img> of the product. Draw with the landing's own mock
//              pieces (re-exported below) plus AppShell, Toolbar, Card, Thread, SettingsRow,
//              Toggle and Pill, using the fictional Acme data in src/mock/acme.ts.
//
// ⚠ A PAGE BODY IS HOOK-FREE. "On this page" is read by calling the body outside a render and
// collecting its H2s (toc.ts). Put state (a clickable mock) in a component the body renders.
// ---------------------------------------------------------------------------

export { Btn, CheckRow, Chip, CourtBar, Diff, Field, FindingRow, Group, Log, MiniTable, MockFrame, PrRow, Section, Stat, Tabs, TextBox };
export type { Tone };

/** A section heading. Its `id` is the anchor (`DocLink to="section/slug#id"`) and its text goes in "On this page". */
export function H2({ id, children }: { id: string; children: ReactNode }): JSX.Element {
  return (
    <h2 id={id} className="dx-h2">
      <a className="dx-anchor" href={`#${id}`} aria-label="Link to this section">
        #
      </a>
      {children}
    </h2>
  );
}

/** A sub-heading. Not listed in "On this page"; give it an id only when something links to it. */
export function H3({ id, children }: { id?: string; children: ReactNode }): JSX.Element {
  return (
    <h3 id={id} className="dx-h3">
      {children}
    </h3>
  );
}

/**
 * A link to another docs page: `to="pending/my-turn"` or `to="pending/my-turn#dismiss"`, or
 * `to="#anchor"` on the same page. The docs test fails on a page or an anchor that does not exist.
 */
export function DocLink({ to, children }: { to: string; children: ReactNode }): JSX.Element {
  return (
    <Link to={docHref(to)} className="dx-link">
      {children}
    </Link>
  );
}

/** A link off the site (a vendor's page, a quoted policy). Opens in a new tab. */
export function ExtLink({ href, children }: { href: string; children: ReactNode }): JSX.Element {
  return (
    <a href={href} className="dx-link" target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

/** A word on the app's screen, exactly as the app spells it: <Ui>Settings → AI</Ui>. */
export function Ui({ children }: { children: ReactNode }): JSX.Element {
  return <strong className="dx-ui">{children}</strong>;
}

/** A keyboard key: <Kbd>g</Kbd> then <Kbd>p</Kbd>. */
export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return <kbd className="dx-kbd">{children}</kbd>;
}

/** Numbered steps. Each child is one step; start each with a verb. */
export function Steps({ children }: { children: ReactNode }): JSX.Element {
  return <ol className="dx-steps">{children}</ol>;
}

type CalloutKind = 'note' | 'tip' | 'warning';
const CALLOUT_LABEL: Record<CalloutKind, string> = { note: 'Note', tip: 'Tip', warning: 'Warning' };

function Callout({ kind, title, children }: { kind: CalloutKind; title?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <aside className={`dx-callout ${kind}`} aria-label={CALLOUT_LABEL[kind]}>
      <p className="dx-callout-h">
        <b>{CALLOUT_LABEL[kind]}</b>
        {title ? <span>{title}</span> : null}
      </p>
      <div className="dx-callout-b">{children}</div>
    </aside>
  );
}

/** Something worth knowing that changes nothing if missed. */
export function Note({ title, children }: { title?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <Callout kind="note" title={title}>
      {children}
    </Callout>
  );
}

/** A quicker or better way. */
export function Tip({ title, children }: { title?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <Callout kind="tip" title={title}>
      {children}
    </Callout>
  );
}

/** Something that can lose work, post to GitHub, spend money or surprise a teammate. */
export function Warning({ title, children }: { title?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <Callout kind="warning" title={title}>
      {children}
    </Callout>
  );
}

/** "Who it helps": what this screen or feature does for a developer and for an engineering manager. */
/** A quoted passage from a vendor's policy, with its source. Quote exactly; link the page. */
export function Quote({ source, href, children }: { source: string; href: string; children: ReactNode }): JSX.Element {
  return (
    <figure className="dx-quote">
      <blockquote cite={href}>{children}</blockquote>
      <figcaption>
        <ExtLink href={href}>{source}</ExtLink>
      </figcaption>
    </figure>
  );
}

/** The placeholder body of a page not written yet. The docs test fails while any page uses it. */
export function Stub(): JSX.Element {
  return (
    <div className="dx-stub">
      <p>This page is being written.</p>
    </div>
  );
}

// ---- pictures --------------------------------------------------------------------------------

/**
 * A captioned picture of a screen, drawn in HTML. `label` is what a screen reader hears (a
 * summary of what the picture shows); `caption` is shown under it after "Illustration:". Pass
 * `live` when the mock inside can be clicked.
 */
export function Illustration({
  label,
  caption,
  title,
  meta,
  live = false,
  children,
}: {
  label: string;
  caption?: ReactNode;
  title?: ReactNode;
  meta?: ReactNode;
  live?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <figure className="dx-fig">
      <MockFrame label={label} title={title} meta={meta} live={live} dots>
        {children}
      </MockFrame>
      {caption ? (
        <figcaption>
          <span>Illustration:</span> {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

/** The app's sidebar words, in order (the docs test checks them against the app). */
export const SIDEBAR_LABELS = [
  'Open pull requests',
  'Pending',
  'This Sprint',
  'Timeline',
  'Docs',
  'Feed',
  'Reports',
  'Bots Monitoring',
] as const;
export type SidebarLabel = (typeof SIDEBAR_LABELS)[number];

/** The app's frame: a small sidebar with `active` marked, and the page beside it. */
export function AppShell({ active, children }: { active?: SidebarLabel; children: ReactNode }): JSX.Element {
  return (
    <div className="dx-shell">
      <ul className="dx-shell-nav" aria-hidden="true">
        {SIDEBAR_LABELS.map((l) => (
          <li key={l} className={l === active ? 'on' : undefined}>
            {l}
          </li>
        ))}
      </ul>
      <div className="dx-shell-main">{children}</div>
    </div>
  );
}

/** A row of controls over a list: buttons, a segmented choice, a search box. Pictures only. */
export function Toolbar({ children }: { children: ReactNode }): JSX.Element {
  return <div className="dx-toolbar">{children}</div>;
}

/** A small rounded label, as the app's chips. Same as Chip. */
export function Pill({ tone = 'grey', children }: { tone?: Tone; children: ReactNode }): JSX.Element {
  return <Chip tone={tone}>{children}</Chip>;
}

/** A card: a title, an optional chip on the right, then its body. */
export function Card({ title, chip, children }: { title: ReactNode; chip?: ReactNode; children?: ReactNode }): JSX.Element {
  return (
    <div className="dx-card">
      <div className="dx-card-h">
        <b>{title}</b>
        {chip}
      </div>
      {children ? <div className="dx-card-b">{children}</div> : null}
    </div>
  );
}

/** A review thread: the file and line, a state chip, then the comments in order. */
export function Thread({
  file,
  state,
  tone = 'grey',
  comments,
}: {
  file?: string;
  state?: ReactNode;
  tone?: Tone;
  comments: ReadonlyArray<{ who: string; when?: string; text: ReactNode; bot?: boolean }>;
}): JSX.Element {
  return (
    <div className="dx-thread">
      {file || state ? (
        <div className="dx-thread-h">
          {file ? <code>{file}</code> : null}
          {state ? <Chip tone={tone}>{state}</Chip> : null}
        </div>
      ) : null}
      {comments.map((c, i) => (
        <div key={i} className="dx-comment">
          <div className="dx-comment-h">
            <b>{c.who}</b>
            {c.bot ? <Chip tone="grey">bot</Chip> : null}
            {c.when ? <span className="muted">{c.when}</span> : null}
          </div>
          <p>{c.text}</p>
        </div>
      ))}
    </div>
  );
}

/** A switch, drawn: on or off. A picture, not a control. */
export function Toggle({ on }: { on: boolean }): JSX.Element {
  return <span className={on ? 'dx-toggle on' : 'dx-toggle'}>{on ? 'On' : 'Off'}</span>;
}

/** One line of a Settings tab: the label and its hint on the left, the control on the right. */
export function SettingsRow({ label, hint, control }: { label: ReactNode; hint?: ReactNode; control: ReactNode }): JSX.Element {
  return (
    <div className="dx-setrow">
      <div>
        <b>{label}</b>
        {hint ? <span>{hint}</span> : null}
      </div>
      <div className="dx-setrow-c">{control}</div>
    </div>
  );
}
