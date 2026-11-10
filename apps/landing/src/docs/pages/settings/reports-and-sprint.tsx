import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, MiniTable, Note, Ui, Warning, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Reports and sprint',
  summary: 'Working hours, budgets and the sprint cadence.',
};

const BUDGET_COLS = [
  { key: 'wait', label: 'Wait' },
  { key: 'good', label: 'Good', num: true },
  { key: 'ok', label: 'Acceptable', num: true },
];
const BUDGET_ROWS = [
  { _key: 'first', wait: 'First look', good: '4h', ok: '8h' },
  { _key: 'reply', wait: 'Reply to review', good: '8h', ok: '16h' },
  { _key: 'land', wait: 'Approved to merged', good: '1h', ok: '4h' },
  { _key: 'lead', wait: 'Opened to merged', good: '8h', ok: '16h' },
];

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Reports and sprint</Ui> tab tells Limn how the current workspace works: when the team is at work, how
        long each kind of wait should take, and how long a sprint is. Reports and Chronology measure against these
        settings. Every setting here applies to this workspace only; other workspaces set their own.
      </p>
      <WhoItHelps
        developer="Waits are counted in working hours, so a pull request opened on Friday evening is not shown as two days late on Monday."
        manager="Set the team's own targets for review and merge times, and line Reports up with your sprint boundaries."
      />

      <H2 id="working-hours">Working hours and budgets</H2>
      <p>
        Chronology counts only the hours your team works, and holds each wait against a budget. Nights, weekends and
        days off are not counted as waiting. See <DocLink to="reports/chronology">Chronology</DocLink>.
      </p>
      <H3>Working hours</H3>
      <ul>
        <li>
          <Ui>Time zone</Ui>: the team&rsquo;s time zone.
        </li>
        <li>The start and end of the working day. The default is 09:00 to 18:00.</li>
        <li>The working days. The default is Monday to Friday. Pick at least one.</li>
      </ul>
      <H3>Budgets</H3>
      <p>
        Each wait has two sliders: <Ui>Good</Ui> and <Ui>Acceptable</Ui>, in working hours. A wait at or under Good is
        within budget; over Acceptable it is slow. Acceptable cannot be tighter than Good.
      </p>
      <Illustration label="The four wait budgets with their default Good and Acceptable values." caption="The default budgets, in working hours.">
        <MiniTable cols={BUDGET_COLS} rows={BUDGET_ROWS} />
      </Illustration>
      <p>
        The first-look default follows published review guidance that a first response should take at most one
        working day. Select <Ui>Reset to defaults</Ui> to go back to these values, then <Ui>Save</Ui>.
      </p>

      <H2 id="sprint-cadence">Sprint cadence and comparison window</H2>
      <H3>Sprint length</H3>
      <p>
        Choose <Ui>1 week</Ui>, <Ui>2 weeks</Ui>, <Ui>3 weeks</Ui>, <Ui>4 weeks</Ui>, <Ui>Custom…</Ui> (a number of
        days), or <Ui>No sprint — this workspace doesn&rsquo;t run one</Ui>. A sprint length needs a <Ui>Start date</Ui>
        : any day one of this workspace&rsquo;s sprints began. The cadence rolls forwards and backwards from it, so it
        sets where the boundaries fall, not when history starts.
      </p>
      <p>
        The sprint length sets this workspace&rsquo;s Reports periods and its &ldquo;Sprint to date&rdquo;. With no
        sprint, Reports cannot build sprint periods and uses rolling 14 days instead.
      </p>
      <H3>Comparison window</H3>
      <p>The window Reports measures, for the flow figures, activity and reach by repository, and Chronology:</p>
      <ul>
        <li>
          <Ui>Rolling 14 days (default)</Ui>: the last 14 days against the 14 before. Always a full window; best if the
          workspace does not run fixed sprints.
        </li>
        <li>
          <Ui>Rolling 7 days</Ui>: the last 7 days against the 7 before. A tighter, quicker read.
        </li>
        <li>
          <Ui>Sprint position (like-for-like)</Ui>: this sprint so far against the same point in the previous sprint
          (day 3 against day 3). With no sprint length it falls back to rolling 14 days.
        </li>
      </ul>
      <p>
        Open pull requests and red checks count what is open right now, so the window does not change them. See{' '}
        <DocLink to="reports/reporting-window">The reporting window</DocLink>.
      </p>
      <Warning title="Changing the sprint length moves the boundaries">
        Saving a new length or start date moves this workspace&rsquo;s period boundaries. Reports already made are kept
        unchanged and stay readable under <Ui>Earlier cadences</Ui> at the bottom of Reports. Limn warns you before you
        save.
      </Warning>
      <Note>
        This Sprint reads its sprint from your tracker or from GitHub milestones, not from this setting. See{' '}
        <DocLink to="this-sprint/overview">This Sprint</DocLink>.
      </Note>
    </>
  );
}
