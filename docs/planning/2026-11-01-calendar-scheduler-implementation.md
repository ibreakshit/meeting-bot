# Calendar Scheduler Implementation Plan

> **For agentic workers:** Use the reviewed design and bounded task interfaces below. Use test-driven development, with a fresh whole-change review after integration.

**Goal:** Build the reviewed calendar scheduler, private dashboard/downloads and persistent two-worker deployment.

**Architecture:** One scheduler polls Google Calendar, applies pure scheduling policy and atomically feeds the existing Redis worker contract. JSON owns account/calendar controls; persistent Redis owns dispatches, results and history. Two isolated worker/Chrome pairs consume one FIFO queue.

**Tech Stack:** Existing TypeScript/CommonJS, Express, Redis, AWS S3 SDK, Node streams and `node:test`; add `google-auth-library` and an explicit TypeScript build dependency.

**Spec:** `docs/superpowers/specs/2026-11-01-calendar-scheduler-design.md`

## Global constraints

- Preserve existing worker source and the `MeetingJoinRedisParams` job contract.
- Default to two workers with separate Chrome, audio, temporary storage and processing lists; overflow stays in the shared queue.
- Poll every 60 seconds, plan every 10 seconds, default lead 60 seconds and snapshot cutoff 300 seconds.
- Redis AOF/fsync always; enqueue, remove/replace and result ingestion use atomic operations and durable identity records.
- Unknown or claimed executions never automatically rejoin. Only confirmed pending removal releases an identity.
- Owner identities are connected verified emails plus explicit aliases; explicit Skip wins over RSVP acceptance.
- Downloads require dashboard authentication and stream private S3 objects with range/resume support.
- Work in the existing feature checkout, preserving the reviewed uncommitted spec. No branch publication, real-calendar mutations or recording of real meetings during automated checks.

## Review focus

- Lost Redis replies and partial script errors must not cause duplicate joins or discard unrecorded results: Task 2.
- Cross-account RSVP, fresh/grace duplicates and group override revisions must not bypass Skip or freshness: Task 1.
- OAuth flow confusion, host/origin spoofing and unescaped calendar titles must not admit unauthorized dashboard actions: Task 4.
- Interrupted and conditional ranged downloads must not buffer entire recordings or expose storage endpoints: Task 4.
- Concurrent worker claims, private runtime mounts and scheduler readiness must preserve isolation and overflow behavior: Task 5.

## Task 1: Shared models and pure scheduling policy

**Files:** `src/scheduler/types.ts`, `links.ts`, `decide.ts`, `group.ts`, `planner.ts`, `policy.test.ts`.

**Interfaces:** `buildGroups(state: SchedulerState, now: number, maxAgeSeconds: number, aliases: string[]): MeetingGroup[]`; `plan(groups: MeetingGroup[], dispatches: DispatchRecord[], pendingPayloads: Set<string>, now: number, leadSeconds: number): PlannerAction[]`. Shared structures live in `types.ts` and are the boundary for all tasks.

- [x] Write and run failing policy tests for supported links, stable occurrence identity, owner responses, hard eligibility, grace expiry and overrides.
- [x] Implement URL parsing and policy/grouping against the shared models; preserve full dispatched URLs and original callback metadata.
- [x] Write and run failing planner tests for lead-time enqueue, later/earlier edits, confirmed removal eligibility, cancellation, group changes and claimed/unknown protection.
- [x] Implement planner actions `enqueue`, `remove`, `replace`, `annotate` and run `node -r ts-node/register --test src/scheduler/policy.test.ts` until green.

## Task 2: Durable Redis execution ledger

**Files:** `src/scheduler/queue.ts`, `queue.test.ts`.

**Interfaces:** `RedisLedger` receives an already connected Redis client, queue/result names and worker registrations. Methods: `initialize()`, `checkPersistence()`, `listDispatches()`, `pendingPayloads()`, `processingPayloads()`, `enqueue(record, replacesBotId?)`, `remove(botId, reason)`, `observe(botId, patch)`, `addAttempt(report)`, `addLog(report)`, `addRecording(payload)`, `ingestResults(limit?)`, `history()`. Return a stored record or null on a rejected enqueue/removal precondition; never mutate worker source.

