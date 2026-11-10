import type { DocMeta } from '../../types';
import { Btn, Card, DocLink, H2, H3, Illustration, Note, Pill, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Bots settings',
  summary: 'Which reviewers are bots, their category and price, and bot comment scoring.',
};

const ROLES: ReadonlyArray<{ label: string; help: string }> = [
  {
    label: 'Review bot',
    help: 'An AI code reviewer. The only role counted in the review-bot figures: ROI, behaviour, duplicates and the benchmark.',
  },
  {
    label: 'Quality check',
    help: 'Static analysis, coverage, scanners, CI. Posts pass or fail verdicts rather than findings. Shown in the Feed, left out of the review-bot figures.',
  },
  {
    label: 'Dependency updates',
    help: 'Version bumps (Dependabot, Renovate). Opens pull requests and never reviews; its merges are reported as overhead, not team output.',
  },
  {
    label: 'Code agent',
    help: 'Writes code that is not a version bump: coding agents, autofix, generated-content sync. Its merged pull requests are reported as work no person typed.',
  },
  {
    label: 'Release automation',
    help: 'Merge queues, release trains, changelogs, backports. Moves code without writing or judging it; its approvals do not count as review.',
  },
  {
    label: 'Housekeeping',
    help: 'CLA and DCO checks, triage, labels, stale-closers, size and preview reports. Left out of every review figure.',
  },
];

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Bots</Ui> tab decides which accounts Limn treats as bots, what kind of bot each one is, and what it
        costs. It also sets up bot comment scoring. These choices feed{' '}
        <DocLink to="bots-monitoring/overview">Bots Monitoring</DocLink>, the Feed and the Timeline. Bot comment scoring
        applies to the whole computer; the classification applies to the current workspace only.
      </p>

      <H2 id="bot-comment-scoring">Bot comment scoring</H2>
      <p>
        A small model reads each review comment a bot leaves and labels how serious it is, from nit to critical. It
        runs on your computer: nothing is sent anywhere to score a comment. Setting it up downloads the model and the
        program that runs it, about 240 MB, once.
      </p>
      <ul>
        <li>
          Select <Ui>Set up (one-time ~240 MB download)</Ui>, or run <code>limn ml install</code> in a terminal.
        </li>
        <li>
          When it is ready the section reads <Ui>Set up. Bot review comments are scored on this machine.</Ui>
        </li>
      </ul>
      <p>
        Scoring is kept gentle on your computer: one comment at a time, at low priority, and it pauses on battery. See{' '}
        <DocLink to="bots-monitoring/severity-scoring">Severity scoring</DocLink>.
      </p>

      <H2 id="bot-classification">Bot classification</H2>
      <p>
        <Ui>Bot classification</Ui> lists every account that has reviewed or commented in this workspace: who counts as
        a bot, what kind of bot it is, and what it costs here. Bots are found automatically. Bots are hidden on the Feed
        and the Timeline by default. A change here reaches every repository in the workspace; the repository chips on
        each card show where that bot is active.
      </p>
      <Illustration label="A bot card for CodeRabbit marked as a Review bot with a monthly price." caption="One card in Bot classification.">
        <Card title="CodeRabbit" chip={<Pill tone="blue">Review bot</Pill>}>
          <p>
            acme/payments · acme/web
          </p>
          <p>
            <Btn>Bot</Btn> <Btn>Person</Btn> <Btn>Save price</Btn>
          </p>
        </Card>
      </Illustration>
      <H3>Bot or person</H3>
      <p>
        Select <Ui>Bot</Ui> or <Ui>Person</Ui> to correct Limn&rsquo;s guess for this workspace. Your choice wins.{' '}
        <Ui>Reset classification</Ui> forgets it and lets detection decide again. Your other workspaces are not
        affected.
      </p>
      <H3>Role</H3>
      <p>Each bot has one role in the workspace. The role decides which figures count it:</p>
      <ul>
        {ROLES.map((r) => (
          <li key={r.label}>
            <Ui>{r.label}</Ui>: {r.help}
          </li>
        ))}
      </ul>
      <H3>Name</H3>
      <p>
        You can pick the vendor and give the bot a label for this workspace. It does not change whether it counts as a
        bot.
      </p>
      <H3>Price for this Workspace</H3>
      <p>
        Type a monthly price in US dollars, choose <Ui>flat</Ui> or <Ui>per seat</Ui>, and select <Ui>Save price</Ui>.
        Type 0 for a free bot. A seat is a person who opened a pull request in this workspace&rsquo;s repositories in
        the last 30 days, so a per-seat monthly figure moves with the team. Clear the box to remove the price.
      </p>
      <Note>
        Prices are set per workspace and are never added up across workspaces: the same bot can have a different price
        in each. See <DocLink to="bots-monitoring/roi">ROI</DocLink>.
      </Note>
    </>
  );
}
