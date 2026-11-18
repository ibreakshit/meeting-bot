# Meeting transcripts and correction implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` for task-by-task execution unless the user chooses delegated execution. Steps use checkboxes for tracking. This document plans the build; it does not authorize deployment or claim implementation is complete.

**Goal:** Automatically generate original and Gemma-corrected, word-aligned, speaker-labeled meeting transcripts, preserve both, and expose them in a right-side History drawer with corrections highlighted and original wording available on hover.

**Architecture:** The scheduler durably queues transcription after accepting recording completion. A single host worker downloads the recording, invokes a small Python runner importing the existing WhisperX fork, calls the existing local Gemma service, and publishes versioned artifacts to the configured private S3-compatible storage. The dashboard reads saved artifacts through authenticated routes; it never runs inference during a request.

**Tech stack:** Existing TypeScript/Node, Redis, AWS S3 SDK, Express, server-rendered HTML/CSS/JavaScript, node:test and Playwright; Python from the existing WhisperX virtual environment; existing Vulkan Whisper, CrispASR, Nemotron and llama.cpp services. No new frontend framework, inference HTTP service, agent framework or queue framework.

**Spec:** The agreed requirements are recorded in the next section. Supporting experimental evidence is `/tmp/whisperx-findings-2026-11-04-gc7zm7fq/REPORT.md`; durable source artifacts are under `/home/ibreakshit/Workspace/whisperx/docs/testing/meetgeek-3aad7a74/`. The temporary report may disappear, so all implementation-critical decisions are included here.

## Agreed behavior

- Produce transcription, word alignment and speaker diarization for completed recordings.
- Keep all new integration and Gemma correction code in `meeting-bot`. No planned edits to the WhisperX fork.
- Preserve the original WhisperX JSON, TXT, SRT and VTT. Save corrected JSON, TXT, SRT and VTT separately, with an audit of proposed, applied, rejected and unresolved corrections.
- Corrected wording receives fresh word alignment and speaker assignment using saved diarization intervals. Never pretend old word boundaries describe replacement text.
- Add **View transcript** alongside recording actions in History. Open a drawer from the right, leaving the list underneath and preserving scroll position.
- Default to the latest successfully published **Corrected** version. Highlight changed spans; hovering shows **Original: <exact source text>**. Keyboard focus and tapping expose the same information.
- Provide a **Corrected / Original** toggle for whole-transcript comparison. Display timestamps and speaker labels in both versions.
- When correction is pending or fails, keep the original accessible and explain its status. Never silently label an original transcript as corrected.
- Close with the close button, Escape or the backdrop; restore focus to the originating button. Use a full-width drawer on narrow screens.
- Evaluate speaker display names from recorded meeting UI frames using Gemma vision. Name assignment requires visible name labels plus reliable speaking indicators synchronized with diarized audio; inconclusive speakers retain their original IDs. This addition has a feasibility gate in Task 9.

## Global constraints

- Original artifacts are immutable after publication. Correction reruns create new revisions and do not replace prior successful revisions.
- Follow the existing private-storage and dashboard authentication patterns. Do not return storage credentials, internal model URLs, raw prompts or reasoning traces to the browser.
- Use Gemma 4 E4B IT Q6_K, alias `gemma-4-e4b-it-q6`, with reasoning explicitly enabled. The recorded service base is `http://127.0.0.1:8091/v1`; Whisper is `http://127.0.0.1:8090`.
- Start with temperature 0, reasoning budget 512 tokens and total completion allowance 2048 tokens, with actual runtime settings recorded. Service defaults have reasoning disabled, so verify the per-request setting.
- One correction inference call per fitting conversation or owned chunk. No detector model, tagging pass, recursive correction loop or Hunspell.
- Prompt explicitly: **Do not fix grammar.** Preserve meaning, turns, ordering, fillers, repetitions, numbers and negation. Flag suspected hallucinated sentences rather than deleting them.
- Model output is a proposal, not ground truth. Structural validation cannot establish that a replacement is true.
- Run one local transcription/correction job at a time initially. Do not automatically stop unrelated models or alter the model service deployment.
- CPU fallback is allowed only with a prominent retained warning. Preserve existing Vulkan diagnostics and never infer the neural backend from the installed Torch package alone.
- Use stable source identifiers and Unicode code-point offsets. Do not mix JavaScript UTF-16 offsets with Python string offsets.
- Current scheduler storage is S3-compatible. Azure integration, biometric identity recognition, live captions, audio playback controls, correction editing and historical backfill are outside this build. Task 9 evaluates mapping visible meeting display names to diarized speakers; it does not establish real-world identity.
- Existing uncommitted work must be preserved. At planning time this includes `scripts/start-chrome-cdp.sh`, `src/scheduler/{decide,group,policy.test,views}.ts` and `src/lib/chromeSidecar.test.ts`. Inspect again before execution; commit only owned hunks.

