import { useEffect, useRef, useState } from 'react';
import { OPEN_PRS, type OpenPr, type OpenPrLead } from '../../mock/acme';
import { MockFrame } from './kit';

// ---------------------------------------------------------------------------
// OPEN PULL REQUESTS, grouped by ticket, with the drawer (Everything else). Mirrors
// apps/frontend Activity/OpenPrsRows.tsx: a ticket line (chevron, key, title) with its
// PRs inset under it (tickets that share PRs: one group, a line per ticket, each PR once); each row a status icon, the title, then repo#N · author · age;
// the Review, CI, Threads and AI review columns. A click opens the docked drawer:
// Can it land, Checks, Reviews, Threads, the AI review, Tickets, then the pull request
// (author, opened, updated, size, reach). Words come from mock/acme.ts OPEN_PRS.
// The prerendered page shows the first PR open.
// ---------------------------------------------------------------------------

const I = {
  pr: (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.1v5.8M12 10.9V7a2.5 2.5 0 0 0-2.5-2.5H7m1.5-1.5L7 4.5 8.5 6" />
    </svg>
  ),
  merge: (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="8" r="1.6" />
      <path d="M4 5.1v5.8M4.6 5c.8 2 3 3 5.8 3" />
    </svg>
  ),
  conflict: (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M8 1.8 14.5 13.5h-13z" />
      <path d="M8 6v3.5M8 11.4v.1" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="m3 8.5 3 3 7-7" />
    </svg>
  ),
  cross: (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  ),
  ring: (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <circle cx="8" cy="8" r="5" />
    </svg>
  ),
  approved: (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="m5.2 8.2 2 2 3.7-4" />
    </svg>
  ),
  changes: (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M5.5 8h5" />
    </svg>
  ),
  threads: (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M2.5 3.5h8v5.5h-4l-2.5 2V9h-1.5zM12.5 6h1v5.5H12v1.5l-2-1.5H7" />
    </svg>
  ),
  ticket: (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M2 4.5h12v2a1.5 1.5 0 0 0 0 3v2H2v-2a1.5 1.5 0 0 0 0-3z" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="m4 6 4 4 4-4" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  ),
};

const LEAD_ICON: Record<OpenPrLead, JSX.Element> = {
  blocked: I.pr,
  conflicts: I.conflict,
  ready: I.merge,
  draft: I.pr,
  neutral: I.pr,
};

const repoShort = (full: string): string => full.split('/').pop() ?? full;

function Ci({ ci, words }: { ci: OpenPr['ci']; words?: boolean }): JSX.Element | null {
  if (ci == null) return words ? <span className="mk-muted">No checks</span> : null;
  const m = {
    failing: { cls: 'bad', icon: I.cross, label: 'CI failing' },
    passing: { cls: 'quiet', icon: I.check, label: 'CI passing' },
    running: { cls: 'neutral', icon: I.ring, label: 'CI running' },
  }[ci];
  return (
    <span className={`mk-op-st ${m.cls}`} title={m.label}>
      {m.icon}
      {words ? <span>{m.label}</span> : <span className="vh">{m.label}</span>}
    </span>
  );
}

function Review({ review, words }: { review: OpenPr['review']; words?: boolean }): JSX.Element | null {
  if (review == null) return words ? <span className="mk-muted">No approval yet</span> : null;
  const m = review === 'approved' ? { cls: 'ok', icon: I.approved, label: 'Approved' } : { cls: 'bad', icon: I.changes, label: 'Changes requested' };
  return (
    <span className={`mk-op-st ${m.cls}`} title={m.label}>
      {m.icon}
      {words ? <span>{m.label}</span> : <span className="vh">{m.label}</span>}
    </span>
  );
}

const threadsText = (t: OpenPr['threads']): string | null =>
  t.untouched > 0 ? `${t.untouched} untouched` : t.open > 0 ? `${t.open} open thread${t.open === 1 ? '' : 's'}` : t.resolved > 0 ? `${t.resolved} resolved` : null;

function Ai({ ai, words }: { ai: OpenPr['ai']; words?: boolean }): JSX.Element {
  if (ai === 'reviewing') {
    return (
      <span className="mk-op-ai working" title="Reviewing">
        <span className="mk-op-pulse" aria-hidden="true" />
        {words ? 'Reviewing' : <span className="vh">Reviewing</span>}
      </span>
    );
  }
  if (ai == null) return <span className="mk-muted">{words ? 'Not reviewed' : '–'}</span>;
  return (
    <span className={`mk-op-ai t-${ai.tone}`} title={ai.verdict}>
      <span className="mk-op-dot" aria-hidden="true" />
      {words ? ai.verdict : <span className="vh">{ai.verdict}</span>}
    </span>
  );
}

function Row({ p, open, onOpen }: { p: OpenPr; open: boolean; onOpen: () => void }): JSX.Element {
  const t = p.threads;
  return (
    <li>
      <button type="button" className={`mk-op-row${open ? ' open' : ''}`} aria-pressed={open} onClick={onOpen}>
        <span className={`mk-op-lead ${p.lead}`} title={p.landDetail != null ? `${p.land}: ${p.landDetail}` : p.land}>
          {LEAD_ICON[p.lead]}
          <span className="vh">{p.land}</span>
        </span>
        <span className="mk-op-two">
          <span className={`mk-op-title${p.draft ? ' draft' : ''}`}>{p.pr.title}</span>
          <span className="mk-op-meta">
            <span className="mk-op-repo">
              {p.draft && 'Draft · '}
              {repoShort(p.pr.repo)}#{p.pr.num}
            </span>
            · <span className="mk-op-av" aria-hidden="true">{p.author[0]}</span>
            <span className="mk-op-who">{p.author}</span> · {p.age}
          </span>
        </span>
        <span className="mk-op-col c-review">
          <Review review={p.review} />
        </span>
        <span className="mk-op-col c-ci">
          <Ci ci={p.ci} />
        </span>
        <span className="mk-op-col c-threads">
          {t.open > 0 && (
            <>
              {I.threads}
              <span>{t.open}</span>
              {t.untouched > 0 && <span className="mk-op-red" aria-hidden="true" />}
              <span className="vh">Review threads: {threadsText(t)}</span>
            </>
          )}
        </span>
        <span className="mk-op-col c-ai">
          <Ai ai={p.ai} />
        </span>
      </button>
    </li>
  );
}

function Fact({ k, children }: { k: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mk-op-fact">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Drawer({
  p,
  ticket,
  onClose,
  picked,
}: {
  p: OpenPr;
  ticket: { key: string; title: string } | null;
  onClose: () => void;
  /** The reader picked this PR (not the first paint): on a phone, where the drawer sits under the list, bring it into view. */
  picked: boolean;
}): JSX.Element {
  const threads = threadsText(p.threads);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!picked || !window.matchMedia('(max-width: 760px)').matches) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    ref.current?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [p.pr.num, picked]);
  return (
    <aside ref={ref} className="mk-op-drawer" aria-label={`${p.pr.title}, ${p.pr.repo}#${p.pr.num}`}>
      <div className="mk-op-dhead">
        <div>
          <div className="mk-op-dtitle">{p.pr.title}</div>
          <div className="mk-op-dsub">
            {p.pr.repo}#{p.pr.num}
          </div>
        </div>
        <button type="button" className="mk-op-x" onClick={onClose} aria-label="Close">
          {I.close}
        </button>
      </div>
      <dl className="mk-op-facts">
        <Fact k="Can it land">
          <span className={`mk-op-st ${p.lead === 'ready' ? 'ok' : p.lead === 'blocked' || p.lead === 'conflicts' ? 'bad' : 'neutral'}`}>
            {LEAD_ICON[p.lead]}
            <span>{p.land}</span>
          </span>
          {p.landDetail != null && <p className="mk-op-detail">{p.landDetail}</p>}
        </Fact>
        <Fact k="Checks">
          <Ci ci={p.ci} words />
        </Fact>
        <Fact k="Reviews">
          <Review review={p.review} words />
        </Fact>
        <Fact k="Threads">
          {threads != null ? (
            <span className="mk-op-thr">
              <span className="mk-op-bar" aria-hidden="true">
                <i className="u" style={{ flex: p.threads.untouched }} />
                <i className="r" style={{ flex: p.threads.open - p.threads.untouched }} />
                <i className="d" style={{ flex: p.threads.resolved }} />
              </span>
              <span className="mk-op-link">{threads}</span>
            </span>
          ) : (
            <span className="mk-muted">No review threads</span>
          )}
        </Fact>
      </dl>

      <h4 className="mk-op-h">AI review</h4>
      <dl className="mk-op-facts">
        <Fact k={p.ai != null && p.ai !== 'reviewing' ? 'Verdict' : 'Status'}>
          <Ai ai={p.ai} words />
        </Fact>
        {p.ai != null && p.ai !== 'reviewing' && p.ai.findings != null && <Fact k="Findings">{p.ai.findings}</Fact>}
      </dl>

      {ticket != null && (
        <>
          <h4 className="mk-op-h">Tickets</h4>
          <p className="mk-op-ticket">
            {I.ticket}
            <span className="mk-op-key">{ticket.key}</span>
            <span className="mk-op-link">{ticket.title}</span>
          </p>
        </>
      )}

      <h4 className="mk-op-h">Pull request</h4>
      <dl className="mk-op-facts">
        <Fact k="Author">
          <span className="mk-op-av" aria-hidden="true">
            {p.author[0]}
          </span>
          {p.author}
        </Fact>
        <Fact k="Opened">{p.opened}</Fact>
        {p.updated !== p.opened && <Fact k="Updated">{p.updated}</Fact>}
        <Fact k="Size">
          {p.size.files} files{' '}
          <code className="mk-op-diff">
            +{p.size.add} −{p.size.del}
          </code>
        </Fact>
        <Fact k="Reach">
          <span className={`mk-op-reach r-${p.reach.toLowerCase()}`}>{p.reach} reach</span>
        </Fact>
      </dl>
    </aside>
  );
}

