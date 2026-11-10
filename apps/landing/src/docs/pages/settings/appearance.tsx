import type { DocMeta } from '../../types';
import { DocLink, H2, Illustration, Note, Pill, SettingsRow, Steps, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Appearance',
  summary: 'Choose the colour scheme.',
};

const SCHEMES_LIGHT = ['Limn Light', 'Solarized Light', 'GitHub Light', 'Gruvbox Light'];
const SCHEMES_DARK = ['Limn Dark', 'Solarized Dark', 'Dracula', 'Nord', 'Tokyo Night'];

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Appearance</Ui> tab is the first tab in Settings. It holds one choice: the colour scheme the whole app
        uses. Pick the one that is easiest on your eyes. The choice changes nothing else.
      </p>

      <H2 id="open-settings">Open Settings</H2>
      <p>
        Every Settings tab opens the same way. The tabs are listed on the left of the Settings window (along the top on
        a narrow screen). The arrow keys move between tabs.
      </p>
      <Steps>
        <li>At the bottom of the sidebar, select your name to open the account menu.</li>
        <li>
          Select <Ui>Settings</Ui>.
        </li>
        <li>
          Select a tab, for example <Ui>Appearance</Ui>.
        </li>
      </Steps>
      <Note title="Two kinds of setting">
        Some settings apply to you everywhere. Others apply to one workspace only. In a tab that has both, the
        workspace settings sit under a heading that reads <Ui>Workspace · </Ui> followed by the workspace name. To
        change another workspace, switch to it in the sidebar first, then open Settings again. See{' '}
        <DocLink to="getting-started/workspaces">Group repositories into workspaces</DocLink>.
      </Note>
      <Note title="Tabs that need AI">
        The <Ui>AI</Ui>, <Ui>AI review</Ui>, <Ui>Docs</Ui> and <Ui>Sandbox</Ui> tabs show only when the AI features
        are on. They are on unless whoever started Limn turned them off.
      </Note>

      <H2 id="colour-scheme">Choose a colour scheme</H2>
      <p>
        Open <Ui>Colour scheme</Ui> and pick a scheme. Each name in the list is drawn in its own colours, so you can see
        it before you choose. The app changes at once. There is no Save button.
      </p>
      <Illustration
        label="The Appearance tab with the Colour scheme list showing Limn Light."
        caption="The scheme setting. Each name in the list shows that scheme's own colours."
      >
        <SettingsRow label="Colour scheme" hint="Saved in this browser." control={<Pill tone="grey">Limn Light</Pill>} />
      </Illustration>
      <p>There are nine schemes:</p>
      <ul>
        <li>
          <b>Light:</b> {SCHEMES_LIGHT.join(', ')}.
        </li>
        <li>
          <b>Dark:</b> {SCHEMES_DARK.join(', ')}.
        </li>
      </ul>
      <p>Every scheme is checked for contrast, so text stays readable whichever one you pick.</p>

      <H2 id="where-it-is-saved">Where the choice is saved</H2>
      <p>
        The scheme is saved in this browser only. Limn does not keep it with your other settings. If you open Limn in a
        second browser or a private window, choose the scheme there too.
      </p>
    </>
  );
}