## Current integration points

- `src/scheduler/queue.ts`: `RedisLedger.addRecording()` accepts webhook evidence; `ingestResults()` consumes recording/failure lists using Lua. Both paths merge recording metadata. Completion currently has no transcription state.
- `src/scheduler/runtime.ts`: periodic reconciliation already exists. Reuse it for missed enqueue recovery, without coupling recording readiness to transcription health.
- `src/scheduler/views.ts`: `renderHistory()` renders the list; recording actions already include **Download recording**. Existing modal behavior is a native `<dialog>`.
- `src/scheduler/web.ts`: protected dashboard routes and base-path support already exist.
- `src/scheduler/download.ts`: private S3 recording access provides the storage-authentication precedent. Do not refactor recording streaming just to add transcripts.
- `src/scheduler/e2e.test.ts`: browser fixtures already run without real Google login.
- WhisperX `transcribe.py` sequences ASR, alignment, diarization and writers, but does not persist reusable diarization intervals. Its callable functions make a small local runner possible without editing the fork.

## Data and publication contracts

Define shared types in `src/transcription/types.ts` before building producers and consumers:

- `RecordingSource`: `{ botId, recordingId, bucket, key }`, derived from validated ledger metadata, never a client-supplied URL. Download with an ETag/version condition and record the downloaded audio SHA-256.
- `TranscriptJob`: `{ jobId, source, attempt, requestedAt }`. `jobId` is SHA-256 of a canonical tuple `[botId, recordingId, bucket, key]`. Identical webhook and Redis deliveries refer to one job.
- `TranscriptSegment`: `{ id, start, end, text, speaker?, words }`; word timing and speaker fields may be absent when the engine cannot assign them. Preserve unknown values instead of inventing timings or names.
- `CorrectionPatch`: `{ id, segmentId, start, end, original, replacement, evidence: [{ segmentId, quote }] }`. Offsets are half-open Unicode code-point positions in the immutable source segment. Use a separate `UnresolvedSpan` collection for ambiguous suggestions.
- `AppliedCorrection`: validated patch plus corrected display range `{ segmentId, start, end }`. The UI highlights exact text ranges rather than deriving changes from tokenization or model-generated HTML.
- `TranscriptManifest`: schema version, source/hash, original artifact keys/hash, diarization key, latest successful correction revision, revision metadata, stage status, safe error summary and warnings. Original state is `queued | running | ready | failed`; correction state is `pending | running | ready | failed | skipped`.
- `TranscriptView`: manifest summary, selected version/revision, canonical display segments and applied correction ranges. Excludes model requests, raw responses, storage locations and internal errors.

Save engine-native original JSON unchanged. Put stable segment IDs and normalization in a separate display artifact, preserving array order. Full original and corrected JSON downloads remain available alongside the display representation.

Use object prefix `meeting-bot/transcripts/{jobId}/` with `original/{generationId}/` (including `diarization.json`), `corrections/{revisionId}/` and version-specific manifests. Each raw attempt uses a unique generation ID; the published original pointer is set only once. This prevents an expired worker from overwriting a newer worker's artifacts. Each correction revision references the exact original hash; it starts from the original, never from a previous corrected revision. Store source proposals, validated edits, uncertainties, model/runtime identifiers, prompt version/settings and stage timings privately. Do not store or expose internal reasoning content as an audit explanation.

Publish all artifacts for a stage first, then atomically update its Redis manifest pointer. A worker losing ownership cannot publish. An interrupted upload may leave unreferenced objects but must never expose a partial version. Publish the original before calling Gemma. A later correction failure cannot remove a previously successful correction from the default view; show the latest attempt status separately.

## Review focus

