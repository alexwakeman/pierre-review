import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, SettingsRow, Steps, TextBox, Toggle, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Docs settings',
  summary: 'Whether reviews read the docs library, and the Confluence and Notion connections.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Docs</Ui> tab holds everything about the current workspace&rsquo;s{' '}
        <DocLink to="docs-library/overview">Docs library</DocLink>: whether AI Review reads it, and the Confluence and
        Notion connections the library uses to add pages. Documents from GitHub need no connection: Limn reads them
        with your GitHub sign-in. Every setting here applies to this workspace only.
      </p>

      <H2 id="reference-docs">Use reference docs in AI Review</H2>
      <p>
        When <Ui>Use reference docs in AI Review</Ui> is on, AI Review reads this workspace&rsquo;s Docs while it checks
        a pull request and its story. It starts at the library&rsquo;s contents, reads only the sections that matter to
        the change, and says where the work or the story disagrees with them, citing each section. It is off by
        default. Select <Ui>Save</Ui> after you change it.
      </p>
      <Illustration label="The Use reference docs in AI Review switch, on." caption="One switch per workspace.">
        <SettingsRow label="Use reference docs in AI Review" hint="Applies to this workspace only." control={<Toggle on />} />
      </Illustration>
      <p>
        See <DocLink to="docs-library/docs-in-reviews">Docs in reviews</DocLink> and{' '}
        <DocLink to="story-checks/check-against-docs">Check against docs</DocLink>.
      </p>

      <H2 id="confluence">Connect Confluence</H2>
      <p>
        Limn only reads Confluence pages. When Jira is this workspace&rsquo;s tracker and the pages are on the same
        Atlassian site, Limn uses your Jira email and token and there is nothing to set up: the section reads{' '}
        <Ui>Using your Jira connection</Ui>. Choose <Ui>Use a different token</Ui> to use another one.
      </p>
      <Steps>
        <li>
          At id.atlassian.com, under <Ui>Security → API tokens</Ui>, create an API token.
        </li>
        <li>
          In the <Ui>Confluence</Ui> section, enter the <Ui>Site</Ui>, the <Ui>Email</Ui> of that Atlassian account and
          the <Ui>API token</Ui>.
        </li>
        <li>
          Select <Ui>Test connection</Ui>, then <Ui>Save</Ui>.
        </li>
      </Steps>
      <p>
        Full guide: <DocLink to="integrations/confluence">Confluence</DocLink>.
      </p>

      <H2 id="notion">Connect Notion</H2>
      <Steps>
        <li>
          At notion.so/my-integrations, create an internal integration with &ldquo;Read content&rdquo; only.
        </li>
        <li>
          Paste its token into <Ui>Integration token</Ui>, select <Ui>Test connection</Ui>, then <Ui>Save</Ui>.
        </li>
        <li>
          In Notion, share each page with the integration (the page&rsquo;s ••• menu → <Ui>Connections</Ui>). Its child
          pages are shared too.
        </li>
      </Steps>
      <Illustration label="The Notion section with a hidden saved token." caption="A saved token is never shown again.">
        <SettingsRow label="Integration token" hint="Saved" control={<TextBox value="Replace · Remove" />} />
      </Illustration>
      <p>
        Full guide: <DocLink to="integrations/notion">Notion</DocLink>.
      </p>

      <H3>About the tokens</H3>
      <Note>
        Each token is stored sealed (encrypted) on your computer and is never shown again. Beside a saved token,{' '}
        <Ui>Replace</Ui> lets you type a new one and <Ui>Remove</Ui> deletes it when you save. <Ui>Keep it</Ui> cancels
        a removal.
      </Note>
    </>
  );
}
