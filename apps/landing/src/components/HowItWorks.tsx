type Step = {
  label: string;
  sub: string;
  accent: string;
};

const STEPS: Step[] = [
  { label: 'GitHub App', sub: 'GraphQL + REST', accent: 'text-brand-sky' },
  { label: 'Sync', sub: 'every 5 min · idempotent', accent: 'text-brand-blue' },
  { label: 'Postgres', sub: 'cloud store', accent: 'text-brand-green' },
  { label: 'API', sub: 'lean Fastify read layer', accent: 'text-brand-amber' },
  { label: 'Timeline SPA', sub: 'React + vis-timeline', accent: 'text-brand-purpleSoft' },
];

function Arrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5 shrink-0 rotate-90 text-gray-600 md:rotate-0"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export default function HowItWorks() {
  return (
    <section
      aria-labelledby="how-heading"
      className="relative border-y border-white/5 bg-white/[0.02]"
    >
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2
            id="how-heading"
            className="text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl"
          >
            How it works
          </h2>
          <p className="mt-4 text-lg text-gray-400">
            One idempotent pipeline, from GitHub to a live timeline.
          </p>
        </div>

        <ol className="mt-16 flex flex-col items-stretch justify-center gap-4 md:flex-row md:items-center">
          {STEPS.map((step, i) => (
            <li
              key={step.label}
              className="flex flex-col items-center gap-4 md:flex-row"
            >
              <div className="flex min-w-[9rem] flex-col items-center rounded-2xl border border-white/10 bg-white/5 px-5 py-4 text-center backdrop-blur">
                <span className={`text-sm font-semibold ${step.accent}`}>
                  {step.label}
                </span>
                <span className="mt-1 text-xs text-gray-500">{step.sub}</span>
              </div>
              {i < STEPS.length - 1 && <Arrow />}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
