// THE DATA-FLOW DIAGRAM (docs/FRONTEND.md § Design diagrams): how data moves through a change (or a
// whole story), as a SEQUENCE — who touches the data across the top, the numbered steps down the page,
// in the order they happen. The ONE renderer of a stored `FlowDiagram`; the Claude Review tab's Design
// section, the story view's Story design and the story build's planned design all draw it. (Rows drawn
// before it hold the older grid, which `DesignGrid` still draws.)
//
//   LAYOUT   lanes are equal columns, never narrower than FLOW_LANE_MIN_REM: a wide flow scrolls
//            SIDEWAYS INSIDE THE FIGURE (a phone at 390px, the ~620px drawer), never the page. Each
//            lane has a dashed line down the page; each step is a row with its arrow between the two
//            lanes' lines (lib/dataFlow.ts computes every position as a percentage).
//   STEPS    a numbered badge, the step's WORD (Read, Check, Transform, Write, Call, Emit, Return) and
//            what data passes. Kind is never colour alone: a Check is a dotted line with a shield and
//            the word; a Write a heavy line with a cylinder and the word; a Return a dashed line. A
//            visible key names the line styles drawn. A step that stays on one lane is a loop.
//   LANES    a card per participant: what kind of thing it is, its name, New / Changed (the border, as
//            on the design grid, keyed by the shared `BorderKey`), and on a story its pull request.
//   CLICK    a step with files is a button: one file opens it in the Changes tab; several open a small
//            list. Which PR's Changes tab is the caller's `openFile`.
//   A11Y     the steps are a real ordered list; each item reads as one sentence ("Step 3, Write: from
//            Orders route to orders table — order row."). The lines and arrowheads are decorative.
//
// Every string is the server's validated plain text, rendered as React text.
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useInteractions,
} from '@floating-ui/react';
import type { DesignChange, FlowDiagram, FlowStepKind, SequenceDiagramMember } from '@pierre-review/shared';
import { usePlacedFloating } from './ui/floating.js';
import { claimActivePopover } from '../lib/activePopover.js';
import { CHANGE_KEY_LABEL, CHANGE_WORD, prBadgeTexts } from '../lib/designGrid.js';
import { FLOW_LANE_MIN_REM, laneChangesPresent, layoutFlow, type FlowRow } from '../lib/dataFlow.js';
import { BorderKey } from './LaneBoard.js';
import { DatabaseIcon, PencilIcon, PlusIcon, ShieldIcon } from './Icons.js';

/** Opens one file of a step (or a grid card): `owner.pr` names its pull request on a story. */
export type OpenFlowFile = (owner: { pr: string | null }, path: string) => void;

// The lane cards' borders: the design grid's own (components/DesignGrid.tsx), so New / Changed read
// the same on both.
const CARD_CHANGE: Record<DesignChange, string> = {
  new: 'border-2 border-solid border-ai-signal-fill bg-ui-surface',
  changed: 'border-2 border-dashed border-ai-signal-fill/70 bg-ui-surface',
  unchanged: 'border border-solid border-ai-border bg-ai-surface-2',
};

// The line under each step, by kind. Colour is never the only mark: the style differs and the word is
// printed beside the number.
const LINE: Record<FlowStepKind, string> = {
  read: 'border-t-[1.5px] border-solid border-ui-mute',
  validate: 'border-t-2 border-dotted border-ui-ink',
  transform: 'border-t-[1.5px] border-solid border-ui-mute',
  write: 'border-t-[3px] border-solid border-ai-signal-fill',
  call: 'border-t-[1.5px] border-solid border-ui-mute',
  emit: 'border-t-[1.5px] border-solid border-ui-mute',
  return: 'border-t-[1.5px] border-dashed border-ui-mute',
};
// The loop drawn for a step that stays on its lane (only checks and transforms do).
const LOOP: Record<'validate' | 'transform', string> = {
  validate: 'border-2 border-dotted border-ui-ink',
  transform: 'border-[1.5px] border-solid border-ui-mute',
};
const HEAD: Record<FlowStepKind, string> = {
  read: 'text-ui-mute',
  validate: 'text-ui-ink',
  transform: 'text-ui-mute',
  write: 'text-ai-signal-fill',
  call: 'text-ui-mute',
  emit: 'text-ui-mute',
  return: 'text-ui-mute',
};

// The line styles the key can name (only those drawn are listed).
const LINE_KEY: Partial<Record<FlowStepKind, string>> = {
  validate: 'Check: dotted line',
  write: 'Write: heavy line, where data is kept',
  return: 'Return: dashed line',
};

