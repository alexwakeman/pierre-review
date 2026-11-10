import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Steps, TextBox, Thread, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Read and ask',
  summary:
    'Read any document in Limn, section by section, or ask a question and get an answer that links and quotes the sections it comes from.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Once a document is built you can read it in Limn, and you can ask questions about the whole library in plain
        words. The answers come from your documents only, and each point links to the section it used.
      </p>


      <H2 id="read-a-document">Read a document</H2>
      <Steps>
        <li>
          Open <Ui>Docs</Ui> in the sidebar.
        </li>
        <li>
          In <Ui>Library</Ui>, select a document. Its contents tree opens with its top-level chapters. Use the
          small arrow beside a row to open the sections under it, or <Ui>Expand all</Ui> and <Ui>Collapse all</Ui>{' '}
          above the tree.
        </li>
        <li>Select a section to read it in the middle of the page.</li>
      </Steps>
      <p>
        Each section starts with a trail (document › chapter › section) and <Ui>Previous</Ui> /{' '}
        <Ui>Contents</Ui> / <Ui>Next</Ui> links. Links between sections open in Limn. A document from the web or a
        wiki keeps a link to its source, through <Ui>Open the source</Ui>. <Ui>All documents</Ui> shows the whole
        library with a summary of each document.
      </p>

      <H2 id="ask-a-question">Ask a question</H2>
      <Illustration
        label="The Docs chat: a question about the refund window and an answer quoting the refund policy with a link to its Time limits section"
        caption="An answer from the library. Each link opens the section with the quoted words highlighted."
      >
        <Thread
          comments={[
            { who: 'You', text: 'How long can a customer ask for a refund?' },
            {
              who: 'Claude',
              text: 'Within 30 days of payment: "Refunds are accepted within 30 days of payment." (Refund policy › Time limits). After that the handbook offers a voucher (Payments handbook › Vouchers).',
            },
          ]}
        />
        <TextBox value="Ask about these docs" />
      </Illustration>
      <Steps>
        <li>
          Type your question in <Ui>Ask about these docs</Ui> and press Enter.
        </li>
        <li>Read the answer. Select a link to open the section it quotes, with the quoted words highlighted.</li>
        <li>Ask a follow-up. The chat remembers the earlier questions in the conversation, up to a limit.</li>
        <li>
          Press <Ui>New conversation</Ui> to start again. Earlier conversations stay in the list until you delete
          them.
        </li>
      </Steps>

      <H3 id="what-the-answer-is-built-from">What the answer is built from</H3>
      <ul>
        <li>
          Limn first finds the sections that best match your question and gives them to AI to start from. AI can
          then open other sections of the library.
        </li>
        <li>AI is told to answer from the library only, and to say so when the library does not cover the question.</li>
        <li>When two documents disagree, it cites both.</li>
        <li>
          Limn keeps a link only when it names a real section of a built document in this workspace, and keeps a
          quote only when the words are really in that section. Anything else is dropped.
        </li>
      </ul>
      <Note>
        The chat reads your library and changes nothing. It runs on your own AI provider, so each answer uses some of
        your subscription or costs a little on an API key. See{' '}
        <DocLink to="settings/ai-usage-and-spend">AI usage and spend</DocLink>.
      </Note>

      <H2 id="highlighted-quotes">Highlighted quotes</H2>
      <p>
        Any link that carries a quote, from the chat, a review, a story check or a docs check, opens the section
        scrolled to the passage, highlighted, with one line above the page: &ldquo;The quoted passage is
        highlighted.&rdquo; If the document was rebuilt and the words are gone, the line says &ldquo;The quoted words
        are no longer in this section.&rdquo; and you land on the section instead.
      </p>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        An answer with the passage beside it can be trusted or checked in seconds. Because every quote is checked
        against the document, the chat cannot invent a rule and put your document&rsquo;s name on it. To find a word
        rather than ask a question, use <DocLink to="docs-library/search">Search the docs</DocLink>.
      </p>
    </>
  );
}
