import { DEMO_PATH, FREE_TEAM_SIZE, INSTALL_COMMAND, SITE_NAME } from '../../lib/site';
import { DashItem, InkButton, InlineLink, RailGrid, Section, UnderlineLink } from './primitives';

// ---------------------------------------------------------------------------
// The closing block, rendered at the bottom of every content page.
//
// It replaced the free-vs-Pro comparison table. There is no paid tier any more, so
// the question a reader has at the end of a page is no longer "what do I pay for?"
// but "how do I get it?" — and the answer is the same everywhere: one npm command,
// or the demo first. So this says that, plus the two facts that decide whether a
// reader can use it at all: who needs a licence, and which AI it works with.
//
// ⚠ THE TEAM SIZE COMES FROM `FREE_TEAM_SIZE`, which mirrors the Limn License at the
// repository root. Never type the number here.
// ---------------------------------------------------------------------------

export function GetStarted(): JSX.Element {
  return (
    <Section divider="ink" pad="lg" id="start">
      <RailGrid rail={{ word: 'Start' }}>
        <div>
          <h2 className="mb-5 max-w-[24ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2-major">
            Free. One command.
          </h2>
          <p className="mb-6 max-w-[56ch] text-pretty text-lede text-ink-soft">
            {SITE_NAME} runs on your machine. It reads GitHub through your{' '}
            <span className="text-ink">gh</span> login and keeps its data in a file on your
            disk. There is no account and nothing to pay.
          </p>
          <p className="mb-9 font-mono text-mono-row text-ink">{INSTALL_COMMAND}</p>
          <div className="flex flex-wrap items-center gap-3.5">
            <InkButton to={DEMO_PATH}>Try the demo</InkButton>
            <UnderlineLink to="/contact?topic=licence">More than {FREE_TEAM_SIZE} users in your organisation? →</UnderlineLink>
          </div>
        </div>
        <ul className="flex flex-col gap-3.5">
          <DashItem>100% free. No sign-in, no card, no repository limit.</DashItem>
          <DashItem>
            Available only from npm: <span className="text-ink">{INSTALL_COMMAND}</span>.
            Needs Node 20 or later.
          </DashItem>
          <DashItem>
            Built for Claude users. Reviews and fixes run on your Claude Code login or an
            Anthropic API key. Codex support is coming soon.
          </DashItem>
          <DashItem>
            Free for individuals, and for organisations where no more than {FREE_TEAM_SIZE}{' '}
            people use it. More users than that need a licence —{' '}
            <InlineLink to="/contact?topic=licence">ask through the contact form</InlineLink>.
          </DashItem>
          <DashItem>
            The demo runs in your browser on sample data. No install, no sign-in.
          </DashItem>
        </ul>
      </RailGrid>
    </Section>
  );
}
