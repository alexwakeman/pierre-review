import type { DocMeta } from '../../types';
import { Card, DocLink, H2, Illustration, Kbd, Note, Steps, TextBox, Toolbar, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Search the docs',
  summary: 'Find a word or phrase across every document in the workspace, ranked by how well each section matches.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>Search</Ui> finds sections of your library that contain the words you type. It is a plain word search,
        fast and free: no AI runs. Use it when you know what you are looking for; use the{' '}
        <DocLink to="docs-library/read-and-ask">chat</DocLink> when you want an answer.
      </p>

      <WhoItHelps
        developer="Find every place the docs mention 'idempotency key' before you change how it works."
        manager="Check whether a rule is written down anywhere before you ask the team to write it."
      />

      <H2 id="search">Search</H2>
      <Steps>
        <li>
          On the Docs page, select <Ui>Search</Ui> at the top of the Library list. You can also press <Kbd>⌘</Kbd>{' '}
          <Kbd>K</Kbd> and choose <Ui>Search the docs</Ui>.
        </li>
        <li>Type your words. Results update as you type.</li>
        <li>
          Sort by <Ui>Relevance</Ui> or <Ui>Newest first</Ui>.
        </li>
        <li>Select a result to open the section with your search words highlighted.</li>
      </Steps>

      <H2 id="what-you-see">What you see</H2>
      <Illustration
        label="Search results for partial refund: two sections, each with its document trail and a snippet with the words marked"
        caption="Search results: one row per section, with the matching words marked."
      >
        <Toolbar>
          <TextBox value="partial refund" />
          <span>2 results · Relevance</span>
        </Toolbar>
        <Card title="Partial refunds">
          <p className="muted">Payments handbook › Refunds › Partial refunds · Confluence</p>
          <p>… a partial refund leaves the order open until the remaining balance is settled …</p>
        </Card>
        <Card title="Time limits">
          <p className="muted">Refund policy › Time limits · PDF</p>
          <p>… the same limit applies to a partial refund of a single item …</p>
        </Card>
      </Illustration>
      <ul>
        <li>The number of results. Past 2,000 sections it says &ldquo;2000+&rdquo;.</li>
        <li>
          One row per section: its title, the document trail, where the document came from, the date it was added,
          and a snippet with your words marked.
        </li>
        <li>20 results a page, with <Ui>Previous</Ui> and <Ui>Next</Ui>.</li>
      </ul>

      <H2 id="how-matching-works">How matching works</H2>
      <ul>
        <li>Every word you type must appear somewhere in the section, not necessarily in the same paragraph.</li>
        <li>
          Put words in quotes, <code>&quot;partial refund&quot;</code>, to find them together as a phrase. A hyphenated
          word is a phrase too.
        </li>
        <li>Word endings are matched: &ldquo;refunds&rdquo; finds &ldquo;refund&rdquo;.</li>
        <li>Very common words, such as &ldquo;the&rdquo;, are left out unless they are all you typed.</li>
        <li>
          <Ui>Relevance</Ui> puts the best matches first; among near-equal matches, newer documents come first.
        </li>
      </ul>
      <Note>
        Search covers documents that have finished building. While the library is empty or still building, it says
        so instead of showing no results. Back returns you from a section to your results.
      </Note>
    </>
  );
}
