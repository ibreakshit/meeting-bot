# Transcript deployment validation, 2026-11-04

Transcription and correction are enabled for new successful uploads. This initial deployment used `/home/ibreakshit/orca/releases/meeting-bot/transcription-15e8c95-20261104T120631Z`; an enabled user systemd unit, `meeting-bot-transcription.service`, processes the host queue. The meeting-drawer follow-up below records the current scheduler release. [Operational commands and rollback](../../operations/calendar-scheduler.md#host-transcription) describe this installation.

## Deployment scope

The isolated release combines feature commit `15e8c95`, the Python fixes described below, and the live checkout's existing scheduler changes. Three-way merging preserved the live History titles and failure/recovery behavior while adding the transcript drawer. The live checkout's 13 modified/untracked source files were hashed before deployment and retained unchanged. Only the scheduler container was recreated. Recording workers, Chrome pairs, Redis and RustFS were not restarted; existing scheduler state and dependency volumes were retained.

The previous scheduler image was no longer available in the local image store. The first recreate attempt failed without stopping the old scheduler. The available image `sha256:320774059fedbf9f249816358035af9bb22e86533aeda83b1a6f2a9ac0452698` was validated against the release and existing dependencies, then pinned for deployment and rollback. Whisper was started through normal `modelctl` admission. No model was evicted and no memory guard setting was changed.

Private configuration, source provenance, before-state backup, validation scripts, logs and screenshots are retained under the release's mode-700 `.deployment` directory. Environment files and credential-bearing snapshots are not committed. The release is a preserved live-source overlay, not a claim that the main checkout was merged or cleaned.

## Actual inference

- A 355.008-second English regression recording completed the real host WhisperX pipeline in 96.77 seconds: 85 segments, 461 words and four anonymous diarization clusters. No fallback warning was emitted. Two native zero-duration word intervals were preserved; perfect word timing is not claimed.
- A structured Gemma preservation control retained grammar, fillers, negation, numbers and untrusted source text without edits. Local preflight and request usage both reported 466 input tokens. The request retained a 512-token reasoning budget and finished normally.
- Gemma processed the full English transcript with zero proposed or applied edits. The known lexical error `gloomit` remained. This verifies successful conservative publication, not useful correction recall or broad correction accuracy.
- A separately labeled, manually specified `gloomit` to `Google Meet` control exercised real one-to-two-word alignment. It reused saved diarization, retained the original hash, produced consistent nested/top-level word arrays, and obtained native timings of 175.54-175.70 and 175.74-175.86 seconds. This was not a model proposal and was not published as one.
- A separate 20-second Korean sample completed with four original ASR segments. The installed cache has no supported Korean alignment model. Word alignment is unavailable, and the persisted warning explicitly says only original ASR segment timing is available. Korean correction realignment and code-switched quality remain unverified.

The real runs exposed two runner defects, each reproduced before its regression fix: missing language alignment incorrectly blocked the original transcript, and centisecond native word timing could precede a millisecond source window by 1 ms. The runner now preserves original ASR with a warning when alignment assets are absent, and accepts native timing within 10 ms rounding tolerance without modifying it. Larger excursions and negative word times remain rejected.

## Deployed upload-to-History test

A private copy of the English recording was uploaded to RustFS under a unique validation key. A clearly labeled completed dispatch, `Transcription validation - recorded English fixture`, received duplicate signed completion webhooks and the same Redis result. These produced one transcript identity. No recording-worker job was enqueued and no live meeting was joined.

The persistent host worker processed this recording using the real Redis queue, private S3 artifacts, WhisperX and Gemma. An authenticated Playwright browser observed these actual states:

| UTC time | Original | Correction | Displayed version |
| --- | --- | --- | --- |
| 12:25:38 | queued | pending | Original |
| 12:26:38 | running | pending | Original |
| 12:28:23 | ready | running | Original |
| 12:28:58 | ready | ready | Corrected |

The original was available about 35 seconds before correction finished. Original/corrected version switching and all eight JSON/TXT/SRT/VTT downloads succeeded. The original download matched its published SHA-256. Unauthenticated access returned 401. Desktop 1280x900 and mobile 390x844 screenshots were inspected, Escape restored focus, and no browser page errors occurred. The Browser plugin was unavailable, so an isolated Playwright profile was used. An owner session was signed with the existing secret for this test; Google OAuth login itself was not repeated.

A correction-only retry through the deployed CLI created a second correction revision. During retry the original remained downloadable with the same hash. After retry its revision/hash were unchanged, and the prior correction artifact remained readable. Test recordings and artifacts are retained privately for operator review.

## Automated verification and remaining limits

The merged release passed 40/40 transcription tests, 114/114 scheduler tests, 10/10 Python runner tests, TypeScript build, scheduler lint and transcription lint. The extra scheduler tests include the live checkout's existing History/recovery coverage. The Python tests include unsupported-language preservation, native rounded timing and out-of-window rejection.

This tests actual recording completion through persisted artifacts and History. Fresh Meet/Zoom/Teams admission, Tailscale browsing, OAuth reconnect, Korean word alignment and broad multilingual correction quality were not established by this run. Automatic display-name identification is deferred at the user's request; anonymous audio labels remain. Correction is enabled for evaluation, but the English fixture demonstrated zero-edit preservation and missed a known target. Originals remain immutable and accessible.

## Meeting drawer rollout, 2026-11-05 KST

The scheduler now runs from `/home/ibreakshit/orca/releases/meeting-bot/meeting-drawer-d2f8f52-20261104T145420Z`. It preserves the existing live History title, error, recovery and duration changes, replacing the two recording/transcript actions with View meeting. The drawer contains video above the transcript, uses 60% desktop width and full mobile width. Only the scheduler was recreated; recording workers, Chrome, Redis and RustFS retained their container IDs and start times. Existing scheduler state/dependency volumes were retained. The host transcription worker continues from the original release, and before-upload compression remains pending a separate recording-worker rollout.

The merged release passed 118 scheduler and 40 transcription tests, build and scheduler lint. The playback test fixture was corrected to include its persisted meeting title, matching the live History renderer. The bundled Playwright browser lacks H.264 support, so the final deployed MP4 test used isolated Google Chrome 156 from the existing worker image, without accessing recording browsers. Actual playback, seeking to 30 seconds, byte-range 206, version switching during playback, attachment download, unauthenticated 401, close/unload and focus restoration passed. Screenshots at 1920x1080 and 390x844 were inspected; no page or console errors occurred. Private results and screenshots are retained under the current release's `.deployment/validation` directory.
