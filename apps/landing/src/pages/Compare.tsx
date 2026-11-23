import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { Link } from '../router';
import { FREE_TEAM_SIZE, SITE_NAME } from '../lib/site';
import { LOWEST_PRICE_GBP, formatGbp } from '../lib/licence';
import { useReveal } from '../components/board/useReveal';
import './pricing.css';

// ---------------------------------------------------------------------------
// Compare — Ensemble beside a per-seat review bot and the two built-in reviews.
//
// ⚠ COMPARATIVE ADVERTISING (UK: the Business Protection from Misleading Marketing
// Regulations 2008, reg. 4): compare only material, verifiable features, never denigrate,
// and keep each claim checkable. So: every competitor cell is a fact from that vendor's own
// page, the page states the date it was checked and links each source, and "Where the others
// are stronger" is part of the page, not an afterthought. Re-check every cell before changing
// CHECKED_ON; a price that moved makes the page misleading.
//
// Reuses the pricing page's layout (./pricing.css, `.lb.pricing`).
// ---------------------------------------------------------------------------

const CHECKED_ON = '22 November 2026';

type Col = 'ensemble' | 'coderabbit' | 'copilot' | 'claude';

const COLS: { key: Col; label: string }[] = [
  { key: 'ensemble', label: SITE_NAME },
  { key: 'coderabbit', label: 'CodeRabbit' },
  { key: 'copilot', label: 'GitHub Copilot code review' },
  { key: 'claude', label: 'Claude Code Review' },
];

const ROWS: { row: string; cells: Record<Col, string> }[] = [
  {
    row: 'Where the review runs',
    cells: {
      ensemble: 'On your own computer',
      coderabbit: 'CodeRabbit’s cloud (self-hosting on Enterprise)',
      copilot: 'GitHub’s cloud',
      claude: 'Anthropic’s infrastructure',
    },
  },
  {
    row: 'What is installed on your GitHub organisation',
    cells: {
      ensemble: 'Nothing; it uses your own GitHub CLI sign-in',
      coderabbit: 'The CodeRabbit GitHub App',
      copilot: 'Nothing extra; it is part of GitHub',
      claude: 'The Claude GitHub App, installed by an owner',
    },
  },
  {
    row: 'How you pay',
    cells: {
      ensemble: `Free for up to ${FREE_TEAM_SIZE} people; then one licence a year for the organisation, from ${formatGbp(LOWEST_PRICE_GBP)} plus VAT. AI usage on your own Anthropic or OpenAI account`,
      coderabbit: 'Per developer who opens pull requests: US$24–30 a month (Essentials), US$48–60 (Team)',
      copilot: 'Copilot AI credits (US$0.01 each) plus GitHub Actions minutes for each review on a private repository',
      claude: 'Token usage, billed to the organisation; Anthropic’s launch figure was US$15–25 a review on average',
    },
  },
  {
    row: 'When it reviews',
    cells: {
      ensemble: 'When you press Review, or on each new commit once you switch auto review on',
      coderabbit: 'When a pull request opens, then on new pushes (by default it pauses after 5 reviewed commits)',
      copilot: 'When requested, or automatically through a repository or organisation ruleset',
      claude: 'After every push by default, for a newly added repository',
    },
  },
];

const SOURCES: { label: string; href: string }[] = [
  { label: 'CodeRabbit pricing', href: 'https://www.coderabbit.ai/pricing' },
  { label: 'CodeRabbit: when reviews run', href: 'https://docs.coderabbit.ai/pr-reviews/when-reviews-run' },
  {
    label: 'GitHub: automatic Copilot code review',
    href: 'https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-automatic-review',
  },
  {
    label: 'GitHub: Copilot code review and Actions minutes',
    href: 'https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/',
  },
  { label: 'Claude Code Review documentation', href: 'https://code.claude.com/docs/en/code-review' },
  { label: 'Claude Code Review costs', href: 'https://code.claude.com/docs/en/code-review-costs' },
  { label: 'Anthropic: Code Review launch', href: 'https://claude.com/blog/code-review' },
];

export default function Compare(): JSX.Element {
  useSeo(seoFor('/compare'));
  const ref = useReveal<HTMLDivElement>();

  return (
    <div className="lb pricing" ref={ref}>
      <section className="board p-head" aria-labelledby="cmp-h1">
        <div className="tile p-name">
          <h1 id="cmp-h1">{SITE_NAME} beside the review you may already have</h1>
          <p className="p-lead">
            How {SITE_NAME} compares with a per-seat review bot and with the reviews built into GitHub and Claude. Facts
            from each vendor&rsquo;s own pages, checked on {CHECKED_ON}. Prices change; follow the links before you decide.
          </p>
        </div>
      </section>

      <section className="section board p-vendor" aria-label="Comparison">
        <div className="tile rise p-tablewrap">
          <table className="p-table">
            <thead>
              <tr>
                <th scope="col" />
                {COLS.map((c) => (
                  <th key={c.key} scope="col">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.row}>
                  <th scope="row">{r.row}</th>
                  {COLS.map((c) => (
                    <td key={c.key}>{r.cells[c.key]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section board p-facts" aria-label="What differs">
        <div className="tile verdigris rise">
          <h2>What {SITE_NAME} adds</h2>
          <ul className="p-list">
            <li>Claude and Codex review the same change separately, and you get one merged list of findings.</li>
            <li>Each change is checked against its ticket&rsquo;s acceptance criteria.</li>
            <li>It shows which of your review bot&rsquo;s comments were acted on, and what each one cost.</li>
          </ul>
        </div>
        <div className="tile lapis rise">
          <h2>Where the others are stronger</h2>
          <ul className="p-list">
            <li>They run in the cloud, so reviews happen when nobody&rsquo;s computer is on.</li>
            <li>They have one admin console, one bill and one policy for the whole organisation.</li>
            <li>Claude Code Review also works with GitHub Enterprise Server. {SITE_NAME} works with GitHub.com only.</li>
          </ul>
        </div>
        <div className="tile rise">
          <h2>Use them together</h2>
          <p>
            {SITE_NAME} reads the comments CodeRabbit, Copilot and other review bots leave, so you can keep the bot you have
            and see which of its comments a person still needs to read.{' '}
            <Link to="/docs/bots-monitoring/overview">How bot monitoring works</Link>.
          </p>
        </div>
      </section>

      <section className="section board p-vendor" aria-label="Sources">
        <div className="tile rise">
          <h2>Sources, checked {CHECKED_ON}</h2>
          <ul className="p-list">
            {SOURCES.map((s) => (
              <li key={s.href}>
                <a href={s.href} rel="noreferrer noopener" target="_blank">
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
          <p>
            CodeRabbit, GitHub Copilot and Claude are trademarks of their owners. {SITE_NAME} is not affiliated with them.
          </p>
        </div>
      </section>
    </div>
  );
}
