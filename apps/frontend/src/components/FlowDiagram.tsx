// THE DATA-FLOW DIAGRAM (docs/FRONTEND.md § Design diagrams): how data moves through a change (or a
// whole story), as a SEQUENCE — who touches the data across the top, the numbered steps down the page,
// in the order they happen. The ONE renderer of a stored `FlowDiagram`; the Claude Review tab's Design
// section, the story view's Story design and the story build's planned design all draw it. (Rows drawn
// before it hold the older grid, which `DesignGrid` still draws.)
//
//   LAYOUT   lanes are equal columns, never narrower than FLOW_LANE_MIN_REM (12rem, so a lane card's
//            name and PR chip are never clipped and a step label wraps at most ~2 lines, capped at
//            26rem): a wide flow scrolls SIDEWAYS INSIDE THE FIGURE, never the page. The lane cards are
//            their own box, STICKY to the top of the scroll pane while the steps go by, and carry the
//            visible scrollbar; the steps' box (a focusable region with a name when it overflows) and
//            the cards share one sideways position, so the arrows stay under their lanes. Each lane has
//            a dashed line down the page; each step is a row whose BOX sits centred between the two
//            lanes' lines (lib/dataFlow.ts computes every span as a percentage).
//   STEPS    a BOX each (a thin grey border, the lane cards' corners): a numbered badge, the step's WORD
//            (Read, Check, Transform, Write, Call, Emit, Return), its PR chip, and what data passes. The
//            arrow runs from the source lane's line to the box's edge and from the box's other edge to
//            the target lane's line, its head on that line. A step that stays on one lane is a box
//            beside it with a loop out to the box and back. Kind is never colour alone: a Check is a
//            dotted line with a shield and the word; a Write a heavy line with a cylinder and the
//            word; a Return a dashed line. A visible key names the line styles drawn. Lines and heads
//            are SVG in boxes of one height, so every head sits on its line at any zoom (`ArrowLine`).
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
import { FLOW_LANE_MIN_REM, FLOW_LANE_MIN_REM_PHONE, FLOW_PHONE_BOX_PX, laneChangesPresent, layoutFlow, type FlowRow } from '../lib/dataFlow.js';
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

