import { useSeo } from '../lib/seo';
import { seoFor } from '../lib/routes';
import { SITE_NAME } from '../lib/site';
import {
  DashItem,
  InkButton,
  MonoLabel,
  RailGrid,
  Section,
  Story,
  UnderlineLink,
} from '../components/feint/primitives';
import { FeatureShot } from '../components/feint/FeatureShot';
import { TierTable } from '../components/feint/TierTable';

// ---------------------------------------------------------------------------
// How we measure — the two machine-learning models, for a general reader.
//
// ⚠ THIS IS MARKETING, NOT A PAPER. The rule this page is written to: if a
// concept cannot be explained in ONE plain sentence, it is left out entirely
// rather than half-explained. So there is no macro-F1 here, no quantiles, no
// confidence intervals, no Snorkel, no SetFit, no stratified sampling, no
// hierarchical Bayes — all of which are real and all of which would lose the
// reader in exchange for nothing they can act on.
//
// What survives is: what each model is FOR, how it was BUILT (in outline), and
// how we know it WORKS. A named architecture is allowed exactly once per model,
// unexplained, as a credibility signal — a reader who knows what ModernBERT is
// gets something from it, and a reader who does not loses nothing.
//
// ⚠ NUMBERS ARE WRITTEN AS PROPORTIONS A PERSON CAN PICTURE ("seven times in
// ten"), never as decimals or percentages that read as statistics. The sample
// COUNTS are deliberately absent: a true, carefully-chosen sample of a few
// hundred sounds small to a casual reader and arguing the point costs more than
// it wins. The underlying measurements are in docs/ML-SEVERITY.md § Accuracy
// and packages/ml — keep this page and those documents in agreement.
//
// ⚠ THE "WHAT THEY DON'T DO" SECTION IS NOT A DISCLAIMER — it is the strongest
// thing on the page. Every competitor puts a model on everything; saying out
// loud that counting beats a model at counting is what makes the two places we
// DO use one believable. Do not cut it for being negative.
// ---------------------------------------------------------------------------

const GRADER_USES = [
  'The severity badge on every bot comment, wherever you read it.',
  'The “needs a look” counts on a pull request, so a wall of forty threads has a top.',
  'The keep / tune / noisy verdict on each vendor, and the over-calling line beside it.',
];

const BENCHMARK_USES = [
  'Where each of your bots sits against the same bot running in comparable repositories.',
  'What a typical team gets out of that vendor, so your own rate has something to mean.',
  'A written refusal wherever the comparison would not be honest.',
];

