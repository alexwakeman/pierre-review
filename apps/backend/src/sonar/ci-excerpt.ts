import { sonarConditionSentence, sonarFailingConditions, type SonarSnapshot } from '@pierre-review/shared';

// A FAILING SONARCLOUD CHECK IN THE CI REVIEW (docs/SONARCLOUD.md § The CI review, 2026-11-11).
//
// SonarCloud's check ("SonarCloud Code Analysis") is a third-party check: it has no GitHub Actions log,
// so the CI review used to list it `no_log` — and when it was the ONLY red check, refuse the whole run
// (`no_logs`) with no model. A failing quality gate was therefore never explained or posted by the CI
// review, even though the CI review runs whether or not an AI review does. Now the CI review is shown
// SonarCloud's own analysis of the head in place of a log: the gate's failing conditions in words and
// the most severe issues. The check failing means SonarCloud has finished, so the analysis is there.

/** Is this check SonarCloud's (or SonarQube's) analysis? By name: it is a third-party check. */
export function isSonarCheckName(name: string): boolean {
  return /\bsonar(?:cloud|qube)?\b/i.test(name);
}

/** The most issues listed in the stand-in (the run's per-check excerpt budget holds the rest back). */
export const SONAR_CI_ISSUES_MAX = 25;

/**
 * The text the CI review is shown for a failing SonarCloud check, from an `ok` snapshot of THIS head:
 * the failing gate conditions (with their files), then the most severe issues, one line each. null
 * when the snapshot is not an `ok` read or holds nothing. Clipped to `maxChars`. Pure.
 */
export function sonarCiExcerptText(snap: SonarSnapshot | null, maxChars: number): string | null {
  if (snap == null || snap.state !== 'ok') return null;
  const failing = sonarFailingConditions(snap.qualityGate);
  const issues = snap.issues ?? [];
  if (failing.length === 0 && issues.length === 0) return null;
  const out: string[] = [
    "SonarCloud's analysis of this commit (this check has no log; this is what SonarCloud reported).",
  ];
  const gate = snap.qualityGate?.status;
  out.push(`Quality gate: ${gate === 'ERROR' ? 'failed' : gate === 'OK' ? 'passed' : (gate ?? 'unknown').toLowerCase()}.`);
  for (const c of failing) {
    out.push(`- ${c.status === 'ERROR' ? 'Failing' : 'Warning'}: ${sonarConditionSentence(c)}`);
    for (const f of c.files ?? []) out.push(`    ${f.path}: ${f.lines} new ${f.lines === 1 ? 'line' : 'lines'}`);
  }
  const total = (snap.totalIssues ?? 0) + (snap.totalHotspots ?? 0);
  if (issues.length > 0) {
    const shown = issues.slice(0, SONAR_CI_ISSUES_MAX);
    out.push(`Open issues, most severe first (${shown.length} of ${Math.max(total, issues.length)}):`);
    for (const it of shown) {
      const where = it.path ? (it.line != null ? `${it.path}:${it.line}` : it.path) : '(project level)';
      const kind = it.kind === 'hotspot' ? 'security hotspot' : (it.type ?? 'issue').toLowerCase().replace(/_/g, ' ');
      out.push(`- ${it.severity.toUpperCase()} ${kind} ${it.rule} at ${where}: ${it.message}`);
    }
  }
  const text = out.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
