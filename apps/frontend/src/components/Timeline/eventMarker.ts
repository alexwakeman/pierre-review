import type { TimelineEvent, User } from '@gh-team-monitor/shared';
import { EVENT_META, relativeTime, userLabel } from '../../lib/ui.js';

export function eventClassName(ev: TimelineEvent): string {
  const meta = EVENT_META[ev.type];
  return `ev ev-${ev.type} ev-${meta.shape}`;
}

export function eventTooltip(
  ev: TimelineEvent,
  usersById: Map<number, User>,
): string {
  const meta = EVENT_META[ev.type];
  const who = userLabel(
    ev.actorId != null ? usersById.get(ev.actorId) : undefined,
    ev.actorId,
  );
  return `${meta.label} · ${who} · ${relativeTime(ev.occurredAt)}`;
}
