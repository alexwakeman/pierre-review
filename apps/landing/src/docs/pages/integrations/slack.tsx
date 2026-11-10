import type { DocMeta } from '../../types';
import { Card, DocLink, ExtLink, Field, FindingRow, H2, H3, Illustration, Note, Section, Steps, TextBox, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Slack',
  summary: 'Send a team digest and selected events to a Slack channel.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Limn can post a digest of a workspace’s Pending board to a Slack channel, once or twice a day, with a short
        sprint summary. It can also post when an auto review finishes and when a pull request merges. The digest is
        about the team’s work, so it never includes your own My turn list. Limn posts through a Slack incoming
        webhook; it needs no Slack app permissions beyond that.
      </p>


      <H2 id="what-you-need">What you need</H2>
      <ul>
        <li>
          A Slack incoming webhook for the channel. Create one at{' '}
          <ExtLink href="https://api.slack.com/apps">api.slack.com/apps</ExtLink> → Incoming Webhooks.
        </li>
        <li>Limn running on your computer at the times the digest is due.</li>
      </ul>
      <Warning title="One person per channel">
        Limn runs on each person’s own computer. If two teammates point their Limn at the same channel, both post, and
        the channel gets two copies. Agree who sets it up.
      </Warning>

      <H2 id="set-it-up">Set it up</H2>
      <Illustration
        label="The Slack section of Settings → Integrations: a webhook URL, cadence Twice daily, send at 09:00 and 14:00"
        caption="Settings → Integrations → Slack, for one workspace."
      >
        <Section title="Slack" desc="Sends this workspace’s Pending board, sprint summary, merges and auto reviews to a Slack channel.">
          <Field label="Incoming webhook URL">
            <TextBox value="https://hooks.slack.com/services/…" mono />
          </Field>
          <Field label="Cadence">
            <TextBox value="Twice daily" />
          </Field>
          <Field label="Send at">
            <TextBox value="09:00" />
          </Field>
          <Field label="And at">
            <TextBox value="14:00" />
          </Field>
        </Section>
      </Illustration>
      <Steps>
        <li>
          Open <DocLink to="settings/integrations">Settings → Integrations</DocLink> and find <Ui>Slack</Ui>. It applies
          to the workspace you have selected.
        </li>
        <li>
          Paste the <Ui>Incoming webhook URL</Ui>.
        </li>
        <li>
          Choose a <Ui>Cadence</Ui>: <Ui>Daily</Ui> or <Ui>Twice daily</Ui>, and the times under <Ui>Send at</Ui> and{' '}
          <Ui>And at</Ui>.
        </li>
        <li>
          Tick what else to send: <Ui>Include a review-bot summary</Ui>, <Ui>Post when an auto review finishes</Ui> and{' '}
          <Ui>Post when a pull request merges</Ui>.
        </li>
        <li>
          Press <Ui>Save</Ui>, then <Ui>Send test</Ui> and check the channel.
        </li>
      </Steps>
      <Note>
        The webhook URL is stored on your computer and never shown again. To change it, enter a new URL and save.
      </Note>

      <H2 id="what-the-digest-says">What the digest says</H2>
      <Illustration
        label="A Slack digest: Needs fixing with two pull requests, Waiting on review with one, Ready to land with one, then a sprint summary"
        caption="A digest: the team’s Pending tabs, then a short sprint summary. Links open Limn."
      >
        <Card title="acme · Pending">
          <FindingRow chip="Needs fixing" tone="red">
            #612 Partial refunds · CI red on test-unit
          </FindingRow>
          <FindingRow chip="Waiting on review" tone="amber">
            #488 Webhook timeouts · 2 days, no review
          </FindingRow>
          <FindingRow chip="Ready to land" tone="green">
            #476 Ledger index · approved, checks green
          </FindingRow>
          <p>Sprint: refunds work is in review; the ledger rename has not started.</p>
        </Card>
      </Illustration>
      <ul>
        <li>
          <strong>The team’s Pending tabs:</strong> <Ui>Needs fixing</Ui>, <Ui>Waiting on review</Ui>,{' '}
          <Ui>Unanswered threads</Ui>, <Ui>Ready to land</Ui> and <Ui>Dependencies</Ui>, the top 5 of each, every pull
          request once. My turn and other personal lists are left out, and nothing in the digest names you.
        </li>
        <li>
          <strong>A short sprint summary,</strong> written by AI. It is not rewritten when the workspace’s activity has
          not changed. If you are over your AI spend limit, the digest still goes out with the last summary.
        </li>
        <li>
          <strong>A review-bot summary,</strong> if ticked: each review bot’s comment count, the share your team used
          and the number left untouched.
        </li>
      </ul>

      <H3 id="event-messages">Event messages</H3>
      <ul>
        <li>
          <Ui>Post when an auto review finishes</Ui>: the pull request, its verdict and the review’s summary, not the
          comments. Reviews you start yourself are never posted.
        </li>
        <li>
          <Ui>Post when a pull request merges</Ui>: the pull request and who merged it. Sent once per pull request,
          only for merges Limn sees as they happen, not for old merges found in a sync.
        </li>
      </ul>
      <p>Both are off until you tick them. Each message is sent once and never retried.</p>

      <H2 id="turn-it-off">Pause or stop</H2>
      <ul>
        <li>
          To pause, set <Ui>Cadence</Ui> to <Ui>Off (paused, channel kept)</Ui>. The webhook is kept. Event messages
          you ticked still post.
        </li>
        <li>
          To stop, press <Ui>Stop sending (delete the channel)</Ui>. This deletes the stored webhook.
        </li>
      </ul>
      <p>
        Only a few workspaces can have a digest at once, because each one writes its own sprint summary; the section
        says when you reach the limit. For the board itself, see <DocLink to="pending/overview">Pending</DocLink>.
      </p>
    </>
  );
}
