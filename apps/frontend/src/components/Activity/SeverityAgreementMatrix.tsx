import type {
  MlSeverity,
  SeverityAgreementCellRef,
  SeverityAgreementMatrix,
  VendorSeverityAxis,
} from '@pierre-review/shared';
import { ML_SEVERITIES, ML_SEVERITY_ORD } from '@pierre-review/shared';
import { matrixCell } from '../../lib/severityAgreement.js';
import { ML_SEVERITY_META } from '../../lib/ui.js';

// The ours-vs-vendor confusion matrix on the "what the bots are flagging" drill-down: for every
// row in the selected population, what OUR model scored it against what the BOT badged it itself.
// Each cell is a filter — click it and the list below narrows to exactly those rows.
//
// ⚠ THIS IS A DISPLAY OF TWO CLAIMS, NEVER A RECONCILIATION. On the adjudicated gold-300 the
// vendor's own badge scores 0.474 exact / 0.697 ordinal MAE against our 0.700 / 0.303, so the grid
// exists to show WHERE the two differ — nothing here corrects, seeds or overrides `severity`, and
// agreement is not scored as "correct" (which is why the diagonal is NEUTRAL rather than green:
// a bot agreeing with us does not make either rating right).
//
// ⚠ AND NOTHING HERE COUNTS. Every number rendered below is the SERVER's, folded from the same
// windowed scan the tiles are — `agree`/`overCall`/`underCall`/`declared` are read straight off
// the wire and never recomputed from `cells`, because a client-side re-derivation is exactly how
// this screen would start disagreeing with the tile it was opened from.

// The vendor axis: our four classes plus the column for "the bot declared nothing", which is a
// real axis value and usually the largest one — dropping it would quietly shrink the matrix's
// denominator and make sparse data read as agreement.
const VENDOR_AXIS: VendorSeverityAxis[] = ['critical', 'major', 'minor', 'nit', 'none'];

// ⚠ AXIS ORDER IS PICKED ONCE, HERE, AND BOTH AXES ARE LABELLED IN THE UI. This codebase contains
// BOTH severity orders: the shared `ML_SEVERITIES` is worst-first (critical → nit) while
// `SEVERITY_COLUMNS` in BotRoiPanel.tsx is ascending (nit → critical) because those columns read
// left-to-right as a scale. Flipping one axis of a square grid transposes every cell and the whole
// screen lies — an over-call renders as an under-call — with nothing to catch it. So: worst-first
// on BOTH axes (`ML_SEVERITIES` for ours, `VENDOR_AXIS` for theirs), which also makes the
// agreement diagonal a true top-left → bottom-right diagonal, and gives the triangles a fixed
// meaning that is stated in the legend under the grid:
//   • UPPER RIGHT  — vendor ordinal > ours ⇒ the bot called it worse than we did (over-call)
//   • LOWER LEFT   — vendor ordinal < ours ⇒ the bot called it milder (under-call)
const OURS_AXIS: MlSeverity[] = ML_SEVERITIES;

// The hue-less tint, for the two kinds of cell that are NOT a claim about worse-or-milder: the
// agreement diagonal and the "no badge" row. Slate — the same neutral CONFIDENCE_META uses for
// "no signal" — so neither reads as a verdict. ⚠ Agreement deliberately does NOT get a green:
// the bot agreeing with us does not make either rating right, and tinting it as success would
// turn a comparison into a scoreboard.
const NEUTRAL_TINT = '#94a3b8';

/** `#rrggbb` + an alpha byte — the `${color}1a` idiom used by every badge here, but computed, so
 *  a cell's tint can carry its share of the biggest cell. */
