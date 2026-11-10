import type { DocMeta } from '../../types';
import { DocLink, H2, Illustration, MiniTable, Note, Pill, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'AI reviews',
  summary: 'The newest AI review on each pull request, with the ones that are new since you last looked.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>AI reviews</Ui> tab on <Ui>Pending</Ui> lists the newest AI review on each pull request in the
        workspace, open or closed, newest first: reviews you ran, reviews auto review ran, and reviews your
        teammates ran with their own Limn and posted. It is a reference list. Nothing here is scored, and
        looking at it never removes a row.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <p>
        The heading is <Ui>Latest AI review on each pull request</Ui>. Each row shows:
      </p>
      <ul>
        <li>the pull request (choose it to open its <DocLink to="pull-request/ai-review-tab">AI Review tab</DocLink>);</li>
        <li>
          who ran the review: <Ui>Your Limn</Ui>, <Ui>Your Limn, auto review</Ui>, or a teammate's Limn with
          their name and picture;
        </li>
        <li>
          the verdict: <Ui>Approve</Ui>, <Ui>Request changes</Ui> or <Ui>Comment</Ui>;
        </li>
        <li>the number of findings (praise is not counted), or <Ui>No findings</Ui>;</li>
        <li>when it finished.</li>
      </ul>
      <p>
        A review by Claude and Codex together counts as one review, with one verdict and both halves'
        findings. See <DocLink to="ai-review/claude-and-codex">Claude and Codex together</DocLink>.
      </p>

      <Illustration
        label="The AI reviews tab: three rows, the first two tagged New."
        caption="AI reviews, with two rows new since your last look."
      >
        <MiniTable
          cols={[
            { key: 'pr', label: 'Pull request' },
            { key: 'by', label: 'Ran by' },
            { key: 'v', label: 'Verdict' },
            { key: 'n', label: 'Findings', num: true },
          ]}
          rows={[
            { _key: 'a', pr: <>#612 Partial refunds <Pill tone="blue">New</Pill></>, by: 'Your Limn, auto review', v: <Pill tone="red">Request changes</Pill>, n: '3' },
            { _key: 'b', pr: <>#482 Retry budget <Pill tone="blue">New</Pill></>, by: 'Priya’s Limn', v: <Pill tone="green">Approve</Pill>, n: '0' },
            { _key: 'c', pr: '#1184 Checkout redesign', by: 'Your Limn', v: <Pill>Comment</Pill>, n: '2' },
          ]}
        />
      </Illustration>

      <H2 id="new-and-seen">New and seen</H2>
      <p>
        The tab's number counts the reviews that are new since you last looked at the tab in this workspace.
        Those rows carry a <Ui>New</Ui> tag while you are on the tab. Rows you saw on earlier visits are grouped
        under headings such as <Ui>Seen today 14:32</Ui> or <Ui>Seen yesterday 09:10</Ui>, newest visit first.
        A re-review of a pull request is new again.
      </p>
      <Note>
        The seen groups are kept in this browser. Another browser, or a review seen before you used this tab,
        shows without a group heading. The New count itself is kept by Limn for each workspace.
      </Note>

      <H2 id="where-else">Where else AI reviews show</H2>
      <ul>
        <li>
          The <DocLink to="open-pull-requests/ai-review-column">AI review column</DocLink> on Open pull requests.
        </li>
        <li>
          The AI review card on each pull request's <DocLink to="pull-request/overview-tab">Overview tab</DocLink>.
        </li>
      </ul>
      <p>
        This tab is counted only here. It never adds to My turn, the notifications or Slack.
      </p>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        Auto review and your teammates can run reviews while you are away. This tab is where you catch up: one
        line per pull request, the newest review only, with what is new marked for you.
      </p>
    </>
  );
}
