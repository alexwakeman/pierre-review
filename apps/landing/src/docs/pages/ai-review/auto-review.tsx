import type { DocMeta } from '../../types';
import {
  DocLink,
  H2,
  Illustration,
  MiniTable,
  Note,
  SettingsRow,
  Steps,
  TextBox,
  Tip,
  Toggle,
  Ui,
  Warning,
  WhoItHelps,
} from '../../kit';

export const meta: DocMeta = {
  title: 'Auto review',
  summary: 'Let Limn review new pull requests and new commits by itself, within your spend budget.',
};

function SettingsPicture(): JSX.Element {
  return (
    <Illustration
      label="The Auto review settings: Review new PRs automatically is on, Auto reviews use Claude + Codex, When an auto review finishes is Post to GitHub, and up to 20 auto reviews a day."
      caption="Settings → AI review: the switches that shape auto review for one workspace."
      title="Auto review"
      meta="Settings → AI review"
    >
      <SettingsRow label="Review new PRs automatically" hint="Only PRs opened after you turn this on." control={<Toggle on />} />
      <SettingsRow label="Auto reviews use" control={<TextBox value="Claude + Codex (the default)" />} />
      <SettingsRow label="When an auto review finishes" hint="As soon as it finishes." control={<TextBox value="Post to GitHub" />} />
      <SettingsRow label="Up to" hint="auto reviews a day (UTC). The rest wait for the next day." control={<TextBox value="20" />} />
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        With auto review on, Limn reviews each new pull request a person opens in the workspace, and reviews it again
        when new commits arrive. You do not press anything. It uses the same models and the same rules as a review
        you start, and it runs on your own AI sign-in, so it is off until you switch it on.
      </p>
      <WhoItHelps
        developer="Every pull request you open or are asked to review already has a review waiting when you look."
        manager="No pull request waits for a first review, and the daily limit and spend budget keep the cost known."
      />

      <H2 id="turn-it-on">Turn it on</H2>
      <SettingsPicture />
      <Steps>
        <li>
          Open <Ui>Settings</Ui>, choose the <Ui>AI review</Ui> tab and pick the workspace at the top.
        </li>
        <li>
          Under <Ui>Auto review</Ui>, tick <Ui>Review new PRs automatically</Ui>.
        </li>
        <li>
          Choose <Ui>Auto reviews use</Ui>: <Ui>Claude + Codex (the default)</Ui>, or your default provider only.
        </li>
        <li>
          Choose <Ui>When an auto review finishes</Ui>: <Ui>Post to GitHub</Ui> (the default) or{' '}
          <Ui>Keep it in Limn</Ui>.
        </li>
        <li>
          With posting on, choose <Ui>Which PRs</Ui> its reviews post on: <Ui>Your own PRs, and PRs you are asked to
          review or have reviewed or commented on</Ui> (the default), or <Ui>Every PR auto review covers</Ui>.
        </li>
      </Steps>
      <Warning>
        With <Ui>Post to GitHub</Ui>, automatic reviews post under your GitHub account as soon as they finish. To
        read them first, choose <Ui>Keep it in Limn</Ui>; you can then post each one yourself from the{' '}
        <Ui>AI Review</Ui> tab. What posts and which verdict is allowed are explained in{' '}
        <DocLink to="ai-review/verdicts-and-posting">Verdicts and posting to GitHub</DocLink>.
      </Warning>
      <p>
        Nothing is reviewed until AI is set up on this machine. Auto review is set per workspace, so each workspace
        can have its own choice.
      </p>

      <H2 id="what-starts-a-review">What starts a review</H2>
      <MiniTable
        cols={[
          { key: 'what', label: 'What happens on GitHub' },
          { key: 'then', label: 'What Limn does' },
        ]}
        rows={[
          { _key: 'open', what: 'A person opens a pull request', then: 'Reviews it within about a minute. A draft waits until it is marked ready.' },
          {
            _key: 'push',
            what: 'New commits',
            then: 'Reviews at once after a quiet spell. Pushes during a review or within 5 minutes of one wait until the pull request has been quiet for 5 minutes, or 20 minutes at most.',
          },
          {
            _key: 'reply',
            what: "A reply on one of your Limn's posted findings",
            then: 'A short replies pass after 5 quiet minutes, at most 5 a day per pull request.',
          },
          {
            _key: 'comment',
            what: 'A new comment by a person or a review bot in an open thread',
            then: 'A light Check threads pass, at most 30 a day per workspace.',
          },
          {
            _key: 'none',
            what: "A thread is resolved, CI finishes, a deploy bot comments, your Limn posts",
            then: 'Nothing.',
          },
        ]}
      />
      <p>
        A review that is running is never cancelled by a new push; the new commit is reviewed after it. Pull requests
        opened by bots, and pull requests opened before you switched auto review on, are not reviewed. See{' '}
        <DocLink to="ai-review/replies-pass">Replies to findings</DocLink> and{' '}
        <DocLink to="ai-review/check-threads">Check threads</DocLink> for the two lighter passes.
      </p>
      <p>
        When a pull request has failing checks, the CI review looks at them on its own too. See{' '}
        <DocLink to="ai-review/ci-review">CI review</DocLink>.
      </p>

      <H2 id="limits">Limits and the spend budget</H2>
      <ul>
        <li>
          <b>A daily limit</b>: 20 automatic reviews a day per workspace by default, from 1 to 500 (UTC days). A
          Claude + Codex review counts once. The rest wait for the next day.
        </li>
        <li>
          <b>The spend budget</b>: every automatic run asks it first. When your budget is used up, the run is
          skipped, not queued. A review you start yourself is never refused. See{' '}
          <DocLink to="settings/ai-usage-and-spend">AI usage and spend</DocLink>.
        </li>
        <li>
          <b>Retries</b>: a failed automatic review is tried again only when the error was temporary, at most 3 tries
          per commit (after an hour, then four hours, or when your usage limit resets).
        </li>
        <li>
          <b>Teammates</b>: when a teammate's Limn is already reviewing a commit with the same model, yours steps aside
          and spends nothing. See <DocLink to="ai-review/team-reviews">Reviewing as a team</DocLink>.
        </li>
        <li>Reviews you start yourself always go first.</li>
      </ul>

      <H2 id="what-you-see">What you see</H2>
      <ul>
        <li>
          In the <Ui>AI Review</Ui> tab: <Ui>Auto review queued</Ui> or <Ui>Auto review running</Ui> beside the Run
          button, or <Ui>Auto review waiting for pushes to settle</Ui> while it waits.
        </li>
        <li>
          An automatic review is labelled <Ui>Auto review</Ui> in the tab.
        </li>
        <li>
          A failed automatic review shows one line with <Ui>Retry</Ui>.
        </li>
        <li>
          On <Ui>Open pull requests</Ui>, <Ui>Run auto reviews now</Ui> reviews every pull request that is due at once,
          within the daily limit, and retries failed runs. See{' '}
          <DocLink to="open-pull-requests/ai-review-column">The AI review column</DocLink>.
        </li>
      </ul>
      <Tip>
        <Ui>Run auto reviews now</Ui> is also in the command menu (<Ui>⌘K</Ui>).
      </Tip>

      <H2 id="auto-ai-fix">Auto AI Fix</H2>
      <p>
        On the same tab, <Ui>Auto AI Fix on your own PRs</Ui> prepares an AI Fix after an auto review of a pull
        request you opened. It is off by default, and off while auto review is off. Unless <Ui>Push automatically</Ui>{' '}
        is also on, the fix waits for you to press Push. See{' '}
        <DocLink to="ai-fix/push-and-auto-fix">Push the fix, and auto fix</DocLink>.
      </p>

      <H2 id="turn-it-off">Turn it off</H2>
      <p>
        Untick <Ui>Review new PRs automatically</Ui>. Running reviews finish; nothing new starts. If you switch it on
        again later, only pull requests opened after that moment are reviewed.
      </p>
      <Note>
        Every setting on this page is explained in full in <DocLink to="settings/ai-review">Settings → AI review</DocLink>.
      </Note>
    </>
  );
}