// THE ARROWS. A line and its head are drawn in SVG, in boxes of ONE height (SEG_PX) whose centre is the
// line's centre, so the head's tip sits exactly on the line at any zoom: CSS borders snap to device
// pixels and SVG does not, which is what set the old heads a pixel or two off their lines. The line
// stops under the head's base (HEAD_OVERLAP_PX in), never at the tip, so a heavy line cannot poke out
// beside it. Kind is never colour alone: the stroke differs too, and the word is printed in the box.
const SEG_PX = 12;
const HEAD_OVERLAP_PX = 1;
interface Stroke {
  width: number;
  dash?: string;
  cap?: 'round' | 'butt';
}
const STROKE: Record<FlowStepKind, Stroke> = {
  read: { width: 1.5 },
  validate: { width: 2, dash: '0 4', cap: 'round' }, // dotted
  transform: { width: 1.5 },
  write: { width: 3 }, // heavy
  call: { width: 1.5 },
  emit: { width: 1.5 },
  return: { width: 1.5, dash: '5 4' }, // dashed
};
// Head length × height, px: a heavy line gets a larger head so it still covers the line's end.
const HEAD_PX: Record<FlowStepKind, { w: number; h: number }> = {
  read: { w: 8, h: 10 },
  validate: { w: 8, h: 10 },
  transform: { w: 8, h: 10 },
  write: { w: 10, h: 12 },
  call: { w: 8, h: 10 },
  emit: { w: 8, h: 10 },
  return: { w: 8, h: 10 },
};
// Line and head colour (the SVG's currentColor).
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
  stickyClassName = 'bg-ui-surface',
}: {
  flow: FlowDiagram;
  // The sticky lane cards' ground: the tone the figure sits on, so steps scrolling under it are hidden.
  stickyClassName?: string;
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
  // Does the figure overflow its pane (a phone, the drawer, a story with many lanes)? Then say it
  // scrolls, and make the steps a keyboard-scrollable region.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  // A phone-sized box draws narrower lanes (a 12rem lane is most of a 390px screen).
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (el == null || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      setOverflows(el.scrollWidth > el.clientWidth + 1);
      setPhone(el.clientWidth > 0 && el.clientWidth < FLOW_PHONE_BOX_PX);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout]);
  // The lane cards and the steps are two boxes (the cards stick to the top of the pane while the
  // steps scroll by): they share ONE sideways position, whichever of them is scrolled.
  const sync = (from: HTMLDivElement | null, to: HTMLDivElement | null): void => {
    if (from == null || to == null || to.scrollLeft === from.scrollLeft) return;
    to.scrollLeft = from.scrollLeft;
  };
  const badges = useMemo(() => prBadgeTexts(members), [members]);
  const n = Math.max(1, layout.lanes.length);
  const cols = { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` };
  const inner = { minWidth: `${n * (phone ? FLOW_LANE_MIN_REM_PHONE : FLOW_LANE_MIN_REM)}rem` };
  const chip = (member: SequenceDiagramMember | null, ref: string | null): string | null =>
    member != null ? (badges.get(member.prId) ?? `#${member.number}`) : ref != null ? (refNames?.get(ref) ?? null) : null;
  const kindsDrawn = new Set(layout.rows.map((r) => r.step.kind));
  const lineKey = (Object.keys(LINE_KEY) as FlowStepKind[])
    .filter((k) => kindsDrawn.has(k))
    .map((k) => ({
      key: k,
      label: LINE_KEY[k]!,
      icon: (
        <span className="relative inline-block w-6" style={{ height: SEG_PX }}>
          <LineSvg kind={k} style={{ left: 0, right: 0 }} />
        </span>
      ),
    }));

  return (
    <div role="group" aria-label={label} className="w-full" data-testid="flow-diagram">
      {/* The figure scrolls sideways INSIDE itself when its lanes do not fit (a phone, the drawer). */}
      {overflows && <p className="mb-1 text-meta text-ui-mute">Scroll sideways to see every lane.</p>}
      {/* The lane cards STICK to the top of the scroll pane while the steps go by, and carry the
          figure's visible scrollbar (the steps' own box can be far taller than the screen). */}
      <div className={`sticky top-0 z-20 ${stickyClassName}`} data-testid="flow-lanes">
        <div
          ref={headRef}
          onScroll={() => sync(headRef.current, scrollRef.current)}
          className={`overscroll-x-contain ${overflows ? 'scroll-x-visible overflow-x-auto pb-1' : 'overflow-x-hidden'}`}
        >
          <ul aria-label="Who touches the data, left to right" className="grid gap-x-2 py-1" style={{ ...cols, ...inner }}>
            {layout.lanes.map((l) => {
              const word = CHANGE_WORD[l.participant.change];
              const c = chip(l.member, l.participant.pr);
              return (
                <li
                  key={l.participant.id}
                  className={`relative z-10 min-w-0 rounded-ui px-2 py-1 text-center ${CARD_CHANGE[l.participant.change]}`}
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
                        <span className="max-w-full break-words rounded-ui border border-ui-line px-1 text-meta text-ui-ink">{c}</span>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={() => sync(scrollRef.current, headRef.current)}
        // Overflowing, the steps are a named region a keyboard can focus and scroll with the arrow keys.
        {...(overflows ? { role: 'region', tabIndex: 0, 'aria-label': `${label}: scrolls sideways` } : {})}
        className="scroll-x-hidden overflow-x-auto overscroll-x-contain rounded-ui pb-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
        data-testid="flow-scroll"
      >
        <div className="relative" style={inner}>
          <ol aria-label="Steps, in the order they happen" className="relative pb-2">
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
              <StepRow key={r.step.n} row={r} chip={chip(r.member, r.step.pr)} openFile={openFile} phone={phone} />
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

// THE STEP ROW: the step's BOX (number, word, PR chip, what passes) centred in its span, the arrow in
// two parts — from one lane's line to the box's edge, and from the box's other edge to the other lane's
// line, its head on that line. The box sits on the arrow's line (vertically centred), so the arrow
// visibly starts and ends on it. A step in place: the box beside its lane, a loop out of the lane's
// line into the box (above) and back out of it to the line (below, the head on the line).
function StepRow({
  row,
  chip,
  openFile,
  phone,
}: {
  row: FlowRow;
  chip: string | null;
  openFile?: OpenFlowFile;
  phone: boolean;
}): JSX.Element {
  const files = row.step.files;
  const k = row.step.kind;
  const clickable = openFile != null && files.length > 0;
  const words: ReactNode = <span className="break-words text-body leading-snug text-ui-ink">{row.step.label}</span>;
  const box = (
    <div
      className={`relative z-10 min-w-0 max-w-[26rem] shrink rounded-ui border border-ui-line bg-ui-surface text-center ${
        phone ? 'px-1 py-1' : 'px-2 py-1'
      }`}
      style={{ flex: '0 1 auto' }}
      data-testid="flow-step-box"
    >
      <span aria-hidden className="flex flex-wrap items-center justify-center gap-1">
        <StepMark row={row} />
        {chip != null && (
          <span className="max-w-full break-words rounded-ui border border-ui-line px-1 text-meta text-ui-ink">{chip}</span>
        )}
      </span>
      {/* A label wraps at a reading width (the box's max), never wider. */}
      <div className="mt-0.5">
        {clickable ? (
          <StepFiles row={row} openFile={openFile!}>
            {words}
          </StepFiles>
        ) : (
          <span aria-hidden>{words}</span>
        )}
      </div>
    </div>
  );
  let drawing: ReactNode;
  if (row.dir === 'self') {
    const stubs = <LoopStubs kind={k} laneOnLeft={row.loopRight} />;
    drawing = row.loopRight ? (
      <>
        {stubs}
        {box}
      </>
    ) : (
      <>
        {box}
        {stubs}
      </>
    );
  } else {
    drawing = (
      <>
        <Segment kind={k} head={row.dir === 'left' ? 'start' : null} phone={phone} />
        {box}
        <Segment kind={k} head={row.dir === 'right' ? 'end' : null} phone={phone} />
      </>
    );
  }
  return (
    <li className="relative pt-2" data-step={row.step.n} data-kind={k} data-dir={row.dir}>
      {!clickable && <span className="sr-only">{row.text}</span>}
      <div
        className={`flex items-stretch ${row.dir === 'self' ? (row.loopRight ? 'justify-start pr-3' : 'justify-end pl-3') : ''}`}
        style={{ marginLeft: `${row.span.left}%`, width: `${row.span.width}%` }}
      >
        {drawing}
      </div>
    </li>
  );
}

/**
 * One part of a step's arrow: a line across its flex share, at the row's middle, with the head at
 * `head` ('start' = pointing left at its left end, 'end' = pointing right at its right end). The
 * part's outer ends ARE the lane line and the box edge, so nothing needs measuring.
 */
function Segment({ kind, head, phone }: { kind: FlowStepKind; head: 'start' | 'end' | null; phone: boolean }): JSX.Element {
  // Never shorter than a head and a visible stub of line (a phone's narrower lanes: a shorter stub).
  return (
    <span aria-hidden className={`relative block flex-1 self-center ${phone ? 'min-w-[0.875rem]' : 'min-w-[1.25rem]'}`} style={{ height: SEG_PX }} data-testid="flow-seg">
      <ArrowLine kind={kind} head={head} />
    </span>
  );
}

/** A loop for a step in place: out of the lane's line into the box, and back to the line with the head. */
function LoopStubs({ kind, laneOnLeft }: { kind: FlowStepKind; laneOnLeft: boolean }): JSX.Element {
  // The head points back at the lane: at the stub's left end when the lane is on the left.
  return (
    <span aria-hidden className="relative block w-6 shrink-0 self-stretch" data-testid="flow-loop">
      <span className="absolute inset-x-0" style={{ top: `calc(0.55rem - ${SEG_PX / 2}px)`, height: SEG_PX }}>
        <ArrowLine kind={kind} head={null} />
      </span>
      <span className="absolute inset-x-0" style={{ bottom: `calc(0.55rem - ${SEG_PX / 2}px)`, height: SEG_PX }}>
        <ArrowLine kind={kind} head={laneOnLeft ? 'start' : 'end'} />
      </span>
    </span>
  );
}

/** The line and its head inside a SEG_PX-high box (the caller sizes and places the box). */
function ArrowLine({ kind, head }: { kind: FlowStepKind; head: 'start' | 'end' | null }): JSX.Element {
  const hp = HEAD_PX[kind];
  const inset = head != null ? hp.w - HEAD_OVERLAP_PX : 0;
  return (
    <>
      <LineSvg kind={kind} style={{ left: head === 'start' ? inset : 0, right: head === 'end' ? inset : 0 }} />
      {head != null && <HeadSvg kind={kind} dir={head === 'end' ? 'right' : 'left'} />}
    </>
  );
}

/** A horizontal line through the middle of a SEG_PX-high box, in the kind's stroke. */
function LineSvg({ kind, style }: { kind: FlowStepKind; style: CSSProperties }): JSX.Element {
  const st = STROKE[kind];
  const y = SEG_PX / 2;
  return (
    // An svg ignores left + right (it is a replaced element), so a span takes them and the svg fills it.
    <span aria-hidden className={`absolute top-0 block ${HEAD[kind]}`} style={{ ...style, height: SEG_PX }}>
      <svg focusable="false" className="block h-full w-full overflow-visible">
        <line
          x1={st.cap === 'round' ? st.width / 2 : 0}
          y1={y}
          x2="100%"
          y2={y}
          stroke="currentColor"
          strokeWidth={st.width}
          strokeLinecap={st.cap ?? 'butt'}
          {...(st.dash != null ? { strokeDasharray: st.dash } : {})}
        />
      </svg>
    </span>
  );
}

/** The head: its tip exactly at the box's end and on the line's centre (both are y = SEG_PX / 2). */
function HeadSvg({ kind, dir }: { kind: FlowStepKind; dir: 'left' | 'right' }): JSX.Element {
  const { w, h } = HEAD_PX[kind];
  const top = (SEG_PX - h) / 2;
  const d = dir === 'right' ? `M0 ${top} L${w} ${SEG_PX / 2} L0 ${top + h} Z` : `M${w} ${top} L0 ${SEG_PX / 2} L${w} ${top + h} Z`;
  return (
    <svg
      aria-hidden
      focusable="false"
      width={w}
      height={SEG_PX}
      viewBox={`0 0 ${w} ${SEG_PX}`}
      className={`absolute top-0 ${HEAD[kind]}`}
      style={dir === 'right' ? { right: 0 } : { left: 0 }}
      data-testid="flow-head"
    >
      <path d={d} fill="currentColor" />
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
