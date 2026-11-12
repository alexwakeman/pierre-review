import { useState } from 'react';
import { SETUP_REPOS, SETUP_WORKSPACES } from '../../mock/acme';
import { Act, Chip, MockFrame, SelectBox, TextBox, useLater } from './kit';

// The docs' Getting started mocks: the first-run repository picker and the
// Repos & workspaces dialog, with the app's own labels (src/mock/acme.ts SETUP_*).
// They are instructions, so every label, option and button matches the real
// screen. The component each mirrors is listed in apps/landing/README.md.

// ---- first run: add the repos you work on ------------------------------------------

export function AddReposMock(): JSX.Element {
  const [on, setOn] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(SETUP_REPOS.suggestions.map((r) => [r.name, r.on])),
  );
  const [adding, setAdding] = useState<number | null>(null);
  const later = useLater();
  const chosen = SETUP_REPOS.suggestions.filter((r) => on[r.name]);
  const total = SETUP_REPOS.suggestions.length;
  const running = adding !== null && adding < chosen.length;
  const done = adding !== null && adding >= chosen.length;
  const touched = adding !== null || SETUP_REPOS.suggestions.some((r) => r.on !== on[r.name]);

  const step = (i: number): void => {
    setAdding(i);
    if (i < chosen.length) later(() => step(i + 1), 350);
  };

  return (
    <MockFrame
      live
      title="First run"
      onReset={
        touched
          ? () => {
              setOn(Object.fromEntries(SETUP_REPOS.suggestions.map((r) => [r.name, r.on])));
              setAdding(null);
            }
          : null
      }
      label="First run: Add the repos you work on. Six repositories you have been active in, five ticked, and an Add 5 selected button"
    >
      <div className="mk-sec-h">
        <b>{SETUP_REPOS.title}</b>
        <p>{SETUP_REPOS.lead}</p>
      </div>
      <div className="mk-repos">
        {SETUP_REPOS.suggestions.map((r) => (
          <label key={r.name} className={on[r.name] ? 'on' : undefined}>
            <input
              type="checkbox"
              checked={on[r.name] ?? false}
              disabled={adding !== null}
              onChange={(e) => setOn((s) => ({ ...s, [r.name]: e.target.checked }))}
            />
            <span>
              <span className="nm">
                <b>{r.name}</b>
                <em>private</em>
                <em className="yours">yours</em>
                {done && on[r.name] ? <Chip tone="green">Added</Chip> : null}
              </span>
              <span className="ds">{r.desc}</span>
              <span className="mt">
                ★ {r.stars} · {r.prs} open PRs
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="mk-inline">
        <Act tone="go" onClick={() => step(0)} disabled={chosen.length === 0 || adding !== null}>
          {running
            ? `Adding ${(adding ?? 0) + 1}/${chosen.length} — ${chosen[adding ?? 0]?.name ?? ''}…`
            : done
              ? 'Added'
              : `Add ${chosen.length} selected`}
        </Act>
        {adding === null ? (
          <span className="mk-muted">
            {chosen.length} of {total} selected
          </span>
        ) : null}
      </div>
      <p className="mk-muted" style={{ marginTop: 10 }}>
        {SETUP_REPOS.or}
      </p>
      <TextBox value={SETUP_REPOS.search} />
    </MockFrame>
  );
}

// ---- Repos & workspaces ------------------------------------------------------------

const MODE_OPTIONS = [
  { id: 'watched', label: 'Watched' },
  { id: 'external', label: 'External' },
];

export function WorkspacesMock(): JSX.Element {
  const ws = SETUP_WORKSPACES.workspaces;
  const initialHome = (): Record<string, string> =>
    Object.fromEntries(SETUP_WORKSPACES.repos.map((r) => [r.name, r.home]));
  const [selected, setSelected] = useState(ws[0]?.id ?? '');
  const [home, setHome] = useState<Record<string, string>>(initialHome);
  const initialExternal = (): Record<string, boolean> =>
    Object.fromEntries(SETUP_WORKSPACES.repos.map((r) => [r.name, r.external === true]));
  const [external, setExternal] = useState<Record<string, boolean>>(initialExternal);
  const sel = ws.find((w) => w.id === selected) ?? ws[0];
  const count = (id: string): number => Object.values(home).filter((h) => h === id).length;
  const inSel = SETUP_WORKSPACES.repos.filter((r) => home[r.name] === selected);
  const elsewhere = SETUP_WORKSPACES.repos.filter((r) => home[r.name] !== selected);
  const moved = SETUP_WORKSPACES.repos.some(
    (r) => r.home !== home[r.name] || (r.external === true) !== external[r.name],
  );
  const options = ws.map((w) => ({ id: w.id, label: w.name }));

  const row = (r: { name: string }): JSX.Element => {
    const [owner, repo] = r.name.split('/');
    return (
      <div key={r.name} className="mk-wsrow">
        <span>
          {owner}/<b>{repo}</b>
        </span>
        <SelectBox
          label={`Workspace for ${r.name}`}
          value={home[r.name] ?? ''}
          options={options}
          onChange={(v) => setHome((h) => ({ ...h, [r.name]: v }))}
        />
        <SelectBox
          label={`Watched or external: ${r.name}`}
          value={external[r.name] ? 'external' : 'watched'}
          options={MODE_OPTIONS}
          onChange={(v) => setExternal((e) => ({ ...e, [r.name]: v === 'external' }))}
        />
      </div>
    );
  };

  return (
    <MockFrame
      live
      title={SETUP_WORKSPACES.title}
      onReset={
        moved || selected !== ws[0]?.id
          ? () => {
              setHome(initialHome());
              setExternal(initialExternal());
              setSelected(ws[0]?.id ?? '');
            }
          : null
      }
      label="The Repos and workspaces dialog: two workspaces, Acme payments (the default) and Web, and each repository with a workspace picker that moves it and a Watched or External picker"
    >
      <div className="mk-ws">
        <div className="mk-wslist" role="group" aria-label="Workspaces">
          <TextBox value="New workspace name…" />
          {ws.map((w) => (
            <button
              key={w.id}
              type="button"
              aria-pressed={w.id === selected}
              className={w.id === selected ? 'on' : undefined}
              onClick={() => setSelected(w.id)}
            >
              <span>{w.name}</span>
              {w.isDefault ? <em>default</em> : null}
              <small>{count(w.id)}</small>
            </button>
          ))}
        </div>
        <div>
          <div className="mk-sec-h">
            <b>Repos</b>
            <p>{SETUP_WORKSPACES.rule}</p>
          </div>
          <div className="mk-grp first">
            In “{sel?.name}” · {inSel.length}
          </div>
          {inSel.map(row)}
          <div className="mk-grp">In other workspaces · {elsewhere.length}</div>
          {elsewhere.map(row)}
        </div>
      </div>
    </MockFrame>
  );
}
