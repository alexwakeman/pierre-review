// Retrospective suppression simulation — the MANDATORY pre-PR gate for suppress-shaped
// intents: "this filter would also have hidden N comments you acted on, M high-severity."
// Pure over prefetched cell data; no ctx, no I/O.
//
// Glob semantics v1: our own emitted globs are exactly the cell's `<seg>/**` pathBucket, so
// the simulation is an IDENTITY over the cell's numbers (the cell was aggregated over the
// same prefix over the same evidence window) — deterministic prefix matching, no glob
// dependency. User-authored globs in existing configs are out of retro scope (disclosed).
//
// Additive intents (AMPLIFY_PATH / ESCALATE / BOOTSTRAP_CONFIG / PROMOTE_TO_LINT) hide
// nothing → `applicable: false`, config-PR permitted without numbers. Suppress-shaped
// intents with no computable basis (SCOPE_OFF: overlap cells carry no acted-on split) come
// back `computable: false`, which BLOCKS the config-PR (422) — the brief still renders,
// disclosing the gap. That asymmetry is the brief's mandate, not an implementation shortcut.
import type {
  AdvisorBotTotals,
  AdvisorCategoryCell,
  AdvisorIntentKind,
  AdvisorPathCell,
  AdvisorRetroCheck,
} from '@pierre-review/shared';

const NOT_APPLICABLE: AdvisorRetroCheck = {
  applicable: false,
  computable: true,
  wouldHideActedOn: 0,
  wouldHideActedOnHigh: 0,
  wouldHideTotal: 0,
  disclosure: 'Additive change — nothing is hidden, so there is nothing to simulate.',
};

export function retroForPathSuppression(cell: AdvisorPathCell): AdvisorRetroCheck {
  return {
    applicable: true,
    computable: true,
    wouldHideActedOn: cell.actedOn,
    wouldHideActedOnHigh: cell.actedOnHigh,
    wouldHideTotal: cell.volume,
    disclosure:
      `Simulated over the evidence window against this bot's ${cell.volume} threads in ` +
      `${cell.pathBucket} (our emitted glob matches the same prefix the cell aggregates). ` +
      'User-authored globs already in the config are outside this simulation.',
  };
}

export function retroForQuietPathNits(cell: AdvisorPathCell): AdvisorRetroCheck {
  const labelled =
    cell.bySeverity.nit + cell.bySeverity.minor + cell.bySeverity.major + cell.bySeverity.critical;
  // Computable only when the path has nit-labelled findings to simulate against.
  const computable = cell.bySeverity.nit > 0;
  return {
    applicable: true,
    computable,
    wouldHideActedOn: cell.actedOnNits,
    wouldHideActedOnHigh: 0, // a nit is by definition not high-severity
    wouldHideTotal: cell.bySeverity.nit,
    disclosure: computable
      ? `Simulated over the ${labelled} ML-labelled threads (of ${cell.volume}) in ` +
        `${cell.pathBucket}: a nit-level filter there hides ${cell.bySeverity.nit} nit ` +
        `finding(s), of which ${cell.actedOnNits} were acted on. Unlabelled threads are ` +
        'outside the simulation — a severity-scoped filter cannot match them.'
      : 'No nit-labelled findings on this path — the simulation has no basis and the config-PR is blocked.',
  };
}

export function retroForCategorySuppression(cell: AdvisorCategoryCell): AdvisorRetroCheck {
  return {
    applicable: true,
    computable: true,
    wouldHideActedOn: cell.actedOn,
    wouldHideActedOnHigh: cell.actedOnHigh,
    wouldHideTotal: cell.findings,
    disclosure:
      `Acted-on counts cover the ${cell.threadLinked} thread-linked findings of ` +
      `${cell.findings} total; PR comments and review bodies carry no acted-on signal.`,
  };
}

export function retroForLowerVerbosity(bot: AdvisorBotTotals): AdvisorRetroCheck {
  // Computable only when the bot has thread-linked nit labels to simulate against — a bot
  // whose nits are all PR-comment-kind has no acted-on signal to check.
  const computable = bot.mlFindings > 0;
  return {
    applicable: true,
    computable,
    wouldHideActedOn: bot.actedOnNits,
    wouldHideActedOnHigh: 0, // a nit is by definition not high-severity
    wouldHideTotal: bot.mlNits,
    disclosure: computable
      ? `Raising the severity floor hides nit-level findings: ${bot.mlNits} in the window, ` +
        `of which ${bot.actedOnNits} thread-linked nits were acted on.`
      : 'No labelled findings in the window — the simulation has no basis and the config-PR is blocked.',
  };
}

export function retroForScopeOff(): AdvisorRetroCheck {
  return {
    applicable: true,
    computable: false,
    wouldHideActedOn: 0,
    wouldHideActedOnHigh: 0,
    wouldHideTotal: 0,
    disclosure:
      'Overlap cells carry no acted-on split for the overlapped threads, so what a scope ' +
      'change would hide cannot be simulated — the config-PR is blocked; use the brief.',
  };
}

export function retroFor(
  kind: AdvisorIntentKind,
  data: {
    pathCell?: AdvisorPathCell;
    categoryCell?: AdvisorCategoryCell;
    bot?: AdvisorBotTotals;
  },
): AdvisorRetroCheck {
  switch (kind) {
    case 'SUPPRESS_PATH':
      return data.pathCell ? retroForPathSuppression(data.pathCell) : retroForScopeOff();
    case 'QUIET_PATH_NITS':
      return data.pathCell ? retroForQuietPathNits(data.pathCell) : retroForScopeOff();
    case 'SUPPRESS_CATEGORY':
      return data.categoryCell
        ? retroForCategorySuppression(data.categoryCell)
        : retroForScopeOff();
    case 'LOWER_VERBOSITY':
      return data.bot ? retroForLowerVerbosity(data.bot) : retroForScopeOff();
    case 'SCOPE_OFF':
      return retroForScopeOff();
    case 'AMPLIFY_PATH':
    case 'ESCALATE':
    case 'BOOTSTRAP_CONFIG':
    case 'PROMOTE_TO_LINT':
      return NOT_APPLICABLE;
  }
}
