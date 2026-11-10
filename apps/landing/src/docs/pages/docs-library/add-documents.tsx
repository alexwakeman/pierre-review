import type { DocMeta } from '../../types';
import { Btn, DocLink, H2, H3, Illustration, MiniTable, Note, Steps, Tip, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Add documents',
  summary:
    'Upload files, add a web page or site, or connect Confluence, Notion or a GitHub repository. Limn can also offer the docs folders it finds in your repositories.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Everything goes into the library through one button, the <Ui>+</Ui> beside <Ui>Library</Ui> on the Docs page.
        It opens a short wizard that asks &ldquo;What would you like to add?&rdquo; and then only the questions that
        kind of source needs.
      </p>


      <H2 id="the-kinds-of-source">The kinds of source</H2>
      <MiniTable
        cols={[
          { key: 'k', label: 'Choice' },
          { key: 'w', label: 'What it adds' },
        ]}
        rows={[
          { _key: 'u', k: 'Upload a document', w: 'PDF, Word (.docx), text, markdown or HTML files from this computer, up to 25 MB each.' },
          { _key: 'w', k: 'Web page or site', w: 'One page, or a page and the pages it links to on the same site.' },
          { _key: 'c', k: 'Confluence', w: 'A whole space, or one page and every page below it.' },
          { _key: 'n', k: 'Notion', w: 'A whole wiki, or one page and every page below it.' },
          { _key: 'g', k: 'GitHub repository', w: 'The markdown and text documents in a repository or one of its folders.' },
          { _key: 'r', k: 'From your repositories', w: 'The docs folders Limn finds in this workspace’s repositories.' },
        ]}
      />

      <H2 id="upload-a-file">Upload a file</H2>
      <Steps>
        <li>
          On the Docs page, press <Ui>+</Ui> and choose <Ui>Upload a document</Ui>.
        </li>
        <li>Choose or drop one or more files. Each file is sent at once, and its build starts.</li>
      </Steps>
      <p>
        Limn decides the kind of file from its contents, not its name. An old Word file (.doc) or an RTF file is
        refused with a note to save it as .docx.
      </p>

      <H2 id="add-a-web-page">Add a web page or site</H2>
      <Steps>
        <li>
          Choose <Ui>Web page or site</Ui> and paste the page address.
        </li>
        <li>
          In <Ui>Links to follow</Ui>, keep <Ui>This page only</Ui>, or choose to follow links 1, 2 or 3 levels deep.
          Limn follows links on the same site only, up to 25 pages, and the whole set becomes one document with a
          chapter per page.
        </li>
        <li>
          Check the sentence on the last step (&ldquo;This will add …&rdquo;) and press <Ui>Start</Ui>.
        </li>
      </Steps>
      <p>
        Pages on your company network, such as an intranet wiki, are allowed. Addresses on this computer itself are
        not. To read a web page again later, use <Ui>Rebuild</Ui> in the document&rsquo;s menu.
      </p>

      <H2 id="connect-confluence-or-notion">Connect Confluence or Notion</H2>
      <Steps>
        <li>
          Choose <Ui>Confluence</Ui> or <Ui>Notion</Ui>.
        </li>
        <li>
          On the <Ui>Connection</Ui> step, save a token if the workspace has none yet. See{' '}
          <DocLink to="integrations/confluence">Confluence</DocLink> and{' '}
          <DocLink to="integrations/notion#notion-pages-in-docs">Notion</DocLink> for what to create.
        </li>
        <li>
          Paste a page address. A space&rsquo;s home page (Confluence) or a top-level page (Notion) adds the whole
          wiki; any other page adds it and every page below it, never its siblings.
        </li>
        <li>
          Limn counts the pages first: &ldquo;This will add 12 pages from Payments handbook.&rdquo; Press{' '}
          <Ui>Start</Ui>.
        </li>
      </Steps>
      <p>
        One document holds up to 100 pages. For a bigger wiki, add its parts as separate documents; the wizard says
        so when you need to.
      </p>

      <H2 id="add-a-github-repository">Add a GitHub repository</H2>
      <Steps>
        <li>
          Choose <Ui>GitHub repository</Ui> and type the repository as <code>owner/name</code>.
        </li>
        <li>
          Choose a folder, or <Ui>Whole repository</Ui>. Each folder shows how many documents it holds.
        </li>
        <li>Press <Ui>Start</Ui>.</li>
      </Steps>
      <p>
        Limn reads the repository with your <code>gh</code> sign-in, on the default branch. It takes markdown and
        other text documents only, and leaves out code, images, lock files and generated or vendored folders.
      </p>

      <H3 id="docs-offered-from-your-repositories">Docs offered from your repositories</H3>
      <p>
        After a repository syncs, Limn looks at its file list (without reading the files) for folders that look like
        documentation: a <code>docs</code>, <code>handbook</code> or <code>adr</code> folder, or any folder with
        several documents and enough words. A README alone never counts. When it finds some, a card on Docs and on
        Pending asks &ldquo;Add 2 docs collections from your repositories?&rdquo;.
      </p>
      <Illustration
        label="The docs offer card: two folders ticked, an Add button and a Not now button"
        caption="Limn builds nothing until you press Add."
      >
        <p>Add 2 docs collections from your repositories?</p>
        <p>acme/payments › docs · 9 files</p>
        <p>acme/api › handbook · 14 files</p>
        <p>
          <Btn tone="go">Add</Btn> <Btn>Not now</Btn>
        </p>
      </Illustration>
      <p>
        Untick any folder you do not want and press <Ui>Add</Ui>. <Ui>Not now</Ui> hides the card for 30 days. The
        wizard&rsquo;s <Ui>From your repositories</Ui> choice lists the same folders at any time.
      </p>
      <Warning>
        Building a document runs your AI provider, so each build uses some of your subscription or costs a little on
        an API key. The card says the most one build can use. Limn never builds anything before you press Add or
        Start.
      </Warning>

      <H2 id="keep-documents-current">Keep documents current</H2>
      <p>
        Confluence, Notion and GitHub documents are checked for changes about every three hours while the
        workspace&rsquo;s library is in use, and just before a review or story check reads them. Only changed pages
        are read again, and only changed sections are summarised again, so a small edit costs little. If a page
        cannot be reached, the document keeps its last good version and says &ldquo;Can&rsquo;t reach this page in
        Confluence since …&rdquo;.
      </p>
      <p>In each document&rsquo;s menu:</p>
      <ul>
        <li>
          <Ui>Refresh now</Ui>: check for changes now.
        </li>
        <li>
          <Ui>Rebuild</Ui>: read every page again and summarise afresh.
        </li>
        <li>
          <Ui>Remove…</Ui>: take the document out of the library, after you confirm.
        </li>
      </ul>
      <Tip>A workspace&rsquo;s library holds up to 200 documents. A crawled site or a wiki counts as one.</Tip>
      <Note>
        The automatic checks for changes are skipped when your AI spend budget is used up. See{' '}
        <DocLink to="settings/ai-usage-and-spend">AI usage and spend</DocLink>.
      </Note>
    </>
  );
}
