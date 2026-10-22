// The advisory brief — the T5 UNIVERSAL output: a deterministic markdown render of the
// selected intents with evidence, retro numbers, capability notes and the path-coverage
// disclosure. Nothing stored, nothing model-generated; the same markdown is the export
// payload and the GitHub-issue body. Pure `(data) => string`.
import type {
  AdvisorBotOverlay,
  AdvisorIntentKind,
  AdvisorIntentWire,
} from '@pierre-review/shared';

const KIND_HEADING: Record<AdvisorIntentKind, string> = {
  SUPPRESS_PATH: 'Suppress a path',
  QUIET_PATH_NITS: 'Quiet nit-level comments on a path',
  SUPPRESS_CATEGORY: 'Suppress a category',
  LOWER_VERBOSITY: 'Raise the severity floor',
  SCOPE_OFF: 'Narrow overlapping coverage',
  AMPLIFY_PATH: 'Amplify a path',
  ESCALATE: 'Escalate a category',
  PROMOTE_TO_LINT: 'Promote to a lint rule',
  BOOTSTRAP_CONFIG: 'Bootstrap a configuration',
};

export interface BriefArgs {
  intents: AdvisorIntentWire[];
  overlays: AdvisorBotOverlay[];
  windowLabel: string; // e.g. "the trailing 30 days"
  generatedAt: string;
}

export function renderBrief(args: BriefArgs): string {
  const overlayByBot = new Map(args.overlays.map((o) => [o.botUserId, o]));
  const byBot = new Map<number, AdvisorIntentWire[]>();
  for (const intent of args.intents) {
    const arr = byBot.get(intent.botUserId) ?? [];
    arr.push(intent);
    byBot.set(intent.botUserId, arr);
  }
  const lines: string[] = [
    '# Bot tuning brief',
    '',
    `Evidence window: ${args.windowLabel} · generated ${args.generatedAt} by Limn's Bot Tuning Advisor.`,
    'Every number below is deterministic (thread states + ML labels); no text was model-generated.',
    '',
  ];
  for (const [botUserId, intents] of byBot) {
    const overlay = overlayByBot.get(botUserId);
    const label = intents[0]!.botLabel;
    lines.push(`## ${label}`);
    if (overlay?.adapterName) {
      lines.push(`Config surface: ${overlay.adapterName} (${overlay.configTargets.map((t) => `\`${t.path}\``).join(', ')})`);
    } else {
      lines.push('Config surface: none known — this brief is the deliverable (tune the bot on its own platform).');
    }
    const coverage = intents[0]!.evidence.pathCoveragePct;
    if (coverage != null) {
      lines.push(
        `Path coverage: ${coverage}% of this bot's scored output can carry a file path — path-keyed findings describe only that share.`,
      );
    }
    lines.push('');
    for (const intent of intents) {
      lines.push(`### ${KIND_HEADING[intent.kind]} — \`${intent.targetKey}\``);
      lines.push('');
      lines.push(intent.rationale);
      const e = intent.evidence;
      lines.push(
        `- Evidence: ${e.volume} ${intent.kind === 'SUPPRESS_CATEGORY' || intent.kind === 'ESCALATE' ? 'findings' : 'threads'}, ` +
          `${e.actedOn} acted on${e.actedOnPct != null ? ` (${e.actedOnPct}%${e.threadLinked != null ? ` of ${e.threadLinked} thread-linked` : ''})` : ''}, ` +
          `${e.untouched} untouched${e.mergedUntouched > 0 ? ` (${e.mergedUntouched} shipped in PRs that merged anyway)` : ''}, ` +
          `${e.overdueUntouched} overdue, ${e.dissent} with pushback.`,
      );
      if (intent.retro.applicable) {
        lines.push(
          intent.retro.computable
            ? `- Retro-check: this change would also have hidden ${intent.retro.wouldHideActedOn} finding(s) you acted on` +
                ` (${intent.retro.wouldHideActedOnHigh} high-severity) of ${intent.retro.wouldHideTotal} total. ${intent.retro.disclosure}`
            : `- Retro-check: NOT computable — ${intent.retro.disclosure}`,
        );
      }
      const cap = overlay?.capabilities?.[intent.kind];
      if (cap && cap.level !== 'expressible') {
        lines.push(
          cap.level === 'degraded'
            ? `- Config support: degraded — ${cap.alternative ?? 'emitted as prose'}.`
            : '- Config support: not expressible in this bot\'s configuration — act on this manually.',
        );
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
