import type { DocMeta } from '../../types';
import { DocLink, H2, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Release settings',
  summary: 'The release and hotfix suffixes, and the repositories released from this workspace, that This Sprint → Releases needs.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Releases</Ui> tab holds the release settings for the current workspace: two suffixes and the repositories
        you release. All are needed before <DocLink to="this-sprint/releases">This Sprint → Releases</DocLink> does
        anything. There is no default.
      </p>

      <H2 id="the-two-suffixes">The two suffixes</H2>
      <ul>
        <li>
          <Ui>Release suffix</Ui>: added to a version tag to release it. Type <code>rc</code> and releasing v2.4.0
          creates the tag v2.4.0-rc on the same commit.
        </li>
        <li>
          <Ui>Hotfix suffix</Ui>: a tag ending in it is a hotfix. Your team creates those by hand on a hotfix branch.
        </li>
      </ul>
      <p>
        The hyphen is always added: it shows beside the box, and you type only the rest. Each is 1 to 32 characters that
        git allows in a tag name: no spaces, no hyphen at the start, and none of <code>~ ^ : ? * [ \</code>. The two
        must be different, and one cannot end with the other.
      </p>

      <H2 id="released-from-this-workspace">Released from this workspace</H2>
      <p>
        Tick each repository your team releases from this workspace. Only ticked repositories are checked, tagged and
        used as hotfix bases. Nothing is ticked at first. Releases ignores the others completely: no rows, no warnings,
        nothing held back. In a hotfix build an unticked repository is read only.
      </p>

      <H2 id="changing-a-suffix">Changing a suffix</H2>
      <Warning>
        Once a release exists, changing a suffix warns you before you save. Tags ending in the old suffix stop counting
        as releases, so the next check starts again from the newest tag with the new one.
      </Warning>
    </>
  );
}
