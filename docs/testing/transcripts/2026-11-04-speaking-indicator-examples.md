# Google Meet speaking-indicator example experiment, 2026-11-04

Result: providing a labeled indicator crop did not improve the completed crop/full-frame controls. The model still missed indicators or associated them with the wrong participant in larger layouts. Automatic speaker naming remains disabled. No production code, live meeting-bot checkout or model/service configuration changed.

## Method

The user loaded Gemma before this run. Health and vision capability were verified on the existing loopback endpoint. Model: `gemma-4-e4b-it-q6`; llama.cpp `b11913-7aca0d2ea`; temperature0, seed20261104, reasoning explicitly requested with512-token budget. Completion allowance was768 for icon/full-frame controls and1024 for multi-participant checks. Requests ran sequentially on the existing single slot; no model was started, stopped or reconfigured by the experiment.

A confirmed active Google Meet microphone/audio-bars indicator was cropped from a recorded-call frame at source bounds `[1005,73,1041,110]`. The resulting36x37 PNG has SHA-256 `b213ce7512c19595024e156da573a630e1368db19c7a81d4e730220234763847`. Its source frame was excluded from target cases.

Six separate target crops were hand-labeled: three positive speaking indicators from another participant, a camera-off tile and a sidebar tile; two ellipsis-menu controls; and one region without an indicator. Identical targets and text instructions were tested first without an image example, then with the labeled positive crop. Each request contained one target, avoiding the previous experiment's cross-frame batching. The prompt explicitly distinguished vertical audio bars from horizontal ellipsis dots, muted microphones and outlines, and prohibited treating the reference as the target.

Two full recorded screenshots were also tested in both conditions: one with an explicit speaking indicator previously missed by the model, and one without an explicit indicator. Targets did not include the reference frame.

The user's additional multi-participant check used the labeled reference in all four cases. Three controlled synthetic six-tile fixtures contained zero, one or two active indicators. Fixtures used generic names/initials and genuine held-out UI indicator/menu crops, with expected speaker positions established before inference. They are synthetic controls, not recordings of live calls.

The fourth case was a different real recorded Google Meet screen-share layout. The UI showed12 participants, with an `8 others` hidden group, two visible human tiles and a truncated assistant label. The model received the full screenshot plus a native-resolution sidebar detail of that same frame. The presentation banner and shared content were explicitly excluded as speaking evidence. Expected names and the expected speaker set were never supplied to Gemma.

## Results

| Check | Without reference | With labeled reference |
| --- | --- | --- |
| Separate indicator crops |6/6 correct|6/6 correct|
| Full recorded screenshots |1/2 correct|1/2 correct|
| Median crop request latency |31.2s|33.9s|
| Median full-frame request latency |67.6s|76.9s|

Both full-frame conditions missed the positive indicator and correctly returned no speaker for the negative frame. The perfect crop baseline is a ceiling result: it does not show that examples can never help, only that this example added no measured benefit on these targets.

| Multi-participant case, all with reference | Observed result |
| --- | --- |
| Six tiles, no active indicators |Correct: empty speaker set|
| Six tiles, one active indicator |Incorrect: missed the speaker|
| Six tiles, two active indicators |Incorrect: one speaker correct, the second assigned to a neighboring tile|
| Real12-participant screen share plus sidebar crop |Correct visible speaker name, but hidden participants were not marked unresolved|

Exact speaker sets were correct in2/4 multi-participant cases. Hidden/group handling was correct in3/4. All responses in this set reported `uncertain:false`, including wrong assignments, so that field must not be treated as reliable confidence. The real-call tile location was described relative to the detail crop; absolute bounding-box accuracy was not evaluated. Multi-participant request times were67.0-86.4 seconds, median71.6 seconds.

Twenty inference requests completed successfully: twelve crop classifications, four full-frame checks and four multi-participant checks. Final outputs were complete (`finish_reason: stop`) and parsed as structured JSON; Markdown fences were removed only as an outer wrapper. No incomplete response was salvaged. Internal reasoning was discarded.

## Operational clarification and limits

The40GiB `llm.slice` value is the aggregate inference memory cap. A separate existing memory guard has a16GiB host-available-memory threshold. `modelctl` normally uses4GiB admission headroom; an earlier conservative check explicitly requested16GiB, which refused admission with approximately25GiB available. That refusal did not establish that Gemma could not load. This run used the model the user had already loaded and changed none of these settings.

Gemma remained healthy after the run; final host available memory was approximately17.3GiB. The existing guard was neither bypassed nor modified. The live meeting service was not restarted or reconfigured.

These small tests do not establish reliable screen-based speaker naming. Remaining gaps include full-frame localization, correct indicator-to-tile association, hidden/truncated participant handling, Korean-name OCR, duplicate names, more real gallery layouts and synchronized diarized-turn validation. The real-call success also used a sidebar detail crop, so it is not evidence that an uncropped screenshot suffices. No automatic speaker map or annotation was published.

Private frames, cropped reference/targets, controlled fixtures, prompts, final outputs, token usage, hashes, timing and comparison summaries are retained at `/tmp/meeting-bot-vision-2026-11-04/indicator-example/`. They are not committed. Cleanup belongs to the task operator after follow-up or acceptance.

## Qwen comparison

The [Qwen2.5-VL-3B Q6_K follow-up](2026-11-04-qwen-vl-validation.md) reused these fixtures and added separately labeled crop/format diagnostics. It did not pass the automatic speaker-naming gate.
