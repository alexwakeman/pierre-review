import type { DocMeta } from '../../types';
import { DocLink, H2, Illustration, Note, SettingsRow, Toggle, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Features',
  summary: 'Choose which pages the sidebar shows.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Features</Ui> tab has one switch for each page the sidebar can leave out. Switch a page off to keep
        the sidebar short. The choice applies to you in every workspace and takes effect as soon as you select the
        switch.
      </p>
      <WhoItHelps
        developer="Hide the pages you never open, so the sidebar shows only the places you work."
        manager="Keep Reports and Bots Monitoring visible for yourself while a teammate hides them on their own Limn."
      />

      <H2 id="the-switches">The switches</H2>
      <Illustration label="The Features tab with four switches, all on." caption="One switch per page the sidebar can hide.">
        <SettingsRow label="Feed" hint="One stream of everything happening in this workspace." control={<Toggle on />} />
        <SettingsRow label="Reports" hint="Shows once your first repository has finished syncing 90 days." control={<Toggle on />} />
        <SettingsRow label="This Sprint" hint="Shows once a tracker or a sprint is found." control={<Toggle on />} />
        <SettingsRow label="Bots Monitoring" hint="Measure what your review bots cost and catch." control={<Toggle on />} />
      </Illustration>
      <ul>
        <li>
          <Ui>Feed</Ui>: one stream of everything happening in this workspace. See{' '}
          <DocLink to="feed/overview">Feed</DocLink>.
        </li>
        <li>
          <Ui>Reports</Ui>: shows once your first repository has finished syncing 90 days of history. See{' '}
          <DocLink to="reports/overview">Reports</DocLink>.
        </li>
        <li>
          <Ui>This Sprint</Ui>: shows once a Jira, Linear or Notion tracker is set up, or Limn finds a GitHub milestone
          with a due date or a current Projects iteration. See <DocLink to="this-sprint/overview">This Sprint</DocLink>.
        </li>
        <li>
          <Ui>Bots Monitoring</Ui>: measure what your review bots cost and catch. See{' '}
          <DocLink to="bots-monitoring/overview">Bots Monitoring</DocLink>.
        </li>
      </ul>
      <p>
        Open pull requests, Pending and Timeline are always in the sidebar. Docs is there whenever the AI features are
        on.
      </p>

      <H2 id="what-hiding-does">What hiding a page does</H2>
      <p>
        Hiding is about what you see, nothing more. A page switched off leaves the sidebar and the search menu. A link
        to it still opens it, and Limn keeps syncing and scoring as before, so the page is up to date if you switch it
        back on.
      </p>
      <Note>
        Reports and This Sprint switch themselves on when they have something to show. Switch one off to keep it
        hidden even then.
      </Note>
    </>
  );
}
