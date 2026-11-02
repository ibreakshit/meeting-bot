import express, { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createRecordingDownloadHandler, RecordingStorageClient } from './download';
import { renderAccounts, renderBotSettings, renderHistory, renderSchedule } from './views';
import { getBotSettings, isValidBotName } from './settings';
import { BotThumbnailStore, InvalidBotThumbnailError, validThumbnailId } from './thumbnails';
import { InvalidManualInviteError, ManualInvitation } from './runtime';
import type { Account, BotLogReport, CalendarListEntry, DispatchRecord, OAuthIdentity, RecordingPayload, RuntimeView, SchedulerConfig, SchedulerState, StatusReport } from './types';

interface CookieCrypto {
  encrypt(plain: string): string;
  decrypt(encrypted: string): string;
  signCookie(payload: Record<string, unknown>, ttlSeconds: number): string;
  verifyCookie<T>(signed: string): T | null;
}
export interface SchedulerWebDependencies {
  config: SchedulerConfig;
  store: { read(): SchedulerState; update(mutator: (state: SchedulerState) => void | Promise<void>): Promise<void> };
  ledger: { listDispatches(): Promise<DispatchRecord[]>; history(): Promise<DispatchRecord[]>; diagnostics?(): Promise<Array<{ kind: string }>>; addAttempt(report: StatusReport): Promise<unknown>; addLog(report: BotLogReport): Promise<unknown>; addRecording(payload: RecordingPayload): Promise<unknown> };
  google: { authorizationUrl(flow: 'login' | 'connect', redirectUri: string, state: string): string; completeOAuth(code: string, redirectUri: string): Promise<OAuthIdentity>; listCalendars(account: Account): Promise<CalendarListEntry[]>; revokeAccount(account: Account): Promise<void> };
  crypto: CookieCrypto;
  runtime: { view(): RuntimeView; tick(): Promise<void>; invite(request: ManualInvitation): Promise<DispatchRecord> };
  s3?: RecordingStorageClient;
  thumbnails?: Pick<BotThumbnailStore, 'save' | 'read'>;
}
interface Session { email: string }
interface OAuthState { nonce: string; flow: 'login' | 'connect'; origin: string; owner?: string }
const calendarScopes = ['https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
const normalizeEmail = (value: string) => value.trim().toLowerCase();
function constantEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function cookies(req: Request): Record<string, string> {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim()).filter(Boolean).map(part => { const index = part.indexOf('='); return [part.slice(0, index), part.slice(index + 1)]; }));
}
function text(value: unknown, max = 1024): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validProvider(value: unknown): boolean { return ['google', 'zoom', 'microsoft'].includes(value as string); }
function validStatus(body: unknown): body is StatusReport {
  return record(body) && text(body.botId, 256) && validProvider(body.provider) && (body.eventId === undefined || text(body.eventId)) && Array.isArray(body.status) && body.status.length > 0 && body.status.length <= 100 && body.status.every((status: unknown) => ['processing', 'joined', 'finished', 'failed'].includes(status as string));
}
function validLog(body: unknown): body is BotLogReport {
  return record(body) && text(body.botId, 256) && validProvider(body.provider) && (body.eventId === undefined || text(body.eventId)) && typeof body.level === 'string' && ['info', 'error'].includes(body.level) && text(body.message, 16384) && text(body.category, 256) && text(body.subCategory, 256);
}
function validRecording(body: unknown): body is RecordingPayload {
  return record(body) && text(body.recordingId, 256) && body.status === 'completed' && text(body.timestamp) && Number.isFinite(Date.parse(body.timestamp)) && record(body.metadata) && text(body.metadata.botId, 256) && (body.metadata.duration === undefined || typeof body.metadata.duration === 'number' && Number.isFinite(body.metadata.duration) && body.metadata.duration >= 0) && (body.blobUrl === undefined || text(body.blobUrl, 8192)) && (body.meetingLink === undefined || text(body.meetingLink, 8192));
}
const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => { Promise.resolve(handler(req, res)).catch(next); };

