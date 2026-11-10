import type { DocMeta } from '../../types';
import { Btn, DocLink, H2, Illustration, Note, Steps, Thread, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Plan first',
  summary: 'Talk the fix through with the agent before it changes any code.',
};

function PlanPicture(): JSX.Element {
  return (
    <Illustration
      label="A Plan first session on pull request 612. The agent's plan says it will add a paid_at check to allows() and a test for day 31. The reader asks it to keep the window in settings. A Start fix button."
      caption="Plan first: the agent proposes, you steer, then Start fix."
      title="AI Fix · Plan first"
      meta="#612 Partial refunds"
    >
      <Thread
        comments={[
          {
            who: 'Claude Code',
            text: 'Plan: 1. In allows(), reject orders whose paid_at is older than the refund window. 2. Add tests for day 30 and day 31. 3. Leave the email retry for a separate change (F2 needs the queue).',
          },
          { who: 'You', text: 'Read the window from settings.REFUND_DAYS rather than a constant.' },
          { who: 'Claude Code', text: 'Updated: step 1 reads settings.REFUND_DAYS.' },
        ]}
      />
      <p>
        <Btn tone="go">Start fix</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Some fixes need a decision before any code changes: which of two approaches, whether a finding is worth fixing
        here, what to leave for later. <Ui>Plan first</Ui> opens the same sandbox in a talking mode. The agent reads the
        items and the code, runs commands if it needs to, and proposes a plan. It cannot edit files until you press{' '}
        <Ui>Start fix</Ui>.
      </p>
      <WhoItHelps
        developer="Agree the approach in a minute of chat instead of rewriting a fix you did not want."
        manager="Larger fixes get a short, reviewable plan before anything is built."
      />

      <H2 id="start-with-a-plan">Start with a plan</H2>
      <PlanPicture />
      <Steps>
        <li>
          On the <Ui>AI Fix</Ui> tab, tick the items under <Ui>What to fix</Ui>.
        </li>
        <li>
          Tick <Ui>Plan first</Ui> beside the Run button. The button now reads <Ui>Make a plan</Ui>.
        </li>
        <li>
          Press <Ui>Make a plan</Ui>. The tab says <Ui>The agent is making a plan.</Ui>, then{' '}
          <Ui>The plan is ready. Talk to the agent, then press Start fix.</Ui>
        </li>
      </Steps>

      <H2 id="talk-it-through">Talk it through</H2>
      <p>
        Type in the message box: <Ui>Ask about the plan, or say what to change in it.</Ui> Each message is one turn. The
        agent can read and run commands in the sandbox to answer, but it does not change any file. Send as many messages
        as you need.
      </p>

      <H2 id="start-the-fix">Start the fix</H2>
      <p>
        Press <Ui>Start fix</Ui>. The same session switches to building and fixes the items, following the plan you
        agreed. Words in the message box go with it. From here it works as any fix: watch, stop, ask for more, then push
        or discard. See <DocLink to="ai-fix/overview#watch-it-work">Fix a pull request with AI Fix</DocLink>.
      </p>
      <Note>
        A plan takes no build slot, so you can plan while another session builds. <Ui>Start fix</Ui> needs the build
        slot: only one session builds at a time on this computer.
      </Note>

      <H2 id="when-to-use-it">When to use it</H2>
      <ul>
        <li>The items touch code you know well and you have a preferred approach.</li>
        <li>Several findings pull in different directions, and you want to choose which to fix.</li>
        <li>The fix could be large, and you want to see its shape first.</li>
      </ul>
      <p>
        Plan first is for fixes you start. An automatic fix never plans. Talking turns and building turns are both
        recorded in your AI usage, as separate lines. See{' '}
        <DocLink to="reports/ai-usage">AI usage</DocLink>.
      </p>
      <Note>
        Plan first shows only when the model you picked can plan. If the sandbox closes while you are planning,{' '}
        <Ui>Resume</Ui> starts a new sandbox; the agent does not remember the conversation.
      </Note>
    </>
  );
}
