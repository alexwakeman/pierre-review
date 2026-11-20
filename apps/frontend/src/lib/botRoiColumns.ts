import { isLimnBotLogin } from '@pierre-review/shared';

// Which optional columns the Bots Monitoring ROI table draws. Pure, so the gate has a test and the
// header, the cell and the chart beneath the table all read the SAME answer.

/** The minimum a ROI row must carry for the gate: its login and its stored kind. */
export interface RoiBotIdentity {
  login?: string | null;
  kind: string;
}

/**
 * Ensemble's own review bot: every `limn:<login>` actor (db/limn-bots.ts), which the classifier
 * always gives the kind `'pierre'`. Either signal is enough — the stored kind wins on read, and an
 * older row may carry only the login.
 */
export function isEnsembleBot(row: RoiBotIdentity): boolean {
  return row.kind === 'pierre' || isLimnBotLogin(row.login);
}

/** True when the table has at least one row and every row is Ensemble's own bot. */
export function onlyEnsembleBots(rows: readonly RoiBotIdentity[]): boolean {
  return rows.length > 0 && rows.every(isEnsembleBot);
}

/**
 * The Inflation column AND the "Severity inflation" chart beneath the table.
 *
 * Shown only when the ML columns are (`mlColumns`: the deployment scores and the window has labels),
 * and not when every row is Ensemble's own bot: Inflation compares a bot's OWN severity badge with
 * our model's, and Ensemble's findings carry the review's own severity, so there is nothing to
 * compare. One other bot in the table brings the column back for every row.
 */
export function inflationShown(mlColumns: boolean, rows: readonly RoiBotIdentity[]): boolean {
  return mlColumns && !onlyEnsembleBots(rows);
}
