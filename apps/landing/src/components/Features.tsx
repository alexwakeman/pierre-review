import type { ReactNode } from 'react';
import {
  TimelineIcon,
  ThreadIcon,
  MyTurnIcon,
  StripIcon,
  FocusIcon,
  SparkleIcon,
} from './icons';

type Feature = {
  title: string;
  body: ReactNode;
  icon: (props: { className?: string }) => ReactNode;
  // Tailwind text color for the icon + a matching tint for its chip background.
  accent: string;
  chip: string;
  badge?: string;
};

const FEATURES: Feature[] = [
  {
    title: 'Timeline situational awareness',
    body: 'An interactive vis-timeline of PR activity, grouped repo → contributor. Bars pack into lanes; opens, reviews, comments and commits render as shaped markers that cluster as you zoom out.',
    icon: TimelineIcon,
    accent: 'text-brand-sky',
    chip: 'bg-brand-sky/10 ring-brand-sky/30',
  },
  {
    title: 'Focus mode',
    body: 'A focus overlay that isolates a single PR and every contributor touching it — sibling bars and unrelated markers fall away, so one thread of work fills the timeline. Esc or the browser back button drops you straight out.',
    icon: FocusIcon,
    accent: 'text-brand-skySoft',
    chip: 'bg-brand-skySoft/10 ring-brand-skySoft/30',
  },
  {
    title: 'Derived thread state',
    body: 'Every review thread is classified — resolved, likely-addressed, replied-unresolved, or untouched. "Likely-addressed" is an honest heuristic, and the UI never hides that it is one.',
    icon: ThreadIcon,
    accent: 'text-brand-green',
    chip: 'bg-brand-green/10 ring-brand-green/30',
  },
  {
    title: '“My Turn” triage',
    body: 'A focused queue of what actually needs you: reviews awaiting you, your own PRs with new activity, and threads sitting untouched in your court.',
    icon: MyTurnIcon,
    accent: 'text-brand-amber',
    chip: 'bg-brand-amber/10 ring-brand-amber/30',
  },
  {
    title: 'Open-PR strip',
    body: 'A collapsible strip of every open PR across your watched repos, with all / my-turn / needs-attention filters so stalled work surfaces instantly.',
    icon: StripIcon,
    accent: 'text-brand-blue',
    chip: 'bg-brand-blue/10 ring-brand-blue/30',
  },
  {
    title: 'Claude Review',
    body: 'An optional agentic PR review that returns structured findings you can curate and post as one GitHub review. You stay in control of every word.',
    icon: SparkleIcon,
    accent: 'text-brand-purpleSoft',
    chip: 'bg-brand-purple/10 ring-brand-purple/30',
    badge: 'Local-only · opt-in',
  },
];

export default function Features() {
  return (
    <section
      id="features"
      aria-labelledby="features-heading"
      className="mx-auto max-w-6xl px-6 py-24"
    >
      <div className="mx-auto max-w-2xl text-center">
        <h2
          id="features-heading"
          className="text-3xl font-bold tracking-tight text-gray-50 sm:text-4xl"
        >
          Everything your sprint needs to stay in sync
        </h2>
        <p className="mt-4 text-lg text-gray-400">
          Pierre reads your repos and turns the noise into one clear,
          attention-routing view.
        </p>
      </div>

      <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map(({ title, body, icon: Icon, accent, chip, badge }) => (
          <article
            key={title}
            className="group relative flex flex-col rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur transition hover:border-white/20 hover:bg-white/[0.07]"
          >
            <span
              className={`inline-flex h-11 w-11 items-center justify-center rounded-xl ring-1 ${chip}`}
            >
              <Icon className={`h-6 w-6 ${accent}`} />
            </span>

            <div className="mt-5 flex items-center gap-2">
              <h3 className="text-lg font-semibold text-gray-100">{title}</h3>
              {badge && (
                <span className="rounded-full bg-brand-purple/15 px-2 py-0.5 text-[11px] font-medium text-brand-purpleSoft ring-1 ring-brand-purple/30">
                  {badge}
                </span>
              )}
            </div>

            <p className="mt-2 text-sm leading-relaxed text-gray-400">{body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