function tint(color: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${color}${a}`;
}

function sameCell(
  a: SeverityAgreementCellRef | null,
  vendor: VendorSeverityAxis,
  ours: MlSeverity,
): boolean {
  return a != null && a.vendor === vendor && a.ours === ours;
}

export function SeverityAgreementMatrixView({
  matrix,
  cell,
  onSelectCell,
}: {
  /** Accepts `undefined` on purpose: the drill-down's infinite query reads this off `pages[0]`,
   *  which does not exist until the first page lands. "Nothing to show" and "not here yet" render
   *  the same — nothing. */
  matrix: SeverityAgreementMatrix | undefined;
  /** The cell currently narrowing the list, or null. Owned by the caller (it rides the query key). */
  cell: SeverityAgreementCellRef | null;
  /** Toggle: a new cell to narrow by, or null to clear. Clicking the ACTIVE cell clears. */
  onSelectCell: (c: SeverityAgreementCellRef | null) => void;
}): JSX.Element | null {
  // NO HOOKS IN THIS COMPONENT — that is what makes the early returns below legal.
  if (!matrix || matrix.total === 0) return null;

  // A confusion matrix with nothing to confuse is chrome that implies a comparison which was never
  // possible. Most bots badge nothing at all, so this is an ordinary state, not an error — say so
  // in one line and skip the 20 empty boxes. (The same `declared > 0` gate is why the caller's
  // direction toggle derives itself off rather than being written back.)
  if (matrix.declared === 0) {
    return (
      <div className="rounded-lg border border-gray-200 p-3 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
        None of the {matrix.total.toLocaleString()} scored comments here carry a severity badge from
        the bot itself, so there is nothing to compare our ratings against.{' '}
        <span className="font-semibold">Severity only.</span> Vendors declare no machine-readable
        category, so category is our model’s alone and cannot be compared.
      </div>
    );
  }

  // Tint intensity scales within the DECLARED rows only. The 'none' row is routinely an order of
  // magnitude larger than every other cell (most bots badge nothing), so including it in the max
  // would wash out the entire comparison the grid exists to show — its magnitude is carried by the
  // honesty line underneath instead.
  let maxDeclared = 0;
  let topDisagreement: { vendor: MlSeverity; ours: MlSeverity; count: number } | null = null;
  for (const c of matrix.cells) {
    if (c.vendor === 'none') continue;
    if (c.count > maxDeclared) maxDeclared = c.count;
    if (c.vendor === c.ours || c.count === 0) continue;
    // Strict `>` keeps the first in the server's dense cell order on a tie, so the callout below
    // is stable across refetches rather than flickering between two equal cells.
    if (!topDisagreement || c.count > topDisagreement.count) {
      topDisagreement = { vendor: c.vendor, ours: c.ours, count: c.count };
    }
  }

  const shareOfDeclared = (n: number): string => `${Math.round((n / matrix.declared) * 100)}%`;

  return (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold">Our severity vs the bot’s own badge</h3>
        <span
          className="text-[11px] text-gray-400"
          title="A comparison, not a correction. Our rating agrees with human adjudication on 70% of a held-out sample against the bot badge's 47% — nothing here changes our severity, and there is no disagreement to 'resolve'."
        >
          click a cell to narrow the list · advisory
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-[26rem] border-collapse">
          <thead>
            <tr>
              {/* Both axes are named in the corner. Without this the grid is a 20-number square
                  whose orientation the reader has to guess — and guessing wrong inverts it. */}
              <th className="px-2 py-1 text-left align-bottom text-[10px] font-medium leading-tight text-gray-400">
                <div>we scored →</div>
                <div>bot badged ↓</div>
              </th>
              {OURS_AXIS.map((ours) => {
                const meta = ML_SEVERITY_META[ours];
                return (
                  <th
                    key={ours}
                    scope="col"
                    className="px-3 py-1 text-center text-[11px] font-semibold"
                    style={{ color: meta.color }}
                    title={`We scored these ${meta.label}. ${meta.description}`}
                  >
                    {meta.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {VENDOR_AXIS.map((vendor) => {
              const undeclaredRow = vendor === 'none';
              const vendorMeta = undeclaredRow ? null : ML_SEVERITY_META[vendor];
              return (
                <tr key={vendor} className="border-t border-gray-100 dark:border-gray-900">
                  <th
                    scope="row"
                    className={`px-2 py-1 text-left text-[11px] font-semibold${
                      undeclaredRow ? ' text-gray-400' : ''
                    }`}
                    style={vendorMeta ? { color: vendorMeta.color } : undefined}
                    title={
                      vendorMeta
                        ? `The bot badged these ${vendorMeta.label} itself.`
                        : 'The bot posted no severity badge of its own on these — the common case, and not a disagreement.'
                    }
                  >
                    {vendorMeta ? vendorMeta.label : 'no badge'}
                  </th>
                  {OURS_AXIS.map((ours) => {
                    const count = matrixCell(matrix, vendor, ours);
                    const active = sameCell(cell, vendor, ours);
                    const agrees = vendor === ours;
                    // Direction uses `ML_SEVERITY_ORD` on BOTH sides — the same shared ordinal map
                    // `disagreeDirection` uses. That helper takes an `MlLabel` (a row); a matrix
                    // cell is a pair of AXIS VALUES with no row behind it, so it cannot be called
                    // here. What must not happen is a second ordinal table, or reading direction
                    // off the array indices (which silently follows an axis flip).
                    const over =
                      !undeclaredRow && !agrees && ML_SEVERITY_ORD[vendor] > ML_SEVERITY_ORD[ours];
                    // The disagreement is tinted by the WORSE of the two claims — that is what the
                    // argument is about, and it makes a nit-vs-critical cell read red while a
                    // minor-vs-nit one stays quiet. Position (not hue) carries the direction.
                    const hue =
                      undeclaredRow || agrees
                        ? null
                        : ML_SEVERITY_META[
                            ML_SEVERITY_ORD[vendor] >= ML_SEVERITY_ORD[ours] ? vendor : ours
                          ].color;
                    // Every cell gets a FULL-cell tint so the grid reads as one surface. The 'none'
                    // row is flat and faint on purpose: its counts are excluded from `maxDeclared`
                    // (see above), so scaling it would either saturate the whole row or, worse,
                    // give the un-compared column the visual weight of the comparison.
                    const strength = maxDeclared > 0 ? count / maxDeclared : 0;
                    const background = undeclaredRow
                      ? tint(NEUTRAL_TINT, 0.06)
                      : tint(hue ?? NEUTRAL_TINT, 0.08 + 0.42 * strength);

                    // A zero cell gets its own sentence rather than the count-0 version of the
                    // others: "the bot called 0 of these worse than we did" is a claim about a
                    // population that does not exist, and the click it advertises is disabled.
                    const title =
                      count === 0
                        ? `Nothing here: no comment we scored ${ML_SEVERITY_META[ours].label} ${
                            undeclaredRow
                              ? 'is missing a badge from the bot'
                              : `carries a ${vendorMeta?.label} badge from the bot`
                          }.`
                        : (undeclaredRow
                            ? `The bot declared no severity of its own on ${count.toLocaleString()} comment${
                                count === 1 ? '' : 's'
                              } we scored ${ML_SEVERITY_META[ours].label}. Not a disagreement — most bots badge nothing.`
                            : agrees
                              ? `The bot and our model both rated ${count.toLocaleString()} comment${
                                  count === 1 ? '' : 's'
                                } ${ML_SEVERITY_META[ours].label}. Agreement is not a score — it doesn’t make either rating right.`
                              : `The bot badged ${count.toLocaleString()} comment${
                                  count === 1 ? '' : 's'
                                } ${vendorMeta?.label} where we scored ${ML_SEVERITY_META[ours].label} — the bot called ${
                                  count === 1 ? 'this' : 'these'
                                } ${over ? 'worse' : 'milder'} than we did. ${shareOfDeclared(
                                  count,
                                )} of the badged rows here.`) +
                          (active ? ' Click again to clear the filter.' : ' Click to show only these.');

                    return (
                      <td key={ours} className="p-0.5">
                        <button
                          type="button"
                          onClick={() => onSelectCell(active ? null : { vendor, ours })}
                          aria-pressed={active}
                          // A zero cell filters to an empty list. Dead unless it is the one
                          // currently on, in which case it must stay clickable to clear itself.
                          disabled={count === 0 && !active}
                          title={title}
                          // The hover ring is applied ONLY when the cell is not the active one —
                          // Tailwind's `hover:ring-1` would otherwise narrow the active cell's
                          // ring-2 and recolour it grey on hover, i.e. the selection would appear
                          // to switch off under the cursor that is about to clear it.
                          className={`w-full rounded px-3 py-2 text-center text-[13px] tabular-nums transition-colors disabled:cursor-default ${
                            active
                              ? 'ring-2 ring-sky-500 ring-offset-1 ring-offset-white dark:ring-offset-gray-950'
                              : count > 0
                                ? 'hover:ring-1 hover:ring-gray-400'
                                : ''
                          } ${
                            count === 0
                              ? 'text-gray-300 dark:text-gray-700'
                              : 'font-medium text-gray-800 dark:text-gray-100'
                          }`}
                          style={
                            count === 0
                              ? undefined
                              : {
                                  backgroundColor: background,
                                  // The single biggest cell is the headline of this grid — in real
                                  // data it is an order of magnitude above its neighbours, and the
                                  // tint alone tops out well before the numbers do.
                                  fontWeight:
                                    maxDeclared > 0 && count === maxDeclared ? 700 : undefined,
                                }
                          }
                        >
                          {count === 0 ? '—' : count.toLocaleString()}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* The triangles' meaning, spelled out — it is a consequence of the worst-first axes above
          and is not guessable from the grid alone. */}
      <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
        Upper right: the bot called it <span className="font-medium">worse</span> than we did. Lower
        left: <span className="font-medium">milder</span>. The diagonal is agreement.
      </div>

      {/* Read straight off the wire — never re-derived from `cells` (see the header). */}
      <div className="mt-1 text-[11px] text-gray-500 tabular-nums dark:text-gray-400">
        Of the {matrix.declared.toLocaleString()} badged: {matrix.agree.toLocaleString()} agree ·{' '}
        {matrix.overCall.toLocaleString()} the bot called worse ·{' '}
        {matrix.underCall.toLocaleString()} milder
      </div>

      {topDisagreement && (
        <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
          Most common disagreement: the bot badged{' '}
          <span className="font-semibold tabular-nums">
            {topDisagreement.count.toLocaleString()}
          </span>{' '}
          of these{' '}
          <span
            className="font-semibold"
            style={{ color: ML_SEVERITY_META[topDisagreement.vendor].color }}
          >
            {ML_SEVERITY_META[topDisagreement.vendor].label}
          </span>{' '}
          where we scored them{' '}
          <span
            className="font-semibold"
            style={{ color: ML_SEVERITY_META[topDisagreement.ours].color }}
          >
            {ML_SEVERITY_META[topDisagreement.ours].label}
          </span>{' '}
          ({shareOfDeclared(topDisagreement.count)} of the badged rows).
        </div>
      )}

      {/* THE HONESTY LINE. Without it a sparse grid reads as "the bots mostly agree with us" when
          the truth is that they mostly said nothing at all — the `vendorDeclared` precedent. */}
      <div className="mt-1 text-[11px] text-gray-400 tabular-nums">
        {matrix.declared.toLocaleString()} of {matrix.total.toLocaleString()} rows carry a badge from
        the bot; the rest ({matrix.undeclared.toLocaleString()}) declared nothing.
      </div>

      <div className="mt-1 text-[11px] text-gray-400">
        <span className="font-semibold">Severity only.</span> Vendors declare no machine-readable
        category, so category is our model’s alone and cannot be compared.
      </div>
    </div>
  );
}
