# Limn design system (the redesign)

Normative. New and redesigned UI follows this file; the primitives in
`apps/frontend/src/components/ui/` implement it, and `test/designTokens.test.ts` +
`test/uiPrimitives.test.ts` hold the parts that can be measured. The reference prototype is
`pierre-review-proto/prototypes/pending-inbox/`. What must survive the redesign is in
[LEDGER.md](LEDGER.md). CLAUDE.md's product-voice, icon, AiRunGate and contrast rules all still apply.

## 1. Principles

1. **One sidebar, one header.** Navigation is the left sidebar; each page has ONE slim header
   (title, a sentence, at most one primary action, the page's tabs). No stacked strips above content.
2. **One line per item.** Lists are one-line rows; detail opens in a side panel.
3. **Colour means something.** Red = blocks. Green = ready to land. Accent = the selection and the
   one primary action. Everything else is grey ink on a tone.
4. **Keyboard first, touch equal.** Every action has a key on desktop and a ≥ 40px target on touch.
5. **Instant.** Act, show the result at once, offer Undo; repair on failure, never hide it.
6. **Nothing lost.** Moving information is fine; deleting it is not (LEDGER.md).

## 2. Type — four sizes

| Token (Tailwind) | Size / line | Use |
|---|---|---|
| `text-meta` | 12 / 16 | counts, ages, sizes, authors, hints, kbd, table secondary cells, form hints |
| `text-body` | 13 / 20 | everything else: rows, buttons, inputs, prose, menus |
| `text-title` | 15 / 22, 600 | side-panel title, section heading, dialog title, palette input |
| `text-display` | 22 / 28, 600 | the page title in the page header — once per page |

- **Nothing under 11px, anywhere** (`designTokens.test.ts` fails the build). The four tokens are
  the ONLY sizes: `test/designRules.test.ts` fails on any `text-[Npx]` or `text-xs/sm/base/lg` in
  src, and holds raw palette classes (`text-gray-500`, `bg-amber-50` …) to a ratchet that only goes
  down.
- Weight: 400 body, 500 for a row's emphasis and buttons, 600 only for title/display. No uppercase
  labels with tracking (the old `UPPERCASE 10px` section heads become `text-meta` mute words).
- Numbers: `tabular-nums` wherever they line up (counts, ages, +/−).
- The Limn wordmark keeps its own face (`.brand-title`, Archivo).

## 3. Colour — roles, both themes

CSS variables `--ui-*` in `src/index.css` (space-separated RGB, light in `:root`, dark in `.dark`),
Tailwind `ui-*` colours. Dark is the default theme; both themes are first-class.

| Role | Tailwind | Meaning |
|---|---|---|
| `bg` | `bg-ui-bg` | the page |
| `surface` | `bg-ui-surface` | sidebar, side panel, palette list |
| `raise` | `bg-ui-raise` | inputs, secondary buttons, menus, popovers |
| `hover` | `bg-ui-hover` | hover on a row or control |
| `sel` | `bg-ui-sel` | the selected row, the active tab or nav item |
| `line` | `ring-ui-line` | the rare edge (an input's ring, a menu separator) |
| `ink` / `mute` / `faint` | `text-ui-*` | primary / secondary / tertiary text — all AA on every surface |
| `accent` | `text-ui-accent`, `ring-ui-accent` | selection marks, focus ring, a link |
| `accent-fill` + `on-accent` | `bg-ui-accent-fill text-ui-on-accent` | the ONE primary button |
| `danger` | `text-ui-danger` | **blocks**: conflicts, failing CI, changes requested, security, errors |
| `success` | `text-ui-success` | **ready**: can land, approved where approval is the news |
| `warn` | `text-ui-warn` | attention marks the product already has (stale, near a limit) — sparingly |
| `scrim` | `bg-ui-scrim/40` | behind sheets and dialogs |

Rules:

- **Surfaces are separated by tone, not borders.** No `border` between panes; the side panel is
  `surface` against the list's `bg`. A 1px `line` ring is allowed on inputs and checkboxes only.
- **A status is an icon + words** (`StatusIcon`). Its tone follows from its meaning
  (`blocked`/`ready`/`active`/`neutral`/`quiet`), never chosen per call site. Colour is never the
  only signal.
- **Red and green are not decoration.** No red "Draft", no green "Comment", no coloured chip for a
  neutral fact. A row is red only when it blocks.
- **Existing colour families stay where they carry meaning**: the AI surface `--ai-*` (violet —
  moved off the brand vermilion, which read as danger red — for "a model produced this"), vendor colours through `vendorInk()` (identity, measured by
  `vendorInk.test.ts`), the derived-thread-state palette (`state-*`) inside thread surfaces, the
  conflict resolver's `--mr-*`. They do not spread to new places.
- The `textContrast.test.ts` / `vendorInk.test.ts` rules still apply to legacy classes;
  `designTokens.test.ts` measures every `--ui-*` ink on every surface in both themes.

## 4. Shape, space, elevation

- **One radius: `rounded-ui` (6px)** for rows, buttons, inputs, menus, panels. Exceptions: full
  circles (avatars, dots, radios), the palette dialog (10px), sheet tops on a phone (`rounded-t-xl`).
- Spacing on the 4px grid. Row padding `px-3`; panel padding `px-5` (`px-4` on a phone); page
  header `px-7 pt-5 pb-3`; gaps 8 / 12 / 16.
- **Row height: `h-row` 36px; `touch:h-row-touch` 44px** on a coarse pointer.
- Controls: 32px (`md`) / 28px (`sm`) on desktop; ≥ 40px (`touch:`) on touch.
- Sidebar `w-sidebar` 232px; docked side panel `w-panel` 400px.
- Elevation: only floating things (menu, popover, palette, sheet) get a shadow. Nothing in the page flow does.

## 5. Motion

| Token | Value | Use |
|---|---|---|
| `duration-ui-fast` | 80ms | hover / colour changes |
| `duration-ui` | 160ms | row slide-out, switch thumb, panel slide-in |
| `animate-ui-pop` | 140ms | menu, popover, palette appear |
| `animate-ui-slide-in` | 160ms | side panel |
| `animate-ui-sheet-up` | 180ms | phone sheets |
| `animate-ui-drawer-in` | 180ms | the mobile sidebar drawer |
| ease `ease-ui` | `cubic-bezier(0.2, 0.7, 0.2, 1)` | everything |

- Use `motion-safe:` for every transition and animation in new code.
- `prefers-reduced-motion: reduce` makes everything instant: a global backstop in `index.css`
  covers legacy CSS, and `prefersReducedMotion()` makes the removal timer 0ms. State still changes.
- Never animate layout height of long lists; never loop an animation except a spinner/pulse that
  says "running" (and then also say it in words).

## 6. Layout and mobile

Breakpoints are Tailwind's: `sm` 640 · `md` 768 · `lg` 1024 · `xl` 1280, plus `touch:` (coarse pointer).

| Width | Sidebar | Side panel | Lists |
|---|---|---|---|
| ≥ 1024 (`lg`) | persistent, 232px | docked column, 400px, beside the list | full row: lead · reason · title · meta · author · age |
| 768 – 1023 | drawer (menu button in the page header, `animate-ui-drawer-in`, scrim, Esc) | sheet from the right, 440px, modal | reason / author columns drop (`RowMeta hideBelow`) |
| < 768 | drawer + a bottom bar with the 4 primary destinations | **full-screen sheet**, Back button top-left, actions pinned to the bottom | one line: lead · title · age |

- **No horizontal page overflow at 390px.** A wide table scrolls inside its own box
  (`overflow-x-auto` on the table wrapper), never the page.
- Touch targets ≥ 40px (`touch:` sizes on every primitive). Kbd hints hide on touch (`Kbd`).
- Menus and selects open as bottom sheets on a phone (built into `Menu` / `Select`).
- Respect safe areas: sheets pad with `env(safe-area-inset-*)`.
- Every screen is checked at 390 × 844 and 768 × 1024 as well as 1440 × 900.

## 7. Components (the primitives)

All in `components/ui/`, exported from `components/ui/index.ts`.

- **`List` / `Row` / `useListKeyboard`** — one-line rows, one tab stop, `role="listbox"`. Rows hold
  no tab stops; actions live in the panel and on keys. Nothing fetches on selection.
- **`SidePanel`** — docked ≥ lg, sheet below. `footer` is the action bar (primary first).
- **`Tabs`** — page tabs with counts (`number` · `'loading'` → "…" · `null` → nothing; 0 stays
  visible and dimmed). `numberKeys` gives 1–9 to the page's own tablist only.
- **`Button` / `IconButton`** — `primary` (one per surface), `secondary`, `ghost`, `danger` (danger
  ink, never a red ground). `kbd` names the shortcut in `aria-keyshortcuts` and the tooltip — it is
  NEVER printed on the button (shortcuts are listed by ⌘K and the `?` sheet). `IconButton` requires
  `label`.
- **`hit`** (index.css) — a small control's tap area grows to 40 × 40 on a coarse pointer through an
  invisible centred `::after`, without moving layout. Every hand-rolled `<button>` / `<a>` with a
  class string carries it; a primitive with real `touch:` sizes does not need it.
- **`useEdgeFade(ref, 'x' | 'y')`** — a scroll box fades the edge that hides more (wide tables, the
  sidebar's middle). `Tabs` does the same and keeps the selected tab in view.
- **`StatusIcon`** — icon + words, tone by rule.
- **`Checkbox` / `Radio` / `RadioGroup` / `Switch`** — real inputs restyled (forms, labels and
  selectors keep working). Switch = takes effect at once; Checkbox = saved by a Save button.
- **`Select`** — custom select-only combobox. Not a native select: scripts using `selectOption()`
  must be updated when one is swapped.
- **`Menu`** — action menu, one popover at a time, type-ahead, bottom sheet on a phone.
- **`CommandPalette` + `useRegisterCommands` / `useCommandProvider`** — ⌘K. Screens register their
  commands while mounted.
- **`removeOptimistically` / `useOptimisticList` / `UndoToast` / `undoLast`** — instant removal with
  Undo through the ONE header toast strip.
- **`Kbd`**, `cx`, `FOCUS_RING`, `useIsDesktop` / `useIsPhone` / `useReducedMotion`, `shortcutBlocked`.

Still the rule, unchanged: explanation behind `InfoButton` (ⓘ, click not hover); every icon from
`Icons.tsx`; every AI run button inside `AiRunGate`; toasts only as `HeaderToast` cards; one open
popover at a time (`lib/activePopover.ts`); a modal or popover owns its Escape (capture phase).

## 8. Keyboard map

Global (any screen, not while typing, not under a modal unless noted):

| Key | Does |
|---|---|
| `⌘K` / `Ctrl+K` | command palette — works even while typing |
| `/` | the palette (it replaced the FilterBar search box); the add-repo field while "Manage repos" is open |
| `g` then a letter | go to a page: `p` Pending · `o` Open pull requests · `s` This Sprint · `t` Timeline · `d` Docs · `f` Feed · `r` Reports · `b` Bots Monitoring (`components/shell/nav.ts`) |
| `1`–`9` | switch the page's own tabs (Pending's seven, Sprint's four, PR detail's tabs) |
| `n` / `p` | PR detail → Changes: next / previous file (in Threads only: files with threads) |
| `]` / `[` | PR detail → Changes: next / previous review thread, shown in the code |
| `t` | PR detail → Changes: Threads only on / off |
| `i` | Activity (kept) |
| `?` | the key sheet (`components/shell/ShortcutsSheet.tsx`) |
| `Esc` | close the top layer: popover → menu → dialog → side panel; then today's behaviour (blur / leave to the Timeline / clear selection) |

Lists (`useListKeyboard`):

| Key | Does |
|---|---|
| `j` / `k` | next / previous row (anywhere on the page) |
| `↓` / `↑`, `Home` / `End` | same, while focus is in the list |
| `G` | last row |
| `↵` | open the selected row (side panel, or the row's primary action when the panel is open) |
| `a` | approve (only where approving is allowed) |
| `m` | merge (only when `mergeVerdict()` says it can land) |
| `e` | done / dismiss (My turn) |
| `z` | undo the last removal |
| `o` | open on GitHub (where the row has a GitHub page) |

A key that cannot act on the selected row does nothing visible except a short status line saying
why ("Can't merge: conflicts with main") — never a silent no-op, never an error toast.

## 9. Feedback

- **Optimistic removal**: the row slides out (170ms), counts drop at once, an Undo card appears in
  the header strip for 8s. `immediate` mode for writes with an inverse (dismiss ↔ restore);
  `deferred` for writes without one (merge) — the write fires when the offer ends, and the card says
  "Merging" not "Merged".
- On failure the row returns and the reason shows where the row is.
- `visible:false` with a comment id still means "it'll show up shortly" — never offer a retry.
- Loading never shows "0": counts show "…", lists show skeleton rows of the real row height.

## 10. Writing

Unchanged from CLAUDE.md: plain English, shortest honest version, name the thing, explanation behind
ⓘ. A row's reason column is a few words ("Review requested", "Conflicts with main"); the full
sentence lives in the side panel.
