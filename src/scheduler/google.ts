import { OAuth2Client } from 'google-auth-library';
import { TokenCrypto } from './crypto';
import type { Account, CalendarEvent, CalendarListEntry, CalendarState, OAuthIdentity, SchedulerConfig } from './types';

const calendarScopes = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];
const eventFields = 'nextPageToken,timeZone,items(id,iCalUID,status,summary,description,location,hangoutLink,updated,conferenceData(entryPoints(entryPointType,uri)),start,end,originalStartTime,attendees(email,self,resource,responseStatus),attendeesOmitted,organizer(email,self))';
type RequestFunction = (account: Account, path: string, params: Record<string, unknown>) => Promise<unknown>;

export class GooglePollError extends Error {
  constructor(public kind: 'transient' | 'access' | 'invalid_grant', message: string) { super(message); }
}

function classify(error: unknown): GooglePollError {
  if (error instanceof GooglePollError) return error;
  const response = (error as { response?: { status?: number; data?: { error?: unknown } } })?.response;
  const detail = response?.data?.error;
  const reason = typeof detail === 'object' && detail !== null ? detail as { errors?: Array<{ domain?: string; reason?: string }> } : undefined;
  if (detail === 'invalid_grant' || (error instanceof Error && /invalid_grant/.test(error.message))) {
    return new GooglePollError('invalid_grant', 'Google account needs reconnecting');
  }
  const rateLimited = reason?.errors?.some(item => item.domain === 'usageLimits' ||
    ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded'].includes(item.reason || ''));
  if ((response?.status === 403 && !rateLimited) || response?.status === 404 || response?.status === 401) {
    return new GooglePollError('access', 'Google calendar read access is unavailable');
  }
  return new GooglePollError('transient', 'Google Calendar is temporarily unavailable');
}

export class GoogleCalendar {
  private clients = new Map<string, { token: string; client: OAuth2Client; tokenWrite: Promise<void> }>();

  constructor(
    private config: Pick<SchedulerConfig, 'googleClientId' | 'googleClientSecret'>,
    private crypto: TokenCrypto,
    private requestOverride?: RequestFunction,
    private saveRefreshToken?: (accountId: string, encrypted: string) => Promise<void>,
  ) {}

  private oauth(redirectUri?: string): OAuth2Client {
    return new OAuth2Client({ clientId: this.config.googleClientId, clientSecret: this.config.googleClientSecret,
      redirectUri, transporterOptions: { timeout: 15_000 } });
  }

  authorizationUrl(flow: 'login' | 'connect', redirectUri: string, state: string): string {
    return this.oauth(redirectUri).generateAuthUrl({
      scope: flow === 'connect' ? ['openid', 'email', ...calendarScopes] : ['openid', 'email'],
      state, ...(flow === 'connect' ? { access_type: 'offline', prompt: 'consent' } : {}),
    });
  }

  async completeOAuth(code: string, redirectUri: string): Promise<OAuthIdentity> {
    const client = this.oauth(redirectUri);
    const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
    if (!tokens.id_token) throw new Error('Google did not supply a verified identity');
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.config.googleClientId });
    const identity = ticket.getPayload();
    if (!identity?.sub || !identity.email || identity.email_verified !== true) throw new Error('Google email is not verified');
    return {
      id: identity.sub, email: identity.email.trim().toLowerCase(),
      refreshToken: tokens.refresh_token || undefined, scopes: (tokens.scope || '').split(/\s+/).filter(Boolean),
    };
  }

  private clientFor(account: Account) {
    const cached = this.clients.get(account.id);
    if (cached && cached.token === account.refreshToken) return cached;
    const client = this.oauth();
    try { client.setCredentials({ refresh_token: this.crypto.decrypt(account.refreshToken) }); }
    catch { throw new GooglePollError('invalid_grant', 'Stored Google credentials cannot be read; reconnect the account'); }
    const entry = { token: account.refreshToken, client, tokenWrite: Promise.resolve() };
    const saveRefreshToken = this.saveRefreshToken;
    client.on('tokens', tokens => {
      if (tokens.refresh_token && saveRefreshToken) {
        const encrypted = this.crypto.encrypt(tokens.refresh_token);
        entry.tokenWrite = entry.tokenWrite.then(() => saveRefreshToken(account.id, encrypted));
        // Retain the failure for the awaited request path without an unhandled rejection.
        entry.tokenWrite.catch(() => undefined);
      }
    });
    this.clients.set(account.id, entry);
    return entry;
  }

  private async request(account: Account, path: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      let data: unknown;
      if (this.requestOverride) data = await this.requestOverride(account, path, params);
      else {
        const entry = this.clientFor(account);
        const response = await entry.client.request({ url: `https://www.googleapis.com/calendar/v3${path}`, method: 'GET', params, timeout: 15_000 });
        await entry.tokenWrite;
        data = response.data;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid calendar response');
      return data as Record<string, unknown>;
    } catch (error) { throw classify(error); }
  }

  private async pages(account: Account, path: string, params: Record<string, unknown>): Promise<unknown[]> {
    const items: unknown[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    do {
      const data = await this.request(account, path, { ...params, ...(pageToken ? { pageToken } : {}) });
      if (data.items !== undefined && !Array.isArray(data.items)) throw new GooglePollError('transient', 'Invalid calendar page');
      items.push(...((data.items as unknown[]) || []));
      if (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string') throw new GooglePollError('transient', 'Invalid calendar pagination');
      pageToken = data.nextPageToken as string | undefined;
      if (pageToken && seen.has(pageToken)) throw new GooglePollError('transient', 'Repeated calendar pagination token');
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    return items;
  }

  async listCalendars(account: Account): Promise<CalendarListEntry[]> {
    const items = await this.pages(account, '/users/me/calendarList', { minAccessRole: 'reader', fields: 'nextPageToken,items(id,summary,timeZone,primary)' });
    return items.map(value => {
      const item = value as Partial<CalendarListEntry>;
      if (!item || typeof item.id !== 'string' || !item.id) throw new GooglePollError('transient', 'Calendar ID missing');
      return { id: item.id, summary: typeof item.summary === 'string' ? item.summary : item.id, timeZone: item.timeZone || 'UTC', primary: item.primary === true };
    });
  }

  async pollCalendar(account: Account, calendar: CalendarState, now: number): Promise<CalendarEvent[]> {
    const events = await this.pages(account, `/calendars/${encodeURIComponent(calendar.id)}/events`, {
      singleEvents: true, orderBy: 'startTime', timeMin: new Date(now).toISOString(),
      timeMax: new Date(now + 24 * 60 * 60_000).toISOString(), fields: eventFields,
    });
    if (events.some(event => !event || typeof (event as CalendarEvent).id !== 'string')) throw new GooglePollError('transient', 'Invalid calendar event');
    return events as CalendarEvent[];
  }

  async revokeAccount(account: Account): Promise<void> {
    const entry = this.clientFor(account);
    const token = this.crypto.decrypt(account.refreshToken);
    await entry.client.revokeToken(token);
    this.clients.delete(account.id);
  }
}
