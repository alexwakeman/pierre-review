import type { DocMeta } from '../../types';
import { Btn, Chip, DocLink, H2, Illustration, MiniTable, Note, Steps, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Design diagrams',
  summary: 'Diagrams that show what a pull request changes: data flow and sequence.',
};

function FlowPicture(): JSX.Element {
  return (
    <Illustration
      label="The design diagram of pull request 612, drawn as a list. Lanes: Screen, API route, Service and Database. Steps: 1 the screen sends the refund amount to the API route; 2 the route checks the amount; 3 the service reads the order's paid date; 4 the service writes the refund row."
      caption="A design diagram, simplified: the lanes the data reaches, left to right, and each step in the order it happens."
      title="Design of this pull request"
      meta="#612 Partial refunds"
    >
      <p>
        <Chip>Screen</Chip> <Chip tone="blue">API route · changed</Chip> <Chip tone="blue">Service · changed</Chip>{' '}
        <Chip>Database</Chip>
      </p>
      <MiniTable
        cols={[
          { key: 'n', label: 'Step' },
          { key: 'f', label: 'From → to' },
          { key: 'd', label: 'What passes' },
        ]}
        rows={[
          { _key: '1', n: '1 · call', f: 'Screen → API route', d: 'refund amount, order id' },
          { _key: '2', n: '2 · validate', f: 'API route', d: 'amount is whole pence and above 0' },
          { _key: '3', n: '3 · read', f: 'Service → Database', d: 'order.paid_at' },
          { _key: '4', n: '4 · write', f: 'Service → Database', d: 'refund row' },
        ]}
      />
      <p>
        <Btn>Redraw</Btn>
      </p>
    </Illustration>
  );
}

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        A diff shows lines; it does not show how the change works. After a review, Limn draws a design diagram of the
        pull request: what touches the data, across the top, and each step down the page in the order it happens. It
        is drawn by a separate run, so it never delays the review.
      </p>
      <WhoItHelps
        developer="Understand a teammate's change before you read the diff, and check your own change does what you meant."
        manager="See the shape of a change (which layers it touches, where it writes data) without reading code."
      />

      <H2 id="what-you-see">What you see</H2>
      <FlowPicture />
      <p>
        The diagram is in the <Ui>AI Review</Ui> tab, under <Ui>Design</Ui>. It has two to seven lanes, left to right in
        the order the data first reaches them. Each lane is one kind of thing: <Ui>Screen</Ui>, <Ui>API route</Ui>,{' '}
        <Ui>Service</Ui>, <Ui>Queue / job</Ui>, <Ui>Database</Ui>, <Ui>File / cache</Ui> or <Ui>Outside API</Ui>. A
        lane's border says whether the pull request adds it, changes it, or leaves it as it was.
      </p>

      <H2 id="read-the-diagram">Read the diagram</H2>
      <ul>
        <li>Steps are numbered in the order they happen, and each arrow names the data that passes.</li>
        <li>A dotted line is a check, a heavy line a write to where data is kept, and a dashed line a result going back.</li>
        <li>The keys under the diagram name the lines and box borders.</li>
        <li>
          Click a step to open its file in the <Ui>Changes</Ui> tab.
        </li>
        <li>
          In a ticket's story view, the diagram covers every pull request of the ticket, and each box and step names the
          pull request that does it.
        </li>
      </ul>
      <Note>
        The model works the flow out from the code, so check it before relying on it. <Ui>Drawn for an earlier
        commit.</Ui> means the pull request has moved on since.
      </Note>

      <H2 id="draw-or-redraw">Draw or redraw</H2>
      <Steps>
        <li>
          Open the pull request's <Ui>AI Review</Ui> tab and find <Ui>Design</Ui>.
        </li>
        <li>
          Press <Ui>Draw</Ui> (or <Ui>Redraw</Ui> when there is one). The button reads <Ui>Drawing…</Ui> while it runs.
        </li>
      </Steps>
      <p>
        A diagram is drawn again after a review of a new commit, unless you turn that off. It is always drawn by a
        mid-sized model (Sonnet on Claude), whichever model reviewed.
      </p>

      <H2 id="when-there-is-none">When there is no diagram</H2>
      <p>
        A change with no data path gets none, and Limn says why in one line, for example{' '}
        <Ui>No diagram: this change only edits copy.</Ui> This happens when the change edits only text or tests, changes
        only a few lines, or the model finds it moves no data. <Ui>Draw</Ui> asks for one anyway.
      </p>

      <H2 id="turn-it-off">Turn it off</H2>
      <p>
        In <Ui>Settings → AI review</Ui>, untick <Ui>Draw a design diagram after each review</Ui>. Turning it off saves
        about a third of a provider's review usage. You can still press <Ui>Draw</Ui> on any pull request. See{' '}
        <DocLink to="settings/ai-review">Settings → AI review</DocLink>.
      </p>
    </>
  );
}
