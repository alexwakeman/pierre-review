import { useId, useState } from 'react';
import {
  SETUP_AI,
  SETUP_ML,
  SETUP_REPOS,
  SETUP_SLACK,
  SETUP_TRACKER,
  SETUP_WORKSPACES,
} from '../../mock/acme';
import type { TrackerProvider } from '../../mock/acme';
import { Act, CheckLine, Chip, Field, MockFrame, Section, SelectBox, TextBox, useAction, useLater } from './kit';

// Getting started's mocks: the Settings sections and dialogs each step names,
// with the app's own labels (src/mock/acme.ts SETUP_*). They are instructions,
// so every label, option and button matches the real screen. The component each
// mirrors is listed in apps/landing/README.md.

// ---- Settings → AI ------------------------------------------------------------

export function AiSettingsMock(): JSX.Element {
  const name = useId();
  const effortId = useId();
  const [choice, setChoice] = useState<'auto' | 'claude' | 'codex'>('auto');
  const [effort, setEffort] = useState('Default');
  const [codexIn, setCodexIn] = useState(false);
  const signIn = useAction(900);
  const changed = choice !== 'auto' || effort !== 'Default' || codexIn;
  const def = choice === 'codex' ? 'Codex' : 'Claude';
  return (
    <MockFrame
      live
      title="Settings"
      meta="AI"
      onReset={
        changed
          ? () => {
              setChoice('auto');
              setEffort('Default');
              setCodexIn(false);
              signIn.reset();
            }
          : null
      }
      label="Settings, AI: the default provider for automatic runs (Auto, Claude or Codex), the effort for reviews and AI Fix, Claude signed in to Claude Code, and Codex with a Sign in with ChatGPT button"
    >
      <Section title="AI" desc={`Default: ${def}.`}>
        <fieldset className="mk-radios">
          <legend>Automatic runs and default:</legend>
          {SETUP_AI.choices.map((c) => (
            <label key={c.id}>
              <input type="radio" name={name} checked={choice === c.id} onChange={() => setChoice(c.id)} />
              {c.label}
            </label>
          ))}
        </fieldset>
        <div className="mk-inline">
          <label htmlFor={effortId}>Effort for reviews and AI Fix:</label>
          <SelectBox
            id={effortId}
            value={effort}
            options={SETUP_AI.efforts.map((e) => ({ id: e, label: e }))}
            onChange={setEffort}
          />
        </div>
        <dl className="mk-dl">
          <div>
            <dt>Claude</dt>
            <dd>{SETUP_AI.claude}</dd>
          </div>
          <div>
            <dt>Codex</dt>
            <dd>
              {codexIn ? (
                <>
                  <span role="status">{SETUP_AI.codexIn}</span>
                  <Act
                    onClick={() => {
                      setCodexIn(false);
                      signIn.reset();
                    }}
                  >
                    {SETUP_AI.signOut}
                  </Act>
                </>
              ) : (
                <>
                  <span>{signIn.phase === 'busy' ? 'Waiting for the ChatGPT sign-in…' : SETUP_AI.codexOut}</span>
                  <Act onClick={() => signIn.run(() => setCodexIn(true))} disabled={signIn.phase === 'busy'}>
                    {SETUP_AI.signIn}
                  </Act>
                  <Act onClick={() => signIn.run(() => setCodexIn(true))} disabled={signIn.phase === 'busy'}>
                    {SETUP_AI.useCode}
                  </Act>
                </>
              )}
            </dd>
          </div>
        </dl>
        <p className="mk-muted">{SETUP_AI.footer}</p>
      </Section>
    </MockFrame>
  );
}

// ---- Settings → Bot comment scoring -------------------------------------------------

export function BotScoringMock(): JSX.Element {
  const setup = useAction(1200);
  return (
    <MockFrame
      live
      title="Settings"
      meta="Bot comment scoring"
      onReset={setup.phase !== 'idle' ? () => setup.reset() : null}
      label="Settings, Bot comment scoring: Score how serious each bot review comment is, with the button Set up (one-time ~240 MB download)"
    >
      <Section title={SETUP_ML.title} desc={setup.phase === 'done' ? SETUP_ML.ready : SETUP_ML.desc}>
        {setup.phase === 'idle' ? (
          <div>
            <Act onClick={() => setup.run()}>{SETUP_ML.button}</Act>
          </div>
        ) : setup.phase === 'busy' ? (
          <p className="mk-muted" role="status">
            {SETUP_ML.busy}
          </p>
        ) : (
          <span role="status">
            <Chip tone="green">Ready</Chip>
          </span>
        )}
      </Section>
    </MockFrame>
  );
}

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

