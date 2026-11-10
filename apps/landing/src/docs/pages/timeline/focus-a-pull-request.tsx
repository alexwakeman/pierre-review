import type { DocMeta } from '../../types';
import { DocLink, H2, Note, Steps, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Focus one pull request',
  summary: 'Open a pull request in its own timeline tab to see only its events.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        A Focus tab is a timeline for one pull request. It shows only that pull request's bar and the rows of the
        people who took part, fitted to the pull request's whole life, with the pull request's detail in a pane
        below. Use it to read the history of one pull request in order: when it was reviewed, who replied, and
        when the fixes were pushed.
      </p>


      <H2 id="open-a-focus-tab">Open a Focus tab</H2>
      <p>Any of these opens one:</p>
      <ul>
        <li>Double-click a pull request's bar on the Timeline.</li>
        <li>Click a mark that several people share.</li>
        <li>
          In a pull request, choose <Ui>Focus in its own timeline tab</Ui> from the menu.
        </li>
        <li>In a feed card, choose the Focus button.</li>
      </ul>
      <p>
        A Focus tab works for a pull request of any age, even one older than the Timeline's range. It is listed
        under <Ui>Open tabs</Ui>, and you can pin it. See{' '}
        <DocLink to="getting-started/find-your-way-around#tabs">Tabs</DocLink>.
      </p>

      <H2 id="what-you-can-do">What you can do</H2>
      <Steps>
        <li>Click a mark to read that event in the pane below.</li>
        <li>
          Use <Ui>Events</Ui> to choose which kinds of event show, and which review verdicts.
        </li>
        <li>
          Use <Ui>Hide bots</Ui> to hide or show bot activity. While you keep some bots visible on the main
          board, it reads <Ui>Hide bots (except N)</Ui>.
        </li>
        <li>Close the tab, or switch to another, to leave.</li>
      </Steps>
      <Note>
        <Ui>Events</Ui> and <Ui>Hide bots</Ui> are the same settings as on the main Timeline, so a change in one
        applies to the other. An event you came to from a link always shows.
      </Note>

      <H2 id="show-vs-focus">Show on the timeline, or Focus</H2>
      <ul>
        <li>
          <b>
            <Ui>Show on the timeline</Ui>
          </b>{' '}
          keeps the whole board and centres it on the pull request, which pulses for a moment.
        </li>
        <li>
          <b>
            <Ui>Focus in its own timeline tab</Ui>
          </b>{' '}
          opens a new tab with that pull request alone.
        </li>
      </ul>
    </>
  );
}
