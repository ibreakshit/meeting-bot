export function renderTranscriptDrawer(): string {
  return '<dialog id="transcript-drawer" class="transcript-drawer" aria-labelledby="transcript-title"><header class="transcript-header"><div class="transcript-heading"><h2 id="transcript-title">Transcript</h2><button type="button" id="transcript-close" aria-label="Close transcript">Close</button></div><div class="transcript-versions" role="group" aria-label="Transcript version"><button type="button" data-transcript-version="corrected" aria-pressed="true">Corrected</button><button type="button" data-transcript-version="original" aria-pressed="false">Original</button></div><p id="transcript-status" role="status" aria-live="polite"></p><div id="transcript-downloads" class="actions" aria-label="Transcript downloads"></div></header><div id="transcript-content" class="transcript-content" aria-busy="false"></div><div id="transcript-tooltip" class="transcript-tooltip" role="tooltip" hidden></div></dialog>';
}
export const transcriptDrawerStyles = `
.transcript-drawer{position:fixed;inset:0 0 0 auto;margin:0;width:min(680px,100vw);height:100dvh;max-width:100vw;max-height:100dvh;padding:0;border:0;border-left:1px solid var(--line);background:var(--surface);color:var(--text);box-shadow:-12px 0 60px #0003;overflow:hidden}
.transcript-drawer[open]{display:flex;flex-direction:column}
.transcript-drawer::backdrop{background:#0c142880}
.transcript-header{padding:24px 28px 18px;border-bottom:1px solid var(--line);flex:none}
.transcript-heading{display:flex;gap:16px;align-items:flex-start;justify-content:space-between}
.transcript-heading h2{margin:0 0 20px;font-size:22px;line-height:1.4;overflow-wrap:anywhere}
.transcript-versions{display:flex;gap:8px}
.transcript-versions button{border:1px solid var(--line);border-radius:7px;padding:7px 14px;background:var(--surface);color:var(--text);cursor:pointer}
.transcript-versions button[aria-pressed=true]{background:var(--soft);color:var(--accent);border-color:var(--accent)}
.transcript-versions button:disabled{opacity:.55;cursor:default}
#transcript-status{font-size:13px;color:var(--muted);margin:12px 0 0;white-space:pre-line}
#transcript-downloads{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;margin-top:10px}
.transcript-content{padding:24px 28px;overflow:auto;overscroll-behavior:contain;flex:1;min-height:0}
.transcript-turn{margin-bottom:26px;overflow-wrap:anywhere}
.transcript-turn h3{font-size:12px;color:var(--muted);font-weight:600;margin:0 0 6px}
.transcript-turn p{white-space:pre-wrap;margin:0;line-height:1.85}
.transcript-change{background:var(--soft);color:inherit;border-bottom:1px dotted var(--accent);border-radius:2px;padding:1px 2px;cursor:help}
.transcript-change:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.transcript-tooltip{position:fixed;z-index:10;padding:8px 12px;border:1px solid var(--line);border-radius:7px;background:var(--surface);color:var(--text);box-shadow:0 4px 20px #0003;font-size:13px;max-width:min(360px,calc(100vw - 24px));white-space:pre-wrap;overflow-wrap:anywhere}
.transcript-tooltip[hidden]{display:none}
@media(max-width:639px){.transcript-drawer{width:100vw;border:0}.transcript-header{padding:20px}.transcript-content{padding:20px}}
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
const versions = [...drawer.querySelectorAll('[data-transcript-version]')];
let bot, origin, desired = 'corrected', request, timer, sequence = 0, scrollPosition, activeChange, hideTimer;
const clearTooltip = () => { tooltip.hidden = true; activeChange = undefined; };
const showTooltip = (element, original) => {
  clearTimeout(hideTimer); activeChange = element; tooltip.textContent = 'Original: ' + original; tooltip.hidden = false;
  const rect = element.getBoundingClientRect(), tip = tooltip.getBoundingClientRect();
  tooltip.style.left = Math.max(12, Math.min(rect.left, innerWidth - tip.width - 12)) + 'px';
  tooltip.style.top = (rect.bottom + tip.height + 12 < innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - tip.height - 6)) + 'px';
};
const hideTooltip = () => { hideTimer = setTimeout(() => { if (!tooltip.matches(':hover') && activeChange !== document.activeElement) clearTooltip(); }, 150); };
tooltip.addEventListener('pointerenter', () => clearTimeout(hideTimer)); tooltip.addEventListener('pointerleave', hideTooltip);
content.addEventListener('scroll', clearTooltip);
const timestamp = value => typeof value === 'number' ? Math.floor(value / 60).toString().padStart(2, '0') + ':' + Math.floor(value % 60).toString().padStart(2, '0') : 'Timing unavailable';
function render(view) {
  const ready = !!view.selectedRevision;
  const correctionReady = view.selectedVersion === 'corrected';
  const corrected = versions.find(button => button.dataset.transcriptVersion === 'corrected');
  corrected.disabled = !view.correctedAvailable && !correctionReady && view.correctionState !== 'ready';
  corrected.title = corrected.disabled ? 'Corrected transcript is not yet available. Original remains accessible.' : '';
  for (const button of versions) button.setAttribute('aria-pressed', String(button.dataset.transcriptVersion === view.selectedVersion));
  const states = [];
  if (!ready) states.push(view.originalState === 'failed' ? 'Transcription failed' : 'Transcript pending');
  else if (!correctionReady) states.push('Original transcript');
  if (view.correctionState === 'pending' || view.correctionState === 'running') states.push('Correction pending');
  if (view.correctionState === 'failed') states.push('Correction failed');
  if (correctionReady && !view.corrections.length) states.push('No corrections made');
  states.push(...(view.warnings || [])); status.textContent = states.join('\\n');
  const fragment = document.createDocumentFragment();
  for (const segment of view.segments) {
    const section = document.createElement('section'); section.className = 'transcript-turn';
    const heading = document.createElement('h3'); heading.textContent = (segment.speaker || 'Speaker unavailable') + ' · ' + timestamp(segment.start); section.append(heading);
    const paragraph = document.createElement('p'); const points = Array.from(segment.text); let end = 0;
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
    paragraph.append(document.createTextNode(points.slice(end).join(''))); section.append(paragraph); fragment.append(section);
  }
  if (ready && !view.segments.length) { const empty = document.createElement('p'); empty.textContent = 'No speech detected.'; fragment.append(empty); }
  const position = content.scrollTop; content.replaceChildren(fragment); content.scrollTop = position;
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
    const response = await fetch(base + '/recordings/' + encodeURIComponent(bot) + '/transcript?version=' + desired, { signal: request.signal });
    if (!response.ok) throw new Error(response.status === 404 ? 'Transcript unavailable' : 'Transcript retrieval failed');
    const view = await response.json();
    if (!drawer.open || current !== sequence || bot !== selectedBot || desired !== selectedVersion) return;
    clearTooltip(); render(view);
    if (['queued','running'].includes(view.originalState) || ['pending','running'].includes(view.correctionState)) timer = setTimeout(load,5000);
  } catch (error) {
    if (error.name !== 'AbortError' && current === sequence && drawer.open) { status.textContent = error.message; content.replaceChildren(); downloads.replaceChildren(); }
  } finally { if (current === sequence) content.setAttribute('aria-busy','false'); }
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-transcript-bot]'); if (!button) return;
  origin = button; bot = button.dataset.transcriptBot; desired = 'corrected'; scrollPosition = window.scrollY;
  document.getElementById('transcript-title').textContent = button.dataset.transcriptTitle || 'Transcript';
  content.replaceChildren(); downloads.replaceChildren(); status.textContent = 'Loading transcript…';
  versions.forEach(button => { button.disabled = false; });
  drawer.showModal(); load();
});
versions.forEach(button => button.addEventListener('click', () => { desired = button.dataset.transcriptVersion; load(); }));
document.getElementById('transcript-close').addEventListener('click', () => drawer.close());
drawer.addEventListener('click', event => { if (event.target === drawer) { const rect = drawer.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) drawer.close(); } });
drawer.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const focusable = [...drawer.querySelectorAll('button:not(:disabled),a[href],[tabindex=\"0\"]')].filter(element => element.getClientRects().length);
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
drawer.addEventListener('close', () => { ++sequence; if(request) request.abort(); clearTimeout(timer); clearTooltip(); origin?.focus({preventScroll:true}); window.scrollTo(0,scrollPosition); });
})();`;
}
