# Calendar scheduler - design

Date: 2026-11-01
Status: implemented; automated verification, independent review and isolated two-worker startup complete; real-account acceptance pending

## Goal

The bot joins and records the owner's Google Meet, Zoom and Microsoft Teams meetings automatically, driven by the owner's Google Calendars. Two isolated workers are available by default, with more configurable when needed. Due jobs start as workers become available; excess jobs wait in a shared queue.

## Context and constraints

- Single user: the owner, who manages calendars across several Google accounts (personal and Google Workspace).
- About 16 meetings a day. The worker pool supports concurrent recordings, back-to-back meetings and overlap caused by recording overruns, retries, uploads or cleanup. Two workers are the default; capacity can be increased through deployment configuration.
- Each bot container is a single-job worker: it consumes `MeetingJoinRedisParams` jobs from the shared Redis list `config.redisQueueName` and only pulls a job when idle. All workers share this pending queue and the result lists, but each has a unique processing list and isolated browser, audio and recording storage.
- The bot has no database, no scheduler and no backend on this machine; recordings go to local S3 storage.
- The dashboard is reached on the host (`http://localhost:3001`) and over Tailscale (`https://<host>.<tailnet>.ts.net` via `tailscale serve`, tailnet only).

## Decisions and rejected alternatives

- **Calendar source: Google Calendar API over OAuth, not secret iCal feeds.**
  The owner's largest work feed measured 15.3 MB and 12.3 s per fetch; polling it means downloading gigabytes a day and expanding recurrences ourselves.
  The API expands recurrences server side and returns only the events in a requested window.
- **Change detection: windowed polling every 60 s, not push notifications and not `syncToken`.**
  Push notifications carry no event data, need a public HTTPS endpoint, expire and are not guaranteed, so polling is required anyway.
  `syncToken` cannot be combined with `timeMin`/`timeMax`; windowed polling directly supports the rolling 24-hour view without maintaining a separate calendar mirror.
  A windowed `events.list` poll per calendar per minute is small and far below quota (see Quotas); a poll follows pagination when needed.
- **Freshness: tolerate temporary polling failures for up to five minutes.**
  A previously verified snapshot may support automatic joining while its last complete poll is less than 300 seconds old. After that, exclude it from scheduling and withdraw pending jobs with no other eligible calendar support. Known loss of access disables the source immediately. Require a successful poll after scheduler startup or account reconnect before using persisted snapshots to join; picked-up executions continue unchanged.
- **Owner identity: connected-account emails plus explicitly configured aliases.**
  Match the owner across personal, Workspace and shared-calendar event copies by those email addresses, not by `attendees[].self`. An accepted invite on one owner account remains joinable when another owner account declined it. An explicit group Skip takes precedence over RSVP-based joining.
- **Architecture: a separate `calendar-scheduler` service in this repo that feeds the existing Redis queue.**
  Rejected: running the scheduler inside the bot process (a recording crash would take scheduling down, and it mixes concerns).
  Rejected: Google Apps Script per account posting to the bot (requires exposing `/join` publicly and maintaining code outside the repo).
- **State: a JSON file for account/calendar state, persistent Redis for execution state.**
  `/data/scheduler-state.json` stores connected accounts, calendar selections, snapshots and overrides. Redis is authoritative for dispatch records, deduplication indexes, attempt reports, recent outcomes and recording metadata, alongside the existing pending, processing and result lists. Execution state is not duplicated into JSON.
  Redis uses AOF persistence on its existing named volume, with `appendfsync always`. Enqueueing a job and creating its dispatch record and member-instance indexes happen in one Lua script. No additional database or native dependency is needed.
- **Outcomes: use the worker's existing Redis results; HTTP reports supplement them.**
  Recording-completed results establish successful upload, and permanent-failure results establish exhausted or non-retryable execution failure. Persist each result before removing it from its source list. Status/log callbacks retain attempt history and the recording webhook supplies metadata; neither replaces the Redis result as the authoritative outcome. Missing results remain unknown rather than inferred success or failure.
- **Recording access: authenticated streaming through the dashboard.**
  Keep S3 private and give the browser dashboard download URLs. The scheduler reads recordings with its server-side S3 credentials and streams bytes with backpressure, including range/resume support. Do not expose direct or presigned S3 URLs. Measure proxy throughput and time to first byte with a representative recording rather than assuming the overhead is negligible.
- **Worker recovery: keep the worker unchanged and use its existing signals conservatively.**
  Observe its health/busy endpoints, queue membership and existing notifications. Missing reports, an unreachable worker or evidence of a restart do not automatically trigger another join. Keep ambiguous executions marked `unknown` for owner investigation; add richer worker reporting only if these signals prove insufficient.
- **Calendar edits: replace pending jobs; flag changes after pickup.**
  A changed join URL, provider or schedule replaces the job only while its exact payload is still pending. Once the worker has picked it up, preserve that execution and show the calendar change without starting another bot.
- **Capacity: two isolated worker/Chrome pairs by default, expandable through Compose configuration.**
  Idle workers compete for the same FIFO pending queue. When every worker is occupied, additional due jobs remain queued until capacity becomes available. Keep one job per worker and use the worker's existing configurable processing-list name to identify which worker claimed a job; no worker code changes or scheduler-side job assignment are required.

## Architecture

```
 Google Calendar API (N accounts)
        ^  events.list(timeMin=now, timeMax=now+24h) every 60 s per watched calendar
        |
+-------+----------- calendar-scheduler (new compose service, same image) -------+
|  poll loop      -> per-calendar snapshots                                      |
|  tick loop      -> groups -> decisions -> planner -> RPUSH / LREM              |
|  dashboard      -> Express :3001 (Google login, schedule, overrides, accounts) |
|  status ingest  -> bot status/log callbacks + recording-completed webhook       |
|  result ingest  -> Redis completion/failure lists -> durable outcomes          |
|  state          -> JSON: accounts/calendars; Redis: dispatches/outcomes        |
+-------------------------------+------------------------------------------------+
                                | MeetingJoinRedisParams (unchanged contract)
                                v
                     shared Redis pending queue
                         |                 |
                         v                 v
                   meeting-bot-1     meeting-bot-2      ... additional workers
                   chrome-cdp-1      chrome-cdp-2
                   processing:1      processing:2
                         |                 |
                         +--------+--------+
                                  v
                   shared results + scheduler callbacks
```

The bot remains unmodified for the initial scheduler. Redis is persistent storage for the queue and execution state, rather than a disposable cache.
Each worker uses the shared pending list and its own processing list, plus shared recording-completed and failure result lists. Recovery uses those existing signals and preserves uncertainty instead of assuming an execution stopped.

## Components

Code lives in `src/scheduler/`, started by `src/scheduler/index.ts`.
Pure modules hold the logic and have no I/O; a thin I/O layer wraps Google, Redis, the state file and HTTP.

| Module | Kind | Responsibility |
|---|---|---|
| `links` | pure | Extract the join URL from an event and normalize it to a provider and room ID |
| `decide` | pure | Apply the decision rules to an event and return join or skip with a reason |
| `group` | pure | Merge events into meeting groups (same invite, or same room with overlapping times) |
| `planner` | pure | Compare groups, dispatch records and queue state at a given time and return `push` / `remove` / `replace` actions; claimed and uncertain executions remain ineligible for automatic redispatch |
| `crypto` | pure | HKDF key derivation, AES-256-GCM token encryption, HMAC cookie signing |
| `google` | I/O | OAuth flows, token refresh, `calendarList.list`, `events.list` via `google-auth-library` |
| `queue` | I/O | Atomic Redis enqueue/deduplication, queue/dispatch transitions and result-list ingestion; observe pending and processing membership without automatically reclaiming processing jobs |
| `store` | I/O | Load and atomically save account/calendar state in JSON; persist and read execution state in Redis |
| `web` | I/O | Dashboard pages, auth routes, status ingest routes and authenticated S3 streaming downloads |

