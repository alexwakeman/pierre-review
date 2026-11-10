import type { DocMeta } from '../../types';
import { DocLink, ExtLink, H2, H3, MiniTable, Note, Quote, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'How Anthropic and OpenAI treat your work',
  summary: 'What Anthropic and OpenAI say, in their own words, about the code and prompts Limn sends on your account.',
};

const CHECKED = 'retrieved 2026-11-09';
const A_USAGE = 'https://code.claude.com/docs/en/data-usage';
const A_USAGE_T = `Data usage - Claude Code Docs (${CHECKED})`;
const A_CONSUMER = 'https://www.anthropic.com/legal/consumer-terms';
const A_CONSUMER_T = `Consumer Terms of Service, Anthropic, effective 8 October 2025 (${CHECKED})`;
const A_COMMERCIAL = 'https://www.anthropic.com/legal/commercial-terms';
const A_COMMERCIAL_T = `Commercial Terms of Service, Anthropic, effective 17 June 2025 (${CHECKED})`;
const A_UPDATE = 'https://www.anthropic.com/news/updates-to-our-consumer-terms';
const A_UPDATE_T = `Updates to Consumer Terms and Privacy Policy, Anthropic, 28 August 2025 (${CHECKED})`;
const A_LEGAL = 'https://code.claude.com/docs/en/legal-and-compliance';
const A_LEGAL_T = `Legal and compliance - Claude Code Docs (${CHECKED})`;
const O_AUTH = 'https://learn.chatgpt.com/docs/auth.md';
const O_AUTH_T = `Authentication, Codex docs (${CHECKED})`;
const O_PRICING = 'https://learn.chatgpt.com/docs/pricing';
const O_PRICING_T = `Pricing, Codex docs (${CHECKED})`;
const O_PRICING_MD = 'https://learn.chatgpt.com/docs/pricing.md';
const O_LOCAL = 'https://learn.chatgpt.com/docs/enterprise/chatgpt-work-local-security.md';
const O_LOCAL_T = `ChatGPT Work local security (${CHECKED})`;
const O_API = 'https://developers.openai.com/api/docs/guides/your-data';
const O_API_T = `Data controls in the OpenAI platform (${CHECKED})`;

