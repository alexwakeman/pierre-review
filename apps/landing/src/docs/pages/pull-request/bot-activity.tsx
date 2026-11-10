import type { DocMeta } from '../../types';
import { DocLink, H2, Illustration, MiniTable, Note, Pill, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Bot activity tab',
  summary: 'How each review bot behaved on this pull request, compared with its own usual.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Bot activity</Ui> tab shows how each review bot behaved on this pull request, compared with that
        bot's own usual over the last 84 days. It appears only when a review bot took part, and it is the last
        tab. No AI is involved: it is counting and comparing.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <p>One card per bot, with:</p>
      <ul>
        <li>
          <b>
            <Ui>Time to first review</Ui>
          </b>
          , and whether that is slower than the bot's typical time.
        </li>
        <li>
          <b>Touches</b>: how many reviews and comments it left. A touch is one review or one comment, so a review
          with three inline comments counts as four.
        </li>
        <li>
          <b>Follow-ups</b>: how often it came back, and whether that is more than usual.
        </li>
        <li>
          <b>A timeline</b> of its touches on this pull request, in order.
        </li>
      </ul>

      <Illustration
        label="Bot activity: CodeRabbit took 2 hours to first review, slower than its usual 20 minutes, with 9 touches."
        caption="One bot, slower than usual on this pull request."
      >
        <MiniTable
          cols={[
            { key: 'bot', label: 'Bot' },
            { key: 'ttfr', label: 'Time to first review' },
            { key: 't', label: 'Touches', num: true },
          ]}
          rows={[
            { _key: 'cr', bot: 'CodeRabbit', ttfr: <>2h <Pill tone="amber">slower than typical — usually 20m</Pill></>, t: '9' },
            { _key: 'cp', bot: 'Copilot', ttfr: '6m', t: '3' },
          ]}
        />
      </Illustration>

      <Note>
        When a bot was slower than usual, the tab's label carries a warning mark. The usual is the bot's own,
        across your account, so the comparison is fair to slow and fast bots alike.
      </Note>

      <H2 id="related">Related pages</H2>
      <ul>
        <li>
          <DocLink to="bots-monitoring/overview">Bots Monitoring</DocLink>: the same measures across the workspace.
        </li>
        <li>
          <DocLink to="bots-monitoring/severity-scoring">Severity scoring</DocLink>: how serious each bot comment is.
        </li>
        <li>
          <DocLink to="feed/people-and-bots">People or bots</DocLink>: how Limn decides who is a bot.
        </li>
      </ul>
    </>
  );
}
