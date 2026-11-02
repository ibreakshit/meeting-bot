import type { BotSettings, DispatchRecord, MeetingGroup, PlannerAction } from './types';

export function blocksDispatch(dispatch: DispatchRecord): boolean {
  return !(dispatch.state === 'removed' && dispatch.removedBeforePickup === true);
}

const sharesIdentity = (group: MeetingGroup, dispatch: DispatchRecord): boolean =>
  group.memberKeys.some(key => dispatch.memberInstanceKeys.includes(key));

function executionChanges(group: MeetingGroup, dispatch: DispatchRecord): string[] {
  const changes: string[] = [];
  const currentCopies = group.members.filter(member => member.sourceStatus !== 'unavailable' && member.decision.reason !== 'superseded snapshot');
  const primary = group.primary || currentCopies.find(member => member.event.id === dispatch.payload.eventId) || currentCopies[0];
  if (primary) {
    if (primary.link?.provider !== dispatch.payload.provider) changes.push('provider');
    if (primary.link?.url !== dispatch.payload.url) changes.push('url');
    if (primary.timeZone !== dispatch.payload.timezone) changes.push('timezone');
  }
  if (group.start !== dispatch.scheduledStart) changes.push('start');
  if (group.end !== dispatch.scheduledEnd) changes.push('end');
  return changes;
}

function removalReason(group: MeetingGroup | undefined, now: number, leadSeconds: number): string | undefined {
  if (!group) return 'calendar unavailable';
  if (!group.join) return group.reason;
  if (now >= group.end) return 'missed before pickup';
  if (now < group.start - leadSeconds * 1000) return 'moved outside dispatch window';
  return undefined;
}

/** Queue membership is observational only. The ledger must atomically verify every returned mutation. */
export function plan(groups: MeetingGroup[], dispatches: DispatchRecord[], pendingPayloads: Set<string>, now: number, leadSeconds: number, appearance?: BotSettings): PlannerAction[] {
  const actions: PlannerAction[] = [];
  const blocking = dispatches.filter(blocksDispatch);
  for (const dispatch of blocking) {
    const matches = groups.filter(group => sharesIdentity(group, dispatch));
    const pending = dispatch.state === 'queued' && pendingPayloads.has(dispatch.serializedPayload);
    if (dispatch.source === 'manual') {
      // Manual invitations are independent of calendar availability and decisions.
      if (pending && now >= dispatch.scheduledEnd) actions.push({ type: 'remove', dispatch, reason: 'Manual invitation expired before pickup' });
      else if (pending && appearance && (dispatch.payload.name !== appearance.name || dispatch.payload.thumbnailId !== appearance.thumbnailId)) {
        actions.push({ type: 'replace-manual', dispatch });
      }
      continue;
    }
    if (pending) {
      const group = matches[0];
      const reason = removalReason(group, now, leadSeconds);
      if (reason) { actions.push({ type: 'remove', dispatch, reason }); continue; }
      // Release an old grouping only after exact pending removal. The next tick plans its new groups.
      if (matches.length > 1 || blocking.some(other => other.botId !== dispatch.botId && sharesIdentity(group, other))) {
        actions.push({ type: 'remove', dispatch, reason: 'group membership changed' }); continue;
      }
      const appearanceChanged = appearance && (dispatch.payload.name !== appearance.name || dispatch.payload.thumbnailId !== appearance.thumbnailId);
      if (executionChanges(group, dispatch).length || appearanceChanged) {
        actions.push({ type: 'replace', dispatch, group }); continue;
      }
      if (group.memberKeys.some(key => !dispatch.memberInstanceKeys.includes(key))) {
        actions.push({ type: 'annotate', dispatch, group, changedFields: [] });
      }
      continue;
    }
    // A missing pending payload can be a concurrent pickup. It never permits replacement or re-enqueue.
    if (!matches.length) {
      if (!dispatch.changedFields?.includes('calendar unavailable')) actions.push({ type: 'annotate', dispatch, changedFields: ['calendar unavailable'] });
      continue;
    }
    for (const group of matches) {
      const changedFields = executionChanges(group, dispatch);
      if (!group.join) changedFields.push('decision');
      if (group.members.every(member => member.sourceStatus === 'unavailable')) changedFields.push('calendar unavailable');
      const newFields = changedFields.filter(field => !dispatch.changedFields?.includes(field));
      const attachesMembers = group.memberKeys.some(key => !dispatch.memberInstanceKeys.includes(key));
      if (newFields.length || attachesMembers) actions.push({ type: 'annotate', dispatch, group, changedFields: newFields });
    }
  }
  const due = groups.filter(group => group.join && group.primary && now >= group.start - leadSeconds * 1000 && now < group.end)
    .sort((a, b) => a.start - b.start || (a.memberKeys[0] < b.memberKeys[0] ? -1 : a.memberKeys[0] > b.memberKeys[0] ? 1 : 0));
  for (const group of due) {
    if (!blocking.some(dispatch => sharesIdentity(group, dispatch))) actions.push({ type: 'enqueue', group });
  }
  return actions;
}