const SUMMARY_COLS = [
  { key: 'account', label: 'How you sign in' },
  { key: 'training', label: 'Training on your work' },
  { key: 'kept', label: 'How long it is kept' },
];
const SUMMARY_ROWS = [
  {
    _key: 'a-consumer',
    account: 'Claude Code login on Free, Pro, Max or Ultra',
    training: 'Only when your training setting is on. Feedback and content flagged for safety review can be used even when it is off.',
    kept: '5 years with the setting on; 30 days with it off',
  },
  {
    _key: 'a-commercial',
    account: 'Anthropic API key, or Claude Team or Enterprise',
    training: 'No, unless your organisation chooses to share data',
    kept: '30 days as standard',
  },
  {
    _key: 'o-business',
    account: 'ChatGPT Business, Enterprise or Edu',
    training: 'Not by default',
    kept: 'Your ChatGPT workspace settings',
  },
  {
    _key: 'o-personal',
    account: 'ChatGPT Free, Go, Plus or Pro',
    training: 'Not covered by OpenAI’s “no training by default” line. Check your ChatGPT data controls.',
    kept: 'Your ChatGPT settings',
  },
];

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        When Limn runs a review, a fix or a summary, it sends the work to the AI provider you chose, on your account:
        the code and the diff, the pull request&rsquo;s text and comments, and where relevant the ticket and sections of
        your docs. Nothing goes to a Limn server, because there is none. What happens to that work at the provider is
        set by the provider&rsquo;s terms for your kind of account. This page quotes those terms word for word, with a
        link to each source, so you can decide for yourself.
      </p>
      <Note title="Checked on 9 November 2026">
        Providers change their terms. Every quotation below was copied from the linked page on 9 November 2026. Follow
        the link to read the current version and the text around it. This page is not legal advice.
      </Note>

      <H2 id="at-a-glance">At a glance</H2>
      <MiniTable cols={SUMMARY_COLS} rows={SUMMARY_ROWS} />
      <p>
        The rest of the page gives the exact words behind each line. For which account Limn uses, see{' '}
        <DocLink to="settings/ai-usage-and-spend#which-account">Which account Limn uses</DocLink>.
      </p>

      <H2 id="anthropic">Anthropic (Claude)</H2>
      <H3>Which terms apply</H3>
      <p>
        Anthropic has consumer terms for its Free, Pro and Max plans, and commercial terms for API keys and business
        plans. A Claude Code login on a personal plan is consumer use:
      </p>
      <Quote source={A_UPDATE_T} href={A_UPDATE}>
        These updates apply to users on our Claude Free, Pro, and Max plans, including when they use Claude Code from
        accounts associated with those plans. They do not apply to services under our Commercial Terms, including
        Claude for Work, Claude for Government, Claude for Education, or API use, including via third parties such as
        Amazon Bedrock and Google Cloud&apos;s Vertex AI.
      </Quote>

      <H3>Training on a personal plan</H3>
      <Quote source={A_USAGE_T} href={A_USAGE}>
        We give you the choice to allow your data to be used to improve future Claude models. We will train new models
        using data from Free, Pro, Max, and Ultra accounts when this setting is on (including when you use Claude Code
        from these accounts).
      </Quote>
      <Quote source={A_CONSUMER_T} href={A_CONSUMER}>
        We may use Materials to provide, maintain, and improve the Services, including training our models, unless you
        opt out of training through your account settings. Even if you opt out, we will use Materials for model training
        when: (1) you provide Feedback to us regarding any Materials, or (2) your Materials are flagged for safety
        review to improve our ability to detect harmful content, enforce our policies, or advance our safety research.
      </Quote>
      <Quote source={A_UPDATE_T} href={A_UPDATE}>
        You&apos;re always in control of this setting and whether we use your data in this way.
      </Quote>
      <Quote source={A_USAGE_T} href={A_USAGE}>
        Privacy settings can be changed at any time at claude.ai/settings/data-privacy-controls
      </Quote>
      <p>
        Check the setting at{' '}
        <ExtLink href="https://claude.ai/settings/data-privacy-controls">claude.ai/settings/data-privacy-controls</ExtLink>{' '}
        before you use Limn on code you would not want used for training.
      </p>

      <H3>Training on an API key or a business plan</H3>
      <Quote source={A_USAGE_T} href={A_USAGE}>
        Anthropic does not train generative models using code or prompts sent to Claude Code under commercial terms,
        unless the customer has chosen to provide their data to us for model improvement
      </Quote>
      <Quote source={A_COMMERCIAL_T} href={A_COMMERCIAL}>
        Anthropic may not train models on Customer Content from Services.
      </Quote>

      <H3>How long Anthropic keeps it</H3>
      <p>For personal plans, by training setting:</p>
      <Quote source={A_USAGE_T} href={A_USAGE}>
        Users who allow data use for model improvement: 5-year retention period to support model development and safety
        improvements
      </Quote>
      <Quote source={A_USAGE_T} href={A_USAGE}>
        Users who don&apos;t allow data use for model improvement: 30-day retention period
      </Quote>
      <p>For commercial users (Team, Enterprise and API), the page lists:</p>
      <Quote source={A_USAGE_T} href={A_USAGE}>
        Standard: 30-day retention period
      </Quote>
      <p>One exception applies to everyone:</p>
      <Quote source={A_USAGE_T} href={A_USAGE}>
        Transcripts shared via /feedback, or via /bug and /share, which report through the same path, are retained
        for 5 years.
      </Quote>
      <p>Limn never sends feedback or bug reports to Anthropic on your behalf.</p>

      <H3>Who owns the work</H3>
      <Quote source={A_CONSUMER_T} href={A_CONSUMER}>
        As between you and Anthropic, and to the extent permitted by applicable law, you retain any right, title, and
        interest that you have in such Inputs. Subject to your compliance with our Terms, we assign to you all our
        right, title, and interest (if any) in Outputs.
      </Quote>
      <Quote source={A_COMMERCIAL_T} href={A_COMMERCIAL}>
        Anthropic agrees that Customer (a) retains all rights to its Inputs, and (b) owns its Outputs.
      </Quote>

      <H3>In transit, and sale of data</H3>
      <Quote source={A_USAGE_T} href={A_USAGE}>
        Claude Code runs locally. To interact with the LLM, Claude Code sends data over the network. This data includes
        all user prompts and model outputs, encrypted in transit via TLS 1.2+.
      </Quote>
      <Quote source={A_UPDATE_T} href={A_UPDATE}>
        We do not sell users&apos; data to third parties.
      </Quote>

      <H2 id="openai">OpenAI (Codex)</H2>
      <H3>Your sign-in decides the policy</H3>
      <p>Limn runs Codex only on a ChatGPT sign-in. OpenAI says:</p>
      <Quote source={O_AUTH_T} href={O_AUTH}>
        When you sign in with ChatGPT, Codex usage follows your ChatGPT workspace permissions, role-based access control
        (RBAC), and ChatGPT Enterprise retention and residency settings.
      </Quote>
      <Quote source={O_PRICING_T} href={O_PRICING}>
        ChatGPT Work and Codex are included in your ChatGPT Free, Go, Plus, Pro, Business, Edu, or Enterprise plan
      </Quote>

      <H3>Training</H3>
      <p>
        OpenAI&rsquo;s Codex pricing page lists this line in its comparison of plans. Check the page for the plans it
        covers:
      </p>
      <Quote source={O_PRICING_T} href={O_PRICING}>
        No training on API or business data by default
      </Quote>
      <Quote source={`Pricing, Codex docs, Business plan (${CHECKED})`} href={O_PRICING_MD}>
        No training on your business data by default.
      </Quote>
      <Quote source={O_LOCAL_T} href={O_LOCAL}>
        Business, Enterprise, and Edu workspace data processed by covered OpenAI services is encrypted in transit and at
        rest and is not used to train OpenAI models by default.
      </Quote>
      <p>
        On a personal ChatGPT plan (Free, Go, Plus or Pro), that line does not apply. Check the data controls in your
        ChatGPT settings before you use Codex in Limn on code you would not want used for training.
      </p>

      <H3>API keys, for context</H3>
      <p>
        Limn does not run Codex on an OpenAI API key today. For comparison, OpenAI says an API key follows different
        settings:
      </p>
      <Quote source={O_AUTH_T} href={O_AUTH}>
        With an API key, usage follows your API organization&apos;s retention and data-sharing settings instead.
      </Quote>
      <Quote source={O_API_T} href={O_API}>
        Your data is your data. As of March 1, 2023, data sent to the OpenAI API is not used to train or improve OpenAI
        models (unless you explicitly opt in to share data with us).
      </Quote>
      <Quote source={O_API_T} href={O_API}>
        By default, abuse monitoring logs are generated for all API feature usage and retained for up to 30 days, unless
        longer retention is required by law, or is reasonably necessary to protect our services or any third party from
        harm.
      </Quote>

      <H2 id="your-claude-login">Using your own Claude login</H2>
      <p>
        Limn is a program you run on your own computer. When it uses Claude, it uses the Claude Code login you made
        yourself, through Anthropic&rsquo;s own sign-in, for your own work. Limn never sees, stores or forwards that
        login, there is no Limn server in between, and no one else&rsquo;s requests go through your account.
      </p>
      <p>Anthropic&rsquo;s policy recommends API keys for products built on its Agent SDK, which Limn uses:</p>
      <Quote source={A_LEGAL_T} href={A_LEGAL}>
        Developers building products or services that interact with Claude&apos;s capabilities, including those using
        the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider.
        Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to
        route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users.
      </Quote>
      <p>
        Limn offers no Claude sign-in of its own and routes nothing on anyone&rsquo;s behalf: each person runs Limn
        with their own access. Anthropic&rsquo;s plan limits assume ordinary, individual use, and its consumer terms
        limit automated access outside an API key (<ExtLink href={A_CONSUMER}>{A_CONSUMER_T}</ExtLink>).
      </p>
      <Note title="When to choose an API key">
        An Anthropic API key works exactly the same in Limn and is a first-class choice. Choose it when your
        organisation prefers commercial terms, when you want API billing kept apart from personal plans, or when you
        run a lot of automatic reviews, fixes or dependency updates. See{' '}
        <DocLink to="integrations/claude#set-it-up">Set up Claude</DocLink>.
      </Note>

      <H2 id="caveats">Caveats</H2>
      <ul>
        <li>
          &ldquo;Not trained on by default&rdquo; applies to Anthropic only under commercial terms (an API key, Team or
          Enterprise), and to OpenAI only for business plans and API keys.
        </li>
        <li>
          Zero data retention is something an organisation arranges with the provider. It is not the standard.
        </li>
        <li>
          OpenAI&rsquo;s help centre and policy pages could not be quoted here. Read them yourself at{' '}
          <ExtLink href="https://openai.com/policies">openai.com/policies</ExtLink>.
        </li>
      </ul>
      <p>
        What Limn itself keeps, and where, is on <DocLink to="security/data-and-storage">What Limn stores</DocLink>.
      </p>
    </>
  );
}
