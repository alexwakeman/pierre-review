import type { DocMeta } from '../../types';
import { Btn, Card, DocLink, H2, Illustration, Note, Pill, Steps, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Themes',
  summary: 'What each bot keeps saying, grouped into themes.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Themes</Ui> tab of Bots Monitoring sums up what your review bots keep raising. AI reads the bots’
        comments in the window and groups them into recurring themes, with how serious each theme is and where in the
        code it clusters. You read a short summary instead of hundreds of comments. The tab shows only while AI is on.
      </p>

      <WhoItHelps
        developer="Learn the mistakes the bots catch most often in your code, so you can avoid them before review."
        manager="See the recurring quality themes across the workspace, which can point to missing tests, a library that needs a wrapper, or a coding standard to agree."
      />

      <H2 id="what-you-see">What you see</H2>
      <Illustration
        label="A Themes report: a two-sentence summary, then a theme card 'Refund amounts handled as floats', Major, 14 comments in acme/payments"
        caption="A theme card: AI’s name and description for the theme, its severity, how many comments it covers and where they are."
      >
        <p>
          The bots mostly flag money handled as floating-point numbers and missing error handling around the payment
          provider. Most of it is in acme/payments.
        </p>
        <Card title="Refund amounts handled as floats" chip={<Pill tone="red">Major</Pill>}>
          <p>Amounts are parsed into floats before rounding, so a refund can be a penny out. 14 comments.</p>
          <p>Where: acme/payments · refunds/</p>
        </Card>
        <Card title="Provider errors swallowed" chip={<Pill tone="amber">Minor</Pill>}>
          <p>Calls to the payment provider catch errors and carry on. 9 comments.</p>
        </Card>
      </Illustration>
      <ul>
        <li>
          <strong>A summary</strong> of the window in a few sentences.
        </li>
        <li>
          <strong>A severity strip:</strong> how the themes split between critical, major, minor and nit.
        </li>
        <li>
          <strong>Theme cards,</strong> each with a name, a description, a severity, a category (such as{' '}
          <Ui>Correctness</Ui>, <Ui>Security</Ui>, <Ui>Error handling</Ui> or <Ui>Testing</Ui>), the comment count and{' '}
          <Ui>Where</Ui> in the code it appears. Select a theme to see its threads, or a pull request to open it.
        </li>
        <li>
          <strong>By reviewer:</strong> each bot’s comment count and the share of its threads later resolved or
          likely addressed.
        </li>
        <li>
          <strong>A coverage line,</strong> for example “Summarised 310 distinct points from 512 bot comments”, and
          when the summary was generated.
        </li>
      </ul>
      <Note title="What is counted and what is AI’s read">
        The themes and their wording are written by AI and are approximate. The comment counts, the per-theme counts
        and the <Ui>Where</Ui> lists are counted exactly.
      </Note>

      <H2 id="generate-a-summary">Generate a summary</H2>
      <Illustration label="The Generate button on the Themes tab" caption="Nothing is generated until you press the button.">
        <Btn tone="gold">Generate</Btn>
      </Illustration>
      <Steps>
        <li>
          Open <Ui>Bots Monitoring</Ui> and choose <Ui>Themes</Ui>.
        </li>
        <li>
          Check the window on the <Ui>ROI</Ui> tab. Themes uses the same window.
        </li>
        <li>
          Press <Ui>Generate</Ui>. The button says <Ui>Summarising…</Ui> while it runs.
        </li>
        <li>
          Later, press <Ui>Regenerate</Ui> for a fresh summary. Comments that have not changed are not read again.
        </li>
      </Steps>
      <p>
        A summary uses your own AI provider (see <DocLink to="integrations/claude">Claude</DocLink> or{' '}
        <DocLink to="integrations/codex">Codex</DocLink>) and counts towards your AI usage.
      </p>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        The numbers on <DocLink to="bots-monitoring/roi">ROI</DocLink> tell you how much a bot says. Themes tells you
        what it says. A theme that repeats every sprint is a fix worth making once, in the code or in your standards,
        rather than a comment to answer again on every pull request.
      </p>
    </>
  );
}