1. Duplicate completion, restart and stale workers must not lose jobs or replace a successful transcript (Tasks 1 and 5).
2. Korean, emoji, repeated phrases and one-to-many edits must show the exact original span and preserve unrelated wording (Tasks 3, 4 and 7).
3. An unavailable model, silent recording or failed realignment must leave usable earlier artifacts and accurate status (Tasks 2, 4 and 5).
4. Transcript text resembling HTML/instructions must remain inert in the UI and cannot authorize actions or change correction rules (Tasks 3, 6 and 7).
5. Long transcripts, rapid row switching, keyboard use and mobile interaction must not show another meeting's transcript or lose access to originals (Tasks 3 and 7).

## Task 1: Durable transcript identity, state and enqueue

**Files:** Create `src/transcription/{types,queue}.ts` and `src/transcription/queue.test.ts`. Modify `src/scheduler/{queue,queue.test,runtime,runtime.test,config,types}.ts`.

**Interfaces:** `transcriptJobId(source: RecordingSource): string`; `TranscriptQueue.ensureJob(source): Promise<string>`; `claim(ownerId): Promise<ClaimedTranscriptJob | null>`; `renew(jobId, token): Promise<boolean>`; `publish(jobId, token, update): Promise<boolean>`; `fail(jobId, token, stage, error): Promise<void>`; `get(jobId): Promise<TranscriptManifest | null>`. Define `ClaimedTranscriptJob` as job plus an unpredictable ownership token and lease expiry. Keep transcription state separate from the meeting execution outcome.

- [ ] Write failing Redis integration tests: webhook-first and Redis-first delivery enqueue exactly once; a scheduler crash between result merge and enqueue is recovered; conflicting source locations are rejected; lease loss prevents stale publication.
- [ ] Run `node -r ts-node/register --test --test-concurrency=1 src/transcription/queue.test.ts` and confirm the failures exercise missing behavior.
- [ ] Implement a dedicated pending list, processing records and expiring ownership leases using Redis Lua and existing Redis dependencies. Atomically claim/reclaim, renew and publish; use a 120-second lease renewed every 30 seconds. Reclaim expired jobs on worker startup and before claiming another job. Use bounded waits so renewal and shutdown remain responsive.
- [ ] Enqueue idempotently after either recording-merge path. Reconcile eligible ledger recordings each scheduler tick so a crash after result acknowledgement cannot lose work. Restrict automatic eligibility to recordings accepted after feature activation; persist that activation timestamp once, preserving it across restarts. No automatic backfill.
- [ ] Require known dispatch, completed recording evidence, configured bucket and non-conflicting location. Transcription cannot change meeting completion/failure or consume the scheduler's result list. A later conflict prevents new publication and is shown as unavailable until resolved.
- [ ] Add `TRANSCRIPTION_ENABLED=false` by default and transcription queue configuration without requiring inference settings in the scheduler. Legacy records without transcription metadata still render.
- [ ] Rerun queue and scheduler runtime tests, then commit only the owned changes with `feat: queue recording transcription durably`.

## Task 2: Local WhisperX runner and preserved raw artifacts

**Files:** Create `scripts/transcription/whisperx_runner.py`, `scripts/transcription/test_whisperx_runner.py`, `src/transcription/{config,whisperx}.ts`, and `src/transcription/whisperx.test.ts`.

**Interfaces:** `runWhisperX(input: { audioPath, outputDirectory, signal }): Promise<RawTranscriptArtifacts>`; Python subcommands `transcribe --audio PATH --output-dir PATH` and, in Task 4, `realign --audio PATH --segments PATH --diarization PATH --output-dir PATH`. `RawTranscriptArtifacts` contains paths for native JSON, display JSON, TXT/SRT/VTT and diarization intervals, plus detected language and warnings.