- [x] Write and run failing tests against an isolated AOF Redis for duplicate enqueue, lost-reply replay, worker pickup winning removal, replacement and result ingestion.
- [x] Implement Lua operations which validate before mutation, write evidence before removing input and retain instance indexes and identity records.
- [x] Add idempotent result merging, malformed/unscheduled archives, conflicts and bounded visible history.
- [x] Verify two consumers claim distinct jobs, a third stays queued, Redis restart preserves the ledger and results, and replay never creates another job.

## Task 3: Configuration, crypto, JSON state, Google polling and runtime

**Files:** `src/scheduler/config.ts`, `crypto.ts`, `store.ts`, `google.ts`, `runtime.ts`, `index.ts`, relevant `*.test.ts`; package manifests.

**Interfaces:** `loadConfig(env): SchedulerConfig`; `SchedulerStore` exposes `read()` and serialized durable `update(mutator)`; `TokenCrypto` encrypts/decrypts refresh tokens and signs/verifies expiring cookies; `GoogleCalendar` exchanges/verifies OAuth credentials, lists calendars, polls all event pages and refreshes credentials; `SchedulerRuntime` owns `start()`, `tick()`, `stop()`, readiness and worker observations.

- [x] Install the approved dependency and TypeScript build tooling, then establish the baseline build.
- [x] Test config validation, authenticated encryption/cookies, atomic state updates and failure recovery before implementing them.
- [x] Test paginated Google reads, partial failure, missing scopes/tokens, immediate access-loss invalidation and independent calendar backoff using injected authenticated request functions.
- [x] Implement runtime boot reconciliation, isolated worker probes, source refresh/freshness and planner execution with no overlapping ticks or polls per calendar.
- [x] Expose an explicit CLI initialization action for the Redis dataset marker; ordinary startup refuses an uninitialized or unsafe ledger.
- [x] Verify using scheduler tests and `npm run build`.

## Task 4: Dashboard, authentication, callbacks and private recordings

**Files:** `src/scheduler/web.ts`, `download.ts`, `web.test.ts`, `download.test.ts`.

**Interfaces:** `createSchedulerApp({config, store, ledger, google, crypto, runtime})` returns an Express app without listening. `createRecordingDownloadHandler({config, getRecording, s3})` provides GET/HEAD handling after the app's session guard. Dependencies are the concrete shared modules, with structural test doubles permitted in tests.

- [x] Write and run failing HTTP tests for unauthenticated access, allowlisted owner login, signed state/session cookies, connect-account owner binding and POST origin/header checks.
- [x] Implement escaped server-rendered Schedule, History and Accounts views, group overrides and account/calendar management.
- [x] Test and implement strict authenticated status/log validation and raw-body webhook signatures, preserving outcome authority in Redis.
- [x] Test and implement authenticated streamed GET/HEAD, ranges, If-Range/version races, disconnect cancellation, sanitized storage errors and no exposed S3 URLs.
- [x] Verify light/dark and phone-width UI through Playwright against fixture data; ensure no live OAuth/calendar account is needed by tests.

## Task 5: Two-worker deployment, operations and final verification

**Files:** `docker-compose.yml`, `.env.example`, `docs/operations/calendar-scheduler.md`, package scripts and focused deployment tests.

- [x] Configure persistent Redis, scheduler readiness and two worker/Chrome pairs with distinct processing lists and private runtime volumes.
- [x] Document Google OAuth setup, required environment, dataset initialization, startup, adding a worker and conservative recovery. Do not replace the owner's `.env` or existing local override files.
- [x] Verify Compose configuration without using or exposing real secrets; test the scheduler end to end with fixture Google/S3 services and isolated Redis.
- [x] Run all scheduler tests, TypeScript build and non-mutating lint on added code; investigate and fix relevant failures.
- [x] Obtain a fresh independent whole-change review, resolve required findings and rerun affected checks.
- [x] Report exact checks and any real-account, real-meeting, deployed S3 or Tailscale verification still requiring configured external access. Do not claim these were exercised through fixtures.