New dependency: `google-auth-library` (code exchange, refresh, ID token verification, authenticated requests).
Calendar calls use its `client.request()`; the much larger `googleapis` package is not needed.
Recording reads use the existing `@aws-sdk/client-s3` dependency and Node streams; no new download framework or storage-provider abstraction is needed.

## Sync

For each watched calendar, every 60 s with a few seconds of jitter, start a poll:

`GET calendars/{id}/events?singleEvents=true&orderBy=startTime&timeMin=<now>&timeMax=<now+24h>&fields=<trimmed>`

- `timeMin` bounds the event end time, so meetings already in progress are included.
- Google expands recurring events, and each moved or modified instance arrives as its own instance with its real time.
- Follow `nextPageToken` until absent, keeping the same time bounds and other query parameters on every page. Include `nextPageToken`, `timeZone` and all event fields used below in the trimmed field mask. A page may be incomplete even when it contains fewer events than the requested page size.
- Only a complete successful poll replaces that calendar's snapshot entirely; a cancelled event simply stops appearing.
- If any page fails, discard the partial result, keep the previous snapshot and mark the calendar stale with the time of its last complete success, so a network error never looks like a cancellation.
- On 403/429 `usageLimits` and 5xx the calendar backs off exponentially, capped at 15 minutes.
- Failures are isolated per calendar.

### Snapshot freshness and source eligibility

- Store each calendar's last complete poll time, last attempt/error and whether its latest completed attempt succeeded. Only a fully successful paginated poll advances the success time. A partial response, token refresh alone, calendar-list request or retry attempt cannot renew the snapshot's eligibility. No snapshot at or beyond the age cutoff can support joining, including when a new poll is still in progress rather than explicitly failed.
- For temporary network, rate-limit and server failures, keep using an already verified snapshot only while `now - lastCompleteSuccess < SCHEDULER_MAX_SNAPSHOT_AGE_SECONDS` (default 300). Show the polling error and remaining grace period. At the cutoff, retain the snapshot for display but mark it expired for scheduling; continued backoff does not extend the grace period.
- `invalid_grant`, confirmed loss of calendar read access, account disconnect or unwatching a calendar disables that source immediately, even if its last successful poll was recent. Do not apply the temporary-failure grace period to a known authorization or selection change. Other calendars and accounts continue independently.
- On scheduler startup, persisted snapshots are for display only until that calendar completes a successful poll in the current run. New watches and reconnected accounts also require a new successful poll before they can support a join. Load and reconcile the Redis ledger, withdraw unsupported pending jobs, and then permit normal scheduling as individual calendars become ready; one unavailable calendar must not block those that have refreshed successfully.
- Evaluate source eligibility before event decision rules and owner overrides, and recheck it before applying an enqueue or replacement action. A Join override cannot make an expired, unverified, unwatched or unauthorized source eligible. Preserve overrides while a source is unavailable so they apply again after a successful refresh.
- Keep all cached copies visible with their source status, but exclude ineligible copies from operational grouping, join decisions, primary-member/link selection and scheduled start/end bounds. When copies with the same instance key exist on both a calendar whose latest completed attempt succeeded and one using the temporary-failure grace period, use the current copies for scheduling and decisions; the grace-period copy must not retain an old link/time or override a current skip decision. Use a grace-period copy only when no current eligible copy of that instance is available.
- A group remains joinable if another eligible calendar copy independently supports joining it. Recompute its scheduling inputs from those copies and replace any outdated pending payload under the normal queued-edit rules. An expired source cannot extend the group's time bounds, bridge two operational groups by room overlap, or supply the old URL when eligible copies specify a different one.
- At each tick, withdraw a pending job when none of its current group members can support joining under this policy. Persist removal with reason `calendar unavailable` and `removedBeforePickup: true` only after removing its exact pending payload successfully. A successful refresh may make the meeting eligible for a new dispatch if it is still due and not ended. A claimed, failed, completed or unknown dispatch remains protected against automatic rejoin.
- Withdrawal is best effort with the unchanged worker, just like removing an expired meeting: a worker can win pickup before the scheduler removes a job. Keep that execution, flag that its calendar source became unavailable and do not recall or replace it. Normal Compose startup waits for scheduler bootstrap reconciliation before starting workers; restarting the scheduler alone does not pause workers already running, so it cannot guarantee withdrawal before every concurrent pickup.
- A successful refresh replaces the old snapshot, clears the transient error and restores source eligibility. An event absent from that complete fresh response no longer supports joining; this is different from a failed or partial poll, which leaves the last snapshot intact but does not renew it.

### Quotas

Google's limits (updated 2026-05-01): 10,000 requests per minute per project, 600 per minute per user, 1,000,000 per day per project.
At 15 calendars across 3 accounts, assuming one page per poll, this design uses about 15 per minute per project, about 5 per minute per user and about 21,600 per day, roughly 2 percent of the daily threshold. Additional pages, retries and calendar-list requests add to that usage.
Normal use is free; Google has announced charges only for usage above these limits.

## Join links

The first supported join URL wins; unsupported conference providers are ignored so extraction can continue:

1. `conferenceData.entryPoints` with `entryPointType == "video"` (Meet, and the Zoom and Teams calendar add-ons).
2. `hangoutLink`.
3. A URL regex over `location` and the HTML `description` matching `meet.google.com/...`, `zoom.us/j/...` and its subdomains, `teams.microsoft.com/l/meetup-join/...`, `teams.microsoft.com/meet/<id>` and `teams.live.com/meet/<id>`.

Parse each candidate as a URL and require HTTPS and a supported host and join path; the provider (`google`, `zoom` or `microsoft`) comes from that validated host.
Decode HTML entities in extracted URLs, such as `&amp;` in a query string. The complete join URL, including any Zoom `pwd` or Teams `p` parameter, is what the bot receives; room normalization must not alter the dispatched URL.

Room ID normalization, used only for matching:

- Meet: the lowercase meeting code, for example `meet:abc-defg-hij`, ignoring query parameters such as `authuser`.
- Zoom: the numeric meeting ID from `/j/<id>`, for example `zoom:85512345678`, ignoring the subdomain and query.
- Teams: the decoded thread ID from a `meetup-join/19:meeting_...@thread.v2/...` path, or the meeting ID from a `teams.microsoft.com/meet/<id>` or `teams.live.com/meet/<id>` link. Keep thread IDs, work/school meeting IDs and personal meeting IDs in separate namespaces; matching between legacy and short URL forms is not assumed.

## Decision rules

### Owner identity and attendee responses

- Owner identities are the verified email addresses of connected Google accounts, including accounts awaiting reconnect, plus `SCHEDULER_OWNER_EMAIL_ALIASES`. Trim and lowercase addresses for matching; do not infer aliases by removing dots, stripping plus tags or treating different domains as equivalent. Calendar IDs, calendar ownership, organizer status and `attendees[].self` do not automatically add owner identities.
- Google's `attendees[].self` identifies the calendar on which the event copy appears. Match owner attendees by email instead, including on shared calendars and when more than one owner address appears on the same invite. Deduplicate matching identities when counting people.
- For one invite occurrence, combine visible owner attendee responses from its eligible scheduling copies after the freshness rules have excluded expired or superseded copies. Any `accepted`, `tentative` or `needsAction` owner response prevents a default declined decision. Skip as declined only when at least one owner response is known and every known owner response is `declined`. Thus accepting on one account and declining on another still permits joining; it does not create two jobs.
- A missing owner attendee entry is not evidence of decline. An owner who organized an event but has no attendee entry is not assumed declined. Watching a shared calendar includes its otherwise eligible meetings even when an owner RSVP is not present; the dashboard identifies that no owner response was available rather than attributing the shared calendar's `self` response to the owner.
- For the alone check, ignore resource attendees and every owner address. Count distinct visible non-owner people, including a non-owner organizer if not already present in the attendee list. Events containing only owner aliases/resources are skipped as alone. If no other person can be established because attendee details are omitted, skip with reason `attendees unavailable` rather than claiming the owner is definitely alone. A valid Join override can bypass these attendee filters.

### Hard join eligibility

