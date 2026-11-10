import type { DocMeta } from '../../types';
import { Btn, Card, Chip, DocLink, H2, Illustration, Note, Steps, Thread, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Ask about a review',
  summary: 'Ask follow-up questions about a review and the code it covers.',
};

function ChatPicture(): JSX.Element {
  return (
    <Illustration
      label="The Review chat of pull request 612. One finding is pinned. The answer card for it has three parts: What it means, Why it matters, What would fix it."
      caption="Review chat: a finding sent to chat, and the card that explains it."
      title="Review chat"
      meta="#612 Partial refunds"
    >
      <p>
        <Chip tone="red">Blocker · RefundPolicy.allows() never reads paid_at</Chip>
      </p>
      <Card title="What it means">allows() only looks at the order's status, so an old paid order still passes.</Card>
      <Card title="Why it matters">Refunds after the 30-day window go through, which PAY-142 forbids.</Card>
      <Card title="What would fix it">Compare order.paid_at with the refund window before returning True.</Card>
      <Thread comments={[{ who: 'You', text: 'Is the window 30 calendar days or 30 working days?' }]} />
      <p>
        <Btn tone="go">Ask</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        A finding is short by design. When you want to know more (why it matters, whether it really applies, what a fix
        would look like), ask in the <Ui>Review chat</Ui>. The chat knows the whole review and the code it read, so
        you do not have to explain the context.
      </p>

      <H2 id="ask-a-question">Ask a question</H2>
      <Steps>
        <li>
          Open the pull request's <Ui>AI Review</Ui> tab. The <Ui>Review chat</Ui> section is under <Ui>Story check</Ui>{' '}
          and open by default. <Ui>Hide</Ui> closes it; when it is closed, the button to open it reads, for example, <Ui>Ask Claude about this review</Ui>.
        </li>
        <li>Type your question.</li>
        <li>
          Press <Ui>Ask</Ui>. The question shows at once and the answer follows. The button reads <Ui>Answering…</Ui>{' '}
          meanwhile.
        </li>
      </Steps>
      <p>
        There is one chat per review, and it covers every finding. A new review of the same pull request starts with an
        empty chat. One answer runs at a time.
      </p>

      <H2 id="explain-findings">Explain findings</H2>
      <ChatPicture />
      <Steps>
        <li>
          On a finding, press <Ui>Send to chat</Ui>. It is pinned to the chat as a pill. You can pin up to ten,
          including a story check's unmet items.
        </li>
        <li>
          Add a question if you want, or just press <Ui>Ask</Ui> to explain them.
        </li>
        <li>
          Read one card per pinned item: <Ui>What it means</Ui>, <Ui>Why it matters</Ui>, where it is, and{' '}
          <Ui>What would fix it</Ui>.
        </li>
      </Steps>

      <H2 id="what-it-can-read">What it can read</H2>
      <ul>
        <li>The pull request's title and description, the review's verdict, summary and every finding, with your rewording.</li>
        <li>The ticket's story and its check, and the follow-up of earlier findings.</li>
        <li>
          After a deep review: the repository at the commit that was reviewed, so it can open other files. After a quick
          review: the diff only.
        </li>
      </ul>
      <p>
        The chat can read; it cannot change files, run commands or reach the web. If the pull request has new commits
        since the review, the chat says <Ui>Answers are about the reviewed commit; the PR has moved on.</Ui> Run a new
        review to talk about the new code.
      </p>

      <H2 id="earlier-chats">Earlier chats</H2>
      <p>
        <Ui>Earlier reviews' chats</Ui>, under the chat, lists the chats of earlier reviews of the pull request. Pick
        one to read it. Earlier chats are read-only.
      </p>
      <Note>
        Each answer uses your own AI subscription or API key, with a small cap per answer on an API key. The chat stays
        on your computer and is never posted or shared with teammates. See{' '}
        <DocLink to="settings/ai-usage-and-spend">AI usage and spend</DocLink>.
      </Note>
    </>
  );
}
