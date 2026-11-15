import type { DocMeta } from '../../types';
import { DocLink, H2, Illustration, Note, Pill, SettingsRow, Steps, Thread, Toggle, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Severity scoring',
  summary: 'Ensemble scores each bot comment as nit, minor, major or critical with a model that runs on your computer.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Bots label their own comments, and most of them label too much as important. Ensemble reads each review comment a
        bot leaves and gives it its own severity, <Ui>Nit</Ui>, <Ui>Minor</Ui>, <Ui>Major</Ui> or{' '}
        <Ui>Critical</Ui>, and up to eight categories, such as correctness, security or testing. A small model does
        this on your computer. It is not a large language model, it sends nothing anywhere, and it never reads the
        bot’s own severity label.
      </p>


      <H2 id="set-it-up">Set it up</H2>
      <Illustration
        label="The Bot comment analysis switch in Settings → Features, off, with the hint Not downloaded yet."
        caption="Settings → Features: scoring is downloaded once per computer."
      >
        <SettingsRow
          label="Bot comment analysis"
          hint="Not downloaded yet. Switching it on asks before downloading."
          control={<Toggle on={false} />}
        />
      </Illustration>
      <Steps>
        <li>
          Open <DocLink to="settings/features">Settings → Features</DocLink>.
        </li>
        <li>
          Switch on <Ui>Bot comment analysis</Ui>, then select <Ui>Download</Ui>. This downloads the models and the
          program that runs them, about 240 MB, once.
        </li>
        <li>
          When it is ready, the switch lists the models it found and where they are.
        </li>
      </Steps>
      <p>
        You can also run <code>npx ensemble-review ml install</code> in a terminal, and{' '}
        <code>npx ensemble-review ml status</code> to check it.
      </p>

      <H2 id="leave-a-repository-out">Leave a repository out</H2>
      <p>
        Every repository is scored. To leave one out, open <Ui>Repos &amp; workspaces</Ui> and switch off its{' '}
        <Ui>Bot scoring</Ui> switch. Its new bot comments are not scored; labels it already has stay. To stop scoring
        everywhere, switch off <Ui>Bot comment analysis</Ui> in Settings → Features.
      </p>

      <H2 id="it-will-not-slow-your-computer">It will not slow your computer</H2>
      <p>
        Scoring runs in the background at low priority, one comment at a time, using at most half of one processor
        core. It pauses while your laptop is on battery. A large backlog of old comments therefore takes a while. If
        you want it faster, or want it to carry on on battery, start Ensemble with <code>ENSEMBLE_ML_CPU_SHARE=1</code> or{' '}
        <code>ENSEMBLE_ML_ON_BATTERY=run</code>. To turn scoring off, start Ensemble with{' '}
        <code>ENSEMBLE_ML_DISABLED=true</code>.
      </p>

      <H2 id="where-you-see-it">Where you see it</H2>
      <Illustration
        label="A CodeRabbit thread with Ensemble's severity Minor and the note: bot said Critical"
        caption="Ensemble’s severity on a bot comment. When the bot’s own label disagrees, it is shown beside it."
      >
        <Thread
          file="refunds/policy.py:41"
          state={<Pill tone="amber">Minor · bot said Critical</Pill>}
          tone="amber"
          comments={[
            { who: 'CodeRabbit', bot: true, when: '2h', text: 'Consider renaming this variable for clarity.' },
          ]}
        />
      </Illustration>
      <ul>
        <li>
          <strong>On each bot comment</strong> on a pull request’s Threads and Activity tabs. Hover over the label to
          see the model’s confidence and the categories. A label under 50% confidence is dimmed. A walkthrough or
          summary comment is marked <Ui>summary</Ui>, not scored as a finding.
        </li>
        <li>
          <strong>In Bots Monitoring</strong>: the <Ui>What the bots are flagging</Ui> strip and the severity columns
          on the <DocLink to="bots-monitoring/roi">ROI</DocLink> table.
        </li>
      </ul>
      <p>
        When a bot labels its own comment, Ensemble shows that label beside its own as “bot said …”, with an arrow when
        the two disagree. The <Ui>Inflation</Ui> column on the ROI table counts how often each bot graded a finding
        worse than Ensemble did. A bot that labels nothing shows a dash: no label is silence, not agreement.
      </p>
      <Note title="How accurate it is">
        On a held-out sample judged by people, Ensemble’s label agreed 70% of the time; the bots’ own labels agreed 47%
        of the time. The model rarely calls something critical, so read major and critical together as “high”.
      </Note>
      <Note>
        Ensemble’s own review findings are not scored by this model. Their severity is the one the review gave them. Some
        older comments cannot be scored, because their text was not stored and GitHub no longer has it; they are left
        out of every figure.
      </Note>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        When every bot comment says “important”, none of them is. An independent severity, made the same way for
        every bot, lets you sort comments by what matters and compare bots fairly. It also feeds the <Ui>Tune</Ui>{' '}
        verdict: a bot whose findings are mostly nits is worth narrowing.
      </p>
    </>
  );
}