An owner can always select Skip, but Join cannot bypass these requirements:

- The calendar source is watched, authorized, verified in the current scheduler run and within its freshness limit.
- The event is not cancelled, has a supported HTTPS join URL and is a timed event. All-day events, missing/unsupported links and invalid or missing times remain non-joinable even with Join selected. Start/end must parse to valid instants and end must be after start.
- Dispatch still requires the group's lead-time window and an unended meeting. Join is a scheduling override, not an immediate join command for an arbitrary time.
- An existing claimed, completed, permanently failed or unknown dispatch continues to block another join. Only confirmed pending-job removal can release that identity, as specified under Dispatch.

Source and event checks determine operational group membership; the time-window and dispatch-record checks gate enqueueing. Future meetings still appear with their planned decisions, and existing dispatches remain visible even when another enqueue is blocked.

Preserve a selected Join override when a hard requirement fails, but show the blocking reason instead of queueing an invalid job. Re-evaluate it if the source/event becomes eligible again. Unsupported, all-day, invalid-time and unavailable-source members cannot bridge operational groups or extend their scheduling bounds.

### Event and group decisions

After hard eligibility, assign each event an automatic decision with a reason, in order:

1. All known owner responses for this invite occurrence are declined: skip, reason `declined`.
2. No non-owner, non-resource person is established: skip, reason `alone` or `attendees unavailable` as described above.
3. Otherwise: join.

An eligible group joins if any member's automatic decision is join, unless an effective owner override applies. Group Join bypasses the RSVP and alone filters but still requires an eligible scheduling member. Group Skip always skips the group, including when another owner account accepted. Reset returns the group to automatic decisions. A skipped or otherwise non-joining member never supplies the join URL or extends the execution schedule of joining members.

## Grouping and dedup

- Each event occurrence has an instance key: `iCalUID` alone for a non-recurring event, or `iCalUID` plus `originalStartTime` for a recurring instance, with distinct key formats for the two cases.
  Never include the current `start` in the key: it changes when an event is rescheduled. Normalize `originalStartTime.dateTime` to a UTC instant so equivalent timestamps with different offsets match; preserve `originalStartTime.date` as a date for all-day instances.
  Copies of the same invite share the key across the owner's calendars, and a reschedule does not change it.
- Events are merged into one group when they share an instance key, or when hard-eligible scheduling members share a room ID and their time ranges strictly overlap. Display-only cached or hard-ineligible copies can be retained under their invite identity but cannot add room-overlap edges or bridge otherwise separate operational groups. A usable cached copy within the temporary-failure grace period remains a scheduling member under the freshness rules.
  Back-to-back meetings in the same room (one ends at 10:30, the next starts at 10:30) are separate groups, which matters for Zoom personal meeting rooms.
- For a joining group, use the earliest start and latest end among the members that authorize joining after freshness, hard eligibility, attendee decisions and the effective group override. Display-only cached or skipped members remain display/history evidence only. A group with no authorizing member cannot join and retains cached times solely for display/removal decisions.
- Apply automatic member decisions and the effective group override as specified above; an accepted owner account can authorize a single group join despite another owner account's decline, but cannot override an explicit group Skip.
- Store a group override action on every current member's instance key so it survives reschedules and splits. Each action has a monotonically increasing revision saved with JSON state; when groups merge with conflicting stored actions, the most recent explicit action wins. Reset is stored as a newer automatic-mode action so a later merge cannot resurrect an older Join or Skip. Serialize state-file mutations so concurrent polls and dashboard actions do not lose overrides.
- The group's primary member is an eligible scheduling member whose decision made the group join; among several, the earliest start wins, then the lexicographically smallest Google event ID.
- The primary member's Google event ID is sent to the bot as `eventId` (for a recurring occurrence this is the instance ID, such as `abc123_20261103T010000Z`, which keeps its original-start suffix when the occurrence is moved).
  It appears in bot logs, callbacks and the dashboard, and can be looked up with `events.get`.
- `eventId` is metadata only: the bot names recordings by `botId`, and the scheduler never matches by `eventId` (see Dispatch).

## Dispatch

The tick loop runs every 10 s: rebuild groups, load authoritative Redis dispatch state, run the planner and apply its actions. Account/calendar changes are saved atomically to JSON; execution-state changes are written to Redis.

- **Push:** when the group joins, `now >= start - SCHEDULER_JOIN_LEAD_SECONDS` and `now < end`, and no blocking dispatch record exists for any member instance key, atomically create a Redis dispatch record `{payload, pushedAt, scheduledStart, scheduledEnd, memberInstanceKeys, state}` keyed by the payload's `botId`, index its member instance keys and `RPUSH` the exact serialized payload.
  The worker consumes from the left with `BLMOVE ... LEFT RIGHT`, so `RPUSH` preserves FIFO order. `LPUSH` is reserved by the worker for returning an unaccepted job to the front.
  A meeting that started while the scheduler was down is still dispatched if it has not ended.
- **Remove:** remove a pending payload when the group no longer joins (cancelled, declined, overridden to skip, or without eligible calendar support), has ended, or moved outside the dispatch window. `LPOS` is only an observation. In one Lua script, verify the expected dispatch/index state, remove one exact payload with `LREM ... 1 <payload>` and mark its record `removed` with `removedBeforePickup: true` and a reason only when the return count is 1. A return count of 0 can mean the worker picked it up after the check; it must not release deduplication indexes or trigger another dispatch on its own.
- **Replace:** when a pending job's execution inputs or scheduled times change and the updated group is still eligible and due, atomically remove the old payload, mark its record removed before pickup, create a new dispatch with a new `botId`, update member-instance indexes and append the replacement. A replacement is allowed only after removing the exact old payload successfully; see Calendar edits below.
- **Picked up:** an idle worker atomically moves a payload from the shared pending list to its own `config.redisProcessingQueueName` and acknowledges it there after completion or permanent failure. Competing workers cannot claim the same pending entry through `BLMOVE`. Record the observed worker ID when the exact payload is found in its processing list; callbacks and results still match by `botId`. An active job cannot currently be recalled; the bot leaves according to its own meeting and inactivity rules. Absence from pending alone does not prove pickup or completion.
- Queue mutations and their dispatch records share Redis as the authoritative store; there is no JSON write between enqueue and recording the dispatch. Scheduler restarts reconcile this ledger with the actual pending list and all configured worker processing lists before considering new jobs.

### Worker capacity and overflow

- Enqueue eligible due groups even when every worker is busy. The scheduler does not reserve a worker, route jobs to individual workers, spawn extra containers or create additional pending queues. Redis distributes entries as idle workers call `BLMOVE` on the shared list.
- When several groups become due in one tick, append them in scheduled-start order, breaking ties by the lexicographically smallest member instance key. Normal claims follow pending-list FIFO order; actual admission/recording start order may differ because meeting providers and lobbies take different amounts of time. A confirmed replacement is appended at the tail, and the existing worker may return an unaccepted job to the front.
- Busy means the entire join/record/upload/retry/cleanup lifecycle. One worker can upload or finish cleanup while another joins the next meeting. Do not interrupt an active execution to free capacity, and do not enqueue the same meeting again because all workers are occupied.
- A queued job becomes late when its scheduled start passes before pickup. Show the delay and pool capacity on the dashboard. If the meeting is still in progress when a worker claims it, the worker joins late. At each scheduler tick, remove expired pending jobs and label them missed before pickup, retaining their confirmed removal history.
- Expiration is best effort with the unchanged worker: it has no scheduled-end field or deadline check, so it can win pickup before the scheduler removes an expired entry. That execution cannot be recalled. If first observed in processing after the scheduled end, flag a possible late pickup and show the observation time; processing-list polling does not reveal the exact claim time. There is no guaranteed on-time join when all workers are busy, the host is resource constrained or a provider delays admission.
- Adding capacity means adding another isolated worker/Chrome pair and registering its worker endpoint and unique processing list. Existing workers continue their jobs; pending jobs become available to the new idle worker through the same queue. Reduce capacity by stopping a worker gracefully after its current job finishes; keep its identity and processing list registered until outstanding entries are reconciled. Never run two worker instances simultaneously with the same logical ID or processing-list name.

