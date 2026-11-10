import type { DocMeta } from '../../types';
import { Btn, Card, DocLink, FindingRow, H2, Illustration, Note, Pill, Steps, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Check against docs',
  summary:
    "Compare a ticket's story with your team's reference docs and see, with quotes, where they agree and where they disagree.",
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>Check against docs</Ui> reads a ticket&rsquo;s story and criteria against the workspace&rsquo;s{' '}
        <DocLink to="docs-library/overview">docs library</DocLink>: your specifications, design notes, policies and
        wiki pages. It tells you where the ticket matches what the docs say, where it goes against them, and what to
        do about it. Every point quotes the passage it rests on.
      </p>


      <H2 id="what-you-need">What you need</H2>
      <ul>
        <li>At least one built document in the workspace&rsquo;s library.</li>
        <li>AI set up in <DocLink to="settings/ai">Settings → AI</DocLink>.</li>
      </ul>
      <p>
        This check does not need <Ui>Use reference docs in AI Review</Ui> to be on. That setting is about
        reviews; pressing the button is enough here.
      </p>

      <H2 id="run-the-check">Run the check</H2>
      <Steps>
        <li>
          Open the ticket&rsquo;s <DocLink to="this-sprint/story-view">story view</DocLink>.
        </li>
        <li>
          Press <Ui>Check against docs</Ui> in the Ticket section&rsquo;s heading. The button reads{' '}
          <Ui>Checking…</Ui> while it runs, with &ldquo;Choosing sections…&rdquo; and then &ldquo;Reading the
          docs…&rdquo; under a progress bar.
        </li>
        <li>
          Read the result in the <Ui>Docs check</Ui> block. To run it again, press <Ui>Check docs again</Ui>.
        </li>
      </Steps>

      <H2 id="what-you-see">What you see</H2>
      <Illustration
        label="A docs check result: Goes against the docs, a two-sentence summary, one What to do point quoting the refund policy, and a note under criterion 3"
        caption="A Docs check block. Each point links to the section it quotes."
      >
        <Card title="Docs check" chip={<Pill tone="red">Goes against the docs</Pill>}>
          <p>
            The ticket allows refunds for 60 days. The refund policy allows 30 days, and the finance handbook relies
            on that limit.
          </p>
          <p>
            <b>What to do</b>
          </p>
          <FindingRow chip="Differs" tone="red">
            Agree the refund window with finance before building criterion 3. Refund policy › Time limits:
            &ldquo;Refunds are accepted within 30 days of payment.&rdquo;
          </FindingRow>
          <p>
            <Btn>Check docs again</Btn>
          </p>
        </Card>
      </Illustration>
      <ul>
        <li>
          <strong>A verdict</strong>: <Ui>Matches the docs</Ui>, <Ui>Partly matches the docs</Ui> or{' '}
          <Ui>Goes against the docs</Ui>.
        </li>
        <li>
          <strong>A summary</strong> of two or three sentences.
        </li>
        <li>
          <strong>What to do</strong>: a few concrete steps.
        </li>
        <li>
          <strong>A note under each criterion</strong> the docs bear on, marked <Ui>Matches</Ui>, <Ui>Partly</Ui>{' '}
          or <Ui>Differs</Ui>.
        </li>
        <li>
          <strong>Other parts of the ticket</strong>: points about the story that are not one criterion.
        </li>
      </ul>
      <p>
        Select a reference to open the section in <Ui>Docs</Ui>, scrolled to the quoted passage and highlighted.
        When nothing in the library bears on the ticket, the block says so in one line.
      </p>

      <H2 id="how-it-decides">How it decides</H2>
      <ul>
        <li>
          It checks the criteria from the latest story check, else the ticket&rsquo;s own, else a list AI works out
          from the description (and says so).
        </li>
        <li>
          With a small library, AI reads all of it. With a large one, Limn first finds the sections that share words
          with the ticket, AI picks up to eight of them, and then reads only those.
        </li>
        <li>
          Every point must quote a section of your library, and Limn checks that the quote is really there. A point
          with no checked quote is dropped, never shown. So the check can say less than AI wrote, but never
          something your docs do not say.
        </li>
      </ul>

      <H2 id="when-nothing-has-changed">When nothing has changed</H2>
      <p>
        If the story, the criteria and the library are the same as at the last check, pressing the button again
        gives the same result at no cost, with &ldquo;Nothing has changed since this check.&rdquo; Press{' '}
        <Ui>Check again anyway</Ui> to run it fresh. When the ticket or the library changes, the result is marked{' '}
        <Ui>Out of date</Ui>.
      </p>
      <Note>
        The docs check runs only when you press the button. It never runs by itself and never posts to GitHub. Each
        check is a run on your AI provider, and you can run up to 30 a day.
      </Note>
    </>
  );
}
