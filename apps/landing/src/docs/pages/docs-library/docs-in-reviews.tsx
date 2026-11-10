import type { DocMeta } from '../../types';
import { DocLink, FindingRow, H2, H3, Illustration, Note, SettingsRow, Steps, Toggle, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Docs in reviews',
  summary:
    "Let the AI review and the story check read the workspace's library, so a change that goes against your documented rules is found with the passage that says so.",
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        With docs on for reviews, the AI review of a pull request and the story check of a ticket can read your
        library. They look for passages that bear on the change or the story, and report each one with a quote: does
        the passage support it, contradict it, or just give context? This setting is off until you turn it on, per
        workspace.
      </p>

      <WhoItHelps
        developer="Learn in the review, not in production, that the retry change breaks the documented idempotency rule, with the rule quoted."
        manager="Make sure the team's written decisions are checked on every pull request, not only when the right reviewer is looking."
      />

      <H2 id="turn-it-on">Turn it on</H2>
      <Steps>
        <li>
          Open <Ui>Settings → Docs</Ui>.
        </li>
        <li>
          Turn on <Ui>Use reference docs in AI Review</Ui> and press <Ui>Save</Ui>. It applies to this workspace only.
        </li>
        <li>Make sure the library has at least one built document.</li>
      </Steps>
      <Illustration label="Settings → Docs with Use reference docs in AI Review switched on" caption="The setting, in Settings → Docs.">
        <SettingsRow
          label="Use reference docs in AI Review"
          hint="Applies to this workspace only."
          control={<Toggle on />}
        />
      </Illustration>

      <H2 id="what-changes">What changes</H2>
      <H3 id="in-a-pull-request-review">In a pull request review</H3>
      <p>
        The review checks the change against the rules and requirements the library documents. In the pull
        request&rsquo;s <Ui>AI Review</Ui> tab:
      </p>
      <ul>
        <li>
          A <Ui>Reference docs</Ui> section lists the passages the review used, with counts of how many support or
          contradict the change. If the library has nothing that bears on it: &ldquo;Nothing in the library bears on
          this change.&rdquo;
        </li>
        <li>A finding that rests on the library carries a line &ldquo;Reference: Document › Section&rdquo;.</li>
      </ul>
      <Illustration
        label="A review finding with a reference line to Payments handbook, Idempotency"
        caption="A finding that rests on a document names the section."
      >
        <FindingRow chip="Major" tone="red">
          The retry sends a new idempotency key each time, so a slow payment can be charged twice. Reference:
          Payments handbook › Idempotency
        </FindingRow>
      </Illustration>

      <H3 id="in-a-story-check">In a story check</H3>
      <p>
        The <DocLink to="story-checks/overview">story check</DocLink> looks for passages that bear on the story and
        reports every contradiction between the story, its criteria or its code and the library, plus support where
        the library backs it. These show in a compact block in the Story check section.
      </p>

      <H2 id="what-stays-the-same">What stays the same</H2>
      <ul>
        <li>The reviewer can read the library and nothing else new. It cannot change a document.</li>
        <li>
          Limn checks every reference before it shows it: the link must name a real section of a built document, and
          the quote must really be in that section. Anything else is dropped.
        </li>
        <li>References are not posted to GitHub; a link to your local library would mean nothing there.</li>
        <li>A change to the library does not make an earlier review out of date.</li>
        <li>With the setting off, reviews run exactly as they did before.</li>
      </ul>
      <Note>
        Reading the library makes a review a little longer, so it uses a little more of your AI allowance. Before a
        review or story check reads a Confluence, Notion or GitHub document, Limn checks it for changes if it has not
        done so in the last 15 minutes. The run does not wait for that check.
      </Note>

      <H2 id="other-uses">Other uses of the library</H2>
      <ul>
        <li>
          <DocLink to="story-checks/check-against-docs">Check against docs</DocLink> works without this setting: you
          press the button on a ticket.
        </li>
        <li>
          <DocLink to="implement-story/overview">Implement story</DocLink> can give its agent a copy of the sections
          that bear on the ticket.
        </li>
        <li>This Sprint&rsquo;s summaries, themes and critical paths do not read the library.</li>
      </ul>
    </>
  );
}