### Calendar edits and removed-dispatch eligibility

- Compare the group's current provider, full join URL (including password parameters), calendar time zone and normalized start/end instants with the stored dispatch inputs. Changes to these inputs replace a pending job. Title changes, calendar labels and a different primary member's `eventId` alone update the dashboard without replacing the job; retain the original payload and metadata in that dispatch's history.
- For a changed pending job that is still due (`start - lead <= now < end`) and joins, prepare a replacement payload and new `botId`. One Lua script checks that the old record and member-instance indexes still match the planner's expected state, checks for any other blocking dispatch among the replacement group's members, and validates all types and inputs before mutation. It then removes exactly the old pending payload. Only if removal returns 1 may it mark the old dispatch removed before pickup, create and index the new record and `RPUSH` the new payload. The new record references the dispatch it replaces. The worker cannot claim the old payload between removal and replacement.
- If the meeting moved later and is not yet due, remove the old job without enqueueing another. If it moved earlier and is still in progress, replace it immediately. A cancelled, skipped or ended group is removed without a replacement. Re-evaluate the latest calendar data and overrides when the group next becomes eligible; do not schedule a future retry from a saved old payload.
- A record is non-blocking only when the scheduler has durably confirmed removal from pending before pickup. Its member-instance indexes may continue referencing that removed record until a later eligible enqueue atomically advances them to a new dispatch. If a group splits, each resulting group's members can advance independently from the removed record; if groups merge, any existing blocking dispatch prevents an additional enqueue. Retain removed records for history.
- Thus a meeting removed while pending can be dispatched again if it becomes joinable and due, including after a later reschedule, cancellation reversal or resetting a Skip override. This is a new dispatch after confirmed removal, not a retry of an execution that may have run. A picked-up, finished, permanently failed, unknown or incompletely removed dispatch continues to block automatic rejoin even if its calendar times or URL change.
- Before retrying an operation whose reply was lost, first look up the candidate replacement `botId` and current member-instance indexes. If that replacement already exists, use its stored result instead of removing or enqueueing again, even if the worker has since picked it up. If another planner action advanced the old record or indexes, discard the stale action and replan. Serialize the scheduler's planner action batches; Redis preconditions still protect against worker pickup and replay.
- If removal returns 0 and no replacement was already committed, preserve the blocking record and reconcile pending/processing membership and results. Do not treat a missing payload as permission to insert its replacement. If a script errors after any mutation, use the durable evidence to reconcile; partial execution must never be assumed rolled back or successfully removed without evidence.
- After pickup, preserve the submitted payload and dispatch start/end times. Changes to the room, provider, password, time, cancellation or skip decision are flagged as "calendar changed after pickup" with the changed fields and detection time. The scheduler does not stop the active bot, change its target, create another dispatch or extend its recording. An uncertain execution gets the same protection; a calendar edit is not evidence that it is safe to retry.

### Durable enqueue and restart behavior

- The enqueue Lua script checks all member-instance indexes before writing. If any member already has a blocking dispatch, return that dispatch instead of enqueueing another job. If none does, write the dispatch record and member indexes before appending the payload. A successful script exposes the record, indexes and queue entry together, without interleaving worker pickup.
- Validate payloads, Redis key types and preconditions before the first write. Redis script execution is atomic with respect to other clients, but script errors do not roll back writes already performed. If an operation errors, reconcile the record, indexes and queue membership before another attempt; a partially recorded dispatch remains blocked or unknown rather than presumed safe to retry.
- A timeout or disconnect after sending the script is an uncertain response, not proof that enqueue failed. Reconnect and look up the durable dispatch by member instance key and candidate `botId`, then reconcile its queue membership. If the script never ran, it is safe to submit it again; if it did, the existing record prevents another enqueue, including when the worker has already picked up or completed the job. Reuse the prepared `botId` and serialized payload while resolving an uncertain response.
- Persist changes to existing dispatch records, including newly attached group members, with their member-instance indexes in the same Redis operation. Completed and unknown dispatches continue to block automatic redispatch. Do not expire dispatch identity records or deduplication indexes when trimming the visible history; only confirmed removal before pickup makes a record non-blocking, as specified above.
- A scheduler restart reloads the Redis ledger. A Redis restart reloads its AOF from the named volume, preserving pending, processing, result and scheduler execution state. Restored processing entries still follow conservative recovery; persistence is not evidence that their former worker remains alive or that it is safe to retry.
- First-time setup explicitly initializes a scheduler dataset marker in Redis. Normal startup requires that marker and the configured AOF policy before enabling dispatch. An empty replacement volume, missing marker or persistence error disables dispatch and shows a recovery error; never silently reconstruct an empty execution ledger from upcoming calendar events. Volume deletion, AOF corruption or restoring an older backup requires owner reconciliation because a previously joined meeting may no longer have a dispatch record.
- JSON account/calendar writes are separate from execution state. A state-changing dashboard request succeeds only after its JSON change is durably saved. On a state-file write failure, keep the pending change dirty, pause new dispatch and retry the write on subsequent ticks even if no further changes arrive. On restart, use the last saved controls and require fresh calendar polls before enabling joins from persisted snapshots.

The guarantee is idempotent scheduler enqueue across scheduler crashes, lost command replies and Redis restarts with intact durable storage. It is not exactly-once meeting execution: the unchanged worker has its own retries, and worker interruption or lost/rolled-back storage still requires conservative reconciliation.

### Worker observation and conservative recovery

The scheduler uses each configured worker's unchanged `/health` and `/isbusy` endpoints, alongside the shared pending list, that worker's processing list and notifications. Probe all worker endpoints every 10 seconds with a 3-second request timeout and no overlapping probe rounds per worker. Failures are isolated per worker. Keep the last successful observations and their timestamps separately for each worker and from each dispatch's outcome.

- `/health` returns a timestamp and process uptime. A response establishes that the Node HTTP server responds; it does not establish that the browser is healthy, the bot was admitted or recording is progressing. A change in the estimated process start time can suggest a restart, but cannot establish what happened to a specific job.
- `/isbusy` returns whether JobStore is occupied, including joining, recording, uploading, retries and cleanup. It exposes no `botId` or phase, so it cannot attribute activity to a particular dispatch or distinguish a lobby wait from other work. An idle response does not establish that an old browser page has closed.
- An exact payload in a worker's processing list establishes that it was claimed through that worker's queue and has not been acknowledged there. It does not prove that its original process is still running. Match worker observations only to executions associated with that processing list; one worker being idle or unreachable says nothing about a job owned by another. A payload absent from pending and every registered processing list with no terminal result is also uncertain, rather than presumed finished or safe to retry.
- Silence during an in-flight job is expected because the worker has no periodic job reports. Keep a claimed execution as `picked up` while the available observations are consistent with ongoing work. Mark it `unknown` when reconciliation cannot establish its state, such as after a worker becomes unreachable, an apparent process restart, or an idle worker with no terminal result for a claimed job. Show the available evidence and timestamps, and keep its dispatch record so the planner cannot automatically create another job for its member instance keys. Age alone never makes an uncertain execution safe to retry.
- A successful Redis recording result establishes successful upload. An explicit permanent failure result establishes the reported execution failure. Attempt status callbacks alone do not establish either a permanent failure or that retries have finished. Consume pending results before classifying an idle worker's unresolved execution as unknown, as specified below. A known outcome is not downgraded merely because the worker later becomes unreachable.
- Preserve a reported admission timeout as "not admitted before timeout"; it does not prove the host deliberately rejected the bot. The existing worker treats its lobby timeout errors as non-retryable. The scheduler adds no retries for these failures and does not interfere with the worker's existing retries for other errors.
- The owner diagnoses uncertain executions using the associated worker's logs and host-side Docker state, including container exit/restart information. Docker evidence can confirm a container restart but cannot establish meeting admission or cleanup of that worker's surviving Chrome sidecar page. The scheduler does not need Docker socket access or new worker endpoints for this policy. Another worker can keep processing pending jobs while one execution is unknown; its dispatch remains blocked from automatic rejoin.
- An uncertain execution is not automatically requeued or removed from processing. A Join override does not bypass its dispatch record. Starting another execution requires an explicit owner recovery action after checking the previous bot/browser; the initial scheduler does not add an automatic recovery workflow.

