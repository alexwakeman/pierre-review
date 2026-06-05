// A browser-framed product screenshot.
function Frame({
  src,
  alt,
  className = '',
}: {
  src: string;
  alt: string;
  className?: string;
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
      <img src={src} alt={alt} loading="lazy" className="block w-full" />
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
      </div>
    </section>
  );
}