- [ ] Write failing runner tests with injected engine functions: diarization runs once; intervals are retained; native original JSON is not amended with application IDs; silence produces valid empty output; missing timings remain absent; failure returns a nonzero exit and does not announce completion.
- [ ] Run `~/Workspace/whisperx/.venv/bin/python -m unittest discover -s scripts/transcription -p 'test_*.py'` and confirm the expected failure.
- [ ] Implement the Python runner by importing `load_audio`, `load_model`, `load_align_model`, `align`, `DiarizationPipeline`, `assign_word_speakers` and existing writers. Match the current launcher's model/device options; do not copy WhisperX internals. Save diarization intervals before speaker assignment. Assign stable display IDs from original output order.
- [ ] Configure the Node subprocess with argument arrays, no shell, and the existing Python/runtime/model paths. Mirror the documented launcher's required PATH, NeMo/CrispASR cache and FFmpeg library environment in this repo's host configuration; do not source its executable launcher or modify the fork. Keep inherited loader paths intact.
- [ ] Pass cancellation through to the Python process and its children, bound captured diagnostics, and retain prominent CPU fallback warnings. Set a configurable stage timeout initially 3600 seconds; timeout marks that stage failed without destroying published output.
- [ ] Run unit tests plus a short local audio integration fixture through the real runner after inspecting `modelctl status`. Compare the existing CLI and runner for output structure, language, speaker labels and plausible timing; record backend and stage durations. Do not claim bit-identical inference.
- [ ] Commit the passing runner with `feat: preserve aligned WhisperX transcripts and diarization`.

## Task 3: Single-pass Gemma correction and source-bound edits

**Files:** Create `src/transcription/{correction,patches}.ts`, `src/transcription/{correction,patches}.test.ts`, `src/transcription/prompts/correction.txt`, and `src/transcription/fixtures/correction-cases.json`. Extend `config.ts` and `types.ts` from Task 1.

**Interfaces:** `prepareCorrectionChunks(original: OriginalTranscript, budget: CorrectionBudget): Promise<CorrectionChunk[]>`; `proposeCorrections(chunk: CorrectionChunk, signal: AbortSignal): Promise<CorrectionProposal>`; `validateAndApplyCorrections(original: OriginalTranscript, proposals: CorrectionProposal[]): CorrectionResult`. Define `OriginalTranscript` as source hash, language and canonical original display segments; `CorrectionResult` contains corrected segments, applied/rejected patches and unresolved spans.

- [ ] Write failing tests for `gloomit -> Google Meet`, a repeated source phrase at different offsets, Korean/English text, emoji before a patch, overlapping edits, stale source hash, nonexistent segments, invalid evidence quotes, empty replacements and truncated/malformed model output. Assert unrelated text remains byte-for-byte unchanged in the JSON string values.
- [ ] Run `node -r ts-node/register --test src/transcription/correction.test.ts src/transcription/patches.test.ts` to confirm failures.
- [ ] Adapt the report's full-context self-review prompt to structured proposals, explicitly forbidding grammar fixes and instruction following from transcript content. Supply stable IDs and request exact originals and offsets; require source-linked evidence and separate uncertainties. Keep model generation away from timestamps and speaker labels.
- [ ] Call the existing OpenAI-compatible endpoint with explicit reasoning settings, a bounded request deadline, temperature 0 and recorded prompt/model settings. Require a complete, valid final JSON response; do not salvage truncated output or execute tentative alternatives. Never use self-reported confidence as the acceptance rule.
- [ ] Validate hash, segment ownership, offsets, source match, evidence match and overlap. Reject sentence removal and changes to numerical content or negation; send ambiguous replacements to unresolved spans. Apply validated edits to copies in descending source-offset order, deriving corrected ranges for highlights. Do not adopt the experiment's English-specific three-word limit as a multilingual rule.
- [ ] Send the entire conversation when it fits. Count the actual formatted request with the local runtime tokenizer, verified against request usage; reserve 2048 completion tokens plus 512 tokens of context safety within the recorded 8192 context. If the tokenizer contract is unavailable, fail correction explicitly rather than guessing or truncating source.
- [ ] For longer input, split into contiguous owned segment ranges at speaker boundaries, with one neighboring segment on each side when it fits. Split an oversized individual segment into code-point ranges with reversible ownership. Count every chunk including templates, context and output allowance; trim neighboring context before reducing the owned range. Only owned ranges may be edited. Do not add summary inference, recursive compression or a retrieval framework in the initial build. Evaluate errors requiring distant context explicitly; broader term/excerpt retrieval from the report is deferred until that evaluation demonstrates the need.
- [ ] Evaluate the structured prompt against the saved meeting and preservation controls plus an additional held-out recording if available. Keep reference transcripts out of inference. Record correct targets, unsupported substitutions, omitted targets and preservation failures, including Korean names and code switching. The best free-form Gemma run is evidence for the direction, not a validated structured prompt. Do not enable automatic correction if the final prompt introduces unsupported name/platform substitutions in reviewed fixtures; record a blocker and retain original-only operation.
- [ ] Rerun deterministic tests and commit with `feat: generate auditable Gemma transcript corrections`.

