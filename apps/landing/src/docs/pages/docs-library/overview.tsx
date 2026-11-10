import type { DocMeta } from '../../types';
import { AppShell, Card, DocLink, H2, Illustration, Note, Pill, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'What the docs library is for',
  summary:
    "Add your team's specifications, design notes and wikis once. Limn turns them into a library you can read and search, answers questions from it, and uses it in reviews and story checks.",
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>Docs</Ui> is the workspace&rsquo;s reference library. You add the documents your team works from: a
        product specification, a refund policy, architecture notes, a Confluence space, a Notion wiki, the{' '}
        <code>docs</code> folder of a repository. Limn turns each one into a tree of short sections with a one-line
        summary each. Then you, the AI reviewer and the story check can all use the same library.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <Illustration
        label="The Docs page: the Library list on the left with three documents, a section open in the middle, and the chat on the right"
        caption="Docs: the library, the document you are reading, and the chat."
      >
        <AppShell active="Docs">
          <Card title="Library" chip={<Pill>3 documents</Pill>}>
            <p>Search</p>
            <p>All documents</p>
            <p>Refund policy · PDF · 6 sections</p>
            <p>Payments handbook · Confluence · 12 pages · 40 sections</p>
            <p>acme/payments docs · GitHub · 9 documents</p>
          </Card>
          <Card title="Refund policy › Time limits">
            <p>Refunds are accepted within 30 days of payment. After that, the customer is offered a voucher.</p>
          </Card>
        </AppShell>
      </Illustration>
      <p>The page has three parts:</p>
      <ul>
        <li>
          <strong>The Library</strong>, on the left: every document with its state and, inside each, its contents
          tree. <Ui>All documents</Ui> opens the list of everything in the library, each with a summary. The{' '}
          <Ui>+</Ui> button adds documents.
        </li>
        <li>
          <strong>The viewer</strong>, in the middle: one section at a time. Every link inside it opens in Limn.
        </li>
        <li>
          <strong>The chat</strong>, on the right (a <Ui>Read</Ui> and <Ui>Ask</Ui> tab on a narrow screen): ask a
          question and get an answer that cites the sections it used.
        </li>
      </ul>

      <H2 id="what-the-library-does">What the library does</H2>
      <ul>
        <li>
          <DocLink to="docs-library/add-documents">Add documents</DocLink>: upload files, add web pages, or connect
          Confluence, Notion or a GitHub repository.
        </li>
        <li>
          <DocLink to="docs-library/read-and-ask">Read and ask</DocLink>: read the library in Limn, and ask questions.
        </li>
        <li>
          <DocLink to="docs-library/search">Search the docs</DocLink>: find a passage across every document.
        </li>
        <li>
          <DocLink to="docs-library/docs-in-reviews">Docs in reviews</DocLink>: let the AI review and the story check
          read the library.
        </li>
        <li>
          <DocLink to="story-checks/check-against-docs">Check against docs</DocLink>: compare a ticket with the
          library.
        </li>
      </ul>

      <H2 id="how-a-document-is-built">How a document is built</H2>
      <p>
        When you add a document, Limn splits it into sections at its headings and AI writes a one-line summary of
        each section and a short summary of the document. That is the &ldquo;build&rdquo;. It runs on your machine
        with your own AI provider, one document at a time, and the line under the document shows how far it has got
        (&ldquo;Summarising sections (3 of 12)&rdquo;). A document you can read is &ldquo;built&rdquo;. If a build
        fails, the document says why and offers <Ui>Try again</Ui>.
      </p>
      <p>
        Images and diagrams in a document are described in words where Limn can, so the text of a diagram can be
        searched and quoted too.
      </p>

      <Note>
        Docs needs AI. The <Ui>Docs</Ui> item shows in the sidebar only when AI is set up in{' '}
        <DocLink to="settings/ai">Settings → AI</DocLink>. Each workspace has its own library, and documents never
        leave your machine except as text sent to your AI provider during a build, a chat or a review.
      </Note>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        Most review mistakes that matter are not bugs; they are a change that goes against something the team
        already decided and wrote down. A library that the reviewer reads, with quotes Limn checks, turns
        &ldquo;someone should have remembered the policy&rdquo; into a finding with the passage beside it.
      </p>
    </>
  );
}
