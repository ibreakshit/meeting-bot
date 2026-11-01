# Calendar scheduler - design

Date: 2026-11-01
Status: draft, awaiting review

## Goal

The bot joins and records the owner's Google Meet, Zoom and Microsoft Teams meetings automatically and on time, driven by the owner's Google Calendars.

## Context and constraints

- Single user: the owner, who manages calendars across several Google accounts (personal and Google Workspace).
- Up to about 16 meetings a day, never overlapping, so one bot container processing jobs sequentially is enough.
- The bot is a single-job worker: it consumes `MeetingJoinRedisParams` jobs from the Redis list `config.redisQueueName` and only pulls a job when idle.
- The bot has no database, no scheduler and no backend on this machine; recordings go to local S3 storage.
- The dashboard is reached on the host (`http://localhost:3001`) and over Tailscale (`https://<host>.<tailnet>.ts.net` via `tailscale serve`, tailnet only).

## Decisions and rejected alternatives

- **Calendar source: Google Calendar API over OAuth, not secret iCal feeds.**
  The owner's largest work feed measured 15.3 MB and 12.3 s per fetch; polling it means downloading gigabytes a day and expanding recurrences ourselves.
  The API expands recurrences server side and returns only the events in a requested window.
- **Change detection: windowed polling every 60 s, not push notifications and not `syncToken`.**
  Push notifications carry no event data, need a public HTTPS endpoint, expire and are not guaranteed, so polling is required anyway.
  `syncToken` cannot be combined with `timeMin`/`timeMax`, so its initial full sync would expand the entire calendar history.
  A windowed `events.list` per calendar per minute is a few KB and far below quota (see Quotas).
- **Architecture: a separate `calendar-scheduler` service in this repo that feeds the existing Redis queue.**
  Rejected: running the scheduler inside the bot process (a recording crash would take scheduling down, and it mixes concerns).
  Rejected: Google Apps Script per account posting to the bot (requires exposing `/join` publicly and maintaining code outside the repo).
- **State: one JSON file, not a database.**
  The data is a handful of accounts, calendar selections, about 16 upcoming events, overrides, dispatch records and recent outcomes.
  The image runs Node 20, which has no built-in SQLite, and a native SQLite dependency is not justified at this size.
- **Final status: the scheduler receives the callbacks the bot already sends.**
  It implements the bot's status and log endpoints and its recording-completed webhook, which gives the dashboard real outcomes and recording links with no bot code changes.

## Architecture

```
 Google Calendar API (N accounts)
        ^  events.list(timeMin=now, timeMax=now+24h) every 60 s per watched calendar
        |
+-------+----------- calendar-scheduler (new compose service, same image) -------+
|  poll loop      -> per-calendar snapshots                                      |
|  tick loop      -> groups -> decisions -> planner -> LPUSH / LREM              |
|  dashboard      -> Express :3001 (Google login, schedule, overrides, accounts) |
|  status ingest  -> bot status/log callbacks + recording-completed webhook       |
|  state          -> /data/scheduler-state.json (atomic write)                   |
+-------------------------------+------------------------------------------------+
                                | MeetingJoinRedisParams (unchanged contract)
                                v
                        redis queue --> meeting-bot (no code changes)
                                          | status and log reports
                                          +--> calendar-scheduler /v2/...
```

The bot is not modified.
Redis stays ephemeral (no persistence); only the job queue lives there.

## Components

Code lives in `src/scheduler/`, started by `src/scheduler/index.ts`.
Pure modules hold the logic and have no I/O; a thin I/O layer wraps Google, Redis, the state file and HTTP.

| Module | Kind | Responsibility |
|---|---|---|
| `links` | pure | Extract the join URL from an event and normalize it to a provider and room ID |
| `decide` | pure | Apply the decision rules to an event and return join or skip with a reason |
| `group` | pure | Merge events into meeting groups (same invite, or same room with overlapping times) |
| `planner` | pure | Compare groups, dispatch records and queue state at a given time and return `push` / `remove` actions |
| `crypto` | pure | HKDF key derivation, AES-256-GCM token encryption, HMAC cookie signing |
| `google` | I/O | OAuth flows, token refresh, `calendarList.list`, `events.list` via `google-auth-library` |
| `queue` | I/O | `LPUSH`, `LPOS`, `LREM` on the existing bot queue |
| `store` | I/O | Load and atomically save the state file |
| `web` | I/O | Dashboard pages, auth routes, status ingest routes |

New dependency: `google-auth-library` (code exchange, refresh, ID token verification, authenticated requests).
Calendar calls use its `client.request()`; the much larger `googleapis` package is not needed.

## Sync

For each watched calendar, every 60 s with a few seconds of jitter, one request:

