import type { CalendarEvent, CalendarState, EventMember, JoinLink, SchedulerState } from './types';

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export function ownerIdentities(state: SchedulerState, aliases: string[]): Set<string> {
  return new Set([...state.accounts.map(account => account.email), ...aliases].map(normalizeEmail).filter(Boolean));
}

export function sourceStatus(state: SchedulerState, calendar: CalendarState, now: number, maxAgeSeconds: number): EventMember['sourceStatus'] {
  const account = state.accounts.find(candidate => candidate.id === calendar.accountId);
  if (!account || account.needsReconnect || !calendar.watched || calendar.unauthorized || !calendar.verified ||
      calendar.lastSuccess === undefined || !Number.isFinite(calendar.lastSuccess) || now - calendar.lastSuccess >= maxAgeSeconds * 1000) return 'unavailable';
  return calendar.lastAttemptSucceeded === true ? 'current' : 'grace';
}

export function hardIneligibility(event: CalendarEvent, start: number, end: number, link?: JoinLink): string | undefined {
  if (event.status === 'cancelled') return 'cancelled';
  if (!link) return 'no supported join link';
  if (event.start?.date || event.end?.date) return 'all-day event';
  if (!event.start?.dateTime || !event.end?.dateTime || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 'invalid event time';
  return undefined;
}

/** Only scheduling copies contribute RSVP evidence, so an expired acceptance cannot override a fresh decline. */
export function decide(event: CalendarEvent, occurrenceCopies: CalendarEvent[], owners: Set<string>): EventMember['decision'] {
  const responses = occurrenceCopies.flatMap(copy => (copy.attendees || [])
    .filter(attendee => attendee.email && owners.has(normalizeEmail(attendee.email)))
    .map(attendee => attendee.responseStatus).filter((response): response is string => Boolean(response)));
  if (responses.length && responses.every(response => response === 'declined')) return { join: false, reason: 'declined' };
  const others = new Set((event.attendees || []).filter(attendee => !attendee.resource && attendee.email && !owners.has(normalizeEmail(attendee.email)))
    .flatMap(attendee => attendee.email ? [normalizeEmail(attendee.email)] : []));
  const organizer = event.organizer?.email && normalizeEmail(event.organizer.email);
  const organizerIsResource = (event.attendees || []).some(attendee => attendee.resource && attendee.email && normalizeEmail(attendee.email) === organizer);
  if (organizer && !owners.has(organizer) && !organizerIsResource) others.add(organizer);
  if (!others.size) return { join: false, reason: event.attendeesOmitted ? 'attendees unavailable' : 'alone' };
  return { join: true, reason: responses.length ? 'automatic' : 'automatic (owner response unavailable)' };
}
