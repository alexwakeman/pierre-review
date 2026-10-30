import type { ReactNode } from 'react';

// One section of the build tab: a quiet heading (+ its ⓘ, an end slot) and its body. No box — the
// section's items carry their own surface (the One PR card shell look for repository cards).
export function StoryBuildSection({
  title,
  info,
  end,
  testId,
  children,
}: {
  title: string;
  info?: ReactNode;
  end?: ReactNode;
  testId?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section data-testid={testId} className="mt-6">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-title text-ui-ink">
          {title}
          {info}
        </h3>
        {end != null && <div className="ml-auto flex flex-wrap items-center gap-2">{end}</div>}
      </div>
      {children}
    </section>
  );
}
