export function renderTranscriptDrawer(): string {
  return '<dialog id="transcript-drawer" class="transcript-drawer" aria-labelledby="transcript-title"><header class="meeting-header transcript-heading"><h2 id="transcript-title">Meeting</h2><button type="button" id="transcript-close" aria-label="Close meeting">Close</button></header><div class="meeting-body"><section class="meeting-processing" aria-label="Meeting processing" aria-live="polite" aria-atomic="true"><p data-processing="video">Checking video status</p><p data-processing="transcription">Checking transcription status</p><p data-processing="correction">Checking correction status</p></section><section class="meeting-recording" aria-label="Recording"><p id="meeting-video-pending" class="meeting-video-pending">The recording will appear here when it is ready.</p><video hidden id="meeting-video" class="meeting-video" controls playsinline preload="metadata" aria-label="Meeting recording">Your browser does not support embedded video. Use the recording download below.</video><p id="meeting-video-error" class="meeting-video-error" role="status" hidden>Video could not be played. Download the recording to watch it.</p><div class="actions"><a id="meeting-recording-download">Download recording</a></div></section><section aria-labelledby="meeting-transcript-title"><header class="transcript-header"><h3 id="meeting-transcript-title">Transcript</h3><div class="transcript-versions" role="group" aria-label="Transcript version"><button type="button" data-transcript-version="corrected" aria-pressed="true">Corrected</button><button type="button" data-transcript-version="original" aria-pressed="false">Original</button></div><p id="transcript-status" role="status" aria-live="polite"></p><div id="transcript-downloads" class="actions" aria-label="Transcript downloads"></div></header><div id="transcript-content" class="transcript-content" aria-busy="false"></div></section></div><div id="transcript-tooltip" class="transcript-tooltip" role="tooltip" hidden></div></dialog>';
}
export const transcriptDrawerStyles = `
.transcript-drawer{position:fixed;inset:0 0 0 auto;margin:0;width:60vw;height:100dvh;max-width:100vw;max-height:100dvh;padding:0;border:0;border-left:1px solid var(--line);background:var(--surface);color:var(--text);box-shadow:-12px 0 60px #0003;overflow:hidden}
.transcript-drawer[open]{display:flex;flex-direction:column}
.transcript-drawer::backdrop{background:#0c142880}
.meeting-header{padding:20px 28px;border-bottom:1px solid var(--line);flex:none}
.meeting-body{padding:24px 28px;overflow:auto;overscroll-behavior:contain;flex:1;min-height:0}
.meeting-processing{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:24px}
.meeting-processing p{display:flex;align-items:center;gap:8px;margin:0;padding:12px;border:1px solid var(--line);border-radius:8px;font-size:12px;line-height:1.5;color:var(--muted);overflow-wrap:anywhere}
.meeting-processing p::before{content:'';width:8px;height:8px;border-radius:50%;background:currentColor;flex:none;opacity:.5}
.meeting-processing [data-state=running]{color:var(--accent);background:var(--soft)}
.meeting-processing [data-state=running]::before{width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;background:none;opacity:1;animation:processing-spin 1s linear infinite}
.meeting-processing [data-state=failed]{color:#b42318;background:#fff3f1;border-color:#f4b4ae}
.meeting-processing [data-state=ready]::before{opacity:1}
.meeting-video[hidden],.meeting-recording .actions[hidden]{display:none}
.meeting-video-pending{padding:32px 20px;border:1px dashed var(--line);border-radius:10px;text-align:center;color:var(--muted);font-size:14px}
@keyframes processing-spin{to{transform:rotate(360deg)}}
@media(max-width:540px){.meeting-processing{grid-template-columns:1fr;gap:6px}.meeting-processing p{padding:9px 12px}}
@media(prefers-color-scheme:dark){.meeting-processing [data-state=failed]{color:#ffb4ab;background:#3d2020;border-color:#82433e}}
@media(prefers-reduced-motion:reduce){.meeting-processing [data-state=running]::before{animation:none}}
.meeting-recording{margin-bottom:24px}
.meeting-video{display:block;width:100%;aspect-ratio:16/9;max-height:45dvh;object-fit:contain;background:#000;border-radius:10px}
.meeting-recording .actions{margin-top:12px;font-size:13px}
.meeting-video-error{font-size:13px;color:var(--muted);margin:12px 0 0}
.transcript-header{padding:0 0 18px;border-bottom:1px solid var(--line)}
.transcript-header h3{font-size:16px;margin:0 0 12px}
.transcript-heading{display:flex;gap:16px;align-items:flex-start;justify-content:space-between}
.transcript-heading h2{margin:0;font-size:22px;line-height:1.4;overflow-wrap:anywhere}
.transcript-versions{display:flex;gap:8px}
.transcript-versions button{border:1px solid var(--line);border-radius:7px;padding:7px 14px;background:var(--surface);color:var(--text);cursor:pointer}
.transcript-versions button[aria-pressed=true]{background:var(--soft);color:var(--accent);border-color:var(--accent)}
.transcript-versions button:disabled{opacity:.55;cursor:default}
#transcript-status{font-size:13px;color:var(--muted);margin:12px 0 0;white-space:pre-line}
#transcript-downloads{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;margin-top:10px}
.transcript-content{padding:20px 0 0;min-height:0}
.transcript-turn{margin-bottom:26px;overflow-wrap:anywhere}
.transcript-turn h3{font-size:12px;color:var(--muted);font-weight:600;margin:0 0 6px}
.transcript-turn p{white-space:pre-wrap;margin:0;line-height:1.85}
.transcript-change{background:var(--soft);color:inherit;border-bottom:1px dotted var(--accent);border-radius:2px;padding:1px 2px;cursor:help}
.transcript-change:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.transcript-tooltip{position:fixed;z-index:10;padding:8px 12px;border:1px solid var(--line);border-radius:7px;background:var(--surface);color:var(--text);box-shadow:0 4px 20px #0003;font-size:13px;max-width:min(360px,calc(100vw - 24px));white-space:pre-wrap;overflow-wrap:anywhere}
.transcript-tooltip[hidden]{display:none}
@media(max-width:900px){.transcript-drawer{width:100vw;border:0}.meeting-header{padding:20px}.meeting-body{padding:20px}}
@media(prefers-reduced-motion:reduce){.transcript-drawer{scroll-behavior:auto}}
`;
export function transcriptDrawerScript(basePath: string): string {
  return `(() => {
const base = ${JSON.stringify(basePath)};
const drawer = document.getElementById('transcript-drawer');
if (!drawer) return;
const content = document.getElementById('transcript-content');
const status = document.getElementById('transcript-status');
const downloads = document.getElementById('transcript-downloads');
const tooltip = document.getElementById('transcript-tooltip');
const body = drawer.querySelector('.meeting-body');
const video = document.getElementById('meeting-video');
const videoError = document.getElementById('meeting-video-error');
const videoDownload = document.getElementById('meeting-recording-download');
const videoPending = document.getElementById('meeting-video-pending');
const progress = drawer.querySelector('.meeting-processing');
const versions = [...drawer.querySelectorAll('[data-transcript-version]')];
let bot, origin, desired = 'corrected', request, timer, sequence = 0, scrollPosition, activeChange, hideTimer, videoBot;
const clearTooltip = () => { tooltip.hidden = true; activeChange = undefined; };
const showTooltip = (element, original) => {
  clearTimeout(hideTimer); activeChange = element; tooltip.textContent = 'Original: ' + original; tooltip.hidden = false;
  const rect = element.getBoundingClientRect(), tip = tooltip.getBoundingClientRect();
  tooltip.style.left = Math.max(12, Math.min(rect.left, innerWidth - tip.width - 12)) + 'px';
  tooltip.style.top = (rect.bottom + tip.height + 12 < innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - tip.height - 6)) + 'px';
};
const hideTooltip = () => { hideTimer = setTimeout(() => { if (!tooltip.matches(':hover') && activeChange !== document.activeElement) clearTooltip(); }, 150); };
tooltip.addEventListener('pointerenter', () => clearTimeout(hideTimer)); tooltip.addEventListener('pointerleave', hideTooltip);
body.addEventListener('scroll', clearTooltip);
video.addEventListener('error', () => { if (drawer.open && video.currentSrc) videoError.hidden = false; });
const timestamp = value => typeof value === 'number' ? Math.floor(value / 60).toString().padStart(2, '0') + ':' + Math.floor(value % 60).toString().padStart(2, '0') : 'Timing unavailable';
function processingIndicator(name, state, labels) {
  const indicator = progress.querySelector('[data-processing="' + name + '"]');
  indicator.textContent = labels[state] || 'Status unavailable';
  indicator.dataset.state = ['encoding','uploading','running'].includes(state) ? 'running' : state === 'failed' ? 'failed' : state === 'ready' ? 'ready' : 'waiting';
}
function renderProcessing(view) {
  processingIndicator('video', view.videoState, { encoding: 'Encoding to MP4', uploading: 'Uploading video', ready: 'Video ready', failed: 'Video processing failed', waiting: 'Waiting for recording', unavailable: 'Video unavailable', unknown: 'Video status unknown' });
  processingIndicator('transcription', view.originalState, { waiting: 'Waiting for transcription', queued: 'Transcription queued', running: 'Transcription running', ready: 'Transcription complete', failed: 'Transcription failed', unavailable: 'Transcription unavailable' });
  processingIndicator('correction', view.correctionState, { waiting: 'Waiting for correction', pending: 'Correction pending', running: 'Correction running', ready: 'Correction complete', failed: 'Correction failed', skipped: 'Correction skipped', unavailable: 'Correction unavailable' });
  video.hidden = !view.recordingReady; videoPending.hidden = view.recordingReady;
  videoDownload.parentElement.hidden = !view.recordingReady;
  if (view.recordingReady && videoBot !== bot) {
    videoBot = bot; videoError.hidden = true;
    video.src = base + '/recordings/' + encodeURIComponent(bot) + '/video';
    videoDownload.href = base + '/recordings/' + encodeURIComponent(bot) + '/download';
  } else if (!view.recordingReady) {
    if (videoBot) { video.pause(); video.removeAttribute('src'); video.load(); }
    videoBot = undefined; videoDownload.removeAttribute('href'); videoError.hidden = true;
    videoPending.textContent = view.videoState === 'failed' ? 'The recording could not be prepared or uploaded.' : view.videoState === 'unknown' ? 'Recording progress cannot currently be confirmed.' : view.videoState === 'unavailable' ? 'No recording is available for this meeting.' : 'The recording will appear here when it is ready.';
  }
}
function render(view) {
  const ready = !!view.selectedRevision;
  const correctionReady = view.selectedVersion === 'corrected';
  const corrected = versions.find(button => button.dataset.transcriptVersion === 'corrected');
  versions.find(button => button.dataset.transcriptVersion === 'original').disabled = !ready;
  corrected.disabled = !view.correctedAvailable && !correctionReady && view.correctionState !== 'ready';
  corrected.title = corrected.disabled ? 'Corrected transcript is not yet available. Original remains accessible.' : '';
  for (const button of versions) button.setAttribute('aria-pressed', String(button.dataset.transcriptVersion === view.selectedVersion));
  const states = [];
  if (!ready) states.push(view.originalState === 'failed' ? 'Transcription failed' : view.originalState === 'running' ? 'Transcription running' : 'Transcript pending');
  else if (!correctionReady) states.push('Original transcript');
  if (view.correctionState === 'pending') states.push('Correction pending');
  if (view.correctionState === 'running') states.push('Correction running');
  if (view.correctionState === 'failed') states.push(ready ? 'Correction failed. The original transcript is still available.' : 'Correction failed');
  if (correctionReady && !view.corrections.length) states.push('No corrections made');
  states.push(...(view.warnings || [])); status.textContent = states.join('\\n');
  const fragment = document.createDocumentFragment();
  let paragraph, previousSpeaker, previousText = '';
  for (const segment of view.segments) {
    // Keep source segments intact for correction offsets; only group their display.
    if (!paragraph || !segment.speaker || segment.speaker !== previousSpeaker) {
      const section = document.createElement('section'); section.className = 'transcript-turn';
      const heading = document.createElement('h3'); heading.textContent = (segment.speaker || 'Speaker unavailable') + ' · ' + timestamp(segment.start); section.append(heading);
      paragraph = document.createElement('p'); section.append(paragraph); fragment.append(section);
      previousText = '';
    }
    if (previousText && segment.text && !/\s$/.test(previousText) && !/^\s/.test(segment.text) && !',.;:!?，。！？、)]}'.includes(segment.text[0])) paragraph.append(document.createTextNode(' '));
    const points = Array.from(segment.text); let end = 0;
    const patches = view.corrections.filter(patch => patch.correctedRange.segmentId === segment.id).sort((a,b) => a.correctedRange.start - b.correctedRange.start);
    for (const patch of patches) {
      const range = patch.correctedRange;
      paragraph.append(document.createTextNode(points.slice(end, range.start).join('')));
      const span = document.createElement('span'); span.className = 'transcript-change'; span.tabIndex = 0; span.textContent = points.slice(range.start, range.end).join('');
      span.setAttribute('aria-label', span.textContent + '. Original: ' + patch.original);
      span.setAttribute('aria-describedby', 'transcript-tooltip');
      span.addEventListener('pointerenter', () => showTooltip(span, patch.original)); span.addEventListener('focus', () => showTooltip(span, patch.original));
      span.addEventListener('pointerleave', hideTooltip); span.addEventListener('blur', () => { if (activeChange === span) clearTooltip(); });
      span.addEventListener('click', () => showTooltip(span, patch.original));
      paragraph.append(span); end = range.end;
    }
    paragraph.append(document.createTextNode(points.slice(end).join('')));
    previousSpeaker = segment.speaker; previousText = segment.text || previousText;
  }
  if (ready && !view.segments.length) { const empty = document.createElement('p'); empty.textContent = 'No speech detected.'; fragment.append(empty); }
  const position = body.scrollTop; content.replaceChildren(fragment); body.scrollTop = position;
  downloads.replaceChildren();
  if (ready) for (const format of ['json','txt','srt','vtt']) {
    const link = document.createElement('a'); link.textContent = format.toUpperCase(); link.href = base + '/recordings/' + encodeURIComponent(bot) + '/transcript/download?version=' + view.selectedVersion + '&format=' + format; downloads.append(link);
  }
}
async function load() {
  clearTimeout(timer); if (request) request.abort();
  request = new AbortController(); const current = ++sequence, selectedBot = bot, selectedVersion = desired;
  content.setAttribute('aria-busy','true');
  try {
    const processingResponse = await fetch(base + '/recordings/' + encodeURIComponent(bot) + '/processing', { signal: request.signal });
    if (!processingResponse.ok) throw new Error('Processing status unavailable');
    const processing = await processingResponse.json();
    if (!drawer.open || current !== sequence || bot !== selectedBot || desired !== selectedVersion) return;
    renderProcessing(processing);
    const pending = ['waiting','encoding','uploading'].includes(processing.videoState) || ['waiting','queued','running'].includes(processing.originalState) || ['waiting','pending','running'].includes(processing.correctionState);
    if (!processing.recordingReady || processing.originalState === 'unavailable' || processing.originalState === 'waiting') {
      status.textContent = processing.originalState === 'unavailable' ? 'Transcript unavailable' : 'Waiting for transcription';
      versions.forEach(button => { button.disabled = true; });
      content.replaceChildren(); downloads.replaceChildren(); if (pending) timer = setTimeout(load,5000); return;
    }
    const response = await fetch(base + '/recordings/' + encodeURIComponent(bot) + '/transcript?version=' + desired, { signal: request.signal });
    if (!response.ok) throw new Error(response.status === 404 ? 'Transcript unavailable' : 'Transcript retrieval failed');
    const view = await response.json();
    if (!drawer.open || current !== sequence || bot !== selectedBot || desired !== selectedVersion) return;
    clearTooltip(); render(view);
    if (pending || ['queued','running'].includes(view.originalState) || ['pending','running'].includes(view.correctionState)) timer = setTimeout(load,5000);
  } catch (error) {
    if (error.name !== 'AbortError' && current === sequence && drawer.open) { status.textContent = error.message; content.replaceChildren(); downloads.replaceChildren(); if (error.message === 'Processing status unavailable') { progress.querySelectorAll('p').forEach(item => { item.dataset.state = 'waiting'; item.textContent = 'Status unavailable'; }); } clearTimeout(timer); timer = setTimeout(load,5000); }
  } finally { if (current === sequence) content.setAttribute('aria-busy','false'); }
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-meeting-bot]'); if (!button) return;
  origin = button; bot = button.dataset.meetingBot; desired = 'corrected'; scrollPosition = window.scrollY;
  document.getElementById('transcript-title').textContent = button.closest('.history-entry')?.querySelector('h2')?.textContent || 'Meeting';
  videoBot = undefined; videoError.hidden = true; video.hidden = true; videoPending.hidden = false; videoPending.textContent = 'Checking recording status…'; videoDownload.parentElement.hidden = true;
  progress.querySelectorAll('p').forEach(item => { item.dataset.state = 'waiting'; item.textContent = 'Checking status…'; });
  content.replaceChildren(); downloads.replaceChildren(); status.textContent = 'Loading transcript…';
  versions.forEach(button => { button.disabled = false; });
  drawer.showModal(); body.scrollTop = 0; load();
});
versions.forEach(button => button.addEventListener('click', () => { desired = button.dataset.transcriptVersion; load(); }));
document.getElementById('transcript-close').addEventListener('click', () => drawer.close());
drawer.addEventListener('click', event => { if (event.target === drawer) { const rect = drawer.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) drawer.close(); } });
drawer.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const focusable = [...drawer.querySelectorAll('button:not(:disabled),a[href],video[controls],[tabindex=\"0\"]')].filter(element => element.getClientRects().length);
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
drawer.addEventListener('close', () => { ++sequence; if(request) request.abort(); clearTimeout(timer); clearTooltip(); video.pause(); video.removeAttribute('src'); video.load(); videoBot = undefined; videoDownload.removeAttribute('href'); videoError.hidden = true; origin?.focus({preventScroll:true}); window.scrollTo(0,scrollPosition); });
})();`;
}