export function OpenPrsMock(): JSX.Element {
  const [openNum, setOpenNum] = useState<number | null>(OPEN_PRS.firstOpen);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState(false);
  const changed = openNum !== OPEN_PRS.firstOpen || folded.size > 0;
  const total = OPEN_PRS.groups.reduce((n, g) => n + g.prs.length, 0);
  let openPr: OpenPr | undefined;
  let openTicket: { key: string; title: string } | null = null;
  for (const g of OPEN_PRS.groups) {
    const hit = g.prs.find((p) => p.pr.num === openNum);
    if (hit) {
      openPr = hit;
      openTicket = g.ticket;
    }
  }
  const fold = (key: string): void =>
    setFolded((f) => {
      const n = new Set(f);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  return (
    <MockFrame
      live
      dots
      title={`Open pull requests · ${OPEN_PRS.workspace}`}
      right={`${total} open`}
      onReset={
        changed
          ? () => {
              setOpenNum(OPEN_PRS.firstOpen);
              setFolded(new Set());
            }
          : null
      }
      label="Open pull requests, grouped by ticket: each row says whether it can land, then review, CI, threads and the AI review. Selecting one opens its drawer."
      className="mk-op"
    >
      <div className={`mk-op-wrap${openPr ? ' has-drawer' : ''}`}>
        <div className="mk-op-list">
          <div className="mk-op-heads" aria-hidden="true">
            <span />
            <span />
            <span className="c-review">Review</span>
            <span className="c-ci">CI</span>
            <span className="c-threads">Threads</span>
            <span className="c-ai">AI review</span>
          </div>
          <ul className="mk-op-groups">
            {OPEN_PRS.groups.map((g) => {
              const key = g.ticket?.key ?? 'none';
              const isFolded = folded.has(key);
              return (
                <li key={key} className="mk-op-group">
                  <div className={`mk-op-ghead${g.more != null && g.more.length > 0 ? ' multi' : ''}`}>
                    <button
                      type="button"
                      className={`mk-op-fold${isFolded ? ' folded' : ''}`}
                      aria-expanded={!isFolded}
                      aria-label={`${isFolded ? 'Show' : 'Hide'} the pull requests for ${g.ticket != null ? [g.ticket, ...(g.more ?? [])].map((t) => t.key).join(', ') : 'no ticket'}`}
                      onClick={() => fold(key)}
                    >
                      {I.chevron}
                    </button>
                    {g.ticket != null ? (
                      // Tickets that share PRs are ONE group: each ticket on its own line.
                      <div className="mk-op-gtickets">
                        {[g.ticket, ...(g.more ?? [])].map((t) => (
                          <h4 key={t.key}>
                            <span className="mk-op-key">
                              {I.ticket}
                              {t.key}
                            </span>
                            <span>{t.title}</span>
                          </h4>
                        ))}
                      </div>
                    ) : (
                      <h4 className="mk-muted">No ticket</h4>
                    )}
                  </div>
                  {!isFolded && (
                    <ul className="mk-op-rows">
                      {g.prs.map((p) => (
                        <Row key={p.pr.num} p={p} open={p.pr.num === openNum} onOpen={() => {
                            setPicked(true);
                            setOpenNum(p.pr.num === openNum ? null : p.pr.num);
                          }} />
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        {openPr != null ? (
          <Drawer p={openPr} ticket={openTicket} picked={picked} onClose={() => setOpenNum(null)} />
        ) : (
          <div className="mk-op-empty">Select a pull request to see it here.</div>
        )}
      </div>
    </MockFrame>
  );
}
