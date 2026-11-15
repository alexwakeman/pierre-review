import type { DocMeta } from '../../types';
import { DocLink, H2, Illustration, Kbd, Note, SettingsRow, Toggle, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Features',
  summary: 'Choose which pages the sidebar shows, and switch AI and bot comment analysis on or off.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Features</Ui> tab has one switch for each page the sidebar can leave out. Switch a page off to keep
        the sidebar short. The choice applies to you in every workspace and takes effect as soon as you select the
        switch.
      </p>

      <H2 id="the-switches">The switches</H2>
      <Illustration label="The Features tab with five switches: Timeline off, the other four on." caption="One switch per page the sidebar can hide.">
        <SettingsRow label="Timeline" hint="Every pull request drawn over time, with its reviews, comments and commits." control={<Toggle on={false} />} />
        <SettingsRow label="Feed" hint="One stream of everything happening in this workspace." control={<Toggle on />} />
        <SettingsRow label="Reports" hint="Shows once your first repository has finished syncing 90 days." control={<Toggle on />} />
        <SettingsRow label="This Sprint" hint="Shows once a tracker or a sprint is found." control={<Toggle on />} />
        <SettingsRow label="Bots Monitoring" hint="Measure what your review bots cost and catch." control={<Toggle on />} />
      </Illustration>
      <ul>
        <li>
          <Ui>Timeline</Ui>: every pull request drawn over time. Off until you switch it on. See{' '}
          <DocLink to="timeline/overview">Read the timeline</DocLink>.
        </li>
        <li>
          <Ui>Feed</Ui>: one stream of everything happening in this workspace. See{' '}
          <DocLink to="feed/overview">Feed</DocLink>.
        </li>
        <li>
          <Ui>Reports</Ui>: shows once your first repository has finished syncing 90 days of history. See{' '}
          <DocLink to="reports/overview">Reports</DocLink>.
        </li>
        <li>
          <Ui>This Sprint</Ui>: shows once a Jira, Linear or Notion tracker is set up, or Ensemble finds a GitHub milestone
          with a due date or a current Projects iteration. See <DocLink to="this-sprint/overview">This Sprint</DocLink>.
        </li>
        <li>
          <Ui>Bots Monitoring</Ui>: measure what your review bots cost and catch. See{' '}
          <DocLink to="bots-monitoring/overview">Bots Monitoring</DocLink>.
        </li>
      </ul>
      <p>
        Open pull requests and Pending are always in the sidebar. Docs is there whenever the AI features are on.
      </p>

      <H2 id="what-hiding-does">What hiding a page does</H2>
      <p>
        Hiding is about what you see, nothing more. A page switched off leaves the sidebar and the search menu. A link
        to it still opens it, and Ensemble keeps syncing and scoring as before, so the page is up to date if you switch it
        back on.
      </p>
      <p>
        The Timeline is different: off means off. Ensemble does not load the board, a link to it opens{' '}
        <Ui>Open pull requests</Ui>, <Kbd>g</Kbd> <Kbd>t</Kbd> does nothing, and the Focus and{' '}
        <Ui>Show on the timeline</Ui> buttons are hidden.
      </p>
      <Note>
        Reports and This Sprint switch themselves on when they have something to show. Switch one off to keep it
        hidden even then.
      </Note>

      <H2 id="ai-and-bot-comment-analysis">AI and bot comment analysis</H2>
      <p>
        Below the pages, two switches turn the downloaded tools on or off. This is the one place in the app that
        downloads them.
      </p>
      <Illustration
        label="Two switches: AI (Claude and Codex) on and downloaded, Bot comment analysis off and not downloaded."
        caption="Each switch says what is installed."
      >
        <SettingsRow label="AI (Claude and Codex)" hint="Downloaded." control={<Toggle on />} />
        <SettingsRow
          label="Bot comment analysis"
          hint="Not downloaded yet. Switching it on asks before downloading."
          control={<Toggle on={false} />}
        />
      </Illustration>
      <ul>
        <li>
          <Ui>AI (Claude and Codex)</Ui>: on when it is downloaded. Ensemble downloads it by itself the first time it
          starts. Switched off, every AI feature shows how to set it up again and nothing runs automatically. The
          download stays on your computer. See <DocLink to="settings/ai">AI</DocLink>.
        </li>
        <li>
          <Ui>Bot comment analysis</Ui>: labels how serious each bot review comment is. Switched off, no new comments are
          scored; labels already shown stay, and so does the model. See{' '}
          <DocLink to="bots-monitoring/severity-scoring">Severity scoring</DocLink>.
        </li>
      </ul>
      <p>
        Switching on a tool that is not downloaded asks first, and says how big the download is. Select{' '}
        <Ui>Download</Ui> to start it. When a tool is installed, the switch lists what was found: versions, the models
        and where they are. From a terminal, <code>npx ensemble-review ai install</code> and{' '}
        <code>npx ensemble-review ml install</code> do the same downloads.
      </p>
    </>
  );
}