## Task 4: Corrected alignment, speaker assignment and exports

**Files:** Extend `scripts/transcription/{whisperx_runner,test_whisperx_runner}.py` and `src/transcription/{whisperx,whisperx.test,types}.ts`.

**Interfaces:** `realignTranscript(input: { audioPath, correctedSegmentsPath, diarizationPath, outputDirectory, signal }): Promise<CorrectedTranscriptArtifacts>`. Corrected artifacts contain timed JSON/TXT/SRT/VTT and a canonical display artifact retaining source segment IDs and applied correction ranges.

- [ ] Write failing tests where one word becomes two, punctuation changes sentence splitting, a corrected phrase crosses a speaker boundary, a word cannot be aligned, and correction contains no edits. Verify source JSON hashes remain unchanged.
- [ ] Run Python runner tests and `src/transcription/whisperx.test.ts`; confirm failures before implementing realignment.
- [ ] Implement `realign` using corrected segment text within original audio windows. Reuse saved audio-relative diarization intervals, call `assign_word_speakers` again, and regenerate nested words and top-level `word_segments` together. Never rerun ASR or speaker detection for correction-only retries.
- [ ] Keep canonical display text and patch ranges separate from alignment-generated sentence splitting. Map aligned words back to their source segment by processing each original segment window with an explicit ID; preserve absolute audio timestamps. Validate the mapping before publishing. Export through WhisperX writers.
- [ ] If no edits were accepted, create a separately identified corrected revision referencing unchanged timing content and an empty edit log. Missing timing is represented as unavailable; no fabricated split boundaries. Fatal alignment failure leaves the original and previous successful corrected revision available, with this revision unpublished and failed.
- [ ] Test language-aware alignment with English and Korean/code-switched fixtures. The benchmark only established the cached English aligner; verify actual local language support before claiming it. If required language assets/runtime support are absent, retain original text and a visible alignment limitation rather than silently using English timings.
- [ ] Rerun tests and a real one-to-two-word correction smoke test, then commit with `feat: realign corrected transcripts and retain speaker timing`.

## Task 5: Host worker, private artifact storage and recovery

**Files:** Create `src/transcription/{storage,worker,index}.ts`, `src/transcription/{storage,worker}.test.ts`. Extend `src/transcription/{config,queue}.ts`, `package.json`, `.env.example`, `docs/operations/calendar-scheduler.md` and, only if necessary for safe loopback Redis access, `docker-compose.yml`.

**Interfaces:** `TranscriptStorage.downloadRecording(source, destination, signal): Promise<SourceFingerprint>`; `uploadArtifacts(jobId, revisionId, artifacts): Promise<ArtifactManifest>`; `readView(manifest, version): Promise<TranscriptView>`; `processTranscriptJob(claim: ClaimedTranscriptJob, deps: WorkerDependencies): Promise<void>`. Define dependencies explicitly as queue, storage, WhisperX, correction, clock and cancellation capabilities, without a generic workflow engine.

- [ ] Write failing integration tests for a worker dying after original upload, dying after corrected uploads but before pointer publication, stale lease completion, storage version change, a down Gemma endpoint and a correction-only retry. Assert no duplicate original publication and no modification of meeting outcome.
- [ ] Run `node -r ts-node/register --test --test-concurrency=1 src/transcription/storage.test.ts src/transcription/worker.test.ts` and confirm failures.
- [ ] Implement streaming downloads from the configured bucket with version/ETag checks and content hashing, private job directories and versioned artifact uploads. Check ownership before publication and conditionally publish through Redis. Clean local job files only after safe publication or cancellation cleanup; keep original storage artifacts permanently until an explicit retention policy exists.
- [ ] Implement sequential stages: acquire job, download, raw pipeline, publish original, propose/validate correction, realign, publish corrected revision, acknowledge. A correction failure only affects correction status. On restart, reuse a verified published original and diarization; do not rerun the raw pipeline unnecessarily.
- [ ] Retry transient storage/network failures up to three attempts with delays of 5 and 30 seconds; persist attempt and next-attempt time so process restart cannot reset the limit. Invalid patches, source conflicts and unsupported language are not automatic retry candidates. Model reasoning must not be retried as a self-correction loop.
- [ ] Add host commands `npm run start:transcription` and `npm run transcription:retry -- --job-id ID --stage correction`. Retry acquires the same ownership mechanism, resumes from immutable original artifacts and creates a new correction revision. Explicit commands may request a new attempt after a terminal failure; no automatic historical backfill.
- [ ] Configure worker-specific Redis/S3 settings, Python/WhisperX/runtime paths, model URLs and timeouts without requiring Google OAuth secrets. Keep host Redis bound to loopback and account for the actual Compose port. Confirm services with `modelctl status`; do not automatically start/stop or reconfigure unrelated models.
- [ ] Run worker tests, `npm run build`, and a fixture recording-completion-to-artifact integration run. Update the existing operations guide with exact startup, status, correction retry and failure recovery commands; commit with `feat: process and store meeting transcripts asynchronously`.

