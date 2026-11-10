import type { DocMeta } from '../../types';
import { Btn, DocLink, H2, Illustration, Note, Pill, SettingsRow, Steps, Thread, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Severity scoring',
  summary: 'Limn scores each bot comment as nit, minor, major or critical with a model that runs on your computer.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Bots label their own comments, and most of them label too much as important. Limn reads each review comment a
        bot leaves and gives it its own severity, <Ui>Nit</Ui>, <Ui>Minor</Ui>, <Ui>Major</Ui> or{' '}
        <Ui>Critical</Ui>, and up to eight categories, such as correctness, security or testing. A small model does
        this on your computer. It is not a large language model, it sends nothing anywhere, and it never reads the
        bot’s own severity label.
      </p>

      <WhoItHelps
        developer="Read the major and critical bot comments first, and leave the nits for later."
        manager="See which bots raise real problems and which mostly raise nits, and which bots overstate how serious their findings are."
      />

      <H2 id="set-it-up">Set it up</H2>
      <Illustration
        label="The Bot comment scoring section of Settings → Bots, with the button Set up (one-time ~240 MB download)"
        caption="Settings → Bots: scoring is set up once per computer."
      >
        <SettingsRow
          label="Bot comment scoring"
          hint="Score how serious each bot review comment is."
          control={<Btn>Set up (one-time ~240 MB download)</Btn>}
        />
      </Illustration>
      <Steps>
        <li>
          Open <DocLink to="settings/bots">Settings → Bots</DocLink>.
        </li>
        <li>
          Under <Ui>Bot comment scoring</Ui>, press <Ui>Set up (one-time ~240 MB download)</Ui>. This downloads the
          model and the program that runs it, once.
        </li>
        <li>
          Wait for the section to say <Ui>Set up. Bot review comments are scored on this machine.</Ui>
        </li>
      </Steps>
      <p>
        You can also run <code>npx limn-review ml install</code> in a terminal, and{' '}
        <code>npx limn-review ml status</code> to check it.
      </p>

      <H2 id="it-will-not-slow-your-computer">It will not slow your computer</H2>
      <p>
        Scoring runs in the background at low priority, one comment at a time, using at most half of one processor
        core. It pauses while your laptop is on battery. A large backlog of old comments therefore takes a while. If
        you want it faster, or want it to carry on on battery, start Limn with <code>LIMN_ML_CPU_SHARE=1</code> or{' '}
        <code>LIMN_ML_ON_BATTERY=run</code>. To turn scoring off, start Limn with{' '}
        <code>LIMN_ML_DISABLED=true</code>.
      </p>

      <H2 id="where-you-see-it">Where you see it</H2>
      <Illustration
        label="A CodeRabbit thread with Limn's severity Minor and the note: bot said Critical"
        caption="Limn’s severity on a bot comment. When the bot’s own label disagrees, it is shown beside it."
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
        When a bot labels its own comment, Limn shows that label beside its own as “bot said …”, with an arrow when
        the two disagree. The <Ui>Inflation</Ui> column on the ROI table counts how often each bot graded a finding
        worse than Limn did. A bot that labels nothing shows a dash: no label is silence, not agreement.
      </p>
      <Note title="How accurate it is">
        On a held-out sample judged by people, Limn’s label agreed 70% of the time; the bots’ own labels agreed 47%
        of the time. The model rarely calls something critical, so read major and critical together as “high”.
      </Note>
      <Note>
        Limn’s own review findings are not scored by this model. Their severity is the one the review gave them. Some
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