`GET calendars/{id}/events?singleEvents=true&orderBy=startTime&timeMin=<now>&timeMax=<now+24h>&fields=<trimmed>`

- `timeMin` bounds the event end time, so meetings already in progress are included.
- Google expands recurring events, and each moved or modified instance arrives as its own instance with its real time.
- Each successful response replaces that calendar's snapshot entirely; a cancelled event simply stops appearing.
- On failure the previous snapshot is kept and the calendar is marked stale with the time of its last success, so a network error never looks like a cancellation.
- On 403/429 `usageLimits` and 5xx the calendar backs off exponentially, capped at 15 minutes.
- Failures are isolated per calendar.

### Quotas

Google's limits (updated 2026-05-01): 10,000 requests per minute per project, 600 per minute per user, 1,000,000 per day per project.
At 15 calendars across 3 accounts this design uses about 15 per minute per project, about 5 per minute per user and about 21,600 per day, roughly 2 percent of the daily cap.
Normal use is free; Google has announced charges only for usage above these limits.

## Join links

The first match wins:

1. `conferenceData.entryPoints` with `entryPointType == "video"` (Meet, and the Zoom and Teams calendar add-ons).
2. `hangoutLink`.
3. A URL regex over `location` and the HTML `description` matching `meet.google.com/...`, `*.zoom.us/j/...`, `teams.microsoft.com/l/meetup-join/...` and `teams.live.com/meet/...`.

The provider (`google`, `zoom` or `microsoft`) comes from the URL host.
The original URL, including any Zoom `pwd` parameter, is what the bot receives.

Room ID normalization, used only for matching:

- Meet: the lowercase meeting code, for example `meet:abc-defg-hij`, ignoring query parameters such as `authuser`.
- Zoom: the numeric meeting ID from `/j/<id>`, for example `zoom:85512345678`, ignoring the subdomain and query.
- Teams: the decoded thread ID from a `meetup-join/19:meeting_...@thread.v2/...` path, or the meeting ID from a `teams.live.com/meet/<id>` link.

## Decision rules

Each event gets exactly one outcome with a reason; the first matching rule wins:

1. An owner override (join or skip).
2. No join link: skip, reason "no link".
3. All-day event (`start.date` without `start.dateTime`): skip, reason "all-day".
4. The owner's attendee entry (`self: true`) has `responseStatus == "declined"`: skip, reason "declined".
5. No attendees other than the owner, not counting resources: skip, reason "alone".
6. Otherwise: join.

## Grouping and dedup

- Each event occurrence has an instance key: `iCalUID` plus `originalStartTime` (or `start` for non-recurring events).
  The key is identical across the owner's calendars for the same invite and stays stable when the occurrence is rescheduled.
- Events are merged into one group when they share an instance key, or when they share a room ID and their time ranges strictly overlap.
  Back-to-back meetings in the same room (one ends at 10:30, the next starts at 10:30) are separate groups, which matters for Zoom personal meeting rooms.
- A group starts at its earliest member start and ends at its latest member end.
- A group joins if any member's decision is join.
- An override set on a group is stored on every member's instance key, so it survives reschedules and changes in group membership.
- The group's primary member is the member whose decision made the group join; among several, the earliest start wins, then the lexicographically smallest Google event ID.
- The primary member's Google event ID is sent to the bot as `eventId` (for a recurring occurrence this is the instance ID, such as `abc123_20261103T010000Z`, which keeps its original-start suffix when the occurrence is moved).
  It appears in bot logs, callbacks and the dashboard, and can be looked up with `events.get`.
- `eventId` is metadata only: the bot names recordings by `botId`, and the scheduler never matches by `eventId` (see Dispatch).

## Dispatch

The tick loop runs every 10 s: rebuild groups, run the planner, apply its actions, and save state only if something changed.

- **Push:** when the group joins, `now >= start - SCHEDULER_JOIN_LEAD_SECONDS` and `now < end`, and no dispatch record exists, `LPUSH` the job and record `{payload, pushedAt, memberInstanceKeys}` keyed by the payload's `botId`.
  A meeting that started while the scheduler was down is still dispatched if it has not ended.
- **Remove:** while the pushed payload is still in the queue (checked with `LPOS`), `LREM` it when:
  - the group moved later (it is pushed again at the new time),
  - the group no longer joins (cancelled, declined, overridden to skip),
  - the group has ended.
- **Picked up:** once the payload has left the queue without the scheduler removing it, the bot owns it and it cannot be recalled; the bot already leaves on its own when alone or inactive.
- Dispatch records are persisted, so a restart never pushes the same group twice.

Job payload (the existing `MeetingJoinRedisParams` contract):

