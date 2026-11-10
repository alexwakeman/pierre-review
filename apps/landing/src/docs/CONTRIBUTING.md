# Writing the Limn docs

The user documentation at **limn-review.com/docs**. It is part of the landing site
(`apps/landing`), prerendered per page, with no runtime dependency.

## The rule

**A user-visible change updates its docs page and `CHANGELOG.md` (under `## [Unreleased]`) in
the same commit. A removed feature removes its docs: the page or section, its manifest line, and
every link to it.** Old text that describes something the app no longer does is worse than no
text.

`apps/landing/test/docs.test.ts` (run by `pnpm test`, CI and the site deploy) holds part of this
rule for you. It fails when:

- the app gains a sidebar destination, a pull request tab, a Settings tab, a Pending tab, a
  Reports tab or a Bots Monitoring tab with no page (it reads the ids from `apps/frontend/src`),
  or loses one that still has a page in `APP_COVERAGE`;
- a page is a stub (`stub: true`) or nearly empty;
- a page shows an image of any kind;
- a `DocLink` points at a page or an anchor that does not exist;
- a title repeats another page's title;
- `CHANGELOG.md` does not parse, or its newest release is not the npm package's version.

It cannot see a label that changed or a flow that moved. That part is on you: when you change a
screen, search the docs for its words (`grep -rn "Old label" apps/landing/src/docs`).

## Where things are

| What | Where |
|---|---|
| The pages | `pages/<section>/<slug>.tsx` — one file per page |
| Sections, order, writers, the app → page map | `manifest.ts` |
| Components for writing a page | `kit.tsx` |
| The layout (contents, search, breadcrumbs, prev/next) | `DocsApp.tsx`, `docs.css` |
| URLs | `routes.ts` — `/docs/<section>/<slug>`; a slug equal to its section is `/docs/<section>` |
| The changelog page | generated from `CHANGELOG.md` at the repository root (`changelog.ts`) |
| The version in the header | `apps/backend/package.json`, read at build time (`version.ts`) |

## Add, move or remove a page

- **Add**: copy a neighbouring page file to `pages/<section>/<slug>.tsx`, then add `{ slug }` to
  its section in `manifest.ts`. The slug is lowercase words joined by hyphens. If the page
  documents a new app tab or destination, add it to `APP_COVERAGE` too.
- **Move or rename**: change the file and the manifest together, then fix the `DocLink`s the
  test reports.
- **Remove**: delete the file, its manifest line, its `APP_COVERAGE` entry if any, and every
  `DocLink` to it. Add a `### Removed` line to the changelog's Unreleased.

## A page

```tsx
import type { DocMeta } from '../../types';
import { DocLink, H2, Illustration, Note, Steps, Ui } from '../../kit';

export const meta: DocMeta = {
  title: 'Dismiss a My Turn card',
  summary: 'Every My Turn card can be dismissed. It comes back when something new happens on that pull request.',
};

export default function Page(): JSX.Element {
  return (
    <>
      <p>One paragraph: what this is and when you use it.</p>
      <H2 id="what-you-see">What you see</H2>
      …
      <H2 id="what-you-can-do">What you can do</H2>
      <Steps>
        <li>Open <Ui>Pending</Ui> and choose <Ui>My turn</Ui>.</li>
        …
      </Steps>
      <H2 id="why-it-helps">Why it helps</H2>
      …
    </>
  );
}
```

- `meta.title` is task-oriented and unique; `meta.summary` is one or two sentences (under 300
  characters). The layout prints both: do not repeat them in the body.
- Start the body with one plain paragraph that says what the screen or feature is for.
- Use the patterns **What you see**, **What you can do**, **Why it helps** where they fit; a
  reference page (a Settings tab, an integration) can use **What you need**, **Set it up**,
  **What Limn reads**, **What Limn writes**, **Turn it off** instead.
- `H2` needs an `id` (lowercase, hyphens). The H2s make "On this page". Use `H3` under them.
- **The body is HOOK-FREE.** "On this page" is read by calling the body as a function. If a
  picture needs state (a clickable mock), put the state in a small component in the same file
  and render that component from the body.
- Keep each page to one subject. Link to the page that owns a subject rather than repeating it.

## Voice

Plain English, as the app's own copy (`CLAUDE.md` § Product voice), leaning on ASD-STE100:

- Short sentences, one instruction each. Active voice. Start steps with a verb.
- **Use the app's own words, exactly**: the label on the button, tab or chip, in `<Ui>`. Check the
  frontend source for the spelling. "Pending", not "the attention board".
- Say what the reader sees and does, not how Limn is built: no file names, table names, internal
  ids, environment variables or code paths. The exception is something the reader must type or set
  (`npx limn-review`, `LIMN_AI_PROVIDER`), which goes in `<code>`.
- Address the reader as "you". A developer and an engineering manager both read these pages; say
  in the text what each gets where the answer differs. No per-page "who it helps" blocks.
- British spelling, as the rest of the site ("licence" the noun, "organisation", "colour").
- No "Pro", "paid", "upgrade" or credits wording: every feature is free under the Limn License
  (free for individuals and for organisations where no more than three people use it).
- Do not promise what Limn does not do. Where Limn guesses (Likely addressed, blast radius),
  say it is a guess. Where Limn refuses (the benchmark), say so and why.
- Numbers: round them, and say what they count.
- Quotes from a vendor's policy are exact, in `Quote`, with a link to the page they come from.

## Pictures: HTML mocks, never screenshots

There are no screenshots, images or videos of the product in the docs, and the test fails on
one. Where a picture helps, draw a small part of the screen in HTML:

- Wrap it in `Illustration` (`label` = a one-sentence summary for screen readers; `caption` =
  the visible caption, printed after "Illustration:").
- Build it from the kit: `AppShell` (the sidebar with one item active), `Toolbar`, `Tabs`,
  `PrRow`, `Pill` / `Chip`, `Card`, `Thread`, `Diff`, `CheckRow`, `FindingRow`, `MiniTable`,
  `Stat`, `CourtBar`, `Log`, `Btn`, `SettingsRow` + `Toggle` / `TextBox`, `Section` / `Field`.
- You may also render a mock the landing already has (`components/mock/home.tsx`,
  `reports.tsx`, `setup.tsx`, `teams.tsx`) when it shows exactly the screen you describe.
- Use the fictional Acme team from `src/mock/acme.ts` (acme/payments, #612 Partial refunds,
  PAY-142 …). Never real names, repositories or data.
- Keep pictures small: the few rows that make the point. A picture never replaces the text.
- Page-specific mock pieces live in the page file. Shared new pieces go in `kit.tsx`.

## Callouts and other pieces

| Piece | Use it for |
|---|---|
| `Note` | Something worth knowing that changes nothing if missed |
| `Tip` | A quicker or better way |
| `Warning` | Something that posts to GitHub, pushes code, spends money, loses work or surprises a teammate |
| `Steps` | A numbered procedure; each `li` one action |
| `Ui` | A word on the app's screen |
| `Kbd` | A key |
| `DocLink to="section/slug#anchor"` | A link to another docs page (checked by the test) |
| `ExtLink href` | A link off the site |
| `Quote source href` | An exact quotation from a vendor's page |

## Check your work

```sh
pnpm --filter @pierre-review/landing test        # the docs test
pnpm --filter @pierre-review/landing typecheck
pnpm --filter @pierre-review/landing build       # prerenders every page; fails on an empty one
pnpm --filter @pierre-review/landing dev         # http://localhost:5174/docs
```
