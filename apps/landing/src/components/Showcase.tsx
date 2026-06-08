// A browser-framed product screenshot.
function Frame({
  src,
  alt,
  className = '',
  eager = false,
}: {
  src: string;
  alt: string;
  className?: string;
  /** Above-the-fold hero: load eagerly. lazy on an above-the-fold image is wrong
   *  and is historically unreliable on iOS Safari (it can fail to load until a
   *  scroll/resize), making the hero shot "pop in" late. */
  eager?: boolean;
}) {
  return (
    <figure
      className={`overflow-hidden rounded-xl border border-white/10 bg-gray-900/60 shadow-2xl shadow-black/50 ring-1 ring-white/5 ${className}`}
    >
      {/* fake browser chrome */}
      <div className="flex items-center gap-2 border-b border-white/10 bg-gray-900/80 px-4 py-2.5">
        <span className="h-3 w-3 rounded-full bg-red-500/70" />
        <span className="h-3 w-3 rounded-full bg-amber-500/70" />
        <span className="h-3 w-3 rounded-full bg-green-500/70" />
        <span className="ml-3 hidden truncate text-xs text-gray-500 sm:inline">
          pierre · /app
        </span>
      </div>
      <img
        src={src}
        alt={alt}
        width={3200}
        height={2000}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        className="block w-full"
      />
    </figure>
  );
}

export default function Showcase() {
  return (
    <section aria-label="Product preview" className="relative px-6 pb-20 sm:pb-28">
      {/* soft glow behind the hero shot */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-16 left-1/2 h-72 w-[44rem] max-w-full -translate-x-1/2 rounded-full bg-brand-blue/20 blur-[130px]" />
      </div>

      <div className="mx-auto max-w-6xl">
        <Frame
          src="/shots/timeline.png"
          alt="The pierre-review timeline: pull-request activity grouped repo → contributor, with shaped review markers and a My Turn triage panel."
          eager
        />

        <div className="mt-10 grid items-center gap-8 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <Frame
              src="/shots/pr-detail.png"
              alt="Drilling into a pull request: review threads grouped by file, each tagged with its derived state (resolved, replied, untouched)."
            />
          </div>
          <div className="lg:col-span-2">
            <h2 className="text-2xl font-semibold tracking-tight text-gray-50 sm:text-3xl">
              Drill into any PR — without leaving the dashboard
            </h2>
            <p className="mt-4 text-pretty leading-relaxed text-gray-400">
              Open a pull request to read its review threads grouped by file, each
              tagged with its{' '}
              <span className="font-medium text-brand-amber">derived state</span> —
              resolved, replied, likely-addressed, or untouched — alongside CI,
              mergeability, approvers, and the full activity feed.
            </p>
          </div>
        </div>

        <div className="mt-10 grid items-center gap-8 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <span className="inline-flex items-center rounded-full bg-brand-purple/10 px-2.5 py-0.5 text-xs font-medium text-brand-purpleSoft ring-1 ring-brand-purple/30">
              Local-only · opt-in
            </span>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-gray-50 sm:text-3xl">
              Review a PR with Claude — then post it in your words
            </h2>
            <p className="mt-4 text-pretty leading-relaxed text-gray-400">
              Run the{' '}
              <span className="font-medium text-brand-purpleSoft">Claude Agent SDK</span>{' '}
              against a pull request to get structured, line-anchored findings —
              blockers, nits, questions. Reword them, tick which to include, and post{' '}
              <span className="font-medium text-gray-200">one</span> GitHub review.
              Claude&rsquo;s output is reference; your words are what ship.
            </p>
          </div>
          <div className="lg:col-span-3">
            <Frame
              src="/shots/claude-review.png"
              alt="The Claude Review tab: an agentic review of a pull request returning severity-tagged, line-anchored findings you can reword, include, and post as a single GitHub review."
            />
          </div>
        </div>
      </div>
    </section>
  );
}
