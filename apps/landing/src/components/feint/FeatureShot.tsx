import type { ReactNode } from 'react';
import { MonoLabel, RailGrid, Section } from './primitives';
import { ShotFrame } from './ShotFrame';

// ---------------------------------------------------------------------------
// A feature section whose screenshot runs the FULL canvas width, under the copy
// rather than beside it.
//
// WHY IT EXISTS. The two-column rail puts a screenshot in a ~500px column. The
// captures are taken at a 1180px viewport, so in that column every one of them
// renders at roughly half size — 12px interface text lands at 6px and the panel
// being described becomes an illegible dark rectangle. That is fine for a shot
// whose job is atmosphere and useless for one whose job is evidence, and on this
// site every shot is evidence: the argument is "here is the actual screen".
//
// At full canvas width (1280px minus two 56px gutters = 1168px) a 1180px capture
// renders at essentially 1:1 and every label on it is readable in the page,
// before anyone clicks Enlarge.
//
// So: narrow crops that fit a column keep the two-column rail; anything with a
// table, a chart row or more than one panel in it comes through here.
// ---------------------------------------------------------------------------

export function FeatureShot({
  rail,
  tone = 'paper',
  divider = 'rule',
  label,
  heading,
  children,
  src,
  alt,
  caption,
  height = 620,
  fit = 'cover',
  note,
}: {
  rail: { n?: string; word: string };
  tone?: 'paper' | 'alt';
  divider?: 'rule' | 'ink' | 'none';
  /** An optional tier line above the heading, e.g. "Pro · $25 per user". */
  label?: string;
  heading: string;
  /** The section's copy. Rendered in the rail column, above the frame. */
  children: ReactNode;
  src: string;
  alt: string;
  caption: string;
  height?: number;
  fit?: 'cover' | 'contain';
  note?: string;
}): JSX.Element {
  return (
    <Section tone={tone} divider={divider}>
      <RailGrid rail={rail} cols="one">
        <div>
          {label && <MonoLabel className="mb-4 text-signal-text">{label}</MonoLabel>}
          <h2 className="mb-6 max-w-[30ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2">
            {heading}
          </h2>
          <div className="max-w-[68ch]">{children}</div>
        </div>
      </RailGrid>
      <ShotFrame
        src={src}
        alt={alt}
        caption={caption}
        height={height}
        fit={fit}
        note={note}
        strong={tone === 'alt'}
        className="mt-10"
      />
    </Section>
  );
}
