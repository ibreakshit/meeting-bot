import type { CalendarEvent, JoinLink } from './types';

/** Calendar add-ons commonly HTML-escape password and context query parameters. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, name: string) => {
    const named: Record<string, string> = { amp: '&', quot: '"', apos: '\'', lt: '<', gt: '>', nbsp: ' ' };
    if (name[0] !== '#') return named[name.toLowerCase()] || entity;
    const value = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
  });
}

export function parseJoinLink(candidate: string): JoinLink | undefined {
  const original = decodeEntities(candidate).trim();
  let url: URL;
  try { url = new URL(original); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  let match: RegExpMatchArray | null;
  if (host === 'meet.google.com' && (match = url.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/i))) {
    return { provider: 'google', roomId: `meet:${match[1].toLowerCase()}`, url: original };
  }
  if ((host === 'zoom.us' || host.endsWith('.zoom.us')) && (match = url.pathname.match(/^\/j\/(\d+)\/?$/))) {
    return { provider: 'zoom', roomId: `zoom:${match[1]}`, url: original };
  }
  if (host === 'teams.microsoft.com' || host === 'teams.live.com') {
    if ((match = url.pathname.match(/^\/meet\/([a-z\d-]+)\/?$/i))) {
      return { provider: 'microsoft', roomId: `teams:${host === 'teams.live.com' ? 'personal' : 'work'}:${match[1]}`, url: original };
    }
    if (host === 'teams.microsoft.com' && (match = url.pathname.match(/^\/l\/meetup-join\/([^/]+)(?:\/[^/]*)?\/?$/))) {
      let thread: string;
      try { thread = decodeURIComponent(match[1]); } catch { return undefined; }
      if (/^19:meeting_.+@thread\.v2$/.test(thread)) return { provider: 'microsoft', roomId: `teams:thread:${thread}`, url: original };
    }
  }
  return undefined;
}

export function extractJoinLink(event: CalendarEvent): JoinLink | undefined {
  const candidates = (event.conferenceData?.entryPoints || [])
    .filter(entry => entry.entryPointType === 'video').flatMap(entry => entry.uri ? [entry.uri] : []);
  if (event.hangoutLink) candidates.push(event.hangoutLink);
  for (const text of [event.location, event.description]) {
    if (text) candidates.push(...(decodeEntities(text).match(/https:\/\/[^\s<>"']+/gi) || []));
  }
  for (const candidate of candidates) {
    const link = parseJoinLink(candidate);
    if (link) return link;
  }
  return undefined;
}