## Task 6: Authenticated transcript view and downloads

**Files:** Create `src/scheduler/transcripts.ts` and `src/scheduler/transcripts.test.ts`; modify `src/scheduler/{web,web.test,index}.ts` and the transcription storage reader.

**Interfaces:** `createTranscriptHandlers({ getRecording, transcriptQueue, transcriptStorage })` returns view and download handlers. Add `GET /recordings/:botId/transcript?version=corrected|original` and `GET /recordings/:botId/transcript/download?version=corrected|original&format=json|txt|srt|vtt` beneath the existing configured dashboard base path.

- [ ] Write failing HTTP tests for unauthenticated access, an unknown meeting, source conflict, invalid version/format, missing artifact, pending correction, failed correction with original available and a previous successful corrected revision. Verify existing dashboard session authorization and base-path behavior apply.
- [ ] Run `node -r ts-node/register --test src/scheduler/transcripts.test.ts src/scheduler/web.test.ts` and confirm failures.
- [ ] Implement lookup from the authenticated bot ID through known ledger recording identity and the saved manifest. Never accept an arbitrary object key or remote URL. Use bounded schema-validated JSON reads and private response caching policy; set attachment content types for downloads and return sanitized errors.
- [ ] Return both stage states, selected version, selected revision and warnings in the view response. When corrected output is unavailable, return the original with explicit fallback metadata. Never expose proposed-but-rejected edits as accepted highlights. Keep full raw model artifacts inaccessible to the dashboard.
- [ ] Add safe tests for transcript strings containing HTML, URLs and instruction-like content. Fetch larger transcripts only when the drawer opens, not while rendering History.
- [ ] Rerun the HTTP tests and commit with `feat: serve private original and corrected transcripts`.

## Task 7: History drawer and accessible correction comparison

**Files:** Modify `src/scheduler/{views,icons,e2e.test}.ts`; create `src/scheduler/transcriptView.ts` and `src/scheduler/transcriptView.test.ts` for drawer-specific markup/styles/client script. Keep existing view infrastructure and styling conventions.

**Interfaces:** `renderTranscriptDrawer(): string`, `transcriptDrawerStyles: string`, `transcriptDrawerScript(basePath: string): string`. History rows provide bot ID and title on their **View transcript** button. The script consumes `TranscriptView` from Task 6 and renders text with DOM text nodes, never model-supplied HTML.

- [ ] Add a failing Playwright flow: History button opens a right-side drawer; corrected is selected; a `Google Meet` highlight exposes `Original: gloomit` on hover and focus; Original switches the entire content; closing restores row focus and list scroll.
- [ ] Run `node -r ts-node/register --test --test-concurrency=1 src/scheduler/e2e.test.ts` with the existing fixture services and verify the intended UI assertion fails.
- [ ] Implement a native modal `<dialog>` anchored right, desktop width `min(680px, 100vw)`, full height, internal scrolling and a fixed header containing meeting title, version selector and close button. At widths below 640px use the full viewport. Match existing dashboard colors, spacing, typography and light/dark behavior; respect reduced motion.
- [ ] Render speaker turns and timestamps. Use exact corrected ranges for subtle text highlights with a visible non-color cue. Give each changed span an accessible description and a tooltip/popover available on hover, focus and tap; keep it visible while pointer/focus is inside it. Support many-to-one and one-to-many corrections without guessing word boundaries.
- [ ] Show **Original transcript**, **Correction pending**, **Correction failed**, **No corrections made**, loading, missing transcript and retrieval failure states as appropriate. A disabled corrected toggle explains why it is unavailable. Provide JSON/TXT/SRT/VTT downloads for the selected published version.
- [ ] Abort obsolete requests and guard responses with the selected bot ID/version/revision so rapid row or version changes cannot overwrite the current drawer. Fetch status every five seconds only while a pending drawer is open, stop on close or terminal state, and never override an explicit Original selection when correction becomes ready.
- [ ] Add browser checks for keyboard focus containment, Escape, tap interactions, tooltip clipping, long Korean/English lines, dark mode, 390px mobile width, long transcript rendering, preserved history position and HTML-like text. Capture desktop/mobile screenshots and inspect them visually.
- [ ] Run the focused view tests and browser suite; commit only owned view hunks with `feat: add transcript comparison drawer to History`.