| Field | Value |
|---|---|
| `provider` | From the join URL host |
| `url` | Original join URL |
| `name` | `SCHEDULER_BOT_NAME` |
| `timezone` | The calendar's time zone |
| `eventId` | The Google event ID of the group's primary member |
| `botId` | A new UUID per dispatch; the key for matching every callback |
| `teamId`, `userId`, `bearerToken` | `SCHEDULER_TEAM_ID`, `SCHEDULER_USER_ID`, `SCHEDULER_BEARER_TOKEN` |

## Bot status and log ingest

The bot already reports to `AUTH_BASE_URL_V2`; compose sets it to `http://calendar-scheduler:3001/v2` for the `meeting-bot` service.

- `PATCH /v2/meeting/app/bot/status` with `{eventId, botId, provider, status}`, sent once when a job ends, where `status` is the full history such as `["processing", "joined", "finished"]` or ending in `"failed"`.
- `PATCH /v2/meeting/app/bot/log` with `{eventId, botId, provider, level, message, category, subCategory}`, sent during a job for lobby, unsupported-meeting and recording events.
- Both require `Authorization: Bearer <SCHEDULER_BEARER_TOKEN>` (constant-time comparison) and return 401 otherwise; bodies are validated and malformed ones get 400.
- Both reply `{"success": true}` so the bot logs no errors.
- Reports are matched by `botId` only, through the dispatch record, so they land on the right row even if the group's membership or primary member changed after dispatch, or the same meeting was dispatched again after a reschedule (same `eventId`, new `botId`).
- Reports whose `botId` has no dispatch record are stored as unscheduled.
- The last 200 outcomes are kept in state.

The final status comes from the status callback, because it is the only callback sent for both success and failure.

The bot's recording-completed webhook adds the recording itself to the dashboard:

- Compose sets `NOTIFY_WEBHOOK_ENABLED=true`, `NOTIFY_WEBHOOK_URL=http://calendar-scheduler:3001/hooks/recording-completed` and a shared `NOTIFY_WEBHOOK_SECRET` for `meeting-bot`.
- `POST /hooks/recording-completed` receives `RecordingCompletedPayload` (`recordingId`, `meetingLink`, `blobUrl`, `metadata.botId`, `metadata.duration`, `metadata.storage`).
- The scheduler verifies `X-Webhook-Signature` (HMAC-SHA256 of the raw body with `NOTIFY_WEBHOOK_SECRET`, constant-time comparison) and returns 401 on mismatch.
- The payload is matched to its group by `metadata.botId`, and the dashboard shows the recording link and duration next to the outcome.
- The bot sends this webhook only on success; failed meetings have no webhook (they are pushed only to the Redis list `jobs:meetbot:failures`), so failures rely on the status callback.

Limit: the bot does not report a live "recording now" state, so the dashboard shows queued, picked up, any logged lobby or failure events, and the final outcome.
Limit: with the `screenapp` uploader the bot also calls upload endpoints on `AUTH_BASE_URL_V2`, which the scheduler does not implement; this setup supports the S3 uploader only.

## Dashboard

Express on port 3001, published as `127.0.0.1:3001:3001`, and exposed to the tailnet with `tailscale serve`.
Pages are server-rendered HTML with a little vanilla JavaScript; there is no frontend framework or build step.

