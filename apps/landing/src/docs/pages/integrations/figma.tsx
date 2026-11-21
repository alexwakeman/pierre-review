import type { DocMeta } from '../../types';
import { DocLink, ExtLink, H2, Note, Steps, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Figma',
  summary: 'Let Implement story read the Figma frames a ticket links.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        When a ticket links a <ExtLink href="https://www.figma.com">Figma</ExtLink> frame, an{' '}
        <DocLink to="implement-story/overview">Implement story</DocLink> build can read it: an outline of the frame&rsquo;s
        layers (sizes, spacing, colours, text styles and components) and a picture of it. Ensemble reads Figma on your
        computer, for the build only. It never changes anything in Figma.
      </p>
      <p>Figma is optional. Without a token, the agent works from the ticket&rsquo;s other files, and the plan says so.</p>

      <H2 id="set-it-up">Set it up</H2>
      <Steps>
        <li>
          In Figma, open <Ui>Settings → Security</Ui> and create a personal access token with read access to file
          content.
        </li>
        <li>
          In Ensemble, open <Ui>Settings → Integrations → Figma</Ui>, paste the token and press Enter.
        </li>
        <li>
          Press <Ui>Test token</Ui>.
        </li>
      </Steps>
      <Note>
        The token is stored sealed on your computer and is never shown again. It applies to one workspace. Figma limits
        how often a token can read files; Ensemble keeps what it read, so a second build of the same frame reads less.
      </Note>

      <H2 id="what-the-build-gets">What the build gets</H2>
      <ul>
        <li>
          <b>An outline</b> of each linked frame: one line per layer, then the components, colours and text styles it uses.
        </li>
        <li>
          <b>A picture</b> of the frame.
        </li>
      </ul>
      <p>
        A link to a whole file, with no frame in it, reads the first page&rsquo;s top frames, at most three. Each read shows in
        the session&rsquo;s <Ui>Network</Ui> panel.
      </p>
    </>
  );
}
