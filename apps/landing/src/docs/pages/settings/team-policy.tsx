import type { DocMeta } from '../../types';
import { DocLink, H2, Steps, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Team policy',
  summary: 'Rules a team commits to a repository, applied on every copy of Ensemble.',
};

const EXAMPLE = `{
  "version": 1,
  "automation": {
    "auto_push": false,
    "dependencies": false
  },
  "ai": { "approve": false },
  "note": "Agreed by the platform team, March 2027."
}`;

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        A team policy is a file your team commits to a repository. Every copy of Ensemble that syncs the repository
        reads it and applies its rules to that repository&rsquo;s pull requests. Ten people no longer need ten matching
        sets of settings, and a change to the rules is a pull request your team reviews like any other.
      </p>

      <H2 id="needs-a-licence-key">Needs a licence key</H2>
      <p>
        Team policy is the one Ensemble feature that needs a licence key. A copy of Ensemble applies policies while it
        holds a licence key or during its 30-day evaluation. Without either, it applies no policy, and{' '}
        <Ui>Settings → Team policy</Ui> says so. Rules your team relies on need the key on every person&rsquo;s copy.
      </p>
      <p>
        Team size does not matter: a team of three or fewer can ask for a free key. See{' '}
        <DocLink to="licence/licence">the licence page</DocLink>.
      </p>

      <H2 id="add-a-policy">Add a policy</H2>
      <Steps>
        <li>
          Create <code>.ensemble/policy.json</code> on the repository&rsquo;s default branch, for example:
          <pre>{EXAMPLE}</pre>
        </li>
        <li>Merge it. Ensemble reads it the next time it syncs the repository, within a few minutes.</li>
        <li>
          Open <Ui>Settings → Team policy</Ui> to check what each copy reads: the rules in plain English, or the problems
          in the file.
        </li>
      </Steps>

      <H2 id="the-rules">The rules</H2>
      <p>
        A policy only switches things off. A rule you leave out keeps each person&rsquo;s own setting, and{' '}
        <code>true</code> changes nothing.
      </p>
      <ul>
        <li>
          <code>automation.auto_review: false</code>: Ensemble never starts a review of this repository&rsquo;s pull
          requests by itself, including <Ui>Run auto reviews now</Ui>. A person can still press <Ui>Review</Ui>.
        </li>
        <li>
          <code>automation.auto_post: false</code>: AI reviews are never posted automatically. <Ui>Review and post</Ui>{' '}
          still posts, because the press is the person&rsquo;s choice.
        </li>
        <li>
          <code>automation.auto_fix: false</code>: no automatic AI Fix.
        </li>
        <li>
          <code>automation.auto_push: false</code>: nothing is pushed without a press of <Ui>Push</Ui>. This covers{' '}
          <Ui>Push automatically</Ui>, <Ui>Push when done</Ui>, dependency fixes and Implement story&rsquo;s automatic
          push.
        </li>
        <li>
          <code>automation.auto_resolve: false</code>: Ensemble never resolves review threads by itself.
        </li>
        <li>
          <code>automation.dependencies: false</code>: no dependency automation at all. A merge it armed earlier is
          disarmed.
        </li>
        <li>
          <code>ai.approve: false</code>: an AI review never approves. It posts a comment instead and says why.
        </li>
        <li>
          <code>dependencies.trusted_bots</code>: a list of GitHub logins, such as <code>&quot;dependabot[bot]&quot;</code>.
          Dependency automation acts only on these bots&rsquo; pull requests.
        </li>
        <li>
          <code>note</code>: text shown in Settings, for the reason behind the rules.
        </li>
      </ul>
      <p>
        A file with a mistake, such as a misspelt rule, is not applied at all, so a typo never quietly drops a rule.{' '}
        <Ui>Settings → Team policy</Ui> lists each problem. Rules for allowed AI providers and a spending limit per run
        are not available yet.
      </p>

      <H2 id="different-rules">When repositories have different rules</H2>
      <p>
        Rules never clash. Each repository&rsquo;s file governs only that repository&rsquo;s pull requests, and every
        pull request belongs to one repository. Two repositories in one workspace can have different rules, or one can
        have none.
      </p>
      <ul>
        <li>
          Work that spans repositories obeys each one: a story check posts to each pull request under that
          pull request&rsquo;s own rules.
        </li>
        <li>
          Implement story pushes to several repositories at once, so one policy has to decide. When the repositories
          agree, theirs applies. When they differ, your workspace decides: under <Ui>When repositories&rsquo; rules
          differ</Ui> in <Ui>Settings → Team policy</Ui>, choose one repository&rsquo;s policy, which then overrides
          the others for that work, or leave the default, the strictest rule from each.
        </li>
        <li>
          There is no rule for a whole GitHub organisation yet. To apply the same rules everywhere, commit the same
          file to each repository.
        </li>
        <li>
          After a change to the file, each copy of Ensemble picks it up at its next sync, usually within a few minutes.
        </li>
      </ul>

      <H2 id="where-you-see-it">Where you see it</H2>
      <ul>
        <li>
          <Ui>Settings → Team policy</Ui> lists every repository in the workspace with a policy, its rules and the commit
          it was read at.
        </li>
        <li>
          Under <Ui>Settings → AI Review → Auto review</Ui> and <Ui>Settings → Dependencies</Ui>, a line names the
          repositories whose policy switches some of those settings off.
        </li>
      </ul>
    </>
  );
}
