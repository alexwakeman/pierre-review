import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Pill, PrRow, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Dependencies',
  summary: 'Dependency updates from bots such as Dependabot and Renovate, and what Limn can do with them.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>Dependencies</Ui> holds every open dependency update in the workspace, and every security alert a
        security tool raised on a pull request. Security items come first, then the other updates. A pull
        request a dependency bot opened is listed only here, so it does not crowd the other tabs. Chips narrow
        the list to <Ui>Security</Ui> or <Ui>Bumps</Ui>.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <H3>Security</H3>
      <ul>
        <li>
          <b>
            <Ui>Security fix</Ui>
          </b>
          : the update's own notes say it fixes a known advisory. The card names the advisory, for example
          "Fixes GHSA-… and 2 more".
        </li>
        <li>
          <b>
            <Ui>Likely security fix</Ui>
          </b>
          : Limn infers a fix but the update does not state it in full.
        </li>
        <li>
          <b>
            <Ui>Security alert</Ui>
          </b>
          : a security tool (for example Socket, Dependency Review or Endor Labs) flagged an advisory on a pull
          request. A person's pull request with an alert keeps its other cards; the alert is an extra job.
        </li>
      </ul>
      <H3>Bumps</H3>
      <p>
        Every other pull request a dependency bot opened, as a <Ui>Dependency update</Ui> card.
      </p>
      <p>
        Each card says who opened it (the bot's name, such as Dependabot or Renovate) and its state:{' '}
        <Ui>Ready to merge</Ui>, <Ui>Behind trunk</Ui>, <Ui>Blocked</Ui>, conflicts, a red build, or needs an
        approving review.
      </p>

      <Illustration
        label="Dependencies: a security fix from Dependabot ready to merge, and a Renovate bump behind trunk."
        caption="One security item and one bump."
      >
        <PrRow title="Bump undici from 6.19.2 to 6.21.1" repo="acme/web · Dependabot" status={<Pill tone="red">Security fix</Pill>}>
          <Pill tone="green">Ready to merge</Pill>
        </PrRow>
        <PrRow title="Update dependency vitest to v3" repo="acme/api · Renovate" status={<Pill>Dependency update</Pill>}>
          <Pill tone="amber">Behind trunk</Pill>
        </PrRow>
      </Illustration>

      <H2 id="what-you-can-do">What you can do</H2>
      <ul>
        <li>
          <b>Land one.</b> A dependency update's card has the same merge buttons as{' '}
          <DocLink to="pending/ready-to-land">Ready to land</DocLink>, where you can push to the repository. A
          conflict carries <Ui>Resolve conflicts</Ui>.
        </li>
        <li>
          <b>Land many.</b> <Ui>Merge or arm all dependency updates…</Ui> merges the ones that can land now and
          arms Merge when ready on the rest. It asks before it does anything.
        </li>
        <li>
          <b>Let Limn do it.</b> Settings can merge, approve, resolve threads on, or AI-fix dependency updates by
          themselves, for the bots you trust. All of it is off until you switch it on. What it did is listed on
          this tab. See <DocLink to="merging/dependency-automation">Dependency automation</DocLink> and{' '}
          <DocLink to="settings/dependencies">Settings → Dependencies</DocLink>.
        </li>
      </ul>

      <Note>
        A review asked of you on a dependency update still shows in <DocLink to="pending/my-turn">My turn</DocLink>.
        The Pending mute does not reach this tab.
      </Note>

      <Warning>
        Merging many updates at once changes many repositories on GitHub. Read the list in the confirmation
        before you accept it.
      </Warning>
    </>
  );
}
