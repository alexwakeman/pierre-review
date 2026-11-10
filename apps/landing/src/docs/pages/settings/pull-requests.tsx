import type { DocMeta } from '../../types';
import { DocLink, H2, H3, Illustration, Note, Pill, SettingsRow, TextBox, Ui, WhoItHelps } from '../../kit';

export const meta: DocMeta = {
  title: 'Pull requests',
  summary: 'When a pull request counts as large, and how blast radius is measured.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        The <Ui>Pull requests</Ui> tab sets two judgements Limn makes about every pull request: whether it is large,
        and how far its change can reach (its blast radius). Both settings apply to every workspace and take effect
        everywhere as soon as you save.
      </p>
      <WhoItHelps
        developer="Tune the Large flag and the Low, Medium and High chip so they match what your repository really treats as risky."
        manager="One shared yardstick for size and risk across every repository, so a High in one team means the same as a High in another."
      />

      <H2 id="large-pull-requests">Large pull requests</H2>
      <p>
        Limn flags a pull request as large when it changes at least a set number of lines of code. Only lines of code
        count. Documentation, configuration, lockfiles and generated or copied-in (vendored) files are left out, so a
        4,000-line lockfile update is not a large pull request.
      </p>
      <Illustration label="The Large pull requests setting with an empty threshold box." caption="Leave the box empty to use the default.">
        <SettingsRow
          label="Threshold (lines of code changed)"
          hint="Leave empty to use the default of 1,500 lines."
          control={<TextBox value="" />}
        />
      </Illustration>
      <ul>
        <li>Type a whole number greater than zero, then select <Ui>Save</Ui>.</li>
        <li>Clear the box and save to go back to the default of 1,500 lines.</li>
      </ul>

      <H2 id="blast-radius">Blast radius</H2>
      <p>
        Blast radius is the <Ui>Low</Ui>, <Ui>Medium</Ui> or <Ui>High</Ui> chip shown beside each pull request. It
        reads what a change touches, not how big it is: a four-line database migration is High, and a 2,000-line
        documentation update is Low. A change that only edits comments or formatting is never lower than Medium. The
        chip is an estimate. See <DocLink to="pull-request/blast-radius">Blast radius</DocLink> for how to read it.
      </p>

      <H3>Sensitivity</H3>
      <p>Choose how readily a pull request counts as Low:</p>
      <ul>
        <li>
          <Ui>Cautious</Ui>: fewer pull requests count as Low. Good when a mistake is expensive to undo.
        </li>
        <li>
          <Ui>Balanced</Ui>: the default. On a typical repository about a third of open pull requests land in each
          level.
        </li>
        <li>
          <Ui>Relaxed</Ui>: more pull requests count as Low. Good for a fast-moving repository you can roll back easily.
        </li>
      </ul>

      <H3>Ignore these when judging reach</H3>
      <p>
        Some areas make a pull request High however small it is. Tick an area to ignore it when your repository is
        simply made of it. For example, a project whose product is a database schema would otherwise see almost every
        change marked High. The areas are:
      </p>
      <ul>
        <li>Database migrations</li>
        <li>Database schemas and models</li>
        <li>SQL files</li>
        <li>Published type definitions</li>
        <li>Service contracts (protobuf, GraphQL, Thrift)</li>
        <li>API descriptions (OpenAPI, Swagger)</li>
        <li>Infrastructure (Terraform, Helm, Kubernetes)</li>
        <li>Auth and security code</li>
      </ul>
      <Illustration label="The blast radius sensitivity choice with Balanced selected." caption="Sensitivity, with the default chosen.">
        <SettingsRow label="Sensitivity" hint="Applies to every workspace." control={<Pill tone="blue">Balanced</Pill>} />
      </Illustration>
      <Note>
        The blast radius chip also decides which pull requests AI review may approve, when you limit approvals by
        impact. See <DocLink to="settings/ai-review">AI review settings</DocLink>.
      </Note>
    </>
  );
}
