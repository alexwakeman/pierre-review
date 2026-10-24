import type { CSSProperties } from 'react';

// "Faster reviews, fewer bottlenecks": the measured before/after bars from the
// Chronology report, with the source line. Figures are the approved copy, verbatim.

type Bar = { label: string; value: string; w: string; c: string };

const MEDIAN: Bar[] = [
  { label: 'September', value: 'about 7 h', w: '100%', c: '#4a4b50' },
  { label: 'Week of 19 Oct', value: '42 min', w: '10%', c: 'var(--verdigris)' },
];

const PER_WEEK: Bar[] = [
  { label: 'September', value: '20', w: '42%', c: '#4a4b50' },
  { label: 'October', value: '44', w: '100%', c: 'var(--lapis)' },
];

function Bars({ bars }: { bars: Bar[] }) {
  return (
    <div className="courts">
      {bars.map((b) => (
        <div key={b.label} style={{ '--w': b.w, '--c': b.c } as CSSProperties}>
          <span>{b.label}</span>
          <b>{b.value}</b>
        </div>
      ))}
    </div>
  );
}

export function Velocity() {
  return (
    <section className="section board flow" aria-labelledby="v-h">
      <div className="tile v-txt rise">
        <h2 id="v-h">Faster reviews, fewer bottlenecks</h2>
        <p>
          On a nine-repository delivery team, Limn took over the reviews in October. Half of their pull requests now
          merge within an hour of working time, and twice as many land each week. It cost them nothing extra.
        </p>
        <p className="src">
          Measured by Limn's Chronology report: merged pull requests by people, working hours, September vs the week of
          19 October 2026.
        </p>
      </div>
      <div className="tile v-ui rise" data-ui>
        <div className="ui-k">Half of pull requests merged within</div>
        <Bars bars={MEDIAN} />
        <div className="ui-k" style={{ marginTop: 28 }}>
          Pull requests merged per week
        </div>
        <Bars bars={PER_WEEK} />
      </div>
    </section>
  );
}
