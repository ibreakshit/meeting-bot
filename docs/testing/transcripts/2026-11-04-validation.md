# Transcript feature validation, 2026-11-04

This records the initial isolated implementation checks. The subsequent [deployment validation](2026-11-04-deployment.md) records real inference, fixes and the now-enabled installation.

Implementation is on `ibreakshit/feat-transcription`. Nothing was deployed, activated or changed in the main checkout or model deployments. Both feature flags default to false. Tests use isolated Redis containers, a loopback HTTP object-store fixture, synthetic audio metadata/inference doubles and fresh Playwright profiles. No private audio or transcript is committed.

Verified behavior includes duplicate recording delivery, activation eligibility, conflicting locations, lease reclamation, stale-owner publication rejection, host-wide serialization, persisted attempt limits, immutable original publication, correction-only retries without ASR, previous successful revision retention, source-content hashing, cancellation, empty Redis warning arrays, printed/logged CPU fallback retention, Unicode patch offsets, numerical/negation preservation and fresh speaker labels after realignment. Mocked inference establishes orchestration behavior, not model accuracy.

The fresh independent reviewer found four important issues: lost fallback warnings, incorrectly classified correction-retry failures, insufficient preservation checks and unabortable artifact storage. All received regression fixes. Mixed-speaker corrected source windows now show the freshly assigned speaker IDs joined with `/`; native timed words retain individual labels. Exact canonical character boundaries are not invented. Conservative preservation checks can defer valid punctuation or number-word edits; their supported word lists are in `src/transcription/patches.ts` and require multilingual evaluation.

Run `npm run test:transcription`, `npm run test:scheduler`, `npm run lint:scheduler`, `npx eslint 'src/transcription/**/*.ts' --max-warnings 0`, `npm run build` and `~/Workspace/whisperx/.venv/bin/python -m unittest discover -s scripts/transcription -p 'test_*.py'`. Desktop, 390px mobile and dark-mode History drawer screenshots were visually inspected. Browser checks cover exact-original tooltips, version switching, inert HTML-like content, Korean wrapping, focus restoration/containment and polling that preserves an explicit Original selection. The Browser plugin was unavailable; Playwright supplied browser verification.

Final automated results: 40/40 transcription tests, 108/108 scheduler tests and 7/7 Python tests passed. Build, both lint commands and diff whitespace checks exited 0. The injected CPU-warning test intentionally prints the retained warnings.

## Acceptance blockers

- Read-only `modelctl status` showed Whisper and Gemma stopped. They were left stopped to protect the live workload. Real transcription, realignment, backend/duration benchmarking, tokenizer count parity, reasoning-budget behavior and structured correction quality remain unverified. Automatic correction remains disabled pending those checks.
- English and Korean/code-switched cached language assets have not been verified by inference. Missing support must leave original transcripts accessible with an explicit correction limitation. No held-out recording has been evaluated.
- At the original validation, speaker-name feasibility was blocked because Gemma lacked a projector. The user subsequently enabled vision; the [follow-up vision experiment](2026-11-04-vision-validation.md) verified image inference but failed exact-name/cue accuracy and was interrupted by the host memory guard. A single representative saved-video frame has readable display labels and a blue tile outline; this does not establish a reliable speaking cue or name assignment. Video starts at 0.066016 seconds, so synchronization needs explicit testing. No automatic name mapping was implemented or enabled.
- A real recording-to-artifacts-to-authenticated-History acceptance run is still required in an isolated inference window. Passing deterministic tests does not satisfy that real-model gate.

Private frame evidence and synthetic UI screenshots remain outside the repository. The WhisperX fork was inspected read-only and its Git status remained clean. Main-checkout uncommitted work was preserved.