export function WorkspacesMock(): JSX.Element {
  const ws = SETUP_WORKSPACES.workspaces;
  const initialHome = (): Record<string, string> =>
    Object.fromEntries(SETUP_WORKSPACES.repos.map((r) => [r.name, r.home]));
  const [selected, setSelected] = useState(ws[0]?.id ?? '');
  const [home, setHome] = useState<Record<string, string>>(initialHome);
  const sel = ws.find((w) => w.id === selected) ?? ws[0];
  const count = (id: string): number => Object.values(home).filter((h) => h === id).length;
  const inSel = SETUP_WORKSPACES.repos.filter((r) => home[r.name] === selected);
  const elsewhere = SETUP_WORKSPACES.repos.filter((r) => home[r.name] !== selected);
  const moved = SETUP_WORKSPACES.repos.some((r) => r.home !== home[r.name]);
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
              setSelected(ws[0]?.id ?? '');
            }
          : null
      }
      label="The Repos and workspaces dialog: two workspaces, Acme payments (the default) and Web, and each repository with a workspace picker that moves it"
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

// ---- Settings → Issue tracker ----------------------------------------------------

export function TrackerMock(): JSX.Element {
  const providerId = useId();
  const whereId = useId();
  const [provider, setProvider] = useState<TrackerProvider>('jira');
  const [where, setWhere] = useState(SETUP_TRACKER.where[0] ?? '');
  const [saved, setSaved] = useState<{ provider: TrackerProvider; where: string }>({
    provider: 'jira',
    where: SETUP_TRACKER.where[0] ?? '',
  });
  const check = useAction(900);
  const save = useAction(600);
  const T = SETUP_TRACKER;
  const dirty = provider !== saved.provider || where !== saved.where;
  const changed = provider !== 'jira' || where !== T.where[0] || saved.provider !== 'jira' || check.phase !== 'idle';
  const url = provider === 'linear' ? T.linear : provider === 'notion' ? T.notion : T.jira;
  return (
    <MockFrame
      live
      title="Settings"
      meta="Issue tracker"
      onReset={
        changed
          ? () => {
              setProvider('jira');
              setWhere(T.where[0] ?? '');
              setSaved({ provider: 'jira', where: T.where[0] ?? '' });
              check.reset();
            }
          : null
      }
      label="Settings, Issue tracker: the provider (None, Jira, GitHub Issues, Linear or Notion) and, for Jira, the base URL, project keys, where to look and optional Jira API access"
    >
      <Section title="Issue tracker" desc={T.desc}>
        <Field label="Provider" id={providerId}>
          <SelectBox id={providerId} value={provider} options={T.providers} onChange={setProvider} />
        </Field>
        {provider === 'github' ? <p className="mk-muted">{T.github}</p> : null}
        {provider === 'jira' || provider === 'linear' || provider === 'notion' ? (
          <>
            <Field
              label={provider === 'linear' ? 'Workspace URL' : provider === 'notion' ? 'Database URL' : 'Base URL'}
              hint={url.urlHint}
            >
              <TextBox value={url.url} />
            </Field>
            {provider !== 'notion' ? (
              <Field
                label={provider === 'linear' ? 'Team keys' : 'Project keys'}
                hint={provider === 'linear' ? T.linear.keysHint : T.jira.keysHint}
              >
                <TextBox value={provider === 'linear' ? T.linear.keys : T.jira.keys} />
              </Field>
            ) : null}
            <Field label="Where to look" id={whereId}>
              <SelectBox
                id={whereId}
                value={where}
                options={T.where.map((w) => ({ id: w, label: w }))}
                onChange={setWhere}
              />
            </Field>
          </>
        ) : null}
        <div>
          <Act
            tone="go"
            disabled={!dirty || save.phase === 'busy'}
            onClick={() => save.run(() => setSaved({ provider, where }))}
          >
            {save.phase === 'busy' ? 'Saving…' : 'Save'}
          </Act>
        </div>
        {/* As in the app, API access is offered once the provider is SAVED. */}
        {provider === 'jira' && saved.provider === 'jira' ? (
          <div className="mk-subsec">
            <b>{T.jira.access}</b>
            <p className="mk-muted">{T.jira.accessDesc}</p>
            <Field label="Email" hint={T.jira.emailHint}>
              <TextBox value={T.jira.email} />
            </Field>
            <Field label="API token">
              <span className="mk-inline">
                <span>Saved</span>
                <span className="mk-btn is-static">Replace</span>
                <span className="mk-btn is-static">Remove</span>
              </span>
            </Field>
            <div className="mk-inline">
              <Act onClick={() => check.run()} disabled={check.phase === 'busy'}>
                {check.phase === 'busy' ? T.checking : T.check}
              </Act>
              {check.phase === 'done' ? (
                <span className="mk-ok" role="status">
                  {T.jira.connected}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
        {provider === 'linear' && saved.provider === 'linear' ? (
          <div className="mk-subsec">
            <b>{T.linear.access}</b>
            <Field label="Personal API key" hint={T.linear.keyHint}>
              <TextBox value="" />
            </Field>
          </div>
        ) : null}
      </Section>
    </MockFrame>
  );
}

// ---- Settings → Slack -----------------------------------------------------------------

export function SlackMock(): JSX.Element {
  const S = SETUP_SLACK;
  const cadenceId = useId();
  const atId = useId();
  const andId = useId();
  const initialChecks = (): Record<string, boolean> => Object.fromEntries(S.checks.map((c) => [c.id, c.on]));
  const [cadence, setCadence] = useState<'off' | 'daily' | 'twice_daily'>('daily');
  const [at, setAt] = useState('9:00 AM');
  const [and, setAnd] = useState('4:00 PM');
  const [checks, setChecks] = useState<Record<string, boolean>>(initialChecks);
  const [savedKey, setSavedKey] = useState('');
  const save = useAction(600);
  const test = useAction(900);
  const key = JSON.stringify([cadence, at, and, checks]);
  const baseline = savedKey || JSON.stringify(['daily', '9:00 AM', '4:00 PM', initialChecks()]);
  const dirty = key !== baseline;
  const changed = key !== JSON.stringify(['daily', '9:00 AM', '4:00 PM', initialChecks()]) || test.phase !== 'idle';
  const hours = S.hours.map((h) => ({ id: h, label: h }));
  return (
    <MockFrame
      live
      title="Settings"
      meta="Slack"
      onReset={
        changed
          ? () => {
              setCadence('daily');
              setAt('9:00 AM');
              setAnd('4:00 PM');
              setChecks(initialChecks());
              setSavedKey('');
              test.reset();
              save.reset();
            }
          : null
      }
      label="Settings, Slack: a stored incoming webhook, cadence Daily at 9:00 AM, three checkboxes, Save and Send test"
    >
      <Section title="Slack" desc={S.desc}>
        <Field label="Incoming webhook URL" hint={S.storedHint}>
          <TextBox value={S.stored} />
        </Field>
        <div className="mk-row">
          <Field label="Cadence" id={cadenceId}>
            <SelectBox id={cadenceId} value={cadence} options={S.cadences} onChange={setCadence} />
          </Field>
          {cadence !== 'off' ? (
            <Field label="Send at" id={atId} hint={S.timezone}>
              <SelectBox id={atId} value={at} options={hours} onChange={setAt} />
            </Field>
          ) : null}
          {cadence === 'twice_daily' ? (
            <Field label="And at" id={andId}>
              <SelectBox id={andId} value={and} options={hours} onChange={setAnd} />
            </Field>
          ) : null}
        </div>
        {S.checks.map((c) => (
          <CheckLine
            key={c.id}
            checked={checks[c.id] ?? false}
            onChange={(v) => setChecks((s) => ({ ...s, [c.id]: v }))}
            label={c.label}
            hint={c.hint}
          />
        ))}
        <p className="mk-muted">{S.cap}</p>
        <div>
          <Act tone="go" disabled={!dirty || save.phase === 'busy'} onClick={() => save.run(() => setSavedKey(key))}>
            {save.phase === 'busy' ? 'Saving…' : 'Save'}
          </Act>
        </div>
        <div className="mk-inline mk-rule">
          <Act onClick={() => test.run()} disabled={test.phase === 'busy'}>
            {test.phase === 'busy' ? S.test.busy : S.test.idle}
          </Act>
          {test.phase === 'done' ? (
            <span className="mk-ok" role="status">
              {S.test.done}
            </span>
          ) : null}
        </div>
      </Section>
    </MockFrame>
  );
}
