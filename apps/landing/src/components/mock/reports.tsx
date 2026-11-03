import type { CSSProperties } from 'react';
import {
  BENCH,
  BOTS,
  BOT_SUMMARY,
  BUDGETS,
  COURTS,
  FLOW,
  OVER_TIME,
  PERIOD,
  SPRINT,
  WHERE,
} from '../../mock/acme';
import { Chip, CourtBar, Group, HBar, MiniTable, MockFrame, Stat } from './kit';

// The Reporting and How we measure pages' mocks. Words and numbers:
// src/mock/acme.ts. Each replaces a screenshot that was hard to read on a phone.

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

export function FlowMetricsMock(): JSX.Element {
  const W = 400;
  const H = 90;
  return (
    <MockFrame
      title="Flow metrics"
      meta={`${FLOW.window}, against the same point last sprint`}
      label="Flow metrics for this sprint so far: 19 merged, 2.5 days to merge, 3.6 hours to first review, 84% of checks green at merge; 33 pull requests open now; a 12-week chart of pull requests opened and merged"
    >
      <Group first>This sprint so far</Group>
      <div className="mk-stats">
        {FLOW.sprint.map((s) => (
          <Stat key={s.k} k={s.k} v={s.v} d={s.d} tone={s.tone} />
        ))}
      </div>
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

export function PeriodReportMock(): JSX.Element {
  return (
    <MockFrame
      title={PERIOD.name}
      meta={PERIOD.grain}
      label="A sprint report for 1 to 15 October: 57% of merges by people and 43% by automation, the biggest movers, and each measure against the sprint before with a forecast"
    >
      <Group first>People against automation</Group>
      <div className="rp-effort">
        {PERIOD.effort.map((e) => (
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
        {PERIOD.movers.map((m) => (
          <Chip key={m.k} tone={m.tone}>
            {m.k} {m.d}
          </Chip>
        ))}
      </div>
      <Group>Against the sprint before</Group>
      <MiniTable
        className="stack"
        cols={[
          { key: 'k', label: 'Measure' },
          { key: 'now', label: 'This sprint', num: true },
          { key: 'prior', label: 'Before', num: true },
          { key: 'change', label: 'Change', num: true },
          { key: 'next', label: 'Next sprint', num: true },
        ]}
        rows={PERIOD.rows.map((r) => ({ _key: r.k, ...r, now: <b>{r.now}</b> }))}
      />
    </MockFrame>
  );
}

export function PeriodSummaryMock(): JSX.Element {
  return (
    <MockFrame
      title="Written summary"
      meta={PERIOD.name}
      label="A sprint report's written summary: what happened, and what to watch"
    >
      <Group first>What happened</Group>
      <ul className="rp-bullets">
        {PERIOD.summary.happened.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <Group>What to watch</Group>
      <ul className="rp-bullets">
        {PERIOD.summary.watch.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </MockFrame>
  );
}

// ---- Chronology ------------------------------------------------------------------

const SCALE = 24; // hours across the track; anything past it runs off the end

const pct = (h: number): string => `${(Math.min(h, SCALE) / SCALE) * 100}%`;

export function ChronologyMock(): JSX.Element {
  return (
    <MockFrame
      title="Chronology"
      meta="This sprint · working hours, Monday to Friday, 09:00–17:30"
      label="Chronology: 36% of working hours waiting for a reviewer, 31% waiting for the author, 33% approved and waiting to merge; first look, approved to merged and opened to merged are past their limits, reply to review is acceptable"
    >
      <Group first>Where the working hours went</Group>
      <CourtBar showPct segments={COURTS} />
      <Group>Each wait against its time budget</Group>
      <div className="rp-budgets">
        {BUDGETS.map((b) => (
          <div key={b.wait} className="rp-budget">
            <div className="h">
              <span>{b.wait}</span>
              <Chip tone={b.tone}>{b.verdict}</Chip>
            </div>
            <div
              className="track"
              style={{ '--b': pct(b.budget), '--l': pct(b.limit) } as CSSProperties}
            >
              <i className="most" style={{ width: pct(b.most) }} />
              <i className="half" style={{ left: pct(b.half) }} />
              <i className="budget" style={{ left: pct(b.budget) }} />
            </div>
          </div>
        ))}
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

export function OverTimeMock(): JSX.Element {
  const W = 420;
  const H = 100;
  const n = OVER_TIME.shares.length;
  const colW = W / n;
  return (
    <MockFrame
      title="Over time"
      meta="Last 26 weeks"
      label="Chronology over time: where the working hours went each week, each wait against its budget week by week, and markers for repositories joining, new bots, new contributors and setting changes"
    >
      <div className="mk-chips" style={{ marginBottom: 6 }}>
        {OVER_TIME.markers.map((m) => (
          <Chip key={m.k}>
            {m.k} {m.n}
          </Chip>
        ))}
      </div>
      <Group>Where the working hours went</Group>
      <svg className="mk-svg" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        {OVER_TIME.shares.map((s, i) => {
          let y = H;
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

export function BotsSeverityMock(): JSX.Element {
  return (
    <MockFrame
      title="What the bots are flagging"
      meta="graded by Limn's model"
      label="Bots Monitoring: 502 findings, 49% high severity, 30% nits, mostly about correctness; a row per bot with threads, share used, not addressed and severity mix"
    >
      <div className="mk-stats">
        {BOT_SUMMARY.map((s) => (
          <Stat key={s.k} k={s.k} v={s.v} d={s.d} />
        ))}
      </div>
      <Group>A row per bot</Group>
      <MiniTable
        className="stack"
        cols={[
          { key: 'bot', label: 'Bot' },
          { key: 'threads', label: 'Threads', num: true },
          { key: 'used', label: 'Used', num: true },
          { key: 'open', label: 'Not addressed', num: true },
          { key: 'mix', label: 'Severity mix' },
          { key: 'high', label: 'High', num: true },
        ]}
        rows={BOTS.map((b) => ({
          _key: b.bot,
          bot: b.bot,
          threads: b.threads,
          used: b.used,
          open: b.open,
          mix: <HBar parts={b.mix} colors={SEVERITY} />,
          high: b.high,
        }))}
      />
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

export function SprintLanesMock(): JSX.Element {
  return (
    <MockFrame
      title={SPRINT.name}
      meta={SPRINT.meta}
      label="This Sprint by theme: Refunds and Ledger as rows, status columns from not started to product review, ticket cards with criteria and assignee, and numbered critical-path links"
    >
      <div className="mk-tabs">
        <span className="on">Theme</span>
        <span>Critical path</span>
        <span>People</span>
        <span>Merged so far</span>
      </div>
      <div className="rp-lanes">
        <div className="hd" aria-hidden="true">
          <span />
          {SPRINT.columns.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        {SPRINT.lanes.map((lane) => (
          <div key={lane.theme} className="lane">
            <b className="theme">{lane.theme}</b>
            {lane.cards.map((card, i) =>
              card ? (
                <div
                  key={card.key}
                  className={`card${card.path ? (card.waiting ? ' wait' : ' path') : ''}`}
                  data-col={SPRINT.columns[i]}
                >
                  <span className="key">
                    {card.key}
                    {card.path ? <em>{card.path}</em> : null}
                  </span>
                  <span className="ti">{card.title}</span>
                  <span className="cr">{card.criteria}</span>
                  <Chip>{card.who}</Chip>
                </div>
              ) : (
                <span key={i} className="empty" />
              ),
            )}
          </div>
        ))}
      </div>
      <Legend
        items={[
          { label: 'On a critical path', color: 'var(--gold)' },
          { label: 'On a path and waiting', color: '#8a7240' },
        ]}
      />
    </MockFrame>
  );
}

