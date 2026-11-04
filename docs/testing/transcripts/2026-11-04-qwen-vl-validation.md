# Qwen2.5-VL-3B Q6_K meeting-UI evaluation, 2026-11-04

Result: Qwen completed the matched fixtures faster than the previous Gemma run, but did not provide reliable full-layout speaker naming. A separate, simpler cropped-icon classification experiment performed well. No speaker resolver or automatic naming was enabled, and no application, model-service or guard configuration was changed.

## Environment and controls

The user loaded `qwen2.5-vl-3b-instruct-q6-vulkan`. Its existing loopback endpoint on port8094 reported healthy, vision/video enabled, model alias `qwen2.5-vl-3b-instruct-q6`, Q6_K weights,3,085,938,688 parameters,8192 context and llama.cpp `b11913-7aca0d2ea`. The model remained healthy after testing. No inference request was sent to Gemma in this follow-up.

The first20 requests reused the exact prompts, reference crop, target images, expected answers, temperature0 and seed20261104 from the [Gemma indicator-example experiment](2026-11-04-speaking-indicator-examples.md). Fixture/reference byte hashes were checked before inference. The independent reference frame was excluded from targets. Requests were sequential on the existing single slot. The768/1024 completion allowances were retained, but Gemma-specific thinking overrides were omitted. Gemma's earlier run requested512 reasoning tokens, so the observed wall times are not an identical-generation-settings speed benchmark.

## Matched fixture results

| Check | Gemma | Qwen |
| --- | --- | --- |
| Native indicator crops, no example |6/6|3/6|
| Native indicator crops, labeled example |6/6|4/6|
| Full-frame indicator boolean, no example |1/2|1/2|
| Full-frame indicator boolean, labeled example |1/2|1/2|
| Exact multi-participant speaker sets, labeled example |2/4|1/4|

The full-frame boolean rows do not imply usable complete answers: all four Qwen full-frame responses named a participant even while reporting no speaking indicator, violating the requested abstention rule. One native-crop response copied the entire answer-options string instead of selecting a valid symbol. Complete JSON syntax alone is insufficient validation.

In the synthetic six-participant controls, Qwen returned the same three first-row names for zero-, one- and two-speaker layouts. All three speaker sets were wrong. For the real12-participant recorded Google Meet screen-share frame plus sidebar detail, it returned the correct visible speaker name, but again failed to mark the hidden participant group unresolved. These are observed UI-label results, not biometric identity recognition or synchronized audio-speaker mapping.

Median Qwen request times were approximately1.0s for native crops,8.6s/8.7s for full-frame checks without/with the example, and10.2s for multi-participant checks. The corresponding earlier Gemma requests took approximately31-34s,68-77s and72s, with different reasoning settings as described above.

## Bounded diagnostic variants

Failures to select a symbol and copying of option strings justified checking response-format interpretation separately from image scale. These were separately labeled experiments, not retries silently replacing the original scores.

1. **Eightfold nearest-neighbor enlargement, original structured prompt:** twelve additional requests. Enlarging crops/reference did not fix the task:3/6 correct indicator booleans with or without the example. No original fixture was overwritten, and enlargement introduced no inferred image detail.
2. **Individual participant tiles:** eighteen requests, covering all six tiles in each synthetic layout. Tiles were cropped using known fixture geometry and enlarged2x; the positive reference remained separate. Qwen missed all three true indicators and read12/18 tile names exactly, sometimes choosing the large avatar initial instead of the small name label. The reconstructed speaker sets were correct only for the no-speaker layout. These are synthetic fixed-layout controls, not a production participant detector.
3. **Simple one-word classification:** eighteen requests. The prompt requested exactly `BARS`, `MENU` or `NONE`, without JSON fields or combined name recognition.

| Simple-label condition | Exact three-way labels |
| --- | --- |
| Native crop, no image example |5/6|
| Enlarged crop, no image example |6/6|
| Enlarged crop, labeled example |4/6|

The last condition had one menu falsely classified as speaking bars and another menu classified as neither. Its binary speaking/non-speaking accuracy was5/6, but exact three-way accuracy remained4/6. The6/6 result supports a narrow cropped-cue task with a simple prompt; it does not establish reliable participant localization, OCR or diarized speaker naming. Upscaling alone did not explain the original failures, and no general benefit from the image example was demonstrated.

## Verification and remaining gate

All68 requests completed with `finish_reason: stop`. Structured final responses were parsed only after removing a complete outer Markdown wrapper; no truncated response was salvaged. The18 simple-label responses were scored as exact output strings. Internal reasoning was not retained. Existing Gemma evidence was preserved.

Qwen remained healthy with vision enabled at the end. Host available memory was approximately14.6GiB. The guard script observed during this run used a4GiB available-memory threshold; this differs from the16GiB value recorded during the earlier Gemma experiment. No guard setting or service state was changed by this task. The live meeting-bot checkout and services were not restarted or reconfigured.

Automatic naming remains disabled. Remaining acceptance work includes robust cue localization and participant association, strict abstention/schema handling, OCR including Korean/duplicate/truncated labels, more real layouts and recordings, audiovisual synchronization and three consistent non-overlapping diarized turns per mapping. A narrow6/6 cropped-icon result is not sufficient to enable speaker names.

Private prompts, scripts, source references, frame/crop fixtures, final outputs, usage, timing and summaries are retained under `/tmp/meeting-bot-vision-2026-11-04/qwen-vl/`. Cleanup belongs to the task operator after follow-up or acceptance. No private meeting image, audio, transcript or participant name is included in this report.
