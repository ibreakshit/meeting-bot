import type { MeetingJoinRedisParams } from '../app/common';

export type Provider = 'google' | 'zoom' | 'microsoft';
export type JobPayload = MeetingJoinRedisParams;
export type EventTime = { date?: string; dateTime?: string; timeZone?: string };
export type Attendee = { email?: string; self?: boolean; resource?: boolean; responseStatus?: string };

export interface CalendarEvent {
  id: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  hangoutLink?: string;
  updated?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  start?: EventTime;
  end?: EventTime;
  originalStartTime?: EventTime;
  attendees?: Attendee[];
  attendeesOmitted?: boolean;
  organizer?: { email?: string; self?: boolean };
}

export interface Account {
  id: string;
  email: string;
  refreshToken: string;
  connectedAt: string;
  needsReconnect: boolean;
}

export interface CalendarState {
  accountId: string;
  id: string;
  summary: string;
  timeZone: string;
  primary?: boolean;
  watched: boolean;
  events: CalendarEvent[];
  lastSuccess?: number;
  lastAttempt?: number;
  lastError?: string;
  lastAttemptSucceeded?: boolean;
  verified?: boolean;
  unauthorized?: boolean;
  selectionRevision?: number;
}

export interface OverrideAction {
  mode: 'join' | 'skip' | 'automatic';
  revision: number;
}

export interface BotSettings {
  name: string;
  thumbnailId?: string;
}

export interface SchedulerState {
  version: 1;
  accounts: Account[];
  calendars: CalendarState[];
  overrides: Record<string, OverrideAction>;
  overrideRevision: number;
  botSettings?: BotSettings;
}

export interface JoinLink {
  provider: Provider;
  url: string;
  roomId: string;
}

export interface EventMember {
  key: string;
  calendarKey: string;
  accountId: string;
  calendarId: string;
  calendarSummary: string;
  timeZone: string;
  event: CalendarEvent;
  start: number;
  end: number;
  link?: JoinLink;
  eligible: boolean;
  sourceStatus: 'current' | 'grace' | 'unavailable';
  decision: { join: boolean; reason: string };
}

export interface MeetingGroup {
  id: string;
  memberKeys: string[];
  members: EventMember[];
  start: number;
  end: number;
  primary?: EventMember;
  join: boolean;
  reason: string;
  override?: OverrideAction;
}

export interface WorkerRegistration {
  id: string;
  baseUrl: string;
  processingQueue: string;
}

export interface WorkerObservation {
  id: string;
  reachable: boolean;
  busy?: boolean;
  observedAt: number;
  lastSuccess?: number;
  uptime?: number;
  startedAt?: number;
  error?: string;
}

export interface StatusReport {
  botId: string;
  eventId?: string;
  provider: Provider;
  status: Array<'processing' | 'joined' | 'finished' | 'failed'>;
}

export interface BotLogReport {
  botId: string;
  eventId?: string;
  provider: Provider;
  level: 'info' | 'error';
  message: string;
  category: string;
  subCategory: string;
}

export interface RecordingPayload {
  recordingId: string;
  status: string;
  timestamp: string;
  meetingLink?: string;
  blobUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface StoredRecording {
  acceptedAt?: number;
  botId: string;
  recordingId: string;
  timestamp: string;
  contentType?: string;
  duration?: number;
  storage?: {
    provider: string;
    bucket?: string;
    key?: string;
  };
  locationConflict?: boolean;
}

export interface Outcome {
  status: 'completed' | 'failed' | 'unknown';
  timestamp: string;
  error?: { type?: string; message: string };
  conflict?: boolean;
}

export interface DispatchRecord {
  botId: string;
  source?: 'manual';
  roomId?: string;
  payload: JobPayload;
  serializedPayload: string;
  memberInstanceKeys: string[];
  pushedAt: number;
  scheduledStart: number;
  scheduledEnd: number;
  state: 'queued' | 'picked_up' | 'removed' | 'unknown' | 'completed' | 'failed';
  removedBeforePickup?: boolean;
  reason?: string;
  workerId?: string;
  firstObservedAt?: number;
  calendarChangedAt?: number;
  changedFields?: string[];
  replacesBotId?: string;
  outcome?: Outcome;
  recording?: StoredRecording;
  attempts?: Array<StatusReport & { receivedAt: number }>;
  logs?: Array<BotLogReport & { receivedAt: number }>;
}

export type DispatchObservation = Partial<Pick<DispatchRecord,
  'state' | 'reason' | 'workerId' | 'firstObservedAt' | 'calendarChangedAt' | 'changedFields'
>>;

export type PlannerAction =
  | { type: 'enqueue'; group: MeetingGroup }
  | { type: 'remove'; dispatch: DispatchRecord; reason: string }
  | { type: 'replace'; dispatch: DispatchRecord; group: MeetingGroup }
  | { type: 'replace-manual'; dispatch: DispatchRecord }
  | { type: 'annotate'; dispatch: DispatchRecord; changedFields: string[]; group?: MeetingGroup };

export interface SchedulerConfig {
  transcriptionEnabled?: boolean;
  port: number;
  googleClientId: string;
  googleClientSecret: string;
  secret: Buffer;
  allowedEmails: string[];
  baseUrls: string[];
  basePath?: string;
  ownerAliases: string[];
  botName: string;
  teamId: string;
  userId: string;
  bearerToken: string;
  webhookSecret: string;
  joinLeadSeconds: number;
  maxSnapshotAgeSeconds: number;
  statePath: string;
  redisUrl: string;
  queueName: string;
  resultList: string;
  failureList: string;
  workers: WorkerRegistration[];
  s3: {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
}

export interface OAuthIdentity {
  id: string;
  email: string;
  refreshToken?: string;
  scopes: string[];
}

export interface CalendarListEntry {
  id: string;
  summary: string;
  timeZone: string;
  primary?: boolean;
}

export interface RuntimeView {
  ready: boolean;
  workers: WorkerObservation[];
  groups: MeetingGroup[];
  queueDepth: number;
  ingestionPending: boolean;
  lastError?: string;
}

export function calendarKey(calendar: Pick<CalendarState, 'accountId' | 'id'>): string {
  return JSON.stringify([calendar.accountId, calendar.id]);
}

export function emptyState(): SchedulerState {
  return { version: 1, accounts: [], calendars: [], overrides: {}, overrideRevision: 0 };
}
