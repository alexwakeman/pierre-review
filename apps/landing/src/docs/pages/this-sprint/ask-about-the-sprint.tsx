import type { DocMeta } from '../../types';
import { Btn, DocLink, H2, Illustration, Note, Steps, TextBox, Thread, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Ask about the sprint',
  summary: "Ask a question about the sprint in plain words, and get a short answer from the sprint's tickets, pull requests and links.",
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>Ask Claude about this sprint</Ui> is a small chat under the This Sprint toolbar. Type a question about
        the sprint, such as &ldquo;what is blocking the work in review?&rdquo;, and get a short answer. Ticket keys in
        the answer are links: select one to read that ticket&rsquo;s story beside the board. If Codex is your AI
        provider, the button and the heading say Codex instead of Claude.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <Illustration
        label="The sprint chat: a question about what blocks the work in review, and a short answer that names two ticket keys"
        caption="A question and its answer. Each ticket key in the answer opens that ticket's story."
      >
        <Thread
          comments={[
            { who: 'You', text: 'What is blocking the work in review?' },
            {
              who: 'Claude',
              text: 'PAY-142 is in code review with failing CI. PAY-158 cannot start until PAY-146, the table rename, is finished.',
            },
          ]}
        />
        <TextBox value="Ask about this sprint" />
        <Btn>Ask</Btn>
      </Illustration>

      <H2 id="what-you-can-do">What you can do</H2>
      <Steps>
        <li>
          Open <Ui>This Sprint</Ui> and press <Ui>Ask Claude</Ui> in the toolbar.
        </li>
        <li>Type your question and press <Ui>Ask</Ui>.</li>
        <li>Ask a follow-up. The chat remembers the earlier questions in this conversation, up to a limit.</li>
        <li>Select a ticket key in an answer to read its story.</li>
        <li>
          Press <Ui>Clear</Ui> to start again, or close the panel.
        </li>
      </Steps>

      <H2 id="what-it-knows">What it knows</H2>
      <p>The answer comes only from what Limn already holds about this sprint:</p>
      <ul>
        <li>each ticket&rsquo;s title, column, status, assignee, epic, one-paragraph summary and criteria count;</li>
        <li>the ticket&rsquo;s pull requests and their state;</li>
        <li>the links between tickets;</li>
        <li>
          the stored <DocLink to="this-sprint/critical-path">critical paths</DocLink> and call-outs.
        </li>
      </ul>
      <p>
        It does not read the code, the tracker or your reference docs while it answers, and it changes nothing. It is
        asked not to rank people. For a question about the code, use a review chat on the pull request; for your
        team&rsquo;s documents, use the <DocLink to="docs-library/read-and-ask">Docs chat</DocLink>.
      </p>
      <Note>
        The conversation is kept only while you stay on the page. Each answer runs on your own AI provider, and the
        line under it shows what it used: a share of your subscription&rsquo;s week, or a cost in US$ on an API key.
        See <DocLink to="settings/ai-usage-and-spend">AI usage and spend</DocLink>.
      </Note>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        The board answers &ldquo;where is everything?&rdquo;. A question answers the one thing you need now, in a
        sentence you can paste into a stand-up note, with each ticket it names one click away.
      </p>
    </>
  );
}
