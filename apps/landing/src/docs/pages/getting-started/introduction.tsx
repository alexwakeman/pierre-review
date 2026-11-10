import type { DocMeta } from '../../types';
import { AppShell, DocLink, H2, Illustration, Note, PrRow, Pill, Tabs, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'What Limn is',
  summary: 'Limn is a dashboard for a team\'s GitHub pull requests that runs on your own computer. This page says what it does, who it is for and how it is different.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Limn shows your team's pull requests across many GitHub repositories on one screen. It tells you
        what is waiting on you, which pull requests are stuck, which review threads nobody has answered,
        and what can land now. It also runs AI reviews and AI fixes on your own Claude or Codex sign-in,
        checks pull requests against their tickets and your reference documents, and measures the review
        bots you already use. Limn runs on your computer. There is no Limn server and no Limn account.
      </p>


      <H2 id="what-it-does">What Limn does</H2>
      <ul>
        <li>
          <b>Collects the activity.</b> Limn reads pull requests, reviews, comments, commits and checks from
          GitHub through your own GitHub CLI sign-in, and keeps a copy on your computer.
        </li>
        <li>
          <b>Says whose turn it is.</b> <DocLink to="pending/overview">Pending</DocLink> lists everything
          that is waiting, in tabs. <DocLink to="pending/my-turn">My turn</DocLink> lists only the pull
          requests where a person is waiting on you.
        </li>
        <li>
          <b>Reads every review thread.</b> Each thread gets a state: Resolved, Likely addressed, Replied or
          Untouched. See <DocLink to="timeline/thread-states">What the thread states mean</DocLink>.
        </li>
        <li>
          <b>Reviews and fixes with AI, under your control.</b> <DocLink to="ai-review/overview">AI
          review</DocLink> and <DocLink to="ai-fix/overview">AI Fix</DocLink> run on your own Claude or Codex
          subscription. Nothing is pushed until you press the button, and nothing is posted to GitHub
          except by your press or by an automatic setting you can switch off.
        </li>
        <li>
          <b>Connects the ticket and the docs.</b> With an issue tracker connected, a review checks the
          change against the ticket's acceptance criteria and your reference documents. See{' '}
          <DocLink to="story-checks/overview">Story checks</DocLink>.
        </li>
        <li>
          <b>Measures the team and the bots.</b> <DocLink to="reports/overview">Reports</DocLink> shows flow
          metrics and where open hours go. <DocLink to="bots-monitoring/overview">Bots Monitoring</DocLink>{' '}
          shows what each review bot says and whether people act on it.
        </li>
      </ul>

      <Illustration
        label="The Limn app: the sidebar on the left with Pending selected, and the My turn tab listing two pull requests."
        caption="The sidebar, with Pending open on the My turn tab."
      >
        <AppShell active="Pending">
          <Tabs tabs={[{ label: 'My turn', count: 2, on: true }, { label: 'AI reviews' }, { label: 'Needs fixing', count: 1 }]} />
          <PrRow title="#612 Partial refunds" repo="acme/payments" status={<Pill tone="red">Your turn</Pill>} />
          <PrRow title="#1190 Settings split" repo="acme/web" status={<Pill tone="amber">Re-review</Pill>} />
        </AppShell>
      </Illustration>

      <H2 id="who-it-is-for">Who it is for</H2>
      <p>
        Limn is for developers and engineering managers in small teams, and in teams inside larger
        organisations, who work across several repositories. It is most useful when more than one person
        reviews code, when review bots comment on your pull requests, or when you want AI review without
        giving a third party your code or your GitHub credentials.
      </p>

      <H2 id="how-it-is-different">How it is different</H2>
      <ul>
        <li>
          <b>It runs on your machine.</b> Your data stays in a local database in your home folder. Limn uses
          the GitHub CLI you have already signed in to, and stores no GitHub token of its own. See{' '}
          <DocLink to="security/runs-on-your-machine">Limn runs on your machine</DocLink>.
        </li>
        <li>
          <b>AI on your terms.</b> The AI features use your own Claude or ChatGPT subscription, or your own
          Anthropic API key. You choose the provider, the effort and a spend budget.
        </li>
        <li>
          <b>It works with the bots you already have.</b> Limn does not replace CodeRabbit, Copilot or other
          review bots. It sorts what they say, scores how serious each comment is, and shows which of their
          threads still need a person.
        </li>
        <li>
          <b>It is honest about guesses.</b> Where Limn guesses (for example, Likely addressed or the blast
          radius chip), it says so.
        </li>
      </ul>

      <Note title="Free to use">
        Every feature is free under the Limn License: free for individuals and for organisations where no
        more than three people use it. Larger organisations can ask for a commercial licence through the
        contact form. See <DocLink to="licence/licence">the licence page</DocLink>.
      </Note>

      <H2 id="next-steps">Next steps</H2>
      <ul>
        <li>
          <DocLink to="getting-started/install-and-run">Install and run Limn</DocLink>.
        </li>
        <li>
          <DocLink to="getting-started/add-repositories">Add your repositories</DocLink>.
        </li>
        <li>
          <DocLink to="getting-started/find-your-way-around">Find your way around</DocLink> the sidebar and{' '}
          <Ui>Search or jump</Ui>.
        </li>
      </ul>
    </>
  );
}
