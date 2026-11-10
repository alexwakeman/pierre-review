import type { DocMeta } from '../../types';
import { Chip, DocLink, FindingRow, H2, Illustration, MiniTable, Note, Steps, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Claude and Codex together',
  summary: 'With both signed in, the two review at the same time without seeing each other, and Limn merges the findings.',
};

function MergedPicture(): JSX.Element {
  return (
    <Illustration
      label="A Claude + Codex review of pull request 612. One blocker was found by both and is shown once, marked Claude + Codex. One warning was found by Codex only."
      caption="One review from two: a point both raised is shown once."
      title="#612 Partial refunds"
      meta="Claude + Codex"
    >
      <FindingRow chip="Blocker" tone="red">
        RefundPolicy.allows() never reads paid_at. <Chip>Claude + Codex</Chip>
      </FindingRow>
      <FindingRow chip="Warning" tone="amber">
        A retried refund sends a second email. <Chip>Codex</Chip>
      </FindingRow>
      <FindingRow chip="Nit">
        Unused import in refunds/policy.py. <Chip>Claude</Chip>
      </FindingRow>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        Two different models miss different things. When you are signed in to both Claude and Codex, Limn can run
        both on the same commit and give you one review. In Limn's own tests, one Claude review and one Codex review,
        merged, found about four in five known issues; either one alone found about half.
      </p>
      <WhoItHelps
        developer="Fewer missed bugs, in one list, with nothing repeated."
        manager="A stronger first review without a second tool, and without twice the noise on GitHub."
      />

      <H2 id="when-it-runs">When it runs</H2>
      <ul>
        <li>
          <b>Reviews you start.</b> In the <Ui>Model</Ui> menu of <Ui>Run a review</Ui>, <Ui>Claude + Codex</Ui> is
          listed last while both providers can review, and it is the default. Pick a single model from the menu to
          review with that one only.
        </li>
        <li>
          <b>Automatic reviews.</b> <Ui>Settings → AI review</Ui>, <Ui>Auto reviews use</Ui>:{' '}
          <Ui>Claude + Codex (the default)</Ui>, or your default provider only. If only one is signed in when a review
          starts, that one reviews alone and the setting says <Ui>Only one is signed in, so it reviews alone.</Ui>
        </li>
      </ul>

      <H2 id="how-the-two-are-merged">How the two are merged</H2>
      <MergedPicture />
      <Steps>
        <li>Claude and Codex start at the same time, each on its own. Neither sees the other's findings.</li>
        <li>
          When both have finished, the tab says <Ui>Merging the two reviews…</Ui>. Limn groups the findings that make
          the same point and keeps one of each group. A short summary covers both.
        </li>
        <li>
          Limn, not a model, decides which finding of a group is kept. The more severe one wins, so a blocker is
          never merged into a nit. A finding already on GitHub is always the one kept.
        </li>
        <li>
          Each finding says who raised it: <Ui>Claude</Ui>, <Ui>Codex</Ui>, or <Ui>Claude + Codex</Ui> when both did. When posted, both halves go out as
          one review.
        </li>
      </Steps>
      <p>
        If the merge step itself fails, Limn still gives you one review: it keeps every finding except the clear
        repeats, and joins the two summaries.
      </p>

      <H2 id="one-verdict">One verdict</H2>
      <p>
        A Claude + Codex review gives one verdict. You choose how strict it is in <Ui>Settings → AI review</Ui>,{' '}
        <Ui>When Claude and Codex disagree</Ui>:
      </p>
      <MiniTable
        cols={[
          { key: 'rule', label: 'Setting' },
          { key: 'means', label: 'What it means' },
        ]}
        rows={[
          { _key: 's', rule: 'Strict: approve only if both approve', means: 'The default. Both models must approve.' },
          {
            _key: 'r',
            rule: 'Relaxed: approve if one approves and the other raises nothing that blocks',
            means: 'One approves and the other only comments, with no blocker.',
          },
        ]}
      />
      <p>
        Either way, if one asks for changes, Limn does not approve. A model may hold back an approval because it could
        not check something, such as a binary file in the diff; strict treats that as a reason not to approve,
        relaxed does not. Open blockers and warnings count the same whichever model found them. See{' '}
        <DocLink to="ai-review/verdicts-and-posting">Verdicts and posting to GitHub</DocLink>.
      </p>

      <H2 id="when-one-fails">When one of them fails</H2>
      <p>
        A Claude + Codex review always gives you a result while at least one half finishes. If one half fails, is
        stopped by its usage limit, or is never started (for example because a teammate's Limn is already reviewing
        with that model), the half that finished is the review. The tab says{' '}
        <Ui>Only one of the two reviews finished, so this is that review.</Ui> and names why the other did not
        finish.
      </p>
      <p>
        Before anything is posted, the half that finished also checks the other model's earlier findings that are
        still open. This short check is labelled, for example, <Ui>Checked Codex's findings</Ui>, with a line such as
        "Checked Codex's 3 open findings: 1 dealt with, 2 still open."
      </p>
      <ul>
        <li>An earlier blocker that is still open makes the review request changes.</li>
        <li>An earlier warning that is still open, or one that could not be checked, stops an approval.</li>
        <li>
          The review says why it did not approve, for example "Not approved: 2 earlier Codex points are still open."
          or "Not approved: 1 earlier Codex point was not checked."
        </li>
        <li>
          The checking model never argues with the other model's finding. It may find it fixed, and then Limn may
          resolve its thread.
        </li>
      </ul>
      <Note>
        The model that failed is not run again straight away, because usage limits last hours. When it next reviews,
        it takes its own findings back.
      </Note>

      <H2 id="usage">Usage and stopping</H2>
      <ul>
        <li>Both runs count towards each provider's own usage.</li>
        <li>
          <Ui>Stop</Ui> stops both halves. A half that has not started yet does not start.
        </li>
        <li>
          An automatic Claude + Codex review asks the spend budget for each half. When the budget is used up, the
          first half runs alone. See <DocLink to="settings/ai-usage-and-spend">AI usage and spend</DocLink>.
        </li>
        <li>
          Turning off design diagrams (<Ui>Draw a design diagram after each review</Ui>) saves about a third of a
          provider's review usage. See <DocLink to="ai-review/design-diagrams">Design diagrams</DocLink>.
        </li>
      </ul>
    </>
  );
}
