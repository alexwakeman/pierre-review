import type { DocMeta } from '../../types';
import { DocLink, H2, Kbd, Note, Steps, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Download the AI adoption report',
  summary:
    'A PDF shaped like a slide deck: how much of your merged work involved AI tools, who used which, and what changed in delivery. Measured from your GitHub data, made on your computer.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>Download report</Ui>, at the top of every <Ui>Reports</Ui> tab, makes a PDF you can forward to a board, a
        finance director or a client. Each page holds one idea: a headline, a chart or a table, and a few sentences that
        say what the figures show. Every figure is counted from your GitHub data for the workspace’s{' '}
        <DocLink to="reports/reporting-window">reporting window</DocLink>, against the same length of time just before
        it. The text in the PDF is real text, so you can copy a table or a sentence into another report.
      </p>

      <H2 id="make-the-report">Make the report</H2>
      <Steps>
        <li>
          Open <Ui>Reports</Ui> and select <Ui>Download report</Ui>. You can also press <Kbd>⌘K</Kbd> and type “Download report”.
        </li>
        <li>
          Optionally, type a name in <Ui>Prepared for</Ui>. It goes on the first page.
        </li>
        <li>
          While AI is on, tick <Ui>Write commentary with AI</Ui> if you want your AI provider to write the sentences
          beside each chart. Leave it clear and Ensemble writes standard sentences from the same figures.
        </li>
        <li>
          Select <Ui>Download</Ui>. A progress bar shows each step: fetching the figures, writing the commentary,
          drawing the slides and building the PDF. The file saves as{' '}
          <Ui>ensemble-ai-adoption-&lt;workspace&gt;-&lt;date&gt;.pdf</Ui>. Close the dialog at any time to stop.
        </li>
      </Steps>

      <H2 id="what-is-in-it">What is in it</H2>
      <ul>
        <li>
          <strong>Title</strong>: the workspace, both periods, <Ui>Prepared for</Ui> and the date.
        </li>
        <li>
          <strong>Summary</strong>: the largest clear changes, each with the number of pull requests behind it.
        </li>
        <li>
          <strong>AI adoption</strong>: the share of merged pull requests with an AI coding tool involved, period by
          period, split by tool. A dashed line marks a setting change, such as auto review switched on.
        </li>
        <li>
          <strong>How widely AI is used</strong>: how many of the people who merged pull requests used an AI tool,
          period by period, and how many used each tool. It counts people and never names anyone. A count of 1 or 2
          people shows as “Fewer than 3”, so it cannot point at someone.
        </li>
        <li>
          <strong>Delivery flow</strong>: merged pull requests, lead time, time to first human review, size, checks
          passing at merge and reviewer load, before and after. Pull requests with AI involved are compared with the
          rest; a comparison, not a cause.
        </li>
        <li>
          <strong>Where the time goes</strong>: how much open time waited on reviewers, on authors and to land (see{' '}
          <DocLink to="reports/chronology">Chronology</DocLink>).
        </li>
        <li>
          <strong>AI review</strong>: each review bot’s comments per pull request, how many of its threads people
          acted on, and its seat price as you entered it.
        </li>
        <li>
          <strong>Guardrails</strong>: checks passing at merge, review threads answered within 36 hours, and the share
          of merged pull requests a person approved.
        </li>
        <li>
          <strong>Cost</strong>: Ensemble’s own AI spend per merged pull request. On an API key it is in US dollars; on
          a subscription it is a share of a week, never dollars.
        </li>
        <li>
          <strong>Method and limits</strong>: what each figure counts, and what it cannot show.
        </li>
      </ul>

      <H2 id="how-ai-use-is-found">How AI use is found</H2>
      <p>
        Ensemble looks for the marks AI coding tools leave by default: a bot account as the author, an agent’s email, a
        co-author line in a commit, a “Generated with …” line in a commit or a pull request description, or a tool’s task
        link. A tool’s branch name only backs up one of these. A tool mentioned in a sentence never counts. It also knows the pull requests its own AI Fix and Implement story pushed to. It
        recognises Claude, Codex, GitHub Copilot, Cursor, Devin, Gemini and Jules, Amazon Q and Kiro, Windsurf, Aider,
        Factory and Amp.
      </p>
      <Note title="Declared AI use only">
        Someone who uses AI and leaves no mark looks like a person working alone, so the figures are an undercount. A
        figure with too small a sample shows as “—” with the reason, never as zero.
      </Note>

      <H2 id="the-commentary">The commentary</H2>
      <p>
        With <Ui>Write commentary with AI</Ui> ticked, the AI writes the sentences with a placeholder for every number,
        and Ensemble fills in each number from its own figures. Text that holds a number of its own, claims a cause, or
        breaks another rule is not used: that page gets the standard sentences instead. A page the AI wrote says{' '}
        <Ui>Written by AI from the figures on this page</Ui>.
      </p>

      <H2 id="privacy">Privacy</H2>
      <p>
        The PDF is made on your computer and goes nowhere unless you send it. It names nobody: no names or GitHub
        logins, only counts. With AI commentary on, only the page’s figures and tool names go to your AI provider: never
        a repository or <Ui>Prepared for</Ui>.
      </p>
    </>
  );
}