- **Schedule** (home): one row per group for the next 24 hours, showing time, titles, calendars, platform, decision and reason, dispatch status (pending, queued, picked up, removed, then the bot's outcome), and Join, Skip and Reset buttons.
  Banners show stale calendars, accounts that need reconnecting and Redis being unreachable.
  The page refreshes itself every 30 seconds.
- **History**: groups from the past 7 days with their outcome and lobby or failure log lines.
- **Accounts**: connected Google accounts, each with its calendar list from `calendarList.list` and a checkbox per calendar, plus Connect account and Disconnect.
  New calendars start unwatched.

## Authentication

One Google OAuth "Web application" client serves two flows.

- **Login:** scopes `openid email`.
  The callback verifies the ID token and requires the email to be in `DASHBOARD_ALLOWED_EMAILS`; anyone else gets 403.
  The session is an HMAC-signed cookie (HttpOnly, SameSite=Lax, Secure on HTTPS, 7-day expiry) with no server-side session store.
- **Connect account:** scopes `openid email https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly`, with `access_type=offline` and `prompt=consent` so Google always returns a refresh token.
  The account email comes from the ID token, and the refresh token is stored encrypted.
- **Disconnect** revokes the token at Google and removes the account from state.
- Both flows carry a random `state` in a short-lived signed cookie, checked on callback.
- The redirect URI is built from the request origin only if that origin is listed in `DASHBOARD_BASE_URLS`; any other origin gets 400.
- State-changing requests are POSTs that require a custom header and a same-origin check in addition to the SameSite cookie.
- A token refresh failing with `invalid_grant` marks the account "needs reconnect" and stops polling its calendars; their last snapshots stay visible and marked stale.
- Refresh tokens are encrypted with AES-256-GCM; `SCHEDULER_SECRET` is expanded with HKDF into separate keys for encryption and cookie signing.

### One-time Google Cloud setup

Documented in `docs/operations/calendar-scheduler.md`:

1. Create a Google Cloud project and enable the Google Calendar API.
2. Configure an External OAuth consent screen and publish it to "In production", because refresh tokens of apps in "Testing" expire after 7 days; the owner sees an "unverified app" warning once per account.
3. Create a Web application client with redirect URIs `http://localhost:3001/auth/callback` and `https://<host>.<tailnet>.ts.net/auth/callback`.
4. If a Workspace account refuses to connect, its admin blocks unverified third-party apps and must allow the client ID.

## Configuration

Required (the scheduler refuses to start without them):

| Variable | Purpose |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth client |
| `SCHEDULER_SECRET` | 32 random bytes, base64; source for the encryption and cookie keys |
| `DASHBOARD_ALLOWED_EMAILS` | Comma-separated emails allowed to log in |
| `DASHBOARD_BASE_URLS` | Comma-separated allowed dashboard origins |
| `SCHEDULER_BOT_NAME` | Display name the bot joins with |
| `SCHEDULER_TEAM_ID`, `SCHEDULER_USER_ID` | Values passed through in job payloads |
| `SCHEDULER_BEARER_TOKEN` | Sent in job payloads and required on the status and log endpoints |
| `NOTIFY_WEBHOOK_SECRET` | Shared with `meeting-bot`; verifies the recording-completed webhook |

Optional:

| Variable | Default |
|---|---|
| `SCHEDULER_JOIN_LEAD_SECONDS` | `60` |
| `SCHEDULER_STATE_PATH` | `/data/scheduler-state.json` |

## Deployment

A new `calendar-scheduler` compose service:

- Same build as `meeting-bot`; command `npx ts-node src/scheduler/index.ts` in development and `node dist/scheduler/index.js` in production.
- Port `127.0.0.1:3001:3001`, a gitignored state volume mounted at `/data`, `restart: unless-stopped`, `depends_on: redis`.
- `GET /health` for the compose healthcheck.
- `meeting-bot` gets `AUTH_BASE_URL_V2=http://calendar-scheduler:3001/v2`, `NOTIFY_WEBHOOK_ENABLED=true` and `NOTIFY_WEBHOOK_URL=http://calendar-scheduler:3001/hooks/recording-completed` in its compose `environment`; both services read `NOTIFY_WEBHOOK_SECRET` from `.env`.

## Error handling

| Failure | Behavior |
|---|---|
| Calendar poll fails | Keep the last snapshot, mark the calendar stale, back off |
| `invalid_grant` on refresh | Mark the account "needs reconnect", stop polling it |
| Redis unreachable | Retry the planner's actions every tick, show a banner |
| State write fails | Log, keep state in memory, retry on the next change |
| Process crash | Compose restarts it; persisted dispatch records prevent duplicate pushes |
| Bad or unauthenticated status report or webhook | 400 or 401, nothing stored |

## Testing

- **Unit tests** with the built-in `node:test` runner through `ts-node`, so no new test framework:
  - `links`: fixtures shaped like real events (Meet `conferenceData`, Zoom and Teams add-ons, links inside HTML descriptions, Zoom URLs with `pwd` and vanity subdomains).
  - `decide`: every rule and its precedence.
  - `group`: same iCalUID across calendars, same room with overlapping times, back-to-back meetings staying separate, override survival across reschedule.
  - `planner`: push at lead time, late start after downtime, reschedule while queued, cancel while queued, ended while queued, restart idempotency.
  - `crypto`: encryption round trip and tamper detection, cookie signature rejection, webhook signature verification.
- **Integration tests** against the compose Redis: the `queue` module and the planner's actions end to end; the status and log routes with valid, missing and wrong bearer tokens; the webhook route with valid and tampered signatures.
- **End to end** with the owner's real accounts:
  1. Log in and connect each account from both `http://localhost:3001` and the Tailscale URL.
  2. Create a test event with a Meet link three minutes out and confirm the bot joins on time and the outcome, recording link and duration appear on the dashboard.
  3. Reschedule an event while its job is queued, and cancel one while queued.
  4. Put the same link in two separate invites and confirm one job.
  5. Repeat the join check with Zoom and Teams links.
  6. Check the dashboard visually with Playwright in light and dark themes and at phone width.

## Out of scope

- Push notifications (can later trigger the same sync function without design changes).
- Non-Google calendars.
- Multiple concurrent bots and overlapping meetings.
- Dashboard-editable settings; configuration stays in environment variables.
- The `screenapp` uploader together with this scheduler.
