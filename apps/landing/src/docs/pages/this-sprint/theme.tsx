import type { DocMeta } from '../../types';
import { Card, DocLink, FindingRow, H2, Illustration, Note, Pill, Steps, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'The Theme view',
  summary: "Tickets grouped by what they are about, so you can see where the sprint's effort goes.",
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Theme</Ui> view is the page This Sprint opens on. It puts the sprint&rsquo;s tickets in rows by area
        of work, such as &ldquo;Refunds&rdquo; or &ldquo;Ledger&rdquo;, rather than by epic. Each row tells you in a
        sentence what that work involves, and its status columns show how far it has got.
      </p>

      <WhoItHelps
        developer="Find the other tickets in your area of work, and see who else is changing the same part of the product."
        manager="See where the sprint's effort goes, which areas are nearly done and which have not started, without reading every ticket."
      />

      <H2 id="what-you-see">What you see</H2>
      <Illustration
        label="Two theme rows: Refunds with three tickets, Ledger with three tickets, each with a one-sentence summary and a status bar"
        caption="Theme rows: the theme's name and summary, the number of pull requests, then the tickets in their columns."
      >
        <Card title="Refunds" chip={<Pill>4 PRs</Pill>}>
          <p>Partial refunds and the customer emails and exports around them. Development work.</p>
          <FindingRow chip="In progress">PAY-150 Refund emails sent once</FindingRow>
          <FindingRow chip="Code review" tone="blue">
            PAY-142 Partial refunds
          </FindingRow>
          <FindingRow chip="Product review" tone="gold">
            PAY-139 Refund reasons in the export
          </FindingRow>
        </Card>
        <Card title="Ledger" chip={<Pill>2 PRs</Pill>}>
          <p>Moving the daily ledger to new tables and retiring the old nightly job. Development work.</p>
          <FindingRow chip="Not started" tone="grey">
            PAY-158 Retire the nightly ledger job
          </FindingRow>
          <FindingRow chip="In progress">PAY-146 Rename ledger tables</FindingRow>
        </Card>
      </Illustration>
      <ul>
        <li>
          <strong>One row per theme.</strong> AI names between three and eight themes for the sprint and puts every
          ticket in exactly one. Tickets that fit no theme go in a last row, <Ui>No theme</Ui>.
        </li>
        <li>
          <strong>The theme&rsquo;s summary.</strong> One or two sentences on what the work involves and whether it
          is development work or other work, such as design, content or testing. The summary has no numbers.
        </li>
        <li>
          <strong>A colour bar.</strong> The row&rsquo;s tickets by column. Hover over it, or move to it with the
          keyboard, to read the counts, for example &ldquo;2 In progress, 3 Product review, 8 Complete&rdquo; and
          &ldquo;4 with a pull request, 9 without&rdquo;. Limn counts these, not AI.
        </li>
        <li>
          <strong>Row order.</strong> Rows with the most pull requests come first. Each row header says its count,
          so you can check the order.
        </li>
      </ul>
      <p>
        An arrow between two tickets is drawn as critical when the two sit next to each other on a{' '}
        <DocLink to="this-sprint/critical-path">critical path</DocLink>.
      </p>

      <H2 id="what-you-can-do">What you can do</H2>
      <Steps>
        <li>Select a card to read its story in the panel on the right.</li>
        <li>
          Use the <Ui>Has PRs</Ui> and <Ui>Needs code</Ui> chips to hide tickets that will not reach the code, such
          as design or content tickets.
        </li>
        <li>Open a row&rsquo;s Complete cell to see what that theme has finished.</li>
      </Steps>

      <H2 id="before-themes-appear">Before themes appear</H2>
      <p>
        Themes are written after AI reads the sprint, and a sprint needs at least six tickets. Until then, the view
        shows one row, <Ui>All tickets</Ui>, and a line that says why: &ldquo;Themes appear after Claude reads the
        sprint.&rdquo;, or that AI is off. Themes are written again only when the sprint&rsquo;s tickets or their
        summaries change, so a status change costs nothing.
      </p>
      <Note>The themes and summaries are AI&rsquo;s reading of the ticket text. Status and pull requests are not sent to it.</Note>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        Epics are often too big or too old to say what a sprint is doing. Themes are made fresh for each sprint from
        the tickets in it, so a manager can say &ldquo;most of this sprint is refunds, and the ledger work has not
        started&rdquo; with the counts to back it.
      </p>
    </>
  );
}
