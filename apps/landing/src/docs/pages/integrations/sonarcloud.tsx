import type { DocMeta } from '../../types';
import { Btn, DocLink, ExtLink, Field, FindingRow, H2, H3, Illustration, Note, Pill, Section, Steps, TextBox, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'SonarCloud',
  summary: 'Show SonarCloud\'s analysis of each pull request, and let AI Fix work on its issues.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        If your team uses <ExtLink href="https://sonarcloud.io">SonarCloud</ExtLink>, Limn can read its analysis of each
        pull request: the quality gate, issues, security hotspots and SonarCloud’s advice on how to fix them. AI Review
        uses them as evidence, the AI Review tab lists them, AI Fix can fix them, and Limn can post them to the pull
        request as one GitHub review. Limn only reads from SonarCloud; it never changes anything there.
      </p>


      <H2 id="what-you-need">What you need</H2>
      <ul>
        <li>A SonarCloud organisation that analyses your pull requests.</li>
        <li>
          A SonarCloud token. Create one in SonarCloud under <Ui>My Account → Security</Ui>.
        </li>
        <li>The organisation key.</li>
      </ul>

      <H2 id="set-it-up">Set it up</H2>
      <Illustration
        label="The SonarCloud section of Settings → Integrations: organisation key acme, token saved, project keys for each repository, and a Test connection button"
        caption="Settings → Integrations → SonarCloud, for one workspace."
      >
        <Section title="SonarCloud" desc="Feed SonarCloud’s findings into AI Review and AI Fix.">
          <Field label="Organization key">
            <TextBox value="acme" mono />
          </Field>
          <Field label="Token">
            <TextBox value="Saved" />
          </Field>
          <Field label="Project keys">
            <TextBox value="acme/payments → acme_payments · Found" />
          </Field>
          <Btn>Test connection</Btn>
        </Section>
      </Illustration>
      <Steps>
        <li>
          Open <DocLink to="settings/integrations">Settings → Integrations</DocLink> and find <Ui>SonarCloud</Ui>.
        </li>
        <li>
          Enter the <Ui>Organization key</Ui> and paste the <Ui>Token</Ui>.
        </li>
        <li>
          Check the <Ui>Project keys</Ui>. Each repository uses SonarCloud’s own default, <code>owner_repo</code>. Type
          a key only if yours is different.
        </li>
        <li>
          Press <Ui>Save</Ui>, then <Ui>Test connection</Ui>. Each repository is marked <Ui>Found</Ui> or{' '}
          <Ui>Not found</Ui>.
        </li>
      </Steps>
      <Note title="The token is write-only">
        The token is stored sealed on your computer and is never shown again, or included in an export. To change it,
        type a new one and save. It is sent only to sonarcloud.io.
      </Note>

      <H2 id="what-limn-reads">What Limn reads</H2>
      <p>
        For each pull request, Limn reads SonarCloud’s analysis when a review runs, when you press <Ui>Refresh</Ui>,
        and when AI Fix opens. Opening a tab never calls SonarCloud; it shows what was read before.
      </p>
      <ul>
        <li>The quality gate and each failing condition in words, with the files behind it, for example coverage on new code.</li>
        <li>Open issues and security hotspots, the most severe first, up to 50, with the total (“50 of 132”).</li>
        <li>For each one: the rule, the flagged lines, why it matters and how to fix it.</li>
      </ul>
      <Warning title="Only an analysis of this exact commit is used">
        SonarCloud often finishes its analysis a few minutes after a push. Until it has analysed the commit you are
        looking at, Limn shows nothing for it, rather than the previous commit’s issues. Press <Ui>Refresh</Ui> a
        little later.
      </Warning>

      <H2 id="where-you-see-it">Where you see it</H2>
      <Illustration
        label="The SonarCloud section of the AI Review tab: Quality gate failed, 3 of 3 issues, with one Major code smell and one security hotspot"
        caption="The AI Review tab’s SonarCloud section."
      >
        <FindingRow chip="Quality gate failed" tone="red">
          Coverage on new code is 40%. The quality gate needs at least 80%.
        </FindingRow>
        <FindingRow chip="Major" tone="amber">
          refunds/policy.py:41 · Refactor this function to reduce its complexity.
        </FindingRow>
        <FindingRow chip="Security hotspot" tone="blue">
          refunds/export.py:12 · Make sure this regular expression cannot run for a very long time.
        </FindingRow>
        <Pill>Open in SonarCloud</Pill> <Pill>Refresh</Pill> <Pill>Post SonarCloud findings</Pill>
      </Illustration>
      <ul>
        <li>
          <strong>AI Review:</strong> the reviewer is given the gate and the most severe items as evidence. It raises a
          finding only where it agrees, and does not copy the list.
        </li>
        <li>
          <strong>The AI Review tab:</strong> a <Ui>SonarCloud</Ui> section for the pull request’s latest commit, with the
          gate, each item with its place (a link into Changes), its lines and <Ui>How to fix</Ui>. When the review above
          it is of an older commit, the section says so.
        </li>
        <li>
          <strong>AI Fix:</strong> the failing gate conditions and the issues appear under <Ui>SonarCloud issues</Ui> in
          the list of things to fix. See <DocLink to="ai-fix/what-to-fix">Choose what to fix</DocLink>.
        </li>
      </ul>

      <H3 id="post-to-github">Post to GitHub</H3>
      <p>
        <Ui>Post SonarCloud findings</Ui> posts one GitHub review for the commit, under your account. An issue on a
        changed line gets its own comment on that line; everything else goes in the review’s summary. An issue already
        posted for an earlier commit is not posted again. The line under the button then says, for example, “Posted to
        GitHub: 12 on the changed lines, 5 in the summary, 3 already there from an earlier commit.”
      </p>
      <p>
        With auto-posting on, Limn posts SonarCloud’s findings after each auto review, unless you turn that off. When
        SonarCloud finishes after the review, Limn posts them when the analysis lands, for up to 2 hours. See{' '}
        <DocLink to="ai-review/verdicts-and-posting">Verdicts and posting</DocLink>.
      </p>

      <H2 id="turn-it-off">Turn it off</H2>
      <p>
        In <Ui>Settings → Integrations → SonarCloud</Ui>, remove the token and press <Ui>Save</Ui>. Limn stops reading
        SonarCloud for that workspace. Each workspace has its own setting.
      </p>
    </>
  );
}