export default function HowWeMeasure(): JSX.Element {
  useSeo(seoFor('/how-we-measure'));

  return (
    <>
      {/* ---------- hero ---------- */}
      <header className="px-gutter pt-hero-y">
        <MonoLabel wide className="mb-[26px] text-secondary">
          How we measure
        </MonoLabel>
        <h1 className="mb-7 max-w-[20ch] text-pretty font-display text-hero-sm font-semibold text-ink type:text-hero">
          Two models. One job each.
        </h1>
        <p className="mb-[34px] max-w-lede text-pretty text-lede text-ink-soft">
          Almost everything {SITE_NAME} shows you is arithmetic — counted, not predicted. Two
          questions resist counting, and each has a model of its own built for it: how serious
          is this comment, and is that good compared to everybody else?
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-3.5">
          <InkButton to="/api/auth/login">Sign in with GitHub</InkButton>
          <UnderlineLink to="/for-managers">See what it produces →</UnderlineLink>
        </div>
        <p className="mb-11 max-w-reassure font-mono text-mono-nav text-secondary">
          Both are built and run by us. Neither sends your code or your comments anywhere.
        </p>
      </header>

      {/* ---------- 01 · the grader ---------- */}
      <FeatureShot
        rail={{ n: '01', word: 'The grader' }}
        divider="ink"
        heading="How serious is this comment?"
        src="/shots/severity-findings.png"
        alt="The model's grades on real bot comments, beside a grid showing where the model and the vendor's own badge agreed and where they did not"
        caption="limn · the grade, and the disagreement"
        height={640}
      >
        <p className="mb-6">
          A review bot leaves forty comments on a pull request. Two of them will change whether
          the code works. The rest are preferences, tidy-ups and things somebody already knew.
          Nothing in the comments themselves tells you which is which — and the vendor&rsquo;s
          own labels are marking their own homework.
        </p>
        <p className="mb-6">
          So the first model reads each comment and says how serious it is: a nit, something
          minor, something major, or something critical. It is the same judgement a
          senior engineer makes in a second and cannot make four hundred times a week.
        </p>

        <h3 className="mb-3 mt-10 font-display text-h4 font-semibold text-ink">
          How it was built
        </h3>
        <p className="mb-6">
          We collected millions of real review-bot comments from public repositories on
          GitHub — every major vendor, across projects of every size — and taught the model
          on those rather than on anything invented. Under the hood it is a fine-tuned
          ModernBERT, which is a language model small enough to run on the ordinary processor
          in a laptop or a server: no graphics card, no cloud, nothing sent out, and nothing
          metered.
        </p>
        <p className="mb-6">
          It does one thing, and that is the point. It is not a general assistant being asked
          nicely to have an opinion; it was trained for this single question and does nothing
          else.
        </p>

        <h3 className="mb-3 mt-10 font-display text-h4 font-semibold text-ink">
          How we know it works
        </h3>
        <p className="mb-6">
          We took a batch of real bot comments, hid every label they already carried, and had
          them graded from scratch by a human expert. Then we compared.
        </p>
        <p className="mb-6">
          The model chose the same severity as the expert{' '}
          <strong>seven times in ten</strong>. To know whether that is good, we needed
          something to compare it against — so we checked how often two human experts agreed
          with <em>each other</em> on the same comments. Also seven times in ten. The model is
          reading these comments about as well as the question can be answered.
        </p>
        <p>
          On those same comments, CodeRabbit&rsquo;s own severity labels matched the expert
          fewer than five times in ten. That gap is the whole reason we grade independently
          instead of passing the vendor&rsquo;s label through.
        </p>

        <h3 className="mb-3 mt-10 font-display text-h4 font-semibold text-ink">
          What it feeds
        </h3>
        <ul className="flex flex-col gap-3.5">
          {GRADER_USES.map((u) => (
            <DashItem key={u}>{u}</DashItem>
          ))}
        </ul>
        <Story moment="Free on every tier">
          the grade, everywhere it appears. The ruler is never the paid part.
        </Story>
      </FeatureShot>

      {/* ---------- 02 · the benchmark ---------- */}
      <FeatureShot
        rail={{ n: '02', word: 'The benchmark' }}
        tone="alt"
        heading="And is that good, or normal?"
        src="/shots/benchmark.png"
        alt="The peer benchmark placing each vendor against comparable repositories, with written refusals where the comparison would not be honest"
        caption="limn · the comparison"
        height={620}
      >
        <p className="mb-6">
          Say your team acts on half of what CodeRabbit tells it. Is that good? There is no way
          to know from inside your own repositories. Half might be excellent. Half might mean
          the bot is badly configured and everyone has quietly started ignoring it.
        </p>
        <p className="mb-6">
          The second model answers that by building the missing half of the comparison: what the
          same bot does in <em>other people&rsquo;s</em> repositories.
        </p>

        <h3 className="mb-3 mt-10 font-display text-h4 font-semibold text-ink">
          How it was built
        </h3>
        <p className="mb-6">
          Every public action on GitHub is published as a public event stream. We read it to
          find repositories running each review vendor, drew a sample of{' '}
          <strong>2,204 of them</strong> across seven vendors, and then visited each one to
          collect what actually happened: how much the bot said, how much of it people replied
          to, resolved, or left sitting.
        </p>
        <p className="mb-6">
          Repositories are then grouped with others of a similar size and pace, because a quiet
          internal service and a busy monorepo are not the same test. Your repository is placed
          against its own group, never against the average of all of them.
        </p>
        <p>
          Which repositories to sample was decided in code, with a fixed seed and a written
          record of every choice, so the cohort is reproducible rather than hand-picked. It is
          rebuilt as the corpus grows, and the page tells you how old the current one is.
        </p>

        <h3 className="mb-3 mt-10 font-display text-h4 font-semibold text-ink">
          How we know it works
        </h3>
        <p className="mb-6">
          By refusing. Some groups have plenty of comparable repositories behind them and some
          have a handful, and a comparison drawn from a handful is a number that will move on
          its own next month. Where a group is too thin, the panel says so in words instead of
          printing a figure.
        </p>
        <p>
          There are fourteen different ways it can decline to answer, and each one names which
          comparison it is declining and why. Every figure it <em>does</em> print carries how
          many repositories are behind it and which group they were.
        </p>

        <h3 className="mb-3 mt-10 font-display text-h4 font-semibold text-ink">
          What it feeds
        </h3>
        <ul className="flex flex-col gap-3.5">
          {BENCHMARK_USES.map((u) => (
            <DashItem key={u}>{u}</DashItem>
          ))}
        </ul>
        <Story moment="Pro">
          the comparison. The independent grade underneath it stays free.
        </Story>
      </FeatureShot>

      {/* ---------- 03 · the honesty bar ---------- */}
      <Section divider="ink">
        <RailGrid rail={{ n: '03', word: 'And nowhere else' }}>
          <div className="rail:col-span-2">
            <h2 className="mb-[30px] max-w-[32ch] text-pretty font-display text-h2-sm font-semibold text-ink type:text-h2-major">
              Everything else here is counting, and counting is better at it.
            </h2>
            <div className="grid gap-grid-gutter rail:grid-cols-2">
              <div>
                <p className="mb-6">
                  Two models, on two questions, and that is the end of the list. How many pull
                  requests merged, how long they waited, whose turn it is, what is stalled, what
                  a change touches, who was holding it — all of that is arithmetic over your own
                  data. It is exact, it is reproducible, and you can check it.
                </p>
                <p>
                  A model would make every one of those <em>worse</em>. It would turn a number
                  you can verify into an estimate you have to trust, and estimates are how
                  dashboards stop being believed.
                </p>
              </div>
              <div>
                <p className="mb-6">
                  There is a third place {SITE_NAME} uses AI, and it is separate from both models
                  on this page: short written summaries — a paragraph on a long pull request, a
                  read on a red build, the reason beside an item in your queue. Those are
                  language, not measurement, and they are clearly marked as writing wherever they
                  appear.
                </p>
                <p>
                  No number on any screen comes from them, and nothing in the product acts on a
                  model&rsquo;s output on its own. A grade changes what a list is sorted by. It
                  never resolves a thread, merges a pull request or closes anything.
                </p>
              </div>
            </div>
          </div>
        </RailGrid>
      </Section>

      <TierTable />
    </>
  );
}
