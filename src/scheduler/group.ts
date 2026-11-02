import { decide, hardIneligibility, ownerIdentities, sourceStatus } from './decide';
import { extractJoinLink } from './links';
import type { CalendarEvent, EventMember, MeetingGroup, OverrideAction, SchedulerState } from './types';

export const calendarKey = (accountId: string, calendarId: string): string => JSON.stringify([accountId, calendarId]);

/** Current start is deliberately absent: moving an occurrence must preserve claims and overrides. */
export function instanceKey(event: CalendarEvent, sourceKey = ''): string {
  const identity = event.iCalUID ? ['uid', event.iCalUID] : ['google', sourceKey, event.id];
  if (event.originalStartTime) {
    const original = event.originalStartTime;
    const instant = original.dateTime && Date.parse(original.dateTime);
    const occurrence = original.date ? `date:${original.date}` : Number.isFinite(instant) ? `instant:${instant}` : `invalid:${original.dateTime || ''}`;
    return `recurring:${JSON.stringify([identity, occurrence])}`;
  }
  return `single:${JSON.stringify(identity)}`;
}

function effectiveOverride(keys: string[], overrides: SchedulerState['overrides']): OverrideAction | undefined {
  return keys.map(key => overrides[key]).filter((action): action is OverrideAction => Boolean(action))
    .sort((a, b) => b.revision - a.revision || a.mode.localeCompare(b.mode))[0];
}

const lexicalOrder = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const primaryOrder = (a: EventMember, b: EventMember): number => a.start - b.start || lexicalOrder(a.event.id, b.event.id) || lexicalOrder(a.calendarKey, b.calendarKey);

export function buildGroups(state: SchedulerState, now: number, maxAgeSeconds: number, aliases: string[]): MeetingGroup[] {
  const owners = ownerIdentities(state, aliases);
  const members: EventMember[] = state.calendars.flatMap(calendar => calendar.events.map(event => {
    const sourceKey = calendarKey(calendar.accountId, calendar.id);
    const source = sourceStatus(state, calendar, now, maxAgeSeconds);
    const start = Date.parse(event.start?.dateTime || event.start?.date || '');
    const end = Date.parse(event.end?.dateTime || event.end?.date || '');
    const link = extractJoinLink(event);
    const reason = source === 'unavailable' ? 'calendar unavailable' : hardIneligibility(event, start, end, link);
    return { key: instanceKey(event, sourceKey), calendarKey: sourceKey, accountId: calendar.accountId,
      calendarId: calendar.id, calendarSummary: calendar.summary, timeZone: calendar.timeZone,
      event, start, end, link, eligible: !reason, sourceStatus: source, decision: { join: false, reason: reason || 'automatic' } };
  }));
  const occurrences = new Map<string, EventMember[]>();
  for (const member of members) {
    const copies = occurrences.get(member.key) || [];
    copies.push(member); occurrences.set(member.key, copies);
  }
  for (const copies of occurrences.values()) {
    // A current cancellation/decline also supersedes an old grace-period acceptance.
    if (copies.some(copy => copy.sourceStatus === 'current')) {
      for (const copy of copies.filter(copy => copy.sourceStatus === 'grace')) {
        copy.eligible = false; copy.decision = { join: false, reason: 'superseded snapshot' };
      }
    }
    const schedulingCopies = copies.filter(copy => copy.eligible).map(copy => copy.event);
    for (const copy of copies.filter(copy => copy.eligible)) copy.decision = decide(copy.event, schedulingCopies, owners);
  }

  const parents = members.map((_, index) => index);
  const root = (index: number): number => {
    while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; }
    return index;
  };
  for (let left = 0; left < members.length; left++) {
    for (let right = left + 1; right < members.length; right++) {
      const a = members[left], b = members[right];
      if (a.key === b.key || (a.eligible && b.eligible && a.link && b.link && a.link.roomId === b.link.roomId && a.start < b.end && b.start < a.end)) {
        parents[root(right)] = root(left);
      }
    }
  }
  const clusters = new Map<number, EventMember[]>();
  members.forEach((member, index) => {
    const key = root(index), cluster = clusters.get(key) || [];
    cluster.push(member); clusters.set(key, cluster);
  });
  return [...clusters.values()].map(cluster => {
    const memberKeys = [...new Set(cluster.map(member => member.key))].sort();
    const override = effectiveOverride(memberKeys, state.overrides);
    const authorizing = cluster.filter(member => member.eligible && override?.mode !== 'skip' && (override?.mode === 'join' || member.decision.join)).sort(primaryOrder);
    const primary = authorizing[0];
    const display = cluster.filter(member => Number.isFinite(member.start) && Number.isFinite(member.end));
    const bounds = authorizing.length ? authorizing : display;
    const reason = primary ? override?.mode === 'join' ? 'join override' : primary.decision.reason : override?.mode === 'skip' ? 'skip override' :
      (cluster.find(member => member.eligible) || cluster.find(member => member.sourceStatus === 'current') || cluster[0]).decision.reason;
    return { id: memberKeys[0], memberKeys, members: cluster, start: bounds.length ? Math.min(...bounds.map(member => member.start)) : 0,
      end: bounds.length ? Math.max(...bounds.map(member => member.end)) : 0, primary, join: Boolean(primary), reason, override };
  }).sort((a, b) => a.start - b.start || lexicalOrder(a.id, b.id));
}