## Task 8: End-to-end acceptance and handoff

**Files:** Create `src/transcription/integration.test.ts`; extend existing scheduler browser fixtures as needed; update the existing operations guide with observed limitations. Store retained validation evidence under `docs/testing/transcripts/` only when useful to the handoff, never in the repository root. Keep private meeting audio/transcripts out of committed fixtures.

- [ ] Add and run an integration test with isolated Redis, fixture object storage and deterministic inference subprocess/model doubles: duplicate recording delivery produces one job, original becomes viewable before correction completes, corrected output is realigned, and the drawer renders its source-linked highlights.
- [ ] Run all focused tests, `npm run test:scheduler`, `npm run lint:scheduler`, `npx eslint 'src/transcription/**/*.ts' --max-warnings 0`, `npm run build`, and Python runner tests. Add `test:transcription` to `package.json` for the complete Node transcription suite. Report actual exits and failures; do not call mocked inference real-model validation.
- [ ] Inspect current model state, then run a real local recording through completion, transcription, correction, realignment and the authenticated History view. Use the report's known meeting as a regression fixture only; separately evaluate held-out speech when available. Capture timings, model settings, fallback diagnostics, artifact hashes, applied/rejected edits and browser screenshots without raw reasoning or secrets.
- [ ] Verify original hashes remain unchanged across correction retry, old successful revisions remain stored, and service interruption leaves original downloads usable. Verify the full corrected JSON has consistent segment words/top-level words and timing within audio bounds; review uncertain/unaligned words explicitly.
- [ ] Confirm the WhisperX fork has no changes attributable to this implementation, unrelated meeting-bot changes are preserved, and no extra inference HTTP service or framework was introduced.
- [ ] Record any blocked real-model checks precisely, including unsupported language assets or lack of held-out evaluation audio. A passing UI test is not evidence of correction quality. Final recap lists changed files, verification outcomes and remaining blockers; do not claim deployment unless separately performed under authorization.

## Task 9: Validate and integrate visible speaker names

**Status:** Proposed addition from the user's follow-up. Run the feasibility experiment before committing to automatic naming. Tasks 1-8 remain useful without this enrichment. This stage makes additional image-analysis calls; it does not change the one-pass text-correction policy.

**Evidence:** Google documents image input for Gemma 4 E4B at https://ai.google.dev/gemma/docs/core/model_card_4. llama.cpp documents a matching multimodal projector with local model loading at https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md. At inspection, `~/Workspace/ai/serving/gemma-4-e4b-it-q6-vulkan/compose.yaml` specifies the text GGUF with no `--mmproj`, and the mounted model directory contains no projector file. Image inference on the pinned runtime is unverified. Google Meet/Zoom capture display video; Teams records X11 video. Inspect actual frames before assuming name badges and speaking indicators are visible.

**Files:** If the experiment passes, create `src/transcription/{speakerNames,speakerNames.test}.ts` and extend `src/transcription/{types,worker,storage}.ts`, `src/scheduler/{transcripts,transcriptView,e2e.test}.ts`. Save retained evaluation results under `docs/testing/transcripts/`. Enabling the local Gemma projector is a separate, explicit model-service configuration change outside this repository; this plan does not silently change that deployment.

**Interfaces:** `resolveSpeakerNames(input: { videoPath, diarizationPath, signal }): Promise<SpeakerNameResult>`. Define `SpeakerNameResult` as source video hash, mapping revision, per-speaker `{ speakerId, displayName?, status: 'supported' | 'unresolved' | 'conflicting', evidenceIds }`, and evidence records `{ id, audioTime, videoPts, frameHash, nameText, nameBounds, indicatorBounds, observedIndicator, source: 'video' }`. Observations are candidate evidence until reviewed by deterministic aggregation and evaluated against human labels.

