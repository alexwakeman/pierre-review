import type { DocMeta } from '../../types';
import { DocLink, Field, H2, Illustration, MiniTable, Note, Section, Steps, TextBox, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'The reporting window',
  summary: 'Every headline figure in Reports covers one stated window. Anything else says so in its heading.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The reporting window is the stretch of time that Reports measures. Each workspace has one. Limn works it out
        once for each page you open, and every headline figure on that page uses it: the flow metrics, the two
        repository cards, the first option in Chronology, Stories and AI usage. Its name is printed beside each
        figure that uses it, so you never have to guess which dates a number covers.
      </p>


      <H2 id="the-three-choices">The three choices</H2>
      <MiniTable
        cols={[
          { key: 'opt', label: 'Comparison window' },
          { key: 'measures', label: 'What it measures' },
          { key: 'name', label: 'Shown as' },
        ]}
        rows={[
          {
            _key: '14',
            opt: 'Rolling 14 days (default)',
            measures: 'The last 14 days against the 14 before. Always a full window; no sprint needed.',
            name: 'Last 14 days',
          },
          {
            _key: '7',
            opt: 'Rolling 7 days',
            measures: 'The last 7 days against the 7 before. A quicker read of momentum.',
            name: 'Last 7 days',
          },
          {
            _key: 'sprint',
            opt: 'Sprint position (like-for-like)',
            measures: 'This sprint so far against the same point in the previous sprint, for example day 3 against day 3.',
            name: 'This sprint so far (day 3 of 14)',
          },
        ]}
      />
      <p>
        <Ui>Sprint position (like-for-like)</Ui> compares like with like. Day 3 of a sprint is never compared with a
        whole finished sprint, so the start of every sprint does not look like a slump.
      </p>

      <H2 id="set-the-window">Set the window</H2>
      <Illustration
        label="The Sprint cadence and comparison window section of Settings, with a sprint length of 2 weeks, a start date, and the comparison window set to Sprint position (like-for-like)"
        caption="Settings → Reports and sprint: the sprint cadence and the comparison window, saved together for one workspace."
      >
        <Section title="Sprint cadence and comparison window" desc="Applies to this workspace only. Every other workspace sets its own.">
          <Field label="Sprint length">
            <TextBox value="2 weeks" />
          </Field>
          <Field label="Start date" hint="Any day one of this workspace’s sprints began.">
            <TextBox value="13 Oct 2026" />
          </Field>
          <Field label="Comparison window">
            <TextBox value="Sprint position (like-for-like)" />
          </Field>
        </Section>
      </Illustration>
      <Steps>
        <li>
          Open <Ui>Settings</Ui> and choose the <Ui>Reports and sprint</Ui> tab.
        </li>
        <li>
          Under <Ui>Sprint cadence and comparison window</Ui>, choose a <Ui>Sprint length</Ui> (1 to 4 weeks, or{' '}
          <Ui>Custom…</Ui>), or <Ui>No sprint — this workspace doesn’t run one</Ui>.
        </li>
        <li>
          Set the <Ui>Start date</Ui> to any day one of your sprints began. Limn counts forwards and backwards from it
          to find every sprint boundary, so it does not need to be the first sprint.
        </li>
        <li>
          Choose the <Ui>Comparison window</Ui>, then press <Ui>Save</Ui>.
        </li>
      </Steps>
      <Note title="With no sprint, the sprint choice falls back">
        If you choose <Ui>Sprint position (like-for-like)</Ui> but the workspace has no sprint length or start date,
        Reports measures the last 14 days, and its labels say <Ui>Last 14 days</Ui>. A window is always named by what
        was measured, not by the setting.
      </Note>
      <p>
        Changing the sprint length moves the period boundaries. A line warns you before you save. Reports already
        made at the old length are kept, and stay readable under <Ui>Earlier cadences</Ui> at the bottom of the
        Reports page. Each workspace keeps its own setting; one workspace never inherits another’s.
      </p>

      <H2 id="the-labelled-exceptions">The labelled exceptions</H2>
      <p>A few figures are deliberately not tied to the window. Each one says so in its own heading:</p>
      <ul>
        <li>
          <Ui>Right now</Ui>: <Ui>Open pull requests</Ui> and <Ui>Red checks now</Ui> count what is open at this
          moment.
        </li>
        <li>
          <Ui>Last 12 weeks</Ui>: the weekly trend charts under the flow metrics, and the 12-week chart on AI usage.
        </li>
        <li>
          <Ui>Period reports</Ui>: completed sprints or months, plus the period in progress.
        </li>
        <li>
          Chronology’s <Ui>30 days</Ui>, <Ui>60 days</Ui> and <Ui>90 days</Ui> options, and its{' '}
          <Ui>Over time</Ui> charts for the last 26 weeks.
        </li>
      </ul>
      <p>
        Bots Monitoring has its own window picker (<Ui>7d</Ui>, <Ui>14d</Ui>, <Ui>30d</Ui>, <Ui>Sprint</Ui>), shared by
        its tabs. See <DocLink to="bots-monitoring/roi">ROI</DocLink>.
      </p>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        When two figures on one screen cover different dates, readers join them up anyway and draw the wrong
        conclusion. One window per page, named beside every figure, stops that. Where a figure needs a different
        span to make sense, it says so in its heading. See <DocLink to="reports/overview">Read the Overview</DocLink>{' '}
        for the figures themselves.
      </p>
    </>
  );
}
