# Gemma screenshot speaker-name feasibility, 2026-11-04

Result: image inference works, but automatic speaker naming fails the current feasibility gate. No resolver, name mapping, feature activation or service configuration changes were made. The live meeting-bot checkout was not changed.

## Environment and method

The existing loopback Gemma endpoint reported healthy with vision/video/audio modalities enabled. Model alias: `gemma-4-e4b-it-q6`; runtime: llama.cpp `b11913-7aca0d2ea`; context: 8192; one inference slot. The user had enabled the matching projector before this test.

A saved meeting video was inspected without live screenshot collection. Twenty-one frames were extracted at quarter/mid/three-quarter positions within seven existing diarized segments spanning three speaker IDs. Extraction used actual video presentation timestamps; audio starts at zero and video starts at 0.066015625 seconds. The old benchmark does not contain reusable diarization intervals, so segment labels were used only to select samples. No reference transcript, expected participant names or diarized speaker IDs were supplied to Gemma.

A full-frame smoke request completed. Subsequent requests each contained three frames from one turn, with each frame accompanied by native-resolution name-badge, audio-indicator and sidebar crops. Input was 2187 reported prompt tokens per batch, within context allowance. Requests were sequential, temperature zero, reasoning explicitly enabled, reasoning budget512 and completion allowance1536. Only final observations, usage/settings and latency were retained; internal reasoning was discarded.

Human review read the exact displayed labels and inspected audio-bar icons. An ellipsis, blue outline or large tile was not counted as evidence of speaking. One sampled frame shows a highlighted large tile while its participant drinks and the actual audio-bar cue appears in a sidebar tile. Blue outlines alone are therefore insufficient. Reference transcript timestamps were examined separately as approximate evaluation context; they are not ground truth for precise audiovisual synchronization.

## Completed results

The full-frame smoke request finished in52.0 seconds, read two of three visible names exactly and returned no speaking name.

Three cropped batches completed, covering nine frames:

| Check | Observed result |
| --- | --- |
| Exact displayed-name strings |18/27 (66.7%)|
| Correctly detected explicit audio cues |4|
| Unsupported audio-cue reports |1|
| Missed visible audio cues |1|
| Correctly reported absence of cues |3|
| Non-null speaking-name proposals |5/9 frames|
| Exact supported speaking-name strings |0/5 proposals|
| Batch wall times |59.6s,64.5s,90.3s|
| Three-distinct-turn mapping threshold |Not satisfied for any cluster|

Errors included adding a diacritic to a visible name, inserting/substituting letters in another name, reporting a sidebar audio indicator in a frame where it was not visible, and missing audio bars in another frame. Similar-looking spellings were not silently normalized to expected participants. Multi-frame cue leakage is a possible explanation for one error; independent single-frame evaluation remains necessary. These observations do not establish reliable speaker assignment or model confidence.

## Runtime interruption and remaining gate

The fourth cropped batch lost its connection after40.8 seconds. Gemma then had exit137 with `OOMKilled=false`. The existing host memory guard journal records available memory below16777216KiB on three consecutive samples, followed by stopping guarded inference containers at12:07:12 KST. Gemma finished stopping at12:07:22 KST. It was left stopped; the guard was not bypassed and no model was restarted or reconfigured. Container memory accounting during an earlier batch showed1019MiB/12GiB, which does not capture all host/APU memory pressure.

The remaining twelve extracted frames were not completed through Gemma. The synthetic text-correction regression could not run after the endpoint stopped (`fetch failed`); this is blocked, not a passing regression. No Korean-name, duplicate/truncated-name, screen-sharing, gallery or held-out-meeting accuracy claim is made. Indicator lag and precise synchronization remain unmeasured.

Automatic naming stays disabled. A later experiment should first establish a safe memory envelope and evaluate independent single-frame/crop requests, exact OCR, cue grounding and three agreeing turns without contradictory names. Existing original/corrected transcript hashes and canonical speaker IDs remain unchanged.

Private screenshots, final observations, extraction timestamps/hashes, human review and numeric summary are retained at `/tmp/meeting-bot-vision-2026-11-04/`, with cleanup owned by the task operator after acceptance or follow-up. They are not committed to the repository. No private audio, transcript or participant labels are included in this report.

## Follow-up

The [labeled speaking-indicator experiment](2026-11-04-speaking-indicator-examples.md) completed on the Gemma instance subsequently loaded by the user. It tested isolated crops, single full screenshots, synthetic six-participant controls and a real12-participant screen-share layout. The sample did not fix full-frame misses or participant-association errors; automatic naming remains disabled.