This policy accepts that some recordings may be missed when the available signals cannot establish a safe recovery. It avoids treating a connectivity failure or unanswered admission request as proof that another bot should join.

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

- `PATCH /v2/meeting/app/bot/status` with `{eventId, botId, provider, status}`, where `status` is a provider attempt's history such as `["processing", "joined", "finished"]` or ending in `"failed"`. JobStore retries reuse the same `botId` and can produce multiple histories for one dispatch. Zoom sends its normal completion status before uploading; Google Meet and Teams send theirs after uploading. Failures before provider execution, such as uploader initialization failure, can produce no status callback.
- `PATCH /v2/meeting/app/bot/log` with `{eventId, botId, provider, level, message, category, subCategory}`, sent during a job for lobby, unsupported-meeting and recording events.
- Both require `Authorization: Bearer <SCHEDULER_BEARER_TOKEN>` (constant-time comparison) and return 401 otherwise; bodies are validated and malformed ones get 400.
- Both reply `{"success": true}` so the bot logs no errors.
- Reports are matched by `botId` only, through the dispatch record, so they land on the right row even if the group's membership or primary member changed after dispatch, or the same meeting was dispatched again after a reschedule (same `eventId`, new `botId`).
- Reports whose `botId` has no dispatch record are stored as unscheduled.
- Attempt reports, logs, recording metadata and the last 200 outcomes are stored in Redis. Report endpoints acknowledge success only after persisting the report; if Redis cannot store it, return a failure response instead of acknowledging an in-memory update. These HTTP calls have no durable sender replay; missed attempt reports may remain missing without preventing Redis result ingestion.

Status callbacks are attempt reports, not an authoritative terminal job signal. A failed attempt can be followed by a successful retry with the same `botId`. Retain each received history with its receipt time; do not concatenate histories into a presumed chronological execution state, assume arrival order identifies the latest attempt, or treat a `finished` callback as proof of upload success. Status/log callbacks never overwrite an authoritative Redis outcome or trigger a scheduler retry.

The bot's recording-completed webhook adds the recording itself to the dashboard:

- Compose sets `NOTIFY_WEBHOOK_ENABLED=true`, `NOTIFY_WEBHOOK_URL=http://calendar-scheduler:3001/hooks/recording-completed` and a shared `NOTIFY_WEBHOOK_SECRET` for `meeting-bot`.
- `POST /hooks/recording-completed` receives `RecordingCompletedPayload` (`recordingId`, `meetingLink`, `blobUrl`, `metadata.botId`, `metadata.duration`, `metadata.storage`).
- The scheduler verifies `X-Webhook-Signature` (HMAC-SHA256 of the raw body with `NOTIFY_WEBHOOK_SECRET`, constant-time comparison) and returns 401 on mismatch.
- The payload is matched to its group by `metadata.botId`. Store the recording metadata and duration, including the S3 bucket/key from `metadata.storage`. The current `blobUrl` is an unsigned object URL built from the upload endpoint; keep it server-side as diagnostic evidence rather than using it as a browser link. Dashboard links use the authenticated download route below.
- The bot sends this webhook only on successful upload and attempts delivery once with a 10-second timeout. It also emits completion results to `config.notifyRedisList` (default `jobs:meetbot:recordings`) and permanent failures to `config.notifyRedisFailureList` (default `jobs:meetbot:failures`) when Redis notifications are enabled. Redis worker mode enables those notifications automatically; compose explicitly enables them for this setup. Webhook and Redis completion delivery run independently, so either may arrive first or be absent. Merge recording metadata by `metadata.botId` and `recordingId` so delivery over both channels creates one recording entry. The webhook alone confirms recording metadata but does not manufacture a Redis terminal result.

### Authoritative results and durable ingestion

- The scheduler is the sole consumer of the configured recording-completed and permanent-failure result lists for this standalone installation. They use the same persistent Redis instance and database as the dispatch ledger, allowing an atomic result-to-outcome write. Other consumers must use separate lists rather than competing for these entries.
- On startup and every 10-second tick, ingest up to 100 entries from each result list before classifying unresolved executions or planning new dispatches. Peek at the head with `LINDEX 0`, validate and prepare its outcome update, then use a Lua script to verify that the exact raw entry is still the head, persist its evidence/outcome and any recording metadata, and finally remove that one entry with `LPOP`. Evaluate duplicates and conflicts against the current stored outcome, and merge only result-owned fields rather than overwriting the dispatch or recording metadata from a stale client snapshot. Never pop an entry first and save its outcome in a later command. If a backlog remains, show result ingestion as pending and defer conclusions based on absent results until the backlog has been processed.
- Validate key types and all result-update preconditions before writing; remove the source entry last. If the scheduler crashes before the script, the entry remains in its source list. After a successful script, the outcome is durable even if the reply is lost. If a script errors after persisting some evidence, the retained source entry is safe to reprocess because persistence is idempotent; an error must not discard an unrecorded result.
- Match results only by `metadata.botId` to the dispatch record, preserving the original payload, instance keys and scheduled times. A valid result without a matching dispatch, or without a usable `botId`, goes to the bounded unscheduled-result history and does not update another row by `eventId`, meeting URL or `recordingId` fallback. Malformed result entries are atomically archived with their validation error and removed from the input list so they do not block later valid results; show a dashboard diagnostic. Persist either archive before removing its source entry.
- Deduplicate a result by its source list and a SHA-256 digest of the exact raw payload, including the `botId`. Worker delivery retries can append the same result more than once. Duplicate results do not add another outcome/history row, and recording metadata is also merged across the Redis and webhook channels by `(botId, recordingId)`. Keep outcome updates idempotent even if detailed evidence is later trimmed; retain the dispatch's terminal summary and blocking identity.
- A validated `status: "completed"` result in the recording list sets the dispatch outcome to `completed`, meaning recording uploaded, and supplies recording metadata even if the webhook or status callback was missed. This result is emitted during upload completion, before final browser cleanup and queue acknowledgement; it does not establish that the worker is idle or ready for another meeting.
- A validated `status: "failed"` result in the failure list sets the dispatch outcome to `failed`, with the reported error type and message. This list is written by the worker's permanent-failure handler after its retries stop, including failures before provider execution. An `error.retryable` field describes the error class; it does not mean more worker attempts remain after this result and does not authorize a scheduler retry.
- A later attempt callback cannot downgrade or change a known outcome. If Redis results for the same `botId` contradict each other, preserve both results and any available recording, flag conflicting results and mark the outcome unknown for investigation. Arrival time alone does not select a winner. Results do not release dispatch deduplication or cause rejoin, even when failed or conflicting.
- If an execution has no authoritative result, keep it picked up while the available worker observations are consistent with ongoing work. Once it becomes unresolved under the conservative-recovery rules, show `unknown` with the last available evidence. A signed recording webhook may still provide a recording link while the final Redis result is unknown. Do not infer success from an empty processing list or a `finished` HTTP callback, or failure from elapsed time alone. A late valid Redis result can resolve an unknown outcome without another dispatch.
- The worker retries Redis notification delivery up to three times but can still lose a result if delivery fails throughout or it crashes before notification. Persisted lists recover notifications already written while the scheduler was down; they cannot recover a result never emitted. Leave such cases unknown without changing the worker or automatically rejoining.

Limit: the bot does not report a live "recording now" state, so the dashboard shows queued, picked up, any logged lobby or failure events, and the reported upload/failure outcome. Worker availability remains a separate observation.
Limit: with the `screenapp` uploader the bot also calls upload endpoints on `AUTH_BASE_URL_V2`, which the scheduler does not implement; this setup supports the S3 uploader only.

## Dashboard

