import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Pill, PrRow, Ui, Warning } from '../../kit';

export const meta: DocMeta = {
  title: 'Blast radius',
  summary: 'The Low, Medium or High reach chip: how much of the code base a change can affect.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The blast radius chip says how far a pull request's change can reach: <Ui>Low</Ui>, <Ui>Medium</Ui> or{' '}
        <Ui>High</Ui>. It is a second reading beside the size. A 2,000-line lock file update reaches little; a
        four-line change to a database migration can reach a lot. The chip shows its reasons, so you can check it
        and disagree. It is worked out from the list of changed files, with no AI.
      </p>


      <H2 id="the-levels">The levels</H2>
      <H3>High: read it properly</H3>
      <p>Any one of these:</p>
      <ul>
        <li>
          It touches a contract other code depends on: a database migration or schema, published type definitions,
          service contracts (protobuf, GraphQL, Thrift, OpenAPI), infrastructure code, or auth and security code.
        </li>
        <li>It touches a hub: a file that, in this repository's history, often changes together with many others.</li>
        <li>It spreads wide: three or more areas, six or more folders, or 15 or more code files.</li>
        <li>It is large: 1,000 or more lines of code.</li>
      </ul>
      <H3>Low: a quick look is enough</H3>
      <p>
        No contract is touched, and either no code files changed (only docs, config, tests or dependencies), or at
        most three code files and 100 lines, in one area.
      </p>
      <H3>Medium</H3>
      <p>
        Everything else. The chip names what kept it out of Low, for example "too many files" or "too long".
      </p>

      <Illustration
        label="Two pull requests: #612 with a Medium chip, #701 Rename ledger with a High chip that names a database migration."
        caption="The chip on two pull requests, with its reason."
      >
        <PrRow title="#612 Partial refunds" repo="acme/payments · +214 −38" status={<Pill tone="amber">Medium</Pill>} why="4 code files, 252 lines" />
        <PrRow title="#701 Rename ledger" repo="acme/ledger · +40 −12" status={<Pill tone="red">High</Pill>} why="Touches a database migration" />
      </Illustration>

      <H2 id="when-there-is-no-chip">When there is no chip</H2>
      <p>
        No chip means Limn does not know. That happens when the file list has not synced, the size was never seen,
        or GitHub cut the file list short and nothing in the part it sent makes the change High. A cut-short list is
        never called Low, because the missing files could only add reach.
      </p>
      <p>
        A change whose every line is a comment, or that only moved whitespace, is never more than Medium.
      </p>

      <H2 id="tune-it">Tune it</H2>
      <p>
        In <DocLink to="settings/pull-requests">Settings → Pull requests</DocLink>, choose how strict the chip is:{' '}
        <Ui>Cautious</Ui> (fewer pull requests count as Low), <Ui>Balanced</Ui> (the default) or <Ui>Relaxed</Ui>{' '}
        (more count as Low). You can also choose which kinds of contract count. Every chip in the app changes at
        once.
      </p>
      <Note>
        The hub reading needs enough history. Many repositories do not have enough, and then no file counts as a
        hub. That is "no reading", not "no hubs".
      </Note>
      <Warning>
        The chip is a guess from the file list. It does not read the code. If auto review is set to approve
        low-impact pull requests, it uses this same level, and treats "no chip" as High. See{' '}
        <DocLink to="ai-review/verdicts-and-posting">Verdicts and posting</DocLink>.
      </Warning>
    </>
  );
}
