import { useState } from 'react';
import type { CSSProperties } from 'react';
import {
  BENCH,
  BOTS,
  BOT_SUMMARY,
  BUDGETS,
  COURTS,
  FLOW,
  OVER_TIME,
  PERIODS,
  PERIOD_SUMMARY,
  SPRINT,
  WHERE,
} from '../../mock/acme';
import type { PeriodGrain, SprintCard, SprintView } from '../../mock/acme';
import { Chip, CourtBar, Group, HBar, MiniTable, MockFrame, MockTabs, Segmented, Stat } from './kit';

// The Reporting and How we measure pages' mocks. Words and numbers:
// src/mock/acme.ts. The app surface each one mirrors: apps/landing/README.md.

const PEOPLE = 'var(--verdigris)';
const AUTOMATION = '#c98a4b';
const SEVERITY = ['#e0707e', '#d98a4e', '#6f95d8', '#6f6c66'];
const SEVERITY_NAMES = ['Critical', 'Major', 'Minor', 'Nit'];

function Legend({ items }: { items: ReadonlyArray<{ label: string; color: string }> }): JSX.Element {
  return (
    <div className="mk-legend">
      {items.map((i) => (
        <span key={i.label}>
          <b style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

// ---- one window: flow metrics ------------------------------------------------

function points(values: number[], max: number, w: number, h: number): string {
  const step = w / (values.length - 1);
  return values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(' ');
}

/** Flow metrics. Each tile opens the pull requests behind its figure, as in the app. */
export function FlowMetricsMock(): JSX.Element {
  const W = 400;
  const H = 90;
  const [open, setOpen] = useState<string | null>(null);
  const tile = FLOW.sprint.find((s) => s.k === open);
  return (
    <MockFrame
      live
      title="Flow metrics"
      meta={`${FLOW.window}, against the same point last sprint`}
      onReset={open ? () => setOpen(null) : null}
      label="Flow metrics for this sprint so far: 19 merged, 2.5 days to merge, 3.6 hours to first review, 84% of checks green at merge; 33 pull requests open now; a 12-week chart of pull requests opened and merged. Each tile opens its pull requests."
    >
      <Group first>This sprint so far</Group>
      <div className="mk-stats">
        {FLOW.sprint.map((s) => (
          <Stat
            key={s.k}
            k={s.k}
            v={s.v}
            d={s.d}
            tone={s.tone}
            pressed={open === s.k}
            onClick={() => setOpen(open === s.k ? null : s.k)}
          />
        ))}
      </div>
      {tile ? (
        <div className="mk-drill" role="region" aria-label={`${tile.k}: the pull requests behind it`}>
          <Group first>{tile.k} · the pull requests behind it</Group>
          <ul className="mk-lines">
            {tile.prs.map((p) => (
              <li key={p}>{p}</li>
            ))}
            <li className="more">and {tile.more} more</li>
          </ul>
        </div>
      ) : null}
      <div className="rp-two">
        <div>
          <Group>Right now</Group>
          <div className="mk-stats">
            {FLOW.now.map((s) => (
              <Stat key={s.k} k={s.k} v={s.v} />
            ))}
          </div>
        </div>
        <div>
          <Group>Last 12 weeks · pull requests opened and merged</Group>
          <svg className="mk-svg" viewBox={`0 0 ${W} ${H + 2}`} aria-hidden="true">
            <line x1="0" y1={H} x2={W} y2={H} stroke="#2c2d33" />
            <polyline points={points(FLOW.opened, 40, W, H)} fill="none" stroke="#6f95d8" strokeWidth="2.5" />
            <polyline points={points(FLOW.merged, 40, W, H)} fill="none" stroke="#4fae95" strokeWidth="2.5" />
          </svg>
          <div className="rp-axis" aria-hidden="true">
            <span>Aug 1</span>
            <span>Oct 17</span>
          </div>
          <Legend
            items={[
              { label: 'Opened', color: '#6f95d8' },
              { label: 'Merged', color: '#4fae95' },
            ]}
          />
        </div>
      </div>
    </MockFrame>
  );
}

// ---- period reports ------------------------------------------------------------

const GRAINS: { id: PeriodGrain; label: string }[] = [
  { id: 'sprint', label: 'Sprint' },
  { id: 'month', label: 'Month' },
];

/** A period report at either grain. Months carry no forecast: they aren't the same length. */
export function PeriodReportMock(): JSX.Element {
  const [grain, setGrain] = useState<PeriodGrain>('sprint');
  const p = PERIODS[grain];
  const forecast = p.rows.some((r) => r.next !== null);
  return (
    <MockFrame
      live
      title={p.name}
      meta={p.grain}
      onReset={grain !== 'sprint' ? () => setGrain('sprint') : null}
      label="A period report, by sprint or by calendar month: the split of merges between people and automation, the biggest movers, and each measure against the period before"
    >
      <Segmented label="Grain" options={GRAINS} value={grain} onChange={setGrain} />
      <Group>People against automation</Group>
      <div className="rp-effort">
        {p.effort.map((e) => (
          <div key={e.k}>
            <span>{e.k}</span>
            <HBar parts={e.parts} colors={[PEOPLE, AUTOMATION]} />
            <b>{e.total}</b>
          </div>
        ))}
      </div>
      <Legend
        items={[
          { label: 'People', color: PEOPLE },
          { label: 'Automation', color: AUTOMATION },
        ]}
      />
      <Group>Biggest movers</Group>
      <div className="mk-chips">
        {p.movers.map((m) => (
          <Chip key={m.k} tone={m.tone}>
            {m.k} {m.d}
          </Chip>
        ))}
      </div>
      <Group>{p.before}</Group>
      <MiniTable
        className="stack"
        cols={[
          { key: 'k', label: 'Measure' },
          { key: 'now', label: grain === 'sprint' ? 'This sprint' : 'This month', num: true },
          { key: 'prior', label: 'Before', num: true },
          { key: 'change', label: 'Change', num: true },
          ...(forecast ? [{ key: 'next', label: 'Next sprint', num: true }] : []),
        ]}
        rows={p.rows.map((r) => ({ _key: r.k, k: r.k, now: <b>{r.now}</b>, prior: r.prior, change: r.change, next: r.next }))}
      />
      {!forecast ? <p className="mk-note">No forecast for calendar months.</p> : null}
    </MockFrame>
  );
}

export function PeriodSummaryMock(): JSX.Element {
  return (
    <MockFrame
      title="Written summary"
      meta={PERIOD_SUMMARY.name}
      label="A sprint report's written summary: what happened, and what to watch"
    >
      <Group first>What happened</Group>
      <ul className="rp-bullets">
        {PERIOD_SUMMARY.happened.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <Group>What to watch</Group>
      <ul className="rp-bullets">
        {PERIOD_SUMMARY.watch.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </MockFrame>
  );
}

// ---- Chronology ------------------------------------------------------------------

const SCALE = 24; // hours across the track; anything past it runs off the end

const pct = (h: number): string => `${(Math.min(h, SCALE) / SCALE) * 100}%`;
const hrs = (h: number): string => `${h}h`;

/**
 * The balance target above the split, as in the app (`ChronologyCharts.tsx` `BalanceTarget`): one
 * triangle, the centre drawn as the target, one marker where the hours sit.
 */
function BalanceMark(): JSX.Element {
  const [rv, au, la] = COURTS.map((c) => c.pct / 100) as [number, number, number];
  const A = { x: 120, y: 22 };
  const B = { x: 30, y: 22 + 180 * 0.866 };
  const C = { x: 210, y: 22 + 180 * 0.866 };
  const t = rv + au + la;
  const at = (r: number, a: number, l: number): { x: number; y: number } => ({
    x: (r * A.x + a * B.x + l * C.x) / t,
    y: (r * A.y + a * B.y + l * C.y) / t,
  });
  const mid = { x: (A.x + B.x + C.x) / 3, y: (A.y + B.y + C.y) / 3 };
  const m = at(rv, au, la);
  const R = 180 / Math.sqrt(3);
  return (
    <div className="rp-balance">
      <p className="v">Balanced</p>
      <svg viewBox="0 0 240 200" width="240" aria-hidden="true">
        <path d={`M${A.x},${A.y} L${B.x},${B.y} L${C.x},${C.y} Z`} className="tri" />
        <circle cx={mid.x} cy={mid.y} r={0.35 * R} className="outer" />
        <circle cx={mid.x} cy={mid.y} r={0.15 * R} className="inner" />
        {[A, B, C].map((v, i) => (
          <circle key={i} cx={v.x} cy={v.y} r={4} style={{ fill: COURTS[i]!.color }} />
        ))}
        <text x={A.x} y={A.y - 9} textAnchor="middle">With reviewer</text>
        <text x={B.x - 4} y={B.y + 17} textAnchor="start">With author</text>
        <text x={C.x + 4} y={C.y + 17} textAnchor="end">Waiting to merge</text>
        <line x1={mid.x} y1={mid.y} x2={m.x} y2={m.y} className="pull" />
        <circle cx={m.x} cy={m.y} r={6} className="mark" />
      </svg>
    </div>
  );
}

/** As in the app (`ChronologyCharts.tsx` `FirstReviewTrend`): 12 weeks, one green line. */
const FIRST_REVIEW_WEEKS = [3, 4, 3, 5, 4, 6, 5, 6, 7, 6, 8, 5];

function FirstReviewLine(): JSX.Element {
  const max = 10;
  const x = (i: number): number => 8 + (i * 224) / (FIRST_REVIEW_WEEKS.length - 1);
  const y = (v: number): number => 62 - (v / max) * 54;
  const d = FIRST_REVIEW_WEEKS.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('');
  return (
    <div className="rp-first-line">
      <p className="t">Approved on the first review, last 12 weeks</p>
      <svg viewBox="0 0 240 70" width="240" aria-hidden="true">
        <path d={d} />
        {FIRST_REVIEW_WEEKS.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r={2.5} className={i === FIRST_REVIEW_WEEKS.length - 1 ? 'now' : ''} />
        ))}
      </svg>
    </div>
  );
}

/** Chronology: each wait's row opens the figures behind its verdict. */
export function ChronologyMock(): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <MockFrame
      live
      title="Chronology"
      meta="This sprint · working hours, Monday to Friday, 09:00–17:30"
      onReset={open ? () => setOpen(null) : null}
      label="Chronology: balanced, 36% of working hours waiting for a reviewer, 31% waiting for the author, 33% approved and waiting to merge; first look, approved to merged and opened to merged are past their limits, reply to review is acceptable. Each wait opens its figures."
    >
      <Group first>Where the working hours went</Group>
      <div className="rp-balance-row">
        <div className="rp-panel">
          <BalanceMark />
        </div>
        <div className="rp-panel rp-first-panel">
          <div className="rp-first">
            <p className="n">23</p>
            <p className="l">approved on the first review</p>
            <p className="d">of 41 merged pull requests</p>
          </div>
          <FirstReviewLine />
        </div>
      </div>
      <CourtBar showPct segments={COURTS} />
      <Group>Each wait against its time budget</Group>
      <div className="rp-budgets">
        {BUDGETS.map((b) => {
          const on = open === b.wait;
          return (
            <div key={b.wait} className={on ? 'rp-budget open' : 'rp-budget'}>
              <button type="button" className="h" aria-expanded={on} onClick={() => setOpen(on ? null : b.wait)}>
                <span>{b.wait}</span>
                <Chip tone={b.tone}>{b.verdict}</Chip>
              </button>
              <div
                className="track"
                style={{ '--b': pct(b.budget), '--l': pct(b.limit) } as CSSProperties}
              >
                <i className="most" style={{ width: pct(b.most) }} />
                <i className="half" style={{ left: pct(b.half) }} />
                <i className="budget" style={{ left: pct(b.budget) }} />
              </div>
              {on ? (
                <p className="rp-why">
                  Budget {hrs(b.budget)}, limit {hrs(b.limit)}. Half of {b.n} pull requests finished within {hrs(b.half)}; three
                  in four within {hrs(b.most)}.
                </p>
              ) : null}
            </div>
          );
        })}
        <div className="rp-axis" aria-hidden="true">
          <span>0h</span>
          <span>8h</span>
          <span>16h</span>
          <span>24h+</span>
        </div>
      </div>
      <Legend
        items={[
          { label: 'Within budget', color: '#21483f' },
          { label: 'Acceptable', color: '#4a3d1e' },
          { label: 'Past limit', color: '#4a252c' },
          { label: 'Three in four finished', color: '#e7e5df' },
        ]}
      />
    </MockFrame>
  );
}

const VERDICT_COLOR: Record<string, string> = { g: '#2f6e5f', a: '#b48a35', r: '#b0505d', n: '#2c2d33' };

/** Chronology over time. The marker chips switch their markers on and off, as in the app. */
export function OverTimeMock(): JSX.Element {
  const W = 420;
  const H = 100;
  const TOP = 14; // room above the bars for the markers
  const n = OVER_TIME.shares.length;
  const colW = W / n;
  const all = OVER_TIME.markers.map((m) => m.id);
  const [shown, setShown] = useState<string[]>(all);
  const toggle = (id: string): void =>
    setShown((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <MockFrame
      live
      title="Over time"
      meta="Last 26 weeks"
      onReset={shown.length !== all.length ? () => setShown(all) : null}
      label="Chronology over time: where the working hours went each week, each wait against its budget week by week, and markers for repositories joining, new bots, new contributors and setting changes, each of which can be shown or hidden"
    >
      <div className="mk-chips" role="group" aria-label="Show markers" style={{ marginBottom: 6 }}>
        {OVER_TIME.markers.map((m) => (
          <button
            key={m.id}
            type="button"
            className="mk-toggle"
            aria-pressed={shown.includes(m.id)}
            onClick={() => toggle(m.id)}
          >
            <b style={{ background: m.color }} aria-hidden="true" />
            {m.k} {m.weeks.length}
          </button>
        ))}
      </div>
      <Group>Where the working hours went</Group>
      <svg className="mk-svg" viewBox={`0 0 ${W} ${H + TOP}`} aria-hidden="true">
        {OVER_TIME.shares.map((s, i) => {
          let y = H + TOP;
          return (
            <g key={i}>
              {s.map((share, j) => {
                const h = (share / 100) * H;
                y -= h;
                return (
                  <rect key={j} x={i * colW + 1} y={y} width={colW - 2} height={h} fill={COURTS[j]?.color ?? '#555'} />
                );
              })}
            </g>
          );
        })}
        {OVER_TIME.markers
          .filter((m) => shown.includes(m.id))
          .map((m, k) =>
            m.weeks.map((w) => (
              <circle key={`${m.id}${w}`} cx={w * colW + colW / 2 + (k - 1.5) * 4} cy={6} r={3.5} fill={m.color} />
            )),
          )}
      </svg>
      <div className="rp-weeks" style={{ '--n': n } as CSSProperties} aria-hidden="true">
        {OVER_TIME.weeks.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>
      <Legend items={COURTS.map((c) => ({ label: c.label, color: c.color }))} />
      <Group>Each wait against its budget</Group>
      <div className="rp-heat">
        {BUDGETS.map((b, r) => (
          <div key={b.wait} className="row">
            <span>{b.wait}</span>
            <div className="cells" style={{ '--n': n } as CSSProperties}>
              {(OVER_TIME.verdicts[r] ?? []).map((v, i) => (
                <i key={i} style={{ background: VERDICT_COLOR[v] }} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <Legend
        items={[
          { label: 'Within budget', color: VERDICT_COLOR.g ?? '' },
          { label: 'Acceptable', color: VERDICT_COLOR.a ?? '' },
          { label: 'Past limit', color: VERDICT_COLOR.r ?? '' },
          { label: 'Too few to judge', color: '#4a4b50' },
        ]}
      />
    </MockFrame>
  );
}

// ---- where the work is happening ------------------------------------------------

export function WhereWorkMock(): JSX.Element {
  const maxOpened = Math.max(...WHERE.map((w) => w.people + w.bots));
  const maxReach = Math.max(...WHERE.map((w) => w.low + w.med + w.high));
  return (
    <div className="rp-where">
      <MockFrame
        title="Activity by repository"
        meta="This sprint so far"
        label="Activity by repository: pull requests opened by people and by automation, and lines changed, for acme/payments, acme/web, acme/api and acme/ledger, whose size is unknown"
      >
        <MiniTable
          className="stack"
          cols={[
            { key: 'repo', label: 'Repository' },
            { key: 'opened', label: 'Opened' },
            { key: 'lines', label: 'Lines changed' },
          ]}
          rows={WHERE.map((w) => ({
            _key: w.repo,
            repo: w.repo,
            opened: (
              <span className="rp-cell">
                <HBar
                  parts={[(w.people / maxOpened) * 100, (w.bots / maxOpened) * 100]}
                  colors={[PEOPLE, AUTOMATION]}
                />
                <b>{w.people + w.bots}</b>
              </span>
            ),
            lines:
              w.lines === null ? (
                <span className="rp-unknown">size unknown</span>
              ) : (
                <span className="rp-cell">
                  <HBar parts={[w.linesPct]} colors={['#6f95d8']} />
                  <b>{w.lines}</b>
                </span>
              ),
          }))}
        />
        <Legend
          items={[
            { label: 'People', color: PEOPLE },
            { label: 'Automation', color: AUTOMATION },
            { label: 'Lines changed', color: '#6f95d8' },
          ]}
        />
      </MockFrame>
      <MockFrame
        title="Reach by repository"
        meta="Merged pull requests"
        label="Reach by repository: how many merged pull requests in each repository could reach little, some or much of the code"
      >
        <MiniTable
          className="stack"
          cols={[
            { key: 'repo', label: 'Repository' },
            { key: 'bar', label: 'Merged' },
            { key: 'low', label: 'Low', num: true },
            { key: 'med', label: 'Medium', num: true },
            { key: 'high', label: 'High', num: true },
          ]}
          rows={WHERE.map((w) => ({
            _key: w.repo,
            repo: w.repo,
            bar: (
              <HBar
                parts={[w.low, w.med, w.high].map((x) => (x / maxReach) * 100)}
                colors={['#6f95d8', '#c98fa0', '#d98a4e']}
              />
            ),
            low: w.low,
            med: w.med,
            high: w.high,
          }))}
        />
        <Legend
          items={[
            { label: 'Low', color: '#6f95d8' },
            { label: 'Medium', color: '#c98fa0' },
            { label: 'High', color: '#d98a4e' },
          ]}
        />
      </MockFrame>
    </div>
  );
}

// ---- bots ----------------------------------------------------------------------------

/** Bots Monitoring. A bot's row opens what Limn's model made of its comments. */
export function BotsSeverityMock(): JSX.Element {
  const [sel, setSel] = useState<string | null>(null);
  const b = BOTS.find((x) => x.bot === sel);
  return (
    <MockFrame
      live
      title="What the bots are flagging"
      meta="graded by Limn's model"
      onReset={sel ? () => setSel(null) : null}
      label="Bots Monitoring: 502 findings, 49% high severity, 30% nits, mostly about correctness; a row per bot with threads, share used, not addressed and severity mix. Each bot's row opens its breakdown."
    >
      <div className="mk-stats">
        {BOT_SUMMARY.map((s) => (
          <Stat key={s.k} k={s.k} v={s.v} d={s.d} />
        ))}
      </div>
      <Group>A row per bot</Group>
      <MiniTable
        className="stack"
        selected={sel}
        onSelect={(k) => setSel(sel === k ? null : k)}
        cols={[
          { key: 'bot', label: 'Bot' },
          { key: 'threads', label: 'Threads', num: true },
          { key: 'used', label: 'Used', num: true },
          { key: 'open', label: 'Not addressed', num: true },
          { key: 'mix', label: 'Severity mix' },
          { key: 'high', label: 'High', num: true },
        ]}
        rows={BOTS.map((x) => ({
          _key: x.bot,
          bot: x.bot,
          threads: x.threads,
          used: x.used,
          open: x.open,
          mix: <HBar parts={x.mix} colors={SEVERITY} />,
          high: x.high,
        }))}
      />
      {b ? (
        <div className="mk-detail" role="status">
          <b>{b.bot}</b>: {b.threads} threads. Your team used {b.used}; {b.open} were not addressed. Top topic:{' '}
          {b.topic}.
          <div className="mk-chips" style={{ marginTop: 6 }}>
            {SEVERITY_NAMES.map((name, i) => (
              <Chip key={name} tone={i === 0 ? 'red' : i === 1 ? 'amber' : i === 2 ? 'blue' : 'grey'}>
                {name} {b.mix[i]}%
              </Chip>
            ))}
          </div>
        </div>
      ) : null}
      <Legend items={SEVERITY_NAMES.map((label, i) => ({ label, color: SEVERITY[i] ?? '' }))} />
    </MockFrame>
  );
}

export function BenchmarkMock(): JSX.Element {
  return (
    <MockFrame
      title={BENCH.bot}
      meta={BENCH.live}
      label="CodeRabbit's cost card: US$30 a month, 51 cents per merged pull request, 45 cents per comment the team used; the team used 52% of what it said where teams with similar repos used 74%; each repository's size group and acted-on rate"
    >
      <div className="rp-cost">
        {BENCH.cost.map((c) => (
          <div key={c.k}>
            <span>{c.k}</span>
            <b>{c.v}</b>
            <Chip>{c.src}</Chip>
          </div>
        ))}
      </div>
      <p className="rp-line">{BENCH.line}</p>
      <Group>Where these numbers come from</Group>
      <MiniTable
        className="stack"
        cols={[
          { key: 'repo', label: 'Repository' },
          { key: 'band', label: 'Size group' },
          { key: 'acted', label: 'Acted on', num: true },
        ]}
        rows={BENCH.repos.map((r) => ({ _key: r.repo, ...r }))}
      />
    </MockFrame>
  );
}

// ---- This Sprint ------------------------------------------------------------------------

type Lane = { name: string; cards: SprintCard[] };

/** One lane board, three views: rows by theme, by critical path, or by person. */
function lanesFor(view: SprintView): Lane[] {
  const by = (key: (c: SprintCard) => string | null): Lane[] => {
    const out: Lane[] = [];
    for (const c of SPRINT.cards) {
      const name = key(c);
      if (name === null) continue;
      const lane = out.find((l) => l.name === name);
      if (lane) lane.cards.push(c);
      else out.push({ name, cards: [c] });
    }
    return out;
  };
  if (view === 'paths') {
    return by((c) => (c.path ? `Path ${c.path}` : null)).sort((a, b) => a.name.localeCompare(b.name));
  }
  if (view === 'people') return by((c) => c.who).sort((a, b) => a.name.localeCompare(b.name));
  return by((c) => c.theme);
}

function SprintCardBox({ card }: { card: SprintCard }): JSX.Element {
  return (
    <div className={`card${card.path ? (card.waiting ? ' wait' : ' path') : ''}`} data-col={SPRINT.columns[card.col]}>
      <span className="key">
        {card.key}
        {card.path ? <em>{card.path}</em> : null}
      </span>
      <span className="ti">{card.title}</span>
      <span className="cr">{card.criteria}</span>
      <Chip>{card.who}</Chip>
    </div>
  );
}

export function SprintLanesMock(): JSX.Element {
  const [view, setView] = useState<SprintView>('themes');
  const lanes = lanesFor(view);
  return (
    <MockFrame
      live
      title={SPRINT.name}
      meta={SPRINT.meta}
      onReset={view !== 'themes' ? () => setView('themes') : null}
      label="This Sprint: one lane board by theme, critical path or person, with status columns from not started to product review, ticket cards with criteria and assignee, and numbered critical-path links"
    >
      <MockTabs label="This Sprint views" tabs={SPRINT.views} value={view} onChange={setView}>
        <div className="rp-lanes">
          <div className="hd" aria-hidden="true">
            <span />
            {SPRINT.columns.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          {lanes.map((lane) => (
            <div key={lane.name} className="lane">
              <b className="theme">{lane.name}</b>
              {SPRINT.columns.map((_, col) => {
                const here = lane.cards.filter((c) => c.col === col);
                return here.length > 0 ? (
                  <div key={col} className="cell">
                    {here.map((c) => (
                      <SprintCardBox key={c.key} card={c} />
                    ))}
                  </div>
                ) : (
                  <span key={col} className="empty" />
                );
              })}
            </div>
          ))}
        </div>
      </MockTabs>
      <Legend
        items={[
          { label: 'On a critical path', color: 'var(--gold)' },
          { label: 'On a path and waiting', color: '#8a7240' },
        ]}
      />
    </MockFrame>
  );
}