export function createSchedulerApp(deps: SchedulerWebDependencies) {
  const { config, store, ledger, crypto, google, runtime } = deps;
  const thumbnails = deps.thumbnails || new BotThumbnailStore(join(dirname(config.statePath), 'bot-thumbnails'));
  const app = express();
  const dashboard = express.Router();
  const basePath = config.basePath || '';
  const dashboardPath = (path: string) => `${basePath}${path}`;
  // Distinct names prevent legacy root cookies from authenticating or shadowing a mounted dashboard.
  const cookieSuffix = basePath ? `_${Buffer.from(basePath).toString('base64url')}` : '';
  const sessionCookieName = `scheduler_session${cookieSuffix}`;
  const oauthCookieName = `scheduler_oauth${cookieSuffix}`;
  app.disable('x-powered-by');
  const allowed = new Set(config.allowedEmails.map(normalizeEmail));
  // Resolve only a configured origin with the exact request Host. Forwarded headers cannot select a callback destination.
  const origin = (req: Request): string | undefined => {
    const matches = config.baseUrls.filter(base => new URL(base).host === req.get('Host'));
    return matches.length === 1 ? new URL(matches[0]).origin : undefined;
  };
  const session = (req: Request): Session | null => {
    const value = crypto.verifyCookie<Session>(cookies(req)[sessionCookieName] || '');
    return value && typeof value.email === 'string' ? { email: normalizeEmail(value.email) } : null;
  };
  const guard: RequestHandler = (req, res, next) => {
    const owner = session(req);
    if (!owner) { res.status(401).type('html').send(`<!doctype html><html lang="en"><title>Sign in</title><main><h1>Meeting scheduler</h1><p>Sign in with your allowed owner account.</p><a href="${dashboardPath('/auth/login')}">Sign in with Google</a></main></html>`); return; }
    if (!allowed.has(owner.email)) { res.status(403).send('Owner access required'); return; }
    if (!origin(req)) { res.status(400).send('Unknown dashboard origin'); return; }
    next();
  };
  const postGuard: RequestHandler = (req, res, next) => {
    if (!req.get('X-Scheduler-Request') || !origin(req) || req.get('Origin') !== origin(req)) { res.status(403).send('Same-origin scheduler request required'); return; }
    next();
  };
  const setCookie = (res: Response, name: string, value: string, base: string, seconds: number) => res.cookie(name, value, { httpOnly: true, sameSite: 'lax', secure: base.startsWith('https:'), maxAge: seconds * 1000, path: basePath || '/' });
  const clearCookie = (res: Response, name: string, base: string) => res.clearCookie(name, { httpOnly: true, sameSite: 'lax', secure: base.startsWith('https:'), path: basePath || '/' });
  const bearer: RequestHandler = (req, res, next) => { if (!constantEqual(req.get('Authorization'), `Bearer ${config.bearerToken}`)) { res.status(401).json({ error: 'Unauthorized' }); return; } next(); };
  app.use((_req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'private, no-store' }); next(); });
  app.get('/health', (_req, res) => res.status(runtime.view().ready ? 200 : 503).json({ ready: runtime.view().ready }));
  const serveThumbnail = asyncRoute(async (req, res) => {
    if (!validThumbnailId(req.params.thumbnailId)) return res.status(404).send('Image not found');
    const image = await thumbnails.read(req.params.thumbnailId);
    if (!image) return res.status(404).send('Image not found');
    res.type('png').send(image);
  });
  app.get('/v2/meeting/app/bot/thumbnail/:thumbnailId', bearer, serveThumbnail);
  app.patch('/v2/meeting/app/bot/status', bearer, express.json({ limit: '64kb' }), asyncRoute(async (req, res) => { if (!validStatus(req.body)) return res.status(400).json({ error: 'Invalid status report' }); await ledger.addAttempt(req.body); res.json({ success: true }); }));
  app.patch('/v2/meeting/app/bot/log', bearer, express.json({ limit: '64kb' }), asyncRoute(async (req, res) => { if (!validLog(req.body)) return res.status(400).json({ error: 'Invalid log report' }); await ledger.addLog(req.body); res.json({ success: true }); }));
  app.post('/hooks/recording-completed', express.raw({ type: 'application/json', limit: '256kb' }), asyncRoute(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !constantEqual(req.get('X-Webhook-Signature'), createHmac('sha256', config.webhookSecret).update(req.body).digest('hex'))) return res.status(401).json({ error: 'Unauthorized' });
    let body; try { body = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid recording report' }); }
    if (!validRecording(body)) return res.status(400).json({ error: 'Invalid recording report' });
    await ledger.addRecording(body); res.json({ success: true });
  }));
  dashboard.get('/auth/login', (req, res) => {
    const base = origin(req); if (!base) return res.status(400).send('Unknown dashboard origin');
    const state: OAuthState = { nonce: randomBytes(32).toString('base64url'), flow: 'login', origin: base };
    setCookie(res, oauthCookieName, crypto.signCookie({ ...state }, 600), base, 600);
    res.redirect(google.authorizationUrl('login', `${base}${dashboardPath('/auth/callback')}`, state.nonce));
  });
  dashboard.post('/auth/connect', guard, postGuard, (req, res) => {
    const base = origin(req), owner = session(req);
    if (!base || !owner) return res.status(401).send('Owner session required');
    const state: OAuthState = { nonce: randomBytes(32).toString('base64url'), flow: 'connect', origin: base, owner: owner.email };
    setCookie(res, oauthCookieName, crypto.signCookie({ ...state }, 600), base, 600);
    res.json({ url: google.authorizationUrl('connect', `${base}${dashboardPath('/auth/callback')}`, state.nonce) });
  });
  dashboard.get('/auth/callback', asyncRoute(async (req, res) => {
    const base = origin(req), state = crypto.verifyCookie<OAuthState>(cookies(req)[oauthCookieName] || '');
    if (!base || !state || state.origin !== base || !['login', 'connect'].includes(state.flow) || typeof req.query.state !== 'string' || !constantEqual(req.query.state, state.nonce) || typeof req.query.code !== 'string' || !text(req.query.code, 8192)) return res.status(400).send('Invalid OAuth callback');
    clearCookie(res, oauthCookieName, base);
    if (state.flow === 'connect') {
      const owner = session(req);
      if (!owner) return res.status(401).send('Owner session required');
      if (!allowed.has(owner.email) || state.owner !== owner.email) return res.status(403).send('Initiating owner session required');
    }
    const identity = await google.completeOAuth(req.query.code, `${base}${dashboardPath('/auth/callback')}`);
    if (!text(identity.email) || !text(identity.id)) return res.status(403).send('Verified Google identity required');
    if (state.flow === 'login') {
      const email = normalizeEmail(identity.email);
      if (!allowed.has(email)) return res.status(403).send('Owner access required');
      setCookie(res, sessionCookieName, crypto.signCookie({ email }, 7 * 86400), base, 7 * 86400);
      res.redirect(dashboardPath('/')); return;
    }
    if (!calendarScopes.every(scope => identity.scopes.includes(scope))) return res.status(400).send('Required calendar access was not granted');
    const existing = store.read().accounts.find(account => account.id === identity.id);
    const refreshToken = identity.refreshToken ? crypto.encrypt(identity.refreshToken) : existing?.refreshToken;
    if (!refreshToken) return res.status(400).send('Reconnect incomplete: grant offline access');
    try { crypto.decrypt(refreshToken); } catch { return res.status(400).send('Reconnect incomplete: grant offline access'); }
    const account: Account = { id: identity.id, email: normalizeEmail(identity.email), refreshToken, connectedAt: existing?.connectedAt || new Date().toISOString(), needsReconnect: false };
    const calendars = await google.listCalendars(account);
    await store.update(state => {
      state.accounts = state.accounts.filter(item => item.id !== account.id).concat(account);
      const previous = state.calendars.filter(calendar => calendar.accountId === account.id);
      state.calendars = state.calendars.filter(calendar => calendar.accountId !== account.id).concat(calendars.map(calendar => { const prior = previous.find(old => old.id === calendar.id); return { ...calendar, accountId: account.id, watched: prior?.watched ?? false, events: prior?.events ?? [], verified: false, selectionRevision: (prior?.selectionRevision || 0) + 1 }; }));
    });
    await runtime.tick(); res.redirect(dashboardPath('/accounts'));
  }));
  dashboard.get('/', guard, asyncRoute(async (_req, res) => res.type('html').send(renderSchedule(store.read(), runtime.view(), await ledger.listDispatches(), config))));
  dashboard.get('/history', guard, asyncRoute(async (_req, res) => res.type('html').send(renderHistory(await ledger.history(), config, await ledger.diagnostics?.() || []))));
  dashboard.get('/accounts', guard, (_req, res) => res.type('html').send(renderAccounts(store.read(), basePath)));
  dashboard.get('/bot-settings', guard, (_req, res) => res.type('html').send(renderBotSettings(getBotSettings(store.read(), config.botName), basePath)));
  dashboard.get('/bot-settings/thumbnail/:thumbnailId', guard, serveThumbnail);
  dashboard.post('/invitations', guard, postGuard, express.json({ limit: '16kb' }), asyncRoute(async (req, res) => {
    const body: unknown = req.body;
    if (!record(body) || typeof body.url !== 'string' || typeof body.requestId !== 'string' || typeof body.timezone !== 'string') {
      return res.status(400).json({ error: 'Enter a supported meeting URL.' });
    }
    try {
      const job = await runtime.invite({ url: body.url, requestId: body.requestId, timezone: body.timezone });
      res.json({ success: true, botId: job.botId, state: job.state, alreadyInvited: job.botId !== `manual-${body.requestId.toLowerCase()}` });
    } catch (error) {
      if (error instanceof InvalidManualInviteError) return res.status(400).json({ error: error.message });
      throw error;
    }
  }));
  dashboard.post('/bot-settings', guard, postGuard, express.json({ limit: '3mb' }), asyncRoute(async (req, res) => {
    const body: unknown = req.body;
    if (!record(body) || typeof body.name !== 'string' || !isValidBotName(body.name.trim()) || /[\u0000-\u001f\u007f-\u009f]/.test(body.name) || (body.thumbnailDataUrl !== undefined && typeof body.thumbnailDataUrl !== 'string') || (body.removeThumbnail !== undefined && typeof body.removeThumbnail !== 'boolean') || (body.removeThumbnail === true && body.thumbnailDataUrl !== undefined)) return res.status(400).json({ error: 'Enter a bot name up to 100 characters and choose one image action.' });
    const name = body.name.trim();
    let uploadedId: string | undefined;
    if (body.thumbnailDataUrl !== undefined) {
      try { uploadedId = await thumbnails.save(body.thumbnailDataUrl as string); }
      catch (error) {
        if (error instanceof InvalidBotThumbnailError) return res.status(400).json({ error: error.message });
        throw error;
      }
    }
    await store.update(state => {
      const previous = getBotSettings(state, config.botName);
      const thumbnailId = body.removeThumbnail === true ? undefined : uploadedId || previous.thumbnailId;
      state.botSettings = { name, ...(thumbnailId ? { thumbnailId } : {}) };
    });
    await runtime.tick();
    res.json({ success: true });
  }));
  dashboard.get('/recordings/:botId/download', guard, createRecordingDownloadHandler({ config, s3: deps.s3, getRecording: async botId => (await ledger.listDispatches()).find(record => record.botId === botId)?.recording }));
  dashboard.post('/auth/logout', guard, postGuard, (req, res) => { const base = origin(req); if (!base) return res.status(400).send('Unknown dashboard origin'); clearCookie(res, sessionCookieName, base); res.json({ success: true }); });
  dashboard.post('/groups/:id/override', guard, postGuard, express.json({ limit: '16kb' }), asyncRoute(async (req, res) => {
    if (!['join', 'skip', 'automatic'].includes(req.body?.mode)) return res.status(400).json({ error: 'Invalid override' });
    const group = runtime.view().groups.find(group => group.id === req.params.id);
    if (!group) return res.status(404).json({ error: 'Meeting no longer available' });
    await store.update(state => { const revision = ++state.overrideRevision; for (const key of group.memberKeys) state.overrides[key] = { mode: req.body.mode, revision }; });
    await runtime.tick(); res.json({ success: true });
  }));
  dashboard.post('/calendars/watch', guard, postGuard, express.json({ limit: '16kb' }), asyncRoute(async (req, res) => {
    if (!text(req.body?.accountId) || !text(req.body?.calendarId) || typeof req.body.watched !== 'boolean') return res.status(400).json({ error: 'Invalid calendar selection' });
    let found = false;
    await store.update(state => { const calendar = state.calendars.find(calendar => calendar.accountId === req.body.accountId && calendar.id === req.body.calendarId); if (calendar) { found = true; if (calendar.watched !== req.body.watched) { calendar.watched = req.body.watched; calendar.verified = false; calendar.selectionRevision = (calendar.selectionRevision || 0) + 1; } } });
    if (!found) return res.status(404).json({ error: 'Calendar not found' });
    await runtime.tick(); res.json({ success: true });
  }));
  dashboard.post('/accounts/:id/disconnect', guard, postGuard, asyncRoute(async (req, res) => {
    const account = store.read().accounts.find(account => account.id === req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    // Disable the source durably even if revocation is temporarily unavailable.
    await store.update(state => { const stored = state.accounts.find(item => item.id === account.id); if (stored) stored.needsReconnect = true; state.calendars.filter(calendar => calendar.accountId === account.id).forEach(calendar => { calendar.verified = false; calendar.unauthorized = true; calendar.selectionRevision = (calendar.selectionRevision || 0) + 1; }); });
    await runtime.tick();
    await google.revokeAccount(account);
    await store.update(state => { state.accounts = state.accounts.filter(item => item.id !== account.id); state.calendars = state.calendars.filter(calendar => calendar.accountId !== account.id); });
    await runtime.tick(); res.json({ success: true });
  }));
  app.use(basePath || '/', dashboard);
  const errors: ErrorRequestHandler = (error, _req, res, next) => {
    // Express identifies error middleware by its four-argument function signature.
    void next;
    if (res.headersSent) { res.destroy(); return; }
    res.status(error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large' ? 400 : 503).json({ error: error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large' ? 'Invalid request body' : 'Scheduler temporarily unavailable' });
  };
  app.use(errors);
  return app;
}