- [ ] Inspect a representative existing meeting video for readable name badges, speaking indicators and audio/video timestamp alignment. Record frames from gallery, speaker and screen-sharing layouts when available. Start with extracted recording frames; do not add live screenshot collection if the saved video already contains the needed evidence.
- [ ] Verify a compatible E4B projector and image support in the pinned llama.cpp/Vulkan runtime. After any separately authorized service change, smoke-test a labeled screenshot through the existing endpoint, check memory/latency and rerun text correction regression cases. Image support in the model card alone does not establish local runtime capability or accuracy. Restore pre-experiment service state when appropriate.
- [ ] Select up to three non-overlapping turns of at least three seconds per diarized speaker, spread across the recording. Sample three frames from the interior of each turn, avoiding transition edges; map audio-relative times to actual video presentation timestamps and account for stream start offsets. Measure speaking-indicator lag. Short turns and overlapping speech are not automatic identity anchors.
- [ ] Ask Gemma to report visible display-name text, its bounding box and the explicit UI cue indicating speech, with an unknown result when absent. Do not infer identity from faces, choose the largest/pinned tile as the speaker, or assume the screen sharer is speaking. Crop UI regions at native readability and include enough surrounding UI to interpret the indicator; count image tokens in request limits.
- [ ] Hand-label the evaluated turns and compare name-text accuracy, wrong-name assignments, unresolved coverage and runtime. Test Korean names, duplicate/truncated labels, camera-off tiles, pinned non-speakers, screen sharing, multiple simultaneous indicators and shared-room microphones. Use controlled labeled screenshots for missing layouts, but distinguish them from live-recording evidence.
- [ ] Start with a conservative aggregation rule: a turn votes only when at least two of its three frames agree on one readable label with an explicit speaking cue; publish a cluster mapping only after three distinct turn votes agree with no competing supported name. These are initial evidence thresholds to validate, not model confidence scores or a proof of identity. Speakers without sufficient evidence stay unresolved. Never force all diarized clusters into distinct participant names or merge clusters just because names match.
- [ ] If misleading indicators, unreadable badges or synchronization error cause wrong automatic names, keep this stage disabled and report the limiting case. Consider timestamped platform DOM/accessibility speaking events only as a subsequent targeted alternative, verified on actual meeting UI; do not assume those selectors exist or add three provider adapters speculatively.
- [ ] After the feasibility gate passes, add failing tests for agreement, contradictory votes, unknown names, offset video streams and duplicated labels. Implement the resolver with bounded image calls and persisted evidence. Run it after original diarization is published and before text correction, serialized with other GPU work. Its failure must not block transcript correction or original availability. Supported labels may supply a labeled participant glossary to correction, never proof that a particular spoken word was that name.
- [ ] Publish name mappings as a separate versioned annotation, leaving raw original/corrected speaker IDs and transcript hashes unchanged. Both drawer versions can display `Jiho Kang · SPEAKER_00` when supported, and `Speaker 1` when unresolved. Show mapping uncertainty independently of lexical correction highlights. Keep downloads' canonical speaker IDs; include the separate name-map artifact for reference.
- [ ] Run the resolver tests and browser coverage showing consistent name annotations across Original/Corrected views. Record the real-video benchmark and the text-correction regression outcome before enabling automatic naming. If local vision support or reliable evidence remains unavailable, report that as this stage's blocker rather than claiming speaker naming is complete.

## Completion criteria

The core feature is complete when a newly recorded meeting automatically produces independently saved original and corrected transcripts; corrected timed outputs reflect realignment and reused diarization; duplicate delivery and worker restart do not lose or corrupt results; and History opens the requested corrected-first drawer with accurate hover originals and whole-transcript switching. Failure paths retain usable originals. All focused automated checks and a real-model end-to-end run have reported results, with language and correction-quality limitations stated explicitly. Speaker naming has its own acceptance gate in Task 9: report verified mapping accuracy and unresolved cases, or explicitly leave it blocked/disabled; core transcript success does not establish naming success.

## Planning verification

This plan was checked against the current scheduler recording ingestion, private download routes, History renderer, browser-test setup, local WhisperX callable interfaces and the supplied experimental report. All agreed requirements map to tasks above. No application code, model service or WhisperX file was changed while preparing the plan; implementation tests have not been run.
