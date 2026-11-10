import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Pill, PrRow, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Needs fixing',
  summary: 'Pull requests with failing checks or merge conflicts, and failing default branches.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        <Ui>Needs fixing</Ui> lists what is broken: pull requests whose latest build failed, pull requests that
        conflict with their base, and default branches whose checks are failing. Chips at the top narrow the
        list to <Ui>CI failing</Ui> or <Ui>Merge conflicts</Ui>. Items are ordered by score; the top five are{' '}
        <Ui>Do next</Ui>.
      </p>


      <H2 id="what-you-see">What you see</H2>
      <H3>CI failing</H3>
      <ul>
        <li>
          <b>
            <Ui>CI failing on your PR</Ui>
          </b>
          : the latest build on an open pull request failed. The card names up to three failing checks, for
          example "CI failing: build, lint and 2 more".
        </li>
        <li>
          <b>
            <Ui>Trunk CI failing</Ui>
          </b>
          : the default branch is failing in a repository you maintain. It is red if you merged the pull
          request that landed the failing commit, and amber otherwise.
        </li>
      </ul>
      <H3>Merge conflicts</H3>
      <p>
        A pull request conflicts with its base, in a repository you can push to. Conflicts in repositories you
        can only read are left out, so your own work is not buried under other people's stale branches.
      </p>

      <Illustration
        label="Needs fixing: a CI failing card on #488 and a Merge conflicts card on #701 with a Resolve conflicts button."
        caption="Two Needs fixing items."
      >
        <PrRow title="#488 Webhook timeouts" repo="acme/api · CI failing: test, lint" status={<Pill tone="red">CI failing</Pill>} />
        <PrRow title="#701 Rename ledger" repo="acme/ledger · conflicts with main" status={<Pill tone="red">Merge conflicts</Pill>}>
          <span className="mk-btn">Resolve conflicts</span>
        </PrRow>
      </Illustration>

      <Note>
        Your own pull request's failing build or conflict is listed in{' '}
        <DocLink to="pending/my-turn">My turn</DocLink> instead, under <Ui>Your PRs</Ui>, so it is listed once.
        A dependency update with a red build is listed in <DocLink to="pending/dependencies">Dependencies</DocLink>.
      </Note>

      <H2 id="what-you-can-do">What you can do</H2>
      <ul>
        <li>
          <b>Read the failing check.</b> Go to the item to open the pull request's Overview, where each failing
          check opens its log. See <DocLink to="merging/ci-logs">CI logs</DocLink>.
        </li>
        <li>
          <b>Ask the AI.</b> Where the AI features are on, the CI review explains why a check failed. See{' '}
          <DocLink to="ai-review/ci-review">CI review</DocLink>. AI Fix can fix a failing check. See{' '}
          <DocLink to="ai-fix/overview">AI Fix</DocLink>.
        </li>
        <li>
          <b>
            <Ui>Resolve conflicts</Ui>
          </b>{' '}
          opens the conflict resolver, where you decide each conflict yourself. See{' '}
          <DocLink to="merging/resolve-conflicts">Resolve merge conflicts</DocLink>.
        </li>
        <li>
          <b>A red default branch</b> opens that repository's page with its default branch row open. A failing
          commit no pull request names opens its checks on GitHub.
        </li>
      </ul>

      <H2 id="why-it-helps">Why it helps</H2>
      <p>
        A red build or a conflict stops a pull request from landing until someone acts. This tab puts those
        items together and names the check that failed, so you can fix it, or ask the person who can.
      </p>
    </>
  );
}