export function FlowDiagram({
  flow,
  members = [],
  label,
  openFile,
  refNames,
}: {
  flow: FlowDiagram;
  // Story designs: the members, in ref order (PR1 = members[0]). Empty for a PR design.
  members?: readonly SequenceDiagramMember[];
  // The accessible name of the whole figure.
  label: string;
  // Absent ⇒ steps are not clickable.
  openFile?: OpenFlowFile;
  // A PLANNED flow (the story build): a `pr` is a repository ref (`R1`) with no pull request yet — its
  // chip reads the repository's name from here.
  refNames?: ReadonlyMap<string, string>;
}): JSX.Element {
  const layout = useMemo(() => layoutFlow(flow, members), [flow, members]);
  // Does the figure overflow its pane (a phone, the drawer)? Then say it scrolls.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (el == null || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => setOverflows(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout]);
  const badges = useMemo(() => prBadgeTexts(members), [members]);
  const n = Math.max(1, layout.lanes.length);
  const cols = { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` };
  const chip = (member: SequenceDiagramMember | null, ref: string | null): string | null =>
    member != null ? (badges.get(member.prId) ?? `#${member.number}`) : ref != null ? (refNames?.get(ref) ?? null) : null;
  const kindsDrawn = new Set(layout.rows.map((r) => r.step.kind));
  const lineKey = (Object.keys(LINE_KEY) as FlowStepKind[])
    .filter((k) => kindsDrawn.has(k))
    .map((k) => ({
      key: k,
      label: LINE_KEY[k]!,
      icon: <span className={`inline-block w-6 ${LINE[k]}`} />,
    }));

  return (
    <div role="group" aria-label={label} className="w-full" data-testid="flow-diagram">
      {/* The figure scrolls sideways INSIDE itself when its lanes do not fit (a phone, the drawer). */}
      {overflows && <p className="mb-1 text-meta text-ui-mute">Scroll sideways to see every lane.</p>}
      <div ref={scrollRef} className="overflow-x-auto overscroll-x-contain pb-1" data-testid="flow-scroll">
        <div className="relative" style={{ minWidth: `${n * FLOW_LANE_MIN_REM}rem` }}>
          <ul aria-label="Who touches the data, left to right" className="grid gap-x-2" style={cols}>
            {layout.lanes.map((l) => {
              const word = CHANGE_WORD[l.participant.change];
              const c = chip(l.member, l.participant.pr);
              return (
                <li
                  key={l.participant.id}
                  className={`relative z-10 min-w-0 rounded-ui px-1.5 py-1 text-center ${CARD_CHANGE[l.participant.change]}`}
                >
                  <span className="block text-meta text-ui-mute">{l.kindLabel}</span>
                  <span className="block break-words text-body font-medium leading-snug text-ui-ink">{l.participant.label}</span>
                  {(word != null || c != null) && (
                    <span className="mt-0.5 flex flex-wrap items-center justify-center gap-1">
                      {word != null && (
                        <span
                          className={`inline-flex items-center gap-0.5 text-meta font-semibold ${
                            l.participant.change === 'new' ? 'text-ai-signal' : 'text-ui-ink'
                          }`}
                        >
                          {l.participant.change === 'new' ? <PlusIcon size={10} /> : <PencilIcon size={10} />}
                          {word}
                        </span>
                      )}
                      {c != null && (
                        <span className="whitespace-nowrap rounded-ui border border-ui-line px-1 text-meta text-ui-ink">{c}</span>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          <ol aria-label="Steps, in the order they happen" className="relative mt-1 pb-2">
            {/* Each lane's line down the page. */}
            {layout.lanes.map((l) => (
              <span
                key={l.participant.id}
                aria-hidden
                className="pointer-events-none absolute bottom-0 top-0 border-l border-dashed border-ui-line"
                style={{ left: `${((l.col + 0.5) / n) * 100}%` }}
              />
            ))}
            {layout.rows.map((r) => (
              <StepRow key={r.step.n} row={r} chip={chip(r.member, r.step.pr)} openFile={openFile} />
            ))}
          </ol>
        </div>
      </div>
      <BorderKey
        testId="flow-border-key"
        label="Box borders"
        items={laneChangesPresent(layout).map((k) => ({ key: k, label: CHANGE_KEY_LABEL[k], swatch: CARD_CHANGE[k] }))}
      />
      <BorderKey testId="flow-line-key" label="Arrow lines" items={lineKey} />
    </div>
  );
}

function StepMark({ row }: { row: FlowRow }): JSX.Element {
  const k = row.step.kind;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-ui-raise px-1 text-meta font-semibold text-ui-ink">
        {row.step.n}
      </span>
      <span className={`inline-flex items-center gap-0.5 text-meta font-semibold ${k === 'write' ? 'text-ai-signal' : 'text-ui-ink'}`}>
        {k === 'validate' && <ShieldIcon size={11} />}
        {k === 'write' && <DatabaseIcon size={11} />}
        {row.word}
      </span>
    </span>
  );
}

function StepRow({
  row,
  chip,
  openFile,
}: {
  row: FlowRow;
  chip: string | null;
  openFile?: OpenFlowFile;
}): JSX.Element {
  const files = row.step.files;
  const clickable = openFile != null && files.length > 0;
  const words: ReactNode = (
    <>
      <span className="rounded-ui bg-ui-surface px-0.5 break-words text-body leading-snug text-ui-ink">{row.step.label}</span>
      {chip != null && (
        <span className="ml-1 whitespace-nowrap rounded-ui border border-ui-line px-1 align-middle text-meta text-ui-ink">{chip}</span>
      )}
    </>
  );
  return (
    <li className="relative pt-1.5" data-step={row.step.n} data-kind={row.step.kind}>
      {!clickable && <span className="sr-only">{row.text}</span>}
      <div
        className="relative z-10 flex flex-col items-center px-1 text-center"
        style={{ marginLeft: `${row.label.left}%`, width: `${row.label.width}%` }}
      >
        <span aria-hidden>
          <StepMark row={row} />
        </span>
        {clickable ? (
          <StepFiles row={row} openFile={openFile!}>
            {words}
          </StepFiles>
        ) : (
          <span aria-hidden>{words}</span>
        )}
      </div>
      <Arrow row={row} />
    </li>
  );
}

/** The line, its head, or a loop for a step that stays on its lane. Decorative. */
function Arrow({ row }: { row: FlowRow }): JSX.Element {
  const k = row.step.kind;
  if (row.dir === 'self') {
    const right = row.loopRight;
    const loop = LOOP[k === 'validate' ? 'validate' : 'transform'];
    return (
      <div aria-hidden className="relative h-5">
        <span
          className={`absolute top-0.5 h-3.5 ${loop} ${right ? 'rounded-r-md border-l-0' : 'rounded-l-md border-r-0'}`}
          style={{ left: `${row.arrow.left}%`, width: `${row.arrow.width}%` }}
        />
        <Head kind={k} dir={right ? 'left' : 'right'} style={{ left: `${right ? row.arrow.left : row.arrow.left + row.arrow.width}%`, top: '0.8rem' }} />
      </div>
    );
  }
  const end = row.dir === 'right' ? row.arrow.left + row.arrow.width : row.arrow.left;
  return (
    <div aria-hidden className="relative h-3">
      <span className={`absolute top-1 ${LINE[k]}`} style={{ left: `${row.arrow.left}%`, width: `${row.arrow.width}%` }} />
      <Head kind={k} dir={row.dir} style={{ left: `${end}%`, top: '0.05rem' }} />
    </div>
  );
}

function Head({ kind, dir, style }: { kind: FlowStepKind; dir: 'left' | 'right'; style: CSSProperties }): JSX.Element {
  // The tip sits ON the lane's line: shifted back by its own width when it points right.
  return (
    <svg
      width="9"
      height="10"
      viewBox="0 0 9 10"
      className={`absolute ${HEAD[kind]}`}
      style={{ ...style, transform: dir === 'right' ? 'translateX(-100%)' : undefined }}
    >
      <path d={dir === 'right' ? 'M0 0 L9 5 L0 10 Z' : 'M9 0 L0 5 L9 10 Z'} fill="currentColor" />
    </svg>
  );
}

/** A step's words as a button: one file opens it; several open a short list of them. */
function StepFiles({ row, openFile, children }: { row: FlowRow; openFile: OpenFlowFile; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const files = row.step.files;
  const many = files.length > 1;
  const { refs, floatingStyles, context } = usePlacedFloating({
    open,
    onOpenChange: setOpen,
    strategy: 'fixed',
    placement: 'bottom',
    middleware: [offset(4), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);
  useEffect(() => {
    if (!open) return;
    return claimActivePopover(() => setOpen(false));
  }, [open]);
  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        {...getReferenceProps()}
        aria-label={`${row.text} ${many ? `${files.length} files` : `Open ${files[0]}`}`}
        aria-haspopup={many ? 'true' : undefined}
        aria-expanded={many ? open : undefined}
        aria-controls={many && open ? listId : undefined}
        onClick={() => {
          if (many) setOpen((o) => !o);
          else openFile(row.step, files[0]!);
        }}
        className="max-w-full rounded-ui px-1 underline decoration-ui-mute decoration-dotted underline-offset-4 hover:bg-ui-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
      >
        {children}
      </button>
      {many && open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              {...getFloatingProps({ onClick: (e) => e.stopPropagation() })}
              id={listId}
              data-noactivate
              className="z-[60] max-w-[min(28rem,92vw)] rounded-ui border border-ui-line bg-ui-surface p-1 shadow-lg"
            >
              <ul className="space-y-0.5">
                {files.map((f) => (
                  <li key={f}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        openFile(row.step, f);
                      }}
                      className="hit block w-full break-all rounded-ui px-2 py-1 text-left font-mono text-meta text-ui-ink hover:bg-ui-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
                    >
                      {f}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}
