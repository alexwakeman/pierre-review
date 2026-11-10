import type { ReactNode } from 'react';
import type { DocMeta } from '../../types';
import { CHANGELOG } from '../../changelog';
import { H2, H3, Note } from '../../kit';
import { LIMN_VERSION } from '../../version';

// GENERATED FROM CHANGELOG.md at the repository root (changelog.ts). Edit that file, not this page.

export const meta: DocMeta = {
  title: 'Changelog',
  summary: 'What changed in each release of Limn, newest first. Run npx limn-review to get the newest release.',
};

/** `code` and **bold**, nothing else. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 3) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

const anchor = (version: string): string => (version === 'Unreleased' ? 'unreleased' : `v${version.replace(/\./g, '-')}`);

const fmtDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export default function Page(): JSX.Element {
  return (
    <>
      <p>
        You are reading the docs for Limn {LIMN_VERSION}. <code>npx limn-review</code> always runs the newest release. Changes
        under <strong>Unreleased</strong> are on their way and arrive with the next release.
      </p>
      {CHANGELOG.map((r) => {
        const empty = r.groups.every((g) => g.items.length === 0);
        if (r.version === 'Unreleased' && empty) return null;
        return (
          <section key={r.version} className="dx-release">
            <H2 id={anchor(r.version)}>{r.version === 'Unreleased' ? 'Unreleased' : `Limn ${r.version}`}</H2>
            {r.date ? <p className="dx-release-date">{fmtDate(r.date)}</p> : null}
            {empty ? <p>No changes you would notice.</p> : null}
            {r.groups.map((g) =>
              g.items.length === 0 ? null : (
                <div key={g.heading}>
                  <H3>{g.heading}</H3>
                  <ul>
                    {g.items.map((it, i) => (
                      <li key={i}>{inline(it)}</li>
                    ))}
                  </ul>
                </div>
              ),
            )}
          </section>
        );
      })}
      <Note>This changelog starts with Limn 1.0.14. Earlier releases are in the repository&rsquo;s history.</Note>
    </>
  );
}
