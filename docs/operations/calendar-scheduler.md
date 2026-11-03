# Calendar scheduler operations

The scheduler polls watched Google Calendars and sends due Meet, Zoom and Teams jobs to one Redis FIFO queue. Two worker/Chrome pairs process separate jobs; overflow waits until a worker finishes recording, uploading and cleanup. Workers and Chrome stay on the Compose network. The dashboard binds only to `127.0.0.1:3001`.

## Configure Google and local storage

1. In Google Cloud, select a project with an OAuth consent screen already configured for production, or create a new project. Enable Google Calendar API in the selected project.
2. Keep the External OAuth consent screen **In production**. A new external project requires valid homepage and privacy-policy links before Google enables publishing; see [Google's branding requirements](https://support.google.com/cloud/answer/15549049). A private installation can use a separate client in an existing production project without changing that project's existing clients or branding. Testing-mode calendar refresh tokens expire after seven days. An unverified application can require the owner to acknowledge Google's warning; a Workspace administrator may need to allow the OAuth client.
3. Create a separate OAuth **Web application** client for the scheduler. Add these redirect URIs, substituting the actual Tailscale hostname:
   - `http://localhost:3001/auth/callback`
   - `https://HOST.TAILNET.ts.net/auth/callback`
   If using `SCHEDULER_BASE_PATH=/meeting-bot`, use `http://localhost:3001/meeting-bot/auth/callback` and `https://HOST.TAILNET.ts.net/meeting-bot/auth/callback` instead. The same dashboard path applies to both origins.
4. Copy `.env.example` to `.env` only when setting up a new installation. Preserve an existing `.env`. Fill in the OAuth client, dashboard allowlisted email, bot name, team/user IDs, and S3 configuration. Generate three independent values with `openssl rand -base64 32` for `SCHEDULER_SECRET`, `SCHEDULER_BEARER_TOKEN` and `NOTIFY_WEBHOOK_SECRET`. Keep these values private and retain the scheduler secret so existing refresh tokens remain decryptable.
5. Use the S3 uploader (`UPLOADER_TYPE=s3`, `STORAGE_PROVIDER=s3`). The scheduler needs read access to the same private bucket that workers write. Use a container-reachable `S3_ENDPOINT`; `host.internal` resolves through the host-gateway mapping on both scheduler and workers. Set `S3_USE_MINIO_COMPATIBILITY=true` when the storage server requires path-style requests. No browser CORS or public bucket is needed. The screenapp uploader is unsupported by this scheduler.

The bundled Redis has no ACL/password; leave `REDIS_USERNAME` and `REDIS_PASSWORD` empty. Compose overrides `REDIS_HOST` and `REDIS_PORT` to `redis:6379`, pins result delivery to database 0 and clears `NOTIFY_REDIS_URI`. Keep `REDIS_QUEUE_NAME`, `NOTIFY_REDIS_LIST` and `NOTIFY_REDIS_FAILURE_LIST` distinct. Do not point another installation at these result lists: this scheduler is their consumer.

Bot Settings controls the name and optional still camera image used by future and still-pending meetings. Images are private PNG assets under `/data/bot-thumbnails`; retain that directory with the scheduler state when backing up or restoring. Removing an image from settings retains earlier immutable assets for jobs that already reference them. A meeting host can disable video. Google Meet also retains its existing display-name normalization, described on the settings page.

Workers start compiled code through `npm run start:worker`, so source edits cannot automatically restart a recording. Build and deliberately recreate idle workers when deploying worker changes. `npm start` remains available for local development with automatic restarts.

Optional controls are documented in `.env.example`: lead time defaults to 60 seconds, snapshot eligibility to 300 seconds, and aliases to empty. Connected account emails and explicit aliases identify owner attendees; aliases do not grant dashboard access. `DASHBOARD_ALLOWED_EMAILS` separately controls login permission. Calendar IDs and Google's attendee `self` flag do not add owner identities.

## First startup

If upgrading the previous single-worker installation, do not recreate Redis first: that configuration disabled both AOF and snapshots, so its named volume alone does not preserve the live dataset. Pause job producers, let the old worker finish its pending jobs and uploads, and reconcile any unresolved processing entries. While the original Redis is still running, enable durable writes:

```sh
docker compose -f docker-compose.yml exec redis redis-cli CONFIG SET appendonly yes
docker compose -f docker-compose.yml exec redis redis-cli CONFIG SET appendfsync always
docker compose -f docker-compose.yml exec redis redis-cli INFO persistence
```

Wait for `aof_enabled:1`, `aof_rewrite_in_progress:0`, `aof_last_bgrewrite_status:ok` and `aof_last_write_status:ok`, then back up the dataset with writes stopped. Do not restart Redis until the initial AOF rewrite has completed successfully. Stop the old `meeting-bot` and `chrome-cdp` containers after confirming they are idle; the renamed worker services do not automatically stop Compose orphans. Preserve their existing recording/profile files. Only then follow the startup commands below with the same Compose project and `cache` volume. Investigate an unsafe or unresolved old dataset before initializing the scheduler ledger.

Use explicit `-f docker-compose.yml` to avoid accidentally applying local override files that publish worker ports or share runtime paths. These commands start the actual installation and should be run deliberately by its operator:

```sh
docker compose -f docker-compose.yml build
docker compose -f docker-compose.yml up -d redis
docker compose -f docker-compose.yml run --rm --no-deps calendar-scheduler npx ts-node src/scheduler/index.ts --init
docker compose -f docker-compose.yml up -d
```

`--init` is an explicit first-time dataset initialization. Ordinary startup refuses a missing dataset marker or unsafe Redis persistence configuration. Do not use initialization to bypass a missing or replaced execution ledger. The `cache` volume retains the existing Redis dataset; initialization does not authorize clearing it.

Redis uses AOF with `appendfsync always`, no eviction and truncated-AOF rejection. The scheduler becomes ready after loading saved controls and reconciling the ledger and unsupported pending jobs. Workers wait for scheduler readiness, their own Chrome healthcheck and Redis. Calendar refreshes then become eligible independently; one failed calendar does not hold up healthy calendars. Startup, reconnect and new watches require a complete new calendar poll before joining from saved snapshots.

Open `http://localhost:3001` (or `http://localhost:3001/meeting-bot/` when configured), sign in with an allowlisted owner, then choose **Connect account** on Accounts for each Google account. Login requests identity scopes. Connecting an account additionally requests `calendar.events.readonly` and `calendar.calendarlist.readonly`, consent and offline access to retain an encrypted refresh token. Check that the scopes and offline grant were accepted, then explicitly watch the desired calendars. Newly discovered calendars start unwatched. Connecting another account does not add it to the dashboard login allowlist.

## Tailscale access

On the host, enable Tailscale HTTPS and configure Serve to forward to the loopback dashboard, for example:

```sh
tailscale serve --bg http://127.0.0.1:3001
```

To share the HTTPS hostname with another application, set `SCHEDULER_BASE_PATH=/meeting-bot` and configure that Serve path with an upstream URL containing the same path:

```sh
tailscale serve --bg --set-path=/meeting-bot http://127.0.0.1:3001/meeting-bot
```

The reverse proxy must deliver `/meeting-bot/...` to the scheduler. The dashboard, account controls and authenticated downloads use that path. `/health`, `/v2/...` and `/hooks/...` remain at the scheduler root for existing internal healthchecks and worker callbacks.

Keep `DASHBOARD_BASE_URLS` as a comma-separated list of exact origins such as `http://localhost:3001,https://HOST.TAILNET.ts.net`, without paths. Add the full callback URLs from the Google configuration section to the OAuth redirect URI allowlist. The optional base path must be an absolute path without a trailing slash, encoded characters, empty segments or `.`/`..` segments. Empty or `/` preserves the default dashboard root. Recreate the scheduler after changing its environment:

```sh
docker compose -f docker-compose.yml up -d --no-deps calendar-scheduler
```

Keep this tailnet-only; do not enable Funnel or publish S3, worker HTTP or CDP ports. Log in separately on each dashboard origin so its browser has the right session cookie. Download links remain authenticated dashboard routes and never redirect to storage URLs.

## Routine operation and recovery

`docker compose -f docker-compose.yml logs calendar-scheduler` shows startup and dispatch diagnostics. Schedule shows source freshness, worker observations, queue delays and changes after pickup. History distinguishes uploaded recordings, permanent failure and unresolved execution; an HTTP `finished` callback alone is not an upload outcome. `/health` returns ready only after reconciliation. Keep all processing-list registrations until their outstanding jobs are resolved, even if a worker has been taken out of service.

A temporary calendar polling failure can use a verified snapshot only before its age reaches the configured cutoff. At the cutoff, pending jobs without another eligible source are withdrawn when exact removal wins. Access loss, unwatch and disconnect disable a source immediately. Successful refresh can restore a removed, unclaimed meeting if it is still due. Overrides cannot bypass freshness or other hard eligibility checks.

A pending edit can replace the exact queued payload, while a move outside the lead window removes it until due. Once claimed, a job cannot be recalled by Join, Skip or calendar edits. Unknown, failed and completed jobs continue to own their meeting identities. An unreachable, restarted or idle worker is insufficient evidence that another bot can safely join. Investigate the associated worker logs, processing entry, browser and upload result before any manual recovery. The initial scheduler provides no automatic retry or recovery action for an uncertain execution.

Preserve `cache`, `scheduler-state`, worker profile/temporary/debug volumes and each Chrome profile. The scheduler state volume holds encrypted account credentials and controls; Redis holds the durable execution ledger. Stop/start or recreate services without `down -v`, volume deletion or anonymous replacement datasets. Keep the Compose project name stable so named volumes continue to refer to the same data. Back up both controls and Redis consistently while writes are stopped, along with the scheduler encryption secret. Restoring an old or incomplete ledger, a missing marker, AOF corruption or disk write failure requires owner reconciliation before dispatch resumes. Do not delete processing entries or reset indexes merely because a worker is no longer responding.

The scheduler's source bind is for development. Workers use compiled code and dependencies from their image, with `dist/_tempvideo`, `.chrome`, `debug-videos` and `assets/screenshots` on private named volumes. Host build output is not required for worker startup. Each Chrome sidecar has its own profile. Display servers, PulseAudio sockets and runtime directories stay container-local. Do not replace those mounts with shared host paths. Stop a worker gracefully after its current recording/upload/cleanup before reducing capacity; stopping the scheduler alone does not pause workers that are already running.

## Add a third worker

Create `compose.scale.yml` with an explicit third pair using the existing local images. Anchors in the base file are local to that YAML document, so this override spells out its settings:

```yaml
services:
  meeting-bot-3:
    image: meeting-bot:local
    platform: linux/amd64
    restart: unless-stopped
    env_file: [.env]
    environment:
      NODE_ENV: development
      REDIS_HOST: redis
      REDIS_PORT: "6379"
      REDIS_CONSUMER_ENABLED: "true"
      REDIS_QUEUE_NAME: ${REDIS_QUEUE_NAME:-jobs:meetbot:list}
      REDIS_PROCESSING_QUEUE_NAME: jobs:meetbot:processing:3
      GOOGLE_CHROME_CDP_URL: http://chrome-cdp-3:9223
      GOOGLE_CHROME_USER_DATA_DIR: /usr/src/app/.chrome/google-meet-profile
      GOOGLE_CHROME_STORAGE_STATE_PATH: ""
      AUTH_BASE_URL_V2: http://calendar-scheduler:3001/v2
      NOTIFY_WEBHOOK_ENABLED: "true"
      NOTIFY_WEBHOOK_URL: http://calendar-scheduler:3001/hooks/recording-completed
      NOTIFY_REDIS_ENABLED: "true"
      NOTIFY_REDIS_URI: ""
      NOTIFY_REDIS_DB: "0"
      NOTIFY_REDIS_LIST: ${NOTIFY_REDIS_LIST:-jobs:meetbot:recordings}
      NOTIFY_REDIS_FAILURE_LIST: ${NOTIFY_REDIS_FAILURE_LIST:-jobs:meetbot:failures}
    extra_hosts: ["host.internal:host-gateway"]
    expose: ["3000"]
    command: ["/bin/bash", "./start.sh"]
    volumes:
      - worker-3-profile:/usr/src/app/.chrome
      - worker-3-recordings:/usr/src/app/dist/_tempvideo
      - worker-3-debug:/usr/src/app/debug-videos
      - worker-3-screenshots:/usr/src/app/assets/screenshots
    depends_on:
      redis: {condition: service_healthy}
      calendar-scheduler: {condition: service_healthy}
      chrome-cdp-3: {condition: service_healthy}
  chrome-cdp-3:
    image: meeting-bot-chrome:local
    platform: linux/amd64
    restart: unless-stopped
    shm_size: "1gb"
    expose: ["9223"]
    volumes: ["chrome-3-profile:/tmp/chrome-profile"]
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:9223/json/version"]
      interval: 5s
      timeout: 3s
      retries: 20
volumes:
  worker-3-profile:
  worker-3-recordings:
  worker-3-debug:
  worker-3-screenshots:
  chrome-3-profile:
```

Set the registry in `.env` with one JSON array on one line:

```dotenv
SCHEDULER_WORKERS=[{"id":"1","baseUrl":"http://meeting-bot-1:3000","processingQueue":"jobs:meetbot:processing:1"},{"id":"2","baseUrl":"http://meeting-bot-2:3000","processingQueue":"jobs:meetbot:processing:2"},{"id":"3","baseUrl":"http://meeting-bot-3:3000","processingQueue":"jobs:meetbot:processing:3"}]
```

Worker IDs, endpoint origins and processing queues must be unique. The environment processing name must exactly match the registry. Recreate the scheduler and start the new pair with both Compose files. All consumers still use the same pending queue; no worker code or routing changes are needed. Check host CPU, memory, disk and encoding headroom before increasing simultaneous capacity.

```sh
docker compose -f docker-compose.yml -f compose.scale.yml up -d calendar-scheduler chrome-cdp-3 meeting-bot-3
```

## Verification boundaries

The focused deployment test runs `docker compose config` with a temporary harmless interpolation file and `--no-env-resolution`, so it neither reads the real `.env` nor starts or changes containers. It verifies Redis persistence settings, startup dependencies, private mounts and internal ports:

```sh
node -r ts-node/register --test src/scheduler/deployment.test.ts
```

Configuration and fixture tests do not verify the deployed installation. Before relying on recordings, verify OAuth login/connect from localhost and Tailscale, real Meet/Zoom/Teams admission, queued edits and cancellation, overrides across connected accounts and aliases, and callback/result delivery. Run simultaneous distinguishable recordings and inspect both files for audio/video interference, repeat same-provider concurrency and overflow, and verify a third configured worker. Exercise the actual S3-compatible server's range and conditional reads, interrupt/resume downloads, compare file hashes, and measure time to first byte, throughput and bounded scheduler memory over localhost and Tailscale while workers are active. These checks require configured accounts, permitted test meetings, deployed storage and a real tailnet client; fixture success does not establish them.

### Host transcription (feature validation pending)

`TRANSCRIPTION_ENABLED=true` queues recordings accepted after the persisted activation time. It does not backfill history. Keep `TRANSCRIPTION_CORRECTION_ENABLED=false` until the structured prompt passes preservation evaluation. The host worker needs Redis/S3 credentials and WhisperX paths, without Google OAuth settings. Set `TRANSCRIPTION_REDIS_URL` to the loopback port actually published by Compose (`REDIS_PORT_HOST`, default 6379). Keep that port bound to loopback.

Run `modelctl status` before scheduling inference. The worker does not start, stop or reconfigure model services. Run `npm run start:transcription` from this checkout to process one job at a time. Inspect a known identity with `npm run transcription:status -- --job-id ID`. Retry only correction with `npm run transcription:retry -- --job-id ID --stage correction`; it starts from the immutable original and creates a new revision. Active ownership prevents concurrent retries. SIGTERM cancels the process group; expired ownership makes interrupted jobs reclaimable after 120 seconds. Transient service/storage failures persist retries at 5 and 30 seconds, for three attempts total.

Original artifacts are published before correction. Failed correction leaves original downloads and any prior successful correction available. Source location/content conflicts require operator investigation. Artifacts remain private under `meeting-bot/transcripts/`; there is no automatic deletion or historical backfill. Unreferenced uploads from interrupted attempts remain private. Real-model English/Korean alignment, tokenizer parity and correction quality remain unverified until an isolated inference window is available. Speaker name enrichment is disabled: the configured Gemma service lacks a multimodal projector.