Express on port 3001, published as `127.0.0.1:3001:3001`, and exposed to the tailnet with `tailscale serve`.
Pages are server-rendered HTML with a little vanilla JavaScript; there is no frontend framework or build step.

- **Schedule** (home): one row per group for the next 24 hours, showing time, titles, calendars, platform, decision and reason, dispatch status (pending, queued, picked up, removed, unknown, then the bot's reported outcome), and Join, Skip and Reset buttons. Unknown executions show the evidence and last observation time; Join does not automatically retry them. Rows show any calendar changes detected after pickup and make clear that Join/Skip changes cannot recall or replace a claimed execution. Retain a changed or cancelled active execution until it has a reported outcome or is marked unknown, even if its calendar group disappears or moves outside the displayed window.
  Show configured worker capacity, each worker's reachable/busy/idle observation, queue depth, queued delays, observed worker assignments and jobs removed as missed. Worker identity is shown only when observed from processing membership; a completed job that finished between observations may have no recorded worker assignment.
  Banners show calendar poll failures, last complete success times, whether a calendar is within its grace period or expired for joining, accounts that need reconnecting, Redis being unreachable, and individual worker observations that are unavailable or stale. Distinguish waiting for startup refresh from a fresh calendar with no events, and calendar-unavailable removals from cancellations or missed meetings. An unavailable worker reduces observed capacity without stopping healthy workers.
  The page refreshes itself every 30 seconds.
- **History**: groups from the past 7 days with their outcome and lobby or failure log lines. Label success as recording uploaded, distinguish attempt errors from permanent failures, and show unknown outcomes and result conflicts explicitly. A recording link may be available even when the authoritative result is missing.
- **Accounts**: connected Google accounts, each with its calendar list from `calendarList.list` and a checkbox per calendar, plus Connect account and Disconnect.
  New calendars start unwatched.

### Authenticated recording downloads

- `GET /recordings/:botId/download` and `HEAD /recordings/:botId/download` require a valid owner dashboard session before making any storage request. Return 401 for a missing or expired session and 403 for an unauthorized user. These routes use the same session on localhost and the Tailscale dashboard origin; they do not issue bearer download links or redirect to S3.
- Look up the stored recording associated with that `botId`. Resolve its object key from validated `metadata.storage`, require the S3 provider and configured bucket, and use only the server-configured endpoint, region, path-style setting and credentials. Do not accept a URL, bucket, object key or credentials from request parameters, and do not choose an endpoint by following `blobUrl` or notification metadata. If recording location metadata is missing or conflicting, show recording location unavailable rather than guessing a key or exposing a storage URL. A recording with valid metadata remains downloadable even when its terminal result is unknown.
- The scheduler needs `s3:GetObject` access to the configured bucket, which also authorizes object metadata reads. Keep the bucket private. The browser receives neither storage credentials nor raw/direct/presigned S3 URLs in HTML, JSON, response headers or redirects; only the authenticated dashboard route is exposed. No browser-to-S3 connectivity or bucket CORS change is required.
- Read the object using `GetObjectCommand` and stream its body directly into the HTTP response with backpressure. Do not accumulate the recording in memory, download it fully before responding, transcode it or write a second temporary copy. Abort the storage request and destroy the upstream stream when the client disconnects. Handle upstream errors before sending response headers; after streaming begins, terminate a broken response rather than returning a successful truncated download or appending an error document to its body.
- A full GET returns 200 with the object's content type and content length. A valid single byte range returns 206 with correct `Content-Range` and partial `Content-Length`; support bounded, open-ended and suffix byte ranges for seeking and resumable downloads. Return 416 with `Content-Range: bytes */<size>` for an unsatisfiable range and 400 for a malformed range. S3 does not support multiple ranges in one GET, so ignore an otherwise valid multipart range request and return the full object with 200. Advertise `Accept-Ranges: bytes`.
- Preserve the object ETag and last-modified metadata. Honor `If-Range`: send a partial response only when its validator matches the current object; otherwise send the full object with 200 so resumed downloads do not silently combine different versions. Ensure any metadata used to validate a range and the streamed body refer to the same object version, using a version ID or a conditional GET when needed. HEAD returns the corresponding metadata without reading or sending the object body; Range is ignored on HEAD.
- Use `Content-Disposition: attachment` with a safe recording filename and `Cache-Control: private, no-store`. Missing recording records or confirmed missing objects return 404. Storage permission failures or connectivity errors return a sanitized 502/503 without credentials, internal endpoints or raw upstream error bodies. A download failure does not rewrite the meeting's recorded execution outcome.
- This route supports ordinary downloads and range-based seeking by clients without adding an in-dashboard player. Performance depends on storage, host load and the client connection. Validate the deployed S3-compatible server's range and conditional-request behavior rather than assuming complete AWS compatibility. See [S3 GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html) and [Node 20 streams](https://nodejs.org/docs/latest-v20.x/api/stream.html).

## Authentication

One Google OAuth "Web application" client serves two flows.

- **Login:** scopes `openid email`.
  The callback verifies the ID token and requires a verified email in `DASHBOARD_ALLOWED_EMAILS`; anyone else gets 403.
  The session is an HMAC-signed cookie (HttpOnly, SameSite=Lax, Secure on HTTPS, 7-day expiry) with no server-side session store.
- **Connect account:** scopes `openid email https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly`, with `access_type=offline` and `prompt=consent` to request a refresh token.
  Require an authenticated allowed owner to initiate and complete this flow. Verify the ID token and its verified email before adding that email to the owner identity set; require the calendar scopes actually granted and a usable refresh token before marking the account connected, and store the token encrypted. If reconnecting omits a new refresh token, retain an existing usable token for that same verified account or report that reconnect is incomplete. Connecting another account does not grant that account permission to log into the dashboard unless separately listed in `DASHBOARD_ALLOWED_EMAILS`.
- **Disconnect** revokes the token at Google and removes the account from state.
- Both flows carry a random `state` in a short-lived signed cookie, checked on callback.
- The redirect URI is built from the request origin only if that origin is listed in `DASHBOARD_BASE_URLS`; any other origin gets 400.
- State-changing requests are POSTs that require a custom header and a same-origin check in addition to the SameSite cookie.
- A token refresh failing with `invalid_grant` marks the account "needs reconnect", stops polling its calendars and immediately makes their snapshots ineligible for joining. Retain the last snapshots for display, withdraw unsupported pending jobs and require a successful poll after reconnect before restoring eligibility.
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
| Existing `S3_*` storage configuration | The scheduler uses the same bucket, region, endpoint/path-style settings and server-side credentials defined in `src/config.ts`; credentials must also permit object reads for downloads |

Optional:

| Variable | Default |
|---|---|
| `SCHEDULER_JOIN_LEAD_SECONDS` | `60` |
| `SCHEDULER_OWNER_EMAIL_ALIASES` | Empty; comma-separated additional owner email addresses for attendee matching, separate from dashboard login permissions |
| `SCHEDULER_MAX_SNAPSHOT_AGE_SECONDS` | `300`; positive maximum age of a complete successful poll for dispatch during temporary failures |
| `SCHEDULER_STATE_PATH` | `/data/scheduler-state.json` |
| `SCHEDULER_WORKERS` | JSON array of the two default worker registrations listed under Deployment; each entry has `id`, `baseUrl` and `processingQueue` |

## Deployment

The existing Redis service becomes persistent:

- Retain its existing `cache:/data` named volume and enable `appendonly yes`, `appendfsync always`, `no-appendfsync-on-rewrite no`, `aof-load-truncated no` and `maxmemory-policy noeviction`. Automatic RDB snapshots may remain disabled; AOF is the restart source. Set `restart: unless-stopped` and retain the Redis healthcheck. A truncated AOF must require owner reconciliation instead of silently discarding its tail and resuming dispatch.
- Redis must retain the full AOF directory on that volume across container replacement. Normal stop/start and deployment commands must preserve the volume. Initial setup creates the scheduler dataset marker once; an ordinary scheduler startup never recreates it automatically.
- The scheduler checks the persistence configuration at startup and stops issuing new dispatches if Redis reports an AOF write failure. If Redis or its persistence status cannot be checked, pause dispatch until it can be checked; do not fall back to an in-memory ledger.
- AOF with fsync on every write is appropriate for this small workload and avoids the acknowledged-write loss window of `appendfsync everysec`. Durability still depends on the host storage honoring fsync. See [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/) and [Lua script execution](https://redis.io/docs/latest/develop/programmability/eval-intro/).

A new `calendar-scheduler` compose service:

- Same build as `meeting-bot`; command `npx ts-node src/scheduler/index.ts` in development and `node dist/scheduler/index.js` in production.
- Port `127.0.0.1:3001:3001`, a gitignored state volume mounted at `/data`, `restart: unless-stopped`, `depends_on: redis`.
- `GET /health` for the compose healthcheck.
- Report ready only after loading saved controls and reconciling the Redis ledger and unsupported pending jobs. Workers depend on scheduler readiness during normal Compose startup; individual calendar polling continues independently and does not hold other successfully refreshed calendars. No calendar can dispatch from its persisted snapshot before its own first successful poll in this run.
- Give the scheduler the same container-reachable S3 connection settings used by the workers. If the local storage endpoint uses `host.internal`, include the workers' host-gateway mapping on the scheduler service too. Tailscale Serve exposes only the dashboard; S3 needs no additional public or tailnet-facing endpoint for browser downloads. Ensure the proxy path streams responses without full-response buffering.
- Every worker gets `AUTH_BASE_URL_V2=http://calendar-scheduler:3001/v2`, `NOTIFY_WEBHOOK_ENABLED=true` and `NOTIFY_WEBHOOK_URL=http://calendar-scheduler:3001/hooks/recording-completed` in its compose `environment`; the scheduler and all workers read `NOTIFY_WEBHOOK_SECRET` from `.env`.
- Set `NOTIFY_REDIS_ENABLED=true`, clear `NOTIFY_REDIS_URI` so notifications use each worker's shared `config.redisUri`, and set `NOTIFY_REDIS_DB=0` to match the queue and scheduler ledger. All services use the same configured `NOTIFY_REDIS_LIST` and `NOTIFY_REDIS_FAILURE_LIST` names. Reject a deployment configured to place result lists on a different instance/database from the ledger; atomic ingestion depends on that shared store.

### Isolated workers and adding capacity

The default compose deployment starts these two worker/Chrome pairs, using the existing worker and Chrome images:

| Worker ID | Worker service / `baseUrl` | Worker `REDIS_PROCESSING_QUEUE_NAME` / registry `processingQueue` | Private Google Chrome sidecar |
|---|---|---|---|
| `1` | `meeting-bot-1` / `http://meeting-bot-1:3000` | `jobs:meetbot:processing:1` | `chrome-cdp-1` |
| `2` | `meeting-bot-2` / `http://meeting-bot-2:3000` | `jobs:meetbot:processing:2` | `chrome-cdp-2` |

- All workers use the same `REDIS_QUEUE_NAME` and Redis connection. Each has a unique, stable processing-list name, and its `GOOGLE_CHROME_CDP_URL` points directly to its paired sidecar, such as `http://chrome-cdp-1:9223`. Do not load-balance workers across a shared Chrome endpoint.
- Every worker has its own Xvfb display, PulseAudio server, `virtual_output` sink and local browser processes. Its Google sidecar has its own display/audio runtime and Chrome profile. Container-local display/device/port names may be reused; do not share host X11 or PulseAudio sockets, runtime directories or writable Chrome profiles between workers.
- Give each worker a separate volume at `/usr/src/app/dist/_tempvideo` and separate writable browser-profile and debug-output storage. Development source bind mounts must not cause these runtime paths to resolve to the same host directory. Zoom and Teams browsers remain local to each worker; Google Chrome profiles are private to each sidecar. Shared Redis and final S3 storage are intentional, and recordings remain identified by unique `botId` values.
- Keep worker port 3000 and sidecar port 9223 internal to Compose; the scheduler reaches each worker by its service name. Remove the existing fixed `3000:3000` worker publication from the default deployment to avoid conflicts. If direct worker HTTP access is needed for diagnostics, use explicit, distinct loopback host ports.
- `SCHEDULER_WORKERS` is a non-empty JSON array of `{id, baseUrl, processingQueue}` registrations. Its defaults are the two rows above. Validate unique IDs, URLs and processing-list names at startup. The configured processing list must match that worker service's environment. Pending and result list names must differ from all processing-list names.
- To add a third or later worker, define another worker/Chrome pair through a Compose override, give it private runtime volumes and a unique ID/list name, and append its registration to `SCHEDULER_WORKERS`. Reuse the existing images and common settings; no worker source changes, generated deployment framework, Docker socket integration or autoscaling controller are required. Keep host CPU, memory and disk capacity sufficient for the configured maximum concurrent recordings, and verify that adding workers does not starve existing recordings.

## Error handling

| Failure | Behavior |
|---|---|
| Temporary calendar poll failure | Keep the snapshot and back off; permit joins only within its five-minute age limit, then withdraw unsupported pending jobs |
| `invalid_grant` or confirmed calendar access loss | Immediately disable source eligibility, withdraw unsupported pending jobs and require reconnect/access restoration plus a successful poll |
| Scheduler startup or account reconnect | Cached snapshots are display-only until individually refreshed; initial worker startup waits for scheduler queue reconciliation |
| Redis unreachable or command reply lost | Pause dispatch, show a banner, then reconcile durable records and queue membership before retrying an uncertain operation |
| Redis AOF write failure, missing dataset marker or unexpected empty dataset | Disable dispatch and show a recovery error; do not recreate execution state automatically |
| State-file write fails | Fail the state-changing request, keep the change dirty, pause new dispatch and retry saving on subsequent ticks |
| Scheduler crash | Compose restarts it; reload the Redis ledger and reconcile pending/processing membership before considering new jobs |
| Redis restart with intact volume | Reload AOF and reconcile restored queue and execution state; uncertain worker executions remain unknown |
| Worker unreachable or apparently restarted | Mark unresolved executions unknown, retain dispatch records and do not automatically retry; use existing notifications and owner diagnostics to reconcile |
| Processing entry with no terminal result | Keep it unresolved; do not reclaim it because of elapsed time, missing callbacks or worker idle status alone |
| All workers busy | Keep additional due jobs queued; process them as workers become idle and show any delay |
| Pending meeting ends before pickup | Remove it on the next tick and label missed if removal succeeds; a worker winning pickup remains protected from automatic recall or redispatch |
| Admission timeout reported as permanent failure | Show not admitted before timeout; no additional scheduler retry |
| Status/webhook callback missed | Redis result still determines outcome and supplies recording metadata; missed attempt logs may remain missing |
| No authoritative result after execution becomes unresolved | Show unknown, retain evidence and deduplication; a late result may resolve it without another join |
| Duplicate, invalid or conflicting Redis result | Deduplicate identical results, archive invalid entries before removing them, and retain conflicting evidence as an unknown outcome; never rejoin automatically |
| Bad or unauthenticated status report or webhook | 400 or 401, nothing stored |
| Recording download unauthenticated or missing | 401/403 before storage access, or 404 for an unknown recording or confirmed missing object |
| Recording storage unavailable, unauthorized upstream or stream interrupted | Return a sanitized 502/503 before response headers, or terminate the interrupted stream after headers; preserve the meeting outcome and permit a client range/resume request |

## Testing

- **Unit tests** with the built-in `node:test` runner through `ts-node`, so no new test framework:
  - `links`: fixtures shaped like real events (Meet `conferenceData`, Zoom and Teams add-ons, unsupported video providers followed by a supported URL, links inside HTML descriptions with escaped query separators, Zoom URLs with `pwd` and vanity subdomains, legacy and short Teams URLs with `p`).
  - `decide`: every rule and its precedence, connected emails and explicit aliases, shared-calendar self flags, mixed accepted/declined owner accounts, all-known-owner-declined, missing owner RSVP, owner organizer without an attendee entry, owner/resource-only events, hidden attendee details and non-owner organizer counting. Verify Join can bypass RSVP/alone checks but not source freshness, cancellation, missing/unsupported URL, all-day/invalid time, dispatch window or a blocking dispatch record; group Skip always wins over automatic acceptance.
  - `group`: same iCalUID across calendars, same room with overlapping times, back-to-back meetings staying separate, distinct recurring occurrences, equivalent original-start instants with different offsets, override and dispatch identity survival across one-off and recurring reschedules, skipped members not extending joining groups' scheduling bounds, hard-ineligible members not bridging operational groups, and Join/Skip/Reset revision precedence after splits and merges.
  - `planner`: push at lead time, late start after downtime, earlier and later reschedules while queued, changed URL/password/provider/time zone, cancellation or skip while queued, ended while queued, metadata-only edits without replacement, restart idempotency, and no automatic redispatch for picked-up or uncertain executions after calendar edits, overrides or an apparent worker restart. Cover re-enqueue after confirmed removal, group splits and merges, and cancelled active groups remaining visible.
  - `crypto`: encryption round trip and tamper detection, cookie signature rejection, webhook signature verification.
- **Integration tests** against the compose Redis: the `queue` module and the planner's actions end to end, FIFO insertion with multiple pending jobs, and a worker pickup between `LPOS` and `LREM`; the status and log routes with valid, missing and wrong bearer tokens and repeated attempt reports for one `botId`; the webhook route with valid and tampered signatures.
- **Durability integration tests** against an isolated Redis instance with its own persistent volume: repeated enqueue for the same member keys creates one job and record; loss of the script reply followed by retry creates no duplicate, including after pickup or completion; scheduler termination immediately after script execution and before handling the reply preserves deduplication; forced Redis termination and restart on the same volume preserve queue entries, indexes and records; removal and its dispatch transition stay consistent across a lost reply. A missing dataset marker, wrong key type, persistence failure or unavailable Redis never causes an unconditional enqueue. Failed JSON writes pause dispatch and retry without needing another state change. These tests must not stop or delete the owner's running Redis volume.
- **Queued-edit integration tests** against isolated Redis: atomic replacement leaves exactly one new pending job and keeps the old removed record; a worker winning pickup before replacement prevents a new job; losing the replacement reply and replaying it does not create another job, including after replacement pickup; a later start removes now and enqueues only when due; stale planner actions cannot replace a newer dispatch; incomplete or failed removal never releases the dispatch for automatic rejoin.
- **Outcome integration tests** against isolated Redis: a failed HTTP attempt followed by a completed Redis result produces a completed outcome; a Zoom `finished` callback followed by permanent upload failure produces failed; failure before provider execution is captured from the failure list; Redis completion without a webhook still supplies recording metadata; duplicate results and webhook/result delivery in either order create one outcome and recording entry; late attempt callbacks do not change terminal outcomes. Cover scheduler termination before ingestion and after commit but before reply handling, outcome-write failure leaving the input entry intact, malformed/unscheduled entries archived without blocking valid results, conflicting results preserved as unknown, a completed recording while the worker remains busy, backlog processing before absent-result classification, and a late result resolving unknown without rejoin.
- **Worker-pool integration tests** against isolated Redis: two idle consumers claim distinct jobs from one pending list into distinct processing lists; a third job waits while both are busy and is claimed once capacity frees; increasing the configured pool to three allows a third distinct claim without changing the queue contract; worker observations and unknown states stay associated with the correct processing list; expired pending jobs are removed as missed when removal wins; a pickup winning expiration is not recalled or redispatched. Reject duplicate worker registrations and processing-list collisions.
- **Download integration tests** with a controlled S3-compatible test object: authenticate GET and HEAD before any storage access; stream the exact full object; verify bounded, open-ended and suffix ranges, 206 headers, unsatisfiable ranges with 416, malformed ranges and multipart-range fallback. Cover If-Range matching/mismatching validators and an object changing between metadata lookup and GET, HEAD without a body, client disconnect cancelling the upstream read, storage denial, missing objects and a midstream failure. Confirm no storage URL or credential is returned, notification URLs cannot select an arbitrary endpoint, and output starts before the complete upstream body is read without buffering the whole recording.
- **Google adapter tests** with mocked paginated responses: short or empty intermediate pages with `nextPageToken`, complete snapshot replacement only after the last page, and preservation of the previous snapshot when a later page fails.
- **Calendar freshness tests** with controlled time and mocked Google responses: a temporary failure inside the five-minute grace period still permits joining; the exact cutoff prevents new enqueue and withdraws unsupported pending jobs; retries/partial pages do not renew success time; startup and reconnect require a complete new poll; invalid grant, access loss, unwatch and disconnect disable eligibility immediately. Cover another eligible calendar supporting the same meeting, a current copy superseding grace-period link/time/decision data, expired copies not extending or bridging groups, refresh restoring a removed-but-unclaimed meeting, overrides unable to bypass source eligibility, and worker pickup winning withdrawal without a replacement dispatch. Verify a failed calendar does not block scheduling from healthy calendars.
- **Worker observation tests** with mocked existing endpoints: a reachable busy worker is not assumed to be recording or waiting in a lobby; a probe timeout, changed process uptime, idle worker with an unresolved processing entry, or missing terminal report never triggers automatic requeue. One worker being idle or unreachable must not change another worker's job state or stop healthy workers from taking queued jobs. Preserve permanent admission-timeout failure separately from unknown execution state.
- **End to end** with the owner's real accounts:
  1. Log in and connect each account from both `http://localhost:3001` and the Tailscale URL.
  2. Create a test event with a Meet link three minutes out and confirm the bot joins on time and the outcome, recording link and duration appear on the dashboard.
  3. With both workers busy so a test job remains queued, change its meeting URL and move it earlier/later, and cancel a queued job; confirm the old URL is never joined. Then edit an event after its job is picked up and confirm the dashboard flags the edit while the existing bot continues without a second dispatch for that meeting.
  4. Put the same link in two separate invites with overlapping times and confirm one job; back-to-back invites using that room remain separate.
  5. Repeat the join check with Zoom and Teams links.
  6. Check the dashboard visually with Playwright in light and dark themes and at phone width.
  7. Run simultaneous test meetings with distinguishable audio and video; inspect both recordings to confirm no cross-meeting audio, screen capture or file interference. Repeat with two Teams meetings to exercise desktop/audio capture and two Meet meetings to exercise separate Chrome sidecars. Delay one worker's upload and confirm the other can join another meeting. Queue a third meeting while both workers are busy, then confirm exactly one worker claims it when free and the dashboard reports its delay. Add a third worker through deployment configuration and repeat with three distinct jobs. Check host resource use under concurrent capture and encoding.
  8. Download a representative recording through both localhost and Tailscale, interrupt and resume it, and verify file integrity and range responses. Compare authorized direct S3 and proxied downloads on the same local path to measure proxy overhead, then measure the real Tailscale client path separately. Record time to first byte, sustained throughput and scheduler CPU/memory. Confirm memory stays bounded as recording size grows and simultaneous downloads do not stall calendar ticks, status ingestion or the two recording workers. Inspect browser network responses to confirm the object is served only through the authenticated dashboard route. Do not claim negligible overhead before these measurements.
  9. Invite two connected owner accounts to one test meeting, accept on one and decline on the other, and confirm exactly one scheduled job. Repeat through a shared calendar, verify explicit Skip prevents the join, and confirm Reset restores automatic behavior. Verify configured aliases count as the owner without granting extra dashboard login access.

## Out of scope

- Push notifications (can later trigger the same sync function without design changes).
- Non-Google calendars.
- Automatic worker scaling or preemption of active meetings; capacity is changed explicitly through deployment configuration.
- Changes to worker code, new phase/heartbeat reporting, and automatic recovery of uncertain worker executions for the initial scheduler.
- Dashboard-editable settings; configuration stays in environment variables.
- The `screenapp` uploader together with this scheduler.
