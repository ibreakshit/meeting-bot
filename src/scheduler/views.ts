import { renderTranscriptDrawer, transcriptDrawerScript, transcriptDrawerStyles } from './transcriptView';
import type { BotSettings, DispatchRecord, RuntimeView, SchedulerConfig, SchedulerState } from './types';
import { icon } from './icons';
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[character] ?? character));
const when = (value: number | undefined): string => value === undefined ? 'Not yet observed' : escape(new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }));
const badge = (value: string, positive = false) => `<span class="badge${positive ? ' good' : ''}">${escape(value)}</span>`;
const css = `
:root {
  color-scheme:light dark;
  --bg:#f6f7f9;
  --surface:#fff;
  --text:#182132;
  --muted:#617087;
  --line:#e0e5ed;
  --accent:#315de1;
  --soft:#edf1ff;
  --warning:#fff5dc;
  --green:#15734e;
  --green-bg:#e5f5ed;
  --orange:#945018;
  --orange-bg:#fdf0e5;
  --sidebar:#1b2637
}
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif }
a { color:var(--accent) }
button,input { font:inherit }
button,a,input,summary { -webkit-tap-highlight-color:transparent }
button:focus-visible,a:focus-visible,input:focus-visible,summary:focus-visible { outline:3px solid var(--accent); outline-offset:4px }
svg { width:22px; height:22px; flex-shrink:0; vertical-align:middle }
.skip-link { position:fixed; top:12px; left:212px; padding:10px 16px; background:var(--surface); z-index:10; transform:translateY(-160%) }
.skip-link:focus { transform:none }
.sidebar { position:fixed; inset:0 auto 0 0; width:180px; padding:30px 12px 24px; background:var(--sidebar); color:#e4eaf4; display:flex; flex-direction:column; z-index:3 }
.brand { display:flex; align-items:center; gap:10px; padding:0 10px; font-weight:700; font-size:17px; line-height:1.3; color:#fff; text-decoration:none; letter-spacing:-.4px }
.brand svg { width:28px; height:28px; color:#8eb5ff }
.sidebar .invite-bot { display:flex; align-items:center; justify-content:center; gap:9px; width:100%; margin-top:30px; padding:12px 10px; font-size:14px; background:#315de1; color:#fff; border-color:#315de1 }
.sidebar .invite-bot:hover { background:#244dc7; color:#fff }
.sidebar .invite-bot svg { width:20px; height:20px }
.sidebar nav { display:grid; gap:9px; margin-top:22px }
.sidebar nav a { display:flex; align-items:center; gap:13px; padding:14px 15px; border-radius:7px; color:#ccd5e5; text-decoration:none; font-size:14px; font-weight:500; line-height:1.4; min-height:50px }
.sidebar nav a:hover { color:#fff; background:#26354b }
.sidebar nav a[aria-current=page] { color:#fff; background:#315de1; font-weight:650 }
.sidebar nav svg { width:23px; height:23px; stroke-width:1.7 }
.sidebar-footer { margin-top:auto; padding-top:32px }
.sidebar .sign-out { display:flex; align-items:center; gap:13px; border:0; background:transparent; color:#c4cddd; padding:12px 15px; width:100%; font-size:14px }
.sidebar .sign-out:hover { background:#26354b; color:#fff }
.shell { margin-left:180px; padding:48px 48px 64px; max-width:1920px }
main { min-width:0 }
h1,h2,h3 { line-height:1.3; letter-spacing:-.5px }
h1 { font-size:40px; line-height:1.15; letter-spacing:-1.4px; margin:0 0 14px; font-weight:750 }
h2 { font-size:21px; margin:0 0 14px; font-weight:680 }
h3 { font-size:16px; margin:0 0 10px }
p { margin:6px 0 16px }
small,.muted { color:var(--muted) }
small { font-size:13px }
.intro { margin-bottom:38px }
.intro p { margin:0; max-width:68ch }
.page-date { font-size:20px; font-weight:550; color:var(--muted) }
.page-date time { display:block }
.schedule-layout { min-height:calc(100vh - 112px); display:grid; grid-template-columns:minmax(0,1fr) 375px; gap:36px }
.agenda { min-width:0 }
.agenda-heading { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px 20px; padding:2px 0 19px; border-bottom:1px solid var(--line) }
.agenda-heading h2 { font-size:16px; margin:0; letter-spacing:0 }
.agenda-heading small { font-size:13px }
.meeting-row { display:grid; grid-template-columns:94px minmax(0,1fr); gap:22px; padding:20px 0; border-bottom:1px solid var(--line) }
.meeting-time { padding-right:16px; border-right:1px solid var(--line) }
.meeting-time strong { font-size:23px; font-weight:700; letter-spacing:-.6px; font-variant-numeric:tabular-nums; line-height:1.4; display:block }
.meeting-time small { display:block; font-size:13px; margin-top:4px }
.meeting-main { min-width:0 }
.meeting-heading { display:flex; align-items:start; justify-content:space-between; gap:16px }
.meeting-heading h2 { margin:0 0 9px; font-size:21px; overflow-wrap:anywhere }
.meeting-heading .actions { margin:36px 0 0; flex-shrink:0 }
.meeting-meta { display:flex; flex-wrap:wrap; gap:7px; align-items:center; margin-bottom:10px }
.meeting-meta .badge { font-size:13px }
.meeting-decision { display:flex; align-items:center; flex-wrap:wrap; gap:9px; margin-top:4px }
.meeting-reason { color:var(--muted); font-size:15px; margin:6px 0 0; overflow-wrap:anywhere }
.meeting-evidence { margin:8px 0 0 }
.meeting-evidence summary { font-size:13px; color:var(--muted) }
.meeting-evidence[open] summary { margin-bottom:12px }
.worker-panel { border-left:1px solid var(--line); padding:40px 0 0 32px; min-width:0 }
.worker-panel h2 { font-size:23px; margin:0 0 18px }
.worker-list { margin:0; padding:0; list-style:none }
.worker-row { padding:18px 0; border-bottom:1px solid var(--line) }
.worker-line { display:grid; grid-template-columns:11px minmax(0,1fr) auto; align-items:start; gap:10px }
.worker-line strong { font-size:16px; font-weight:600; min-width:0; overflow-wrap:anywhere }
.worker-state { margin-left:auto; color:var(--muted); font-size:15px; flex-shrink:0 }
.worker-row small { display:block; font-size:12px; margin:5px 0 0 24px }
.status-dot { width:11px; height:11px; color:var(--muted); flex-shrink:0; margin-top:7px }
.status-dot svg { display:block; width:11px; height:11px }
.status-idle .status-dot { color:#20aa71 }
.status-busy .status-dot { color:var(--accent) }
.status-unavailable .status-dot { color:#d9654d }
.queue-summary { margin:26px 0 }
.queue-summary strong { display:block; font-size:40px; font-variant-numeric:tabular-nums; line-height:1.25; font-weight:650; letter-spacing:-1px }
.queue-summary span { display:block; color:var(--muted); font-size:16px; margin-top:4px }
.worker-panel .queue-explanation { color:var(--muted); font-size:16px; line-height:1.7; margin:0 0 24px }
.worker-panel .button { display:block; text-align:center; width:100%; padding:13px 16px; font-size:14px }
.worker-panel .capacity-note { margin-top:16px; font-size:12px }
.card { margin:0 0 24px; background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:25px 28px }
.rowhead { display:flex; justify-content:space-between; align-items:start; gap:20px }
.rowhead h2 { margin:0 0 5px; overflow-wrap:anywhere }
.rowhead p { margin:0 0 18px; font-size:14px }
.detail { display:flex; flex-wrap:wrap; gap:7px 16px; color:var(--muted); font-size:13px; margin:10px 0; overflow-wrap:anywhere }
.badge { font-size:12px; display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); border-radius:20px; padding:3px 11px; background:var(--surface); color:var(--muted); max-width:100%; overflow-wrap:anywhere }
.badge svg { width:16px; height:16px }
.provider-google svg { color:#00897b }
.provider-microsoft svg { color:#6264a7 }
.provider-zoom svg { color:#2d8cff }
.badge.good { background:var(--green-bg); color:var(--green); border-color:transparent }
.badge.skip { background:var(--orange-bg); color:var(--orange); border-color:transparent }
.badge.calendar-label { background:#e9edf3; color:#526078; border-color:transparent }
.actions { display:flex; flex-wrap:wrap; gap:8px; margin:16px 0 }
button,.button { display:inline-block; font:inherit; font-size:13px; line-height:1.4; font-weight:600; border:1px solid var(--line); border-radius:6px; padding:11px 17px; background:var(--surface); color:var(--text); cursor:pointer; text-decoration:none; white-space:nowrap; min-height:42px }
button:hover,.button:hover { border-color:var(--accent); color:var(--accent) }
button:disabled { opacity:.5; cursor:default }
button.primary,.button.primary { background:#315de1; color:#fff; border-color:#315de1 }
button.primary:hover,.button.primary:hover { background:#244dc7 }
.banner { padding:14px 18px; margin:0 0 20px; background:var(--warning); border-radius:7px; overflow-wrap:anywhere; font-size:14px }
.empty { text-align:center; padding:72px 24px; background:transparent; border:0 }
.empty svg { width:34px; height:34px; color:var(--muted); margin-bottom:14px; stroke-width:1.4 }
.empty h2 { font-size:20px; margin-bottom:10px }
.empty p { color:var(--muted); max-width:42ch; margin:0 auto 20px }
.retained-heading { margin:32px 0 18px }
.history-list { max-width:1024px }
.history-entry { padding:24px 0; border-bottom:1px solid var(--line) }
.history-entry:first-child { padding-top:0 }
.history-entry h2 { font-size:19px; overflow-wrap:anywhere; margin-bottom:8px }
.history-entry .execution-id { font-size:12px; overflow-wrap:anywhere }
details { margin-top:14px }
summary { cursor:pointer; font-size:14px; font-weight:550 }
.logs { font:13px/1.7 ui-monospace,monospace; white-space:pre-wrap; overflow-wrap:anywhere; padding:14px; background:var(--surface); border:1px solid var(--line); border-radius:6px; margin-top:12px }
.notice { margin:16px 0; color:var(--muted); font-size:13px; max-width:78ch }
.accounts-actions { margin:-6px 0 28px }
.account-card { max-width:1040px }
.account-identity { display:flex; align-items:center; gap:14px; min-width:0 }
.account-identity>svg { width:24px; height:24px; color:var(--muted) }
.account-identity>div { min-width:0 }
.calendar { display:flex; gap:13px; padding:15px 0; align-items:center; border-top:1px solid var(--line) }
.calendar label { flex:1; min-width:0; cursor:pointer; overflow-wrap:anywhere }
.calendar label small { display:block; margin-top:3px; font-size:12px }
.calendar .badge { margin-left:6px; font-size:11px; vertical-align:middle }
input[type=checkbox] { width:18px; height:18px; flex-shrink:0; accent-color:#315de1; cursor:pointer }
.settings-form { max-width:1100px; padding:0; border:0; background:transparent }
.settings-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(280px,.9fr); gap:56px }
.settings-fields { min-width:0 }
.settings-field + .settings-field { margin-top:32px; padding-top:28px; border-top:1px solid var(--line) }
.settings-form label { display:block; font-weight:650; font-size:15px; margin-bottom:10px }
.settings-form input[type=text] { width:100%; border:1px solid var(--line); border-radius:7px; padding:12px 14px; background:var(--surface); color:var(--text); font:inherit }
.settings-form input[type=file] { max-width:100%; font:inherit; font-size:13px; color:var(--muted) }
.settings-form input[type=file]::file-selector-button { margin-right:12px; padding:11px 15px; border:1px solid var(--line); border-radius:6px; background:var(--surface); color:var(--text); font:inherit; font-weight:600; cursor:pointer }
.settings-form small { display:block; margin:9px 0 16px; line-height:1.7 }
.settings-preview { border-left:1px solid var(--line); padding-left:32px; min-width:0 }
.settings-preview h2 { font-size:16px; margin-bottom:14px }
.thumbnail-preview { aspect-ratio:16/9; width:100%; background:#151d2b; border-radius:9px; overflow:hidden; position:relative }
.thumbnail-preview img { width:100%; height:100%; object-fit:contain; display:block }
.thumbnail-preview p { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; color:#c3ccda; font-size:14px; margin:0 }
.thumbnail-preview p svg { width:28px; height:28px; stroke-width:1.5 }
.thumbnail-preview [hidden] { display:none }
.preview-caption { margin:13px 0 0; color:var(--muted); font-size:13px }
.settings-footer { border-top:1px solid var(--line); margin-top:32px; padding-top:12px }
#settings-status { margin:12px 0 0; overflow-wrap:anywhere; font-size:14px }
.invite-dialog { width:min(500px,calc(100% - 32px)); max-height:calc(100dvh - 32px); padding:30px; border:1px solid var(--line); border-radius:14px; background:var(--surface); color:var(--text); box-shadow:0 24px 80px #0004; overflow:auto }
.invite-dialog::backdrop { background:#0c1428a6; backdrop-filter:blur(3px) }
.invite-dialog h2 { font-size:25px; margin:0 0 10px }
.invite-dialog .invite-description { color:var(--muted); font-size:14px; margin-bottom:24px }
.invite-dialog label { display:block; font-size:14px; font-weight:650; margin-bottom:8px }
.invite-dialog input { width:100%; border:1px solid var(--line); border-radius:7px; padding:12px 14px; background:var(--bg); color:var(--text); min-width:0 }
.invite-dialog small { display:block; font-size:12px; line-height:1.6; margin:9px 0 0 }
.invite-dialog .notice { margin:20px 0; font-size:12px }
.invite-dialog .actions { justify-content:flex-end; margin:24px 0 0 }
.invite-dialog .invite-status { margin:18px 0 0; font-size:14px; overflow-wrap:anywhere }
.invite-dialog .invite-status:empty { display:none }
.invite-dialog .invite-status[data-error=true] { color:var(--orange) }
.invite-dialog [hidden] { display:none }
#feedback { position:fixed; bottom:24px; left:calc(50% + 90px); transform:translateX(-50%); max-width:min(600px,calc(100% - 32px)); padding:13px 20px; background:var(--text); color:var(--surface); border-radius:8px; z-index:5; font-size:14px }
#feedback:empty { display:none }
@media(min-width:1600px) {
  .shell { padding:54px 64px 72px }
  .schedule-layout { grid-template-columns:minmax(0,1fr) 375px; gap:48px }
}
@media(max-width:1250px) {
  .shell { padding:36px 30px 56px }
  .schedule-layout { grid-template-columns:minmax(0,1fr) 255px; gap:24px }
  .worker-panel { padding-left:24px }
  .meeting-heading { flex-wrap:wrap; gap:2px }
  .meeting-heading .actions { margin:0 0 12px }
  .settings-grid { gap:28px }
}
@media(max-width:1000px) {
  .sidebar { width:176px }
  .sidebar nav a { padding:13px 11px; gap:10px }
  .shell { margin-left:176px }
  .schedule-layout { grid-template-columns:1fr; gap:28px }
  .agenda { display:contents }
  .agenda>.intro { grid-row:1; margin-bottom:0 }
  .agenda-content { grid-row:3 }
  .worker-row.status-idle small,.worker-row.status-busy small { display:none }
  .worker-panel { grid-row:2; border-left:0; padding:0 0 24px; border-bottom:1px solid var(--line); display:grid; grid-template-columns:1fr 1fr; gap:10px 28px }
  .worker-panel h2 { grid-column:1/-1; font-size:18px; margin-bottom:0 }
  .worker-list { grid-column:1 }
  .queue-summary { grid-column:2; grid-row:2; align-self:center; margin:0 }
  .queue-summary strong { font-size:30px }
  .worker-panel .queue-explanation { display:none }
  .worker-panel .button { grid-column:2; align-self:center }
  .worker-panel .capacity-note { grid-column:1; grid-row:3; margin:0 }
  .settings-grid { grid-template-columns:1fr }
  .settings-preview { border:0; padding:0; max-width:480px }
  #feedback { left:calc(50% + 88px) }
}
@media(max-width:640px) {
  .sidebar { position:static; width:auto; padding:18px 18px 0; display:block }
  .brand { padding:0; font-size:16px }
  .brand span br { display:none }
  .brand svg { width:25px; height:25px }
  .sidebar .invite-bot { margin-top:20px; padding:11px 14px; min-height:44px }
  .sidebar nav { display:flex; margin-top:14px; gap:4px }
  .invite-dialog { padding:24px }
  .invite-dialog h2 { font-size:23px }
  .sidebar nav a { flex:1; justify-content:center; padding:12px 4px; font-size:12px; min-height:44px; gap:0; border-radius:6px 6px 0 0; white-space:nowrap }
  .sidebar nav a svg { display:none }
  .sidebar nav a[aria-current=page] { background:#315de1 }
  .sidebar-footer { position:absolute; top:14px; right:16px; padding:0 }
  .sidebar .sign-out { width:auto; font-size:12px; padding:9px }
  .sidebar .sign-out svg { width:17px; height:17px }
  .sidebar .sign-out span { display:none }
  .shell { margin-left:0; padding:28px 22px 48px }
  h1 { font-size:30px; letter-spacing:-1px; margin-bottom:10px }
  .intro { margin-bottom:26px }
  .intro p { font-size:14px }
  .page-date { font-size:17px }
  .agenda-heading { align-items:start; gap:6px }
  .agenda-heading h2 { font-size:14px }
  .agenda-heading small { font-size:12px }
  .schedule-layout { gap:25px }
  .worker-panel { gap:12px 20px; padding-bottom:22px }
  .worker-panel h2 { font-size:17px }
  .worker-row { padding:11px 0 }
  .worker-line { gap:7px }
  .worker-line strong { font-size:13px }
  .worker-state { font-size:12px }
  .worker-row small { margin-left:18px; font-size:11px }
  .worker-panel .button { padding:10px 8px; font-size:12px }
  .worker-panel .capacity-note { font-size:11px; align-self:center }
  .meeting-row { grid-template-columns:69px minmax(0,1fr); gap:16px; padding:23px 0 }
  .meeting-time { padding-right:12px }
  .meeting-time strong { font-size:19px }
  .meeting-time small { font-size:11px }
  .meeting-heading h2 { font-size:18px }
  .meeting-heading .actions { gap:6px; margin:2px 0 10px }
  .meeting-heading .actions button { padding:9px 13px; font-size:12px }
  .meeting-meta { gap:6px; margin-bottom:10px }
  .meeting-meta .badge { font-size:11px; padding:3px 8px }
  .meeting-reason { font-size:13px }
  .card { padding:20px; margin-bottom:18px }
  .rowhead { flex-wrap:wrap; gap:5px }
  .rowhead h2 { font-size:16px }
  .rowhead>button { margin-bottom:18px }
  .account-identity { gap:10px }
  .account-identity>svg { width:20px; height:20px }
  .account-identity h2 { font-size:14px; letter-spacing:0 }
  .calendar { gap:10px; padding:13px 0 }
  .calendar label { font-size:14px }
  .calendar .badge { margin-left:0; padding:2px 7px }
  .settings-form { padding:0 }
  .settings-grid { gap:28px }
  .settings-field + .settings-field { margin-top:25px; padding-top:24px }
  .empty { padding:48px 10px }
  .skip-link { left:20px }
  #feedback { left:50% }
}
@media(prefers-color-scheme:dark) {
  :root { --bg:#111927; --surface:#1a2434; --text:#e6edf7; --muted:#a6b3c9; --line:#2d3a50; --accent:#9ab4ff; --soft:#243656; --warning:#3c321f; --green:#8fdbba; --green-bg:#183c31; --orange:#f1bb89; --orange-bg:#3d2b20; --sidebar:#151f30 }
  .badge.calendar-label { background:#25334a; color:#bfcbde }
  .sidebar { border-right:1px solid var(--line) }
  .thumbnail-preview { border:1px solid var(--line) }
}

`;
const script = (basePath: string, refresh: boolean) => `
// Use the viewer's timezone for the agenda, while keeping explicit UTC fallbacks without JavaScript.
const timeFormats = {
  time: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  day: { month: 'short', day: 'numeric' },
  date: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }
};
for (const time of document.querySelectorAll('time[data-format]')) {
  time.textContent = new Intl.DateTimeFormat(undefined, timeFormats[time.dataset.format]).format(new Date(time.dateTime));
}
for (const label of document.querySelectorAll('[data-timezone]')) label.textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
const inviteDialog = document.getElementById('invite-dialog');
const inviteForm = document.getElementById('invite-form');
const inviteButton = document.getElementById('invite-bot');
const inviteUrl = document.getElementById('invite-url');
const inviteSubmit = document.getElementById('invite-submit');
const inviteCancel = document.getElementById('invite-cancel');
const inviteStatus = document.getElementById('invite-status');
const inviteSchedule = document.getElementById('invite-schedule');
let invitePending = false;
let inviteComplete = false;
let inviteRequestId;
let scheduleRefresh;
const resumeRefresh = () => {
  clearTimeout(scheduleRefresh);
  if (${refresh} && !inviteDialog.open && !invitePending) scheduleRefresh = setTimeout(() => {
    if (!inviteDialog.open && !invitePending) location.reload();
  }, 30000);
};
resumeRefresh();
inviteButton.addEventListener('click', () => {
  if (invitePending || inviteDialog.open) return;
  clearTimeout(scheduleRefresh);
  inviteForm.reset();
  inviteRequestId = crypto.randomUUID();
  inviteComplete = false;
  inviteUrl.disabled = false;
  inviteSubmit.hidden = false;
  inviteSubmit.disabled = false;
  inviteSubmit.textContent = 'Invite bot';
  inviteStatus.textContent = '';
  delete inviteStatus.dataset.error;
  inviteSchedule.hidden = true;
  inviteCancel.textContent = 'Cancel';
  inviteDialog.showModal();
  inviteUrl.focus();
});
inviteDialog.addEventListener('cancel', event => { if (invitePending) event.preventDefault(); });
inviteDialog.addEventListener('close', () => {
  inviteUrl.value = '';
  inviteButton.focus();
  resumeRefresh();
});
inviteCancel.addEventListener('click', () => { if (!invitePending) inviteDialog.close(); });
inviteForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (invitePending || inviteComplete || !inviteForm.reportValidity()) return;
  const url = inviteUrl.value.trim();
  invitePending = true;
  clearTimeout(scheduleRefresh);
  const controls = [inviteUrl, inviteSubmit, inviteCancel, inviteButton];
  controls.forEach(control => { control.disabled = true; });
  inviteForm.setAttribute('aria-busy', 'true');
  inviteSubmit.textContent = 'Inviting...';
  inviteStatus.textContent = 'Sending invitation...';
  delete inviteStatus.dataset.error;
  const requestController = new AbortController();
  const requestTimeout = setTimeout(() => requestController.abort(), 20000);
  try {
    const response = await fetch(${JSON.stringify(`${basePath}/invitations`)}, {
      signal: requestController.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Scheduler-Request': '1' },
      body: JSON.stringify({ url, requestId: inviteRequestId, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    });
    if (!response.ok) {
      const message = response.status === 400 ? 'Enter a supported Google Meet, Microsoft Teams or Zoom meeting URL.'
        : response.status === 401 || response.status === 403 ? 'Your session or access could not be verified. Reload the page and sign in again.'
        : response.status === 409 ? 'This invitation could not be changed. Close this form and try again.'
        : 'The invitation could not be confirmed. Try again with this form to avoid a duplicate invitation.';
      throw Error(message);
    }
    const result = await response.json();
    if (result.success !== true || !['queued', 'picked_up', 'unknown', 'completed', 'failed', 'removed'].includes(result.state)) {
      throw Error('The invitation could not be confirmed. Try again with this form to avoid a duplicate invitation.');
    }
    const messages = {
      queued: result.alreadyInvited ? 'This meeting is already queued. A worker will pick it up when available.' : 'Invitation queued. A worker will pick it up when available.',
      picked_up: 'This meeting invitation has already been picked up by a worker.',
      unknown: 'This meeting already has an invitation with an unknown execution state. Check the schedule before trying again.',
      completed: 'This meeting invitation has already completed. View its outcome in the schedule or history.',
      failed: 'This meeting invitation has a recorded failure. View its details in history.',
      removed: 'This meeting invitation is no longer queued. View its details in history.'
    };
    inviteComplete = true;
    inviteUrl.value = '';
    inviteStatus.textContent = messages[result.state];
    inviteSchedule.hidden = false;
    inviteSubmit.hidden = true;
    inviteCancel.textContent = 'Close';
  } catch (error) {
    inviteStatus.textContent = error instanceof TypeError || error instanceof SyntaxError || error.name === 'AbortError'
      ? 'The invitation could not be confirmed. Check your connection and retry with this form to avoid a duplicate invitation.'
      : error.message;
    inviteStatus.dataset.error = 'true';
  } finally {
    clearTimeout(requestTimeout);
    invitePending = false;
    controls.forEach(control => { control.disabled = false; });
    inviteUrl.disabled = inviteComplete;
    inviteSubmit.textContent = 'Invite bot';
    inviteForm.removeAttribute('aria-busy');
    if (inviteComplete) inviteSchedule.focus();
    resumeRefresh();
  }
});
document.addEventListener('click', async event => {
  const button = event.target.closest('button[data-url]');
  if (!button) return;
  button.disabled = true;
  try {
    const response = await fetch(button.dataset.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Scheduler-Request': '1' },
      body: button.dataset.body || '{}'
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Request failed');
    if (result.url) location.assign(result.url);
    else if (button.dataset.url === ${JSON.stringify(`${basePath}/auth/logout`)}) location.assign(${JSON.stringify(`${basePath}/`)});
    else location.reload();
  } catch (error) {
    document.getElementById('feedback').textContent = error.message;
    button.disabled = false;
  }
});
document.addEventListener('change', async event => {
  const input = event.target;
  if (!input.matches('input[data-calendar]')) return;
  input.disabled = true;
  try {
    const response = await fetch(${JSON.stringify(`${basePath}/calendars/watch`)}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Scheduler-Request': '1' },
      body: JSON.stringify({
        accountId: input.dataset.account,
        calendarId: input.dataset.calendar,
        watched: input.checked
      })
    });
    if (!response.ok) throw Error('Calendar selection could not be saved');
    location.reload();
  } catch (error) {
    input.checked = !input.checked;
    input.disabled = false;
    document.getElementById('feedback').textContent = error.message;
  }
});
`;
function layout(page: string, subtitle: string, body: string, refresh = false, basePath = ''): string {
  const navigation = [
    ['Schedule', '/', 'calendar'], ['History', '/history', 'clock'],
    ['Accounts', '/accounts', 'users'], ['Bot Settings', '/bot-settings', 'settings'],
  ] as const;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${page} - Meeting scheduler</title><style>${css}</style></head><body><a class="skip-link" href="#main">Skip to content</a><header class="sidebar"><a class="brand" href="${escape(`${basePath}/`)}">${icon('circle-dot')}<span>Meeting<br> scheduler</span></a><button id="invite-bot" class="invite-bot" type="button" aria-haspopup="dialog" aria-controls="invite-dialog">${icon('video')}<span>Invite bot</span></button><nav aria-label="Main navigation">${navigation.map(([label, href, symbol]) => `<a href="${escape(basePath + href)}"${page === label ? ' aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span></a>`).join('')}</nav><div class="sidebar-footer"><button class="sign-out" aria-label="Sign out" data-url="${escape(`${basePath}/auth/logout`)}">${icon('logout')}<span>Sign out</span></button></div></header><div class="shell"><main id="main" tabindex="-1">${page === 'Schedule' ? '' : `<div class="intro"><h1>${page}</h1><p class="muted">${subtitle}</p></div>`}${body}</main></div><dialog id="invite-dialog" class="invite-dialog" aria-labelledby="invite-title" aria-describedby="invite-description"><form id="invite-form"><h2 id="invite-title">Invite bot to a meeting</h2><p id="invite-description" class="invite-description">Paste a meeting link to invite your bot now.</p><label for="invite-url">Meeting URL</label><input id="invite-url" name="url" type="url" required maxlength="4096" autocomplete="off" spellcheck="false" placeholder="https://meet.google.com/abc-defg-hij" aria-describedby="invite-help"><small id="invite-help">Supports Google Meet, Microsoft Teams and Zoom meeting links.</small><p class="notice">Uses your saved bot name and camera image. If all workers are busy, the invitation waits in the queue. Invitations expire after 3 hours without pickup.</p><p id="invite-status" class="invite-status" role="status" aria-live="polite" aria-atomic="true"></p><div class="actions"><button id="invite-cancel" type="button">Cancel</button><a id="invite-schedule" class="button primary" href="${escape(`${basePath}/`)}" hidden>View schedule</a><button id="invite-submit" class="primary" type="submit">Invite bot</button></div></form></dialog><div id="feedback" role="status" aria-live="polite"></div><script>${script(basePath, refresh)}</script></body></html>`;
}
function control(label: string, url: string, body?: unknown, primary = false): string { return `<button${primary ? ' class="primary"' : ''} data-url="${escape(url)}"${body ? ` data-body="${escape(JSON.stringify(body))}"` : ''}>${escape(label)}</button>`; }
function diagnostic(value: unknown, config?: SchedulerConfig): string {
  let message = String(value ?? '').replace(/https?:\/\/[^\s<>"']+/gi, '[URL redacted]');
  const secrets = config ? [config.bearerToken, config.webhookSecret, config.googleClientSecret, config.s3.accessKeyId, config.s3.secretAccessKey] : [];
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
  return escape(message);
}
function manualTitle(dispatch: DispatchRecord): string {
  const provider = dispatch.payload.provider;
  return `Manual ${provider === 'google' ? 'Google Meet' : provider === 'microsoft' ? 'Microsoft Teams' : provider === 'zoom' ? 'Zoom' : 'meeting'} invitation`;
}
function dispatchDetails(dispatch: DispatchRecord, config?: SchedulerConfig): string {
  const state = dispatch.outcome?.conflict ? 'Conflicting results - unknown' : dispatch.outcome?.status === 'completed' ? 'Recording uploaded' : dispatch.outcome?.status === 'failed' ? 'Permanent failure' : dispatch.state === 'picked_up' ? 'Picked up' : dispatch.state === 'removed' && /ended|expired|missed/.test(dispatch.reason || '') ? 'Missed before pickup' : dispatch.state;
  const latestObservation = dispatch.firstObservedAt !== undefined ? `Pickup first observed ${when(dispatch.firstObservedAt)}` : 'No worker pickup observation';
  const possibleLatePickup = dispatch.firstObservedAt !== undefined && dispatch.firstObservedAt >= dispatch.scheduledEnd;
  return `<div class="detail">${badge(state, dispatch.outcome?.status === 'completed')}<span>Bot ${escape(dispatch.botId)}</span>${dispatch.workerId ? `<span>Worker ${escape(dispatch.workerId)}</span>` : ''}${dispatch.state === 'queued' && dispatch.scheduledStart < Date.now() ? `<span>Queued delay: ${Math.floor((Date.now() - dispatch.scheduledStart) / 60000)} min</span>` : ''}</div>${possibleLatePickup ? `<p class="banner">Possible late pickup: the worker was first observed holding this job at ${when(dispatch.firstObservedAt)}, after its scheduled end. Exact pickup time is unknown.</p>` : ''}${dispatch.source === 'manual' && dispatch.state === 'queued' ? `<p class="muted">Pickup deadline: ${when(dispatch.scheduledEnd)}</p>` : ''}${dispatch.reason ? `<p>${diagnostic(dispatch.reason, config)}</p>` : ''}${dispatch.state === 'unknown' ? `<p class="banner">Execution unknown. ${latestObservation}. Investigate the worker before recovery. Join does not retry this execution.</p>` : ''}${dispatch.calendarChangedAt ? `<p class="banner">Calendar changed after pickup: ${escape(dispatch.changedFields?.join(', '))}. Detected ${when(dispatch.calendarChangedAt)}. This execution keeps its original target and schedule.</p>` : ''}${dispatch.outcome?.error ? `<p>${diagnostic(dispatch.outcome.error.message, config)}</p>` : ''}${dispatch.recording ? recordingLink(dispatch, config) : ''}`;
}
function recordingLink(dispatch: DispatchRecord, config?: SchedulerConfig): string {
  const recording = dispatch.recording;
  if (!recording) return '';
  if (recording.locationConflict || recording.storage?.provider !== 's3' || !recording.storage.bucket || !recording.storage.key || (config && recording.storage.bucket !== config.s3.bucket)) return '<p class="muted">Recording location unavailable</p>';
  return `<p><a class="button" href="${escape(config?.basePath || '')}/recordings/${encodeURIComponent(dispatch.botId)}/download">Download recording</a>${typeof recording.duration === 'number' ? ` <small>${escape(Math.round(recording.duration))} seconds</small>` : ''}${!dispatch.outcome ? ' <small>Authoritative result unavailable</small>' : ''}</p>`;
}
function agendaTime(timestamp: number, format: 'time' | 'day' | 'date'): string {
  const options: Intl.DateTimeFormatOptions = format === 'time' ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : format === 'day' ? { month: 'short', day: 'numeric' } : { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
  const date = new Date(timestamp);
  return `<time datetime="${escape(date.toISOString())}" data-format="${format}">${escape(date.toLocaleString('en-US', { ...options, timeZone: 'UTC' }))}</time>`;
}

const meetingReasons: Record<string, string> = {
  automatic: 'The bot will join this meeting automatically.',
  'automatic (owner response unavailable)': 'The bot will join automatically. Your RSVP is unavailable.',
  'join override': 'You asked the bot to join this meeting.',
  'skip override': 'You asked the bot to skip this meeting.',
  'no supported join link': 'No supported meeting link was found.',
  'all-day event': 'All-day events are skipped.',
  'invalid event time': 'This event has an invalid start or end time.',
  cancelled: 'This meeting was cancelled.',
  declined: 'You declined this meeting.',
  'attendees unavailable': 'Attendee information is unavailable.',
  alone: 'No other participants were found.',
  'calendar unavailable': 'The calendar is unavailable or waiting for a fresh sync.',
  'superseded snapshot': 'A newer calendar update is available.',
};

export function renderSchedule(state: SchedulerState, view: RuntimeView, dispatches: DispatchRecord[], config: SchedulerConfig): string {
  const now = Date.now();
  const basePath = config.basePath || '';
  const banners = [!view.ready ? '<div class="banner">Scheduling paused while startup or durable state is reconciled.</div>' : '', view.lastError ? `<div class="banner">Scheduler unavailable: ${diagnostic(view.lastError, config)}</div>` : '', view.ingestionPending ? '<div class="banner">Result ingestion pending. Some outcomes may not have arrived yet.</div>' : '', ...state.accounts.filter(account => account.needsReconnect).map(account => `<div class="banner">${escape(account.email)} needs reconnecting. <a href="${escape(basePath)}/accounts">Manage accounts</a></div>`), ...state.calendars.filter(calendar => calendar.watched && (!calendar.verified || calendar.lastError || !calendar.lastSuccess || now - calendar.lastSuccess >= config.maxSnapshotAgeSeconds * 1000)).map(calendar => { const age = calendar.lastSuccess ? (now - calendar.lastSuccess) / 1000 : Infinity; const status = !calendar.verified ? 'Waiting for startup refresh' : age >= config.maxSnapshotAgeSeconds || calendar.unauthorized ? 'Unavailable for joining' : `Using cached events for up to ${Math.max(0, Math.ceil(config.maxSnapshotAgeSeconds - age))} more seconds`; return `<div class="banner">${escape(calendar.summary)}: ${status}. Last complete success: ${when(calendar.lastSuccess)}.${calendar.lastError ? ` Polling error: ${diagnostic(calendar.lastError, config)}` : ''}</div>`; })].join('');
  const workers = config.workers.map(registration => {
    const worker = view.workers.find(observation => observation.id === registration.id);
    const stale = worker && now - worker.observedAt > 30000;
    const status = !worker ? 'Not observed' : stale ? 'Stale observation' : !worker.reachable ? 'Unavailable' : worker.busy === true ? 'Busy' : worker.busy === false ? 'Idle' : 'Unknown';
    const tone = status === 'Idle' ? 'idle' : status === 'Busy' ? 'busy' : status === 'Unavailable' ? 'unavailable' : 'unknown';
    return `<li class="worker-row status-${tone}"><div class="worker-line"><span class="status-dot">${icon('circle-filled')}</span><strong>Worker ${escape(registration.id)}</strong><span class="worker-state">${status}</span></div>${worker ? `<small>Observed ${when(worker.observedAt)}</small>` : '<small>Waiting for first observation</small>'}</li>`;
  }).join('');
  const visible = new Set<string>();
  const rows = [...view.groups].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)).map(group => {
    const records = dispatches.filter(dispatch => dispatch.memberInstanceKeys.some(key => group.memberKeys.includes(key)));
    records.forEach(dispatch => visible.add(dispatch.botId));
    const provider = (group.primary?.link || group.members.find(member => member.link)?.link)?.provider;
    const platform = provider === 'google' ? 'Google Meet' : provider === 'microsoft' ? 'Microsoft Teams' : provider === 'zoom' ? 'Zoom' : 'No supported platform';
    const title = [...new Set(group.members.map(member => member.event.summary || 'Untitled meeting'))].join(' / ');
    const calendars = [...new Set(group.members.map(member => member.calendarSummary))];
    return `<article class="meeting-row"><div class="meeting-time"><strong>${agendaTime(group.start, 'time')}</strong><small>${agendaTime(group.start, 'day')}</small><small>${Math.max(0, Math.round((group.end - group.start) / 60000))} min</small></div><div class="meeting-main"><div class="meeting-heading"><div><h2>${escape(title)}</h2><div class="meeting-meta"><span class="badge provider-${escape(provider || 'unknown')}">${icon(provider === 'google' ? 'googlemeet' : provider === 'microsoft' ? 'microsoftteams' : provider === 'zoom' ? 'zoom' : 'video')}${platform}</span>${calendars.map(calendar => `<span class="badge calendar-label">${escape(calendar)}</span>`).join('')}</div></div><div class="actions" role="group" aria-label="Actions for ${escape(title)}">${control('Join', `${basePath}/groups/${encodeURIComponent(group.id)}/override`, { mode: 'join' }, true)}${control('Skip', `${basePath}/groups/${encodeURIComponent(group.id)}/override`, { mode: 'skip' })}${control('Reset', `${basePath}/groups/${encodeURIComponent(group.id)}/override`, { mode: 'automatic' })}</div></div><div class="meeting-decision"><span class="badge ${group.join ? 'good' : 'skip'}">${group.join ? 'Will join' : 'Will skip'}</span></div><p class="meeting-reason">${escape(meetingReasons[group.reason] || group.reason)}</p>${records.map(dispatch => dispatchDetails(dispatch, config)).join('')}<details class="meeting-evidence"><summary>Meeting details</summary><p class="muted">${when(group.start)} - ${when(group.end)}</p><div class="detail">${group.members.map(member => `<span>${escape(member.calendarSummary)} · ${escape(member.sourceStatus)}</span>`).join('')}</div>${records.length === 0 ? '<p class="muted">Pending schedule</p>' : ''}<p class="notice">Join follows the meeting schedule and eligibility checks. Changes cannot recall or replace a claimed execution.</p></details></div></article>`;
  }).join('');
  const manual = dispatches.filter(dispatch => dispatch.source === 'manual' && !visible.has(dispatch.botId) && ['queued', 'picked_up', 'unknown'].includes(dispatch.state)).sort((a, b) => b.pushedAt - a.pushedAt).map(dispatch => `<article class="card"><h2>${escape(manualTitle(dispatch))}</h2><p class="muted">Invited ${when(dispatch.pushedAt)}</p>${dispatchDetails(dispatch, config)}</article>`).join('');
  const retained = dispatches.filter(dispatch => dispatch.source !== 'manual' && !visible.has(dispatch.botId) && ['picked_up', 'unknown', 'queued'].includes(dispatch.state)).map(dispatch => `<article class="card"><h2>Retained execution</h2><p class="muted">The calendar event is no longer in this schedule.</p><p>${when(dispatch.scheduledStart)} - ${when(dispatch.scheduledEnd)}</p>${dispatchDetails(dispatch, config)}</article>`).join('');
  const empty = `<section class="empty">${icon('calendar')}<h2>No upcoming meetings</h2><p>Your next 24 hours are clear. Meetings from watched calendars appear here automatically.</p><a class="button" href="${escape(basePath)}/accounts">Manage calendars</a></section>`;
  return layout('Schedule', '', `<div class="schedule-layout"><section class="agenda" aria-label="Upcoming meetings"><div class="intro"><h1>Schedule</h1><p class="page-date">${agendaTime(now, 'date')}</p></div><div class="agenda-content">${banners}${manual ? `<section aria-label="Manual invitations"><h2>Manual invitations</h2>${manual}</section>` : ''}<div class="agenda-heading"><h2>Next 24 hours <span class="muted">· <span data-timezone>UTC</span></span></h2><small>Refreshes every 30 seconds</small></div>${rows || empty}${retained ? `<h2 class="retained-heading">Ongoing and retained executions</h2>${retained}` : ''}</div></section><aside class="worker-panel" aria-label="Bot availability"><h2>Bot availability</h2><ul class="worker-list">${workers || '<li class="muted">No workers configured</li>'}</ul><div class="queue-summary" aria-label="Queued meetings"><strong>${view.queueDepth}</strong><span>meetings queued</span></div><p class="queue-explanation">When all workers are busy, additional meetings wait in the queue until a worker is free.</p><a class="button primary" href="${escape(basePath)}/accounts">Manage calendars</a><p class="muted capacity-note">${config.workers.length} ${config.workers.length === 1 ? 'worker' : 'workers'} configured · One meeting per worker</p></aside></div>`, true, basePath);
}
export function renderHistory(dispatches: DispatchRecord[], config?: SchedulerConfig, archives: Array<{ kind: string }> = []): string {
  const cutoff = Date.now() - 7 * 86400000;
  const rows = dispatches.filter(dispatch => dispatch.pushedAt >= cutoff).sort((a, b) => b.pushedAt - a.pushedAt).map(dispatch => `<article class="history-entry"><h2>${escape(dispatch.source === 'manual' ? manualTitle(dispatch) : dispatch.payload.eventId || 'Meeting execution')}</h2><p class="muted">${when(dispatch.scheduledStart)} - ${when(dispatch.scheduledEnd)}</p>${dispatchDetails(dispatch, config)}${dispatch.recording ? `<p><button type="button" data-transcript-bot="${escape(dispatch.botId)}" data-transcript-title="${escape(dispatch.payload.eventId || 'Meeting transcript')}" aria-haspopup="dialog" aria-controls="transcript-drawer">View transcript</button></p>` : ''}${dispatch.attempts?.length ? `<details><summary>${dispatch.attempts.length} attempt reports</summary><p class="notice">Attempt reports do not establish upload success or permanent failure.</p>${dispatch.attempts.map(attempt => `<p>${when(attempt.receivedAt)}: ${escape(attempt.status.join(' → '))}</p>`).join('')}</details>` : ''}${dispatch.logs?.length ? `<details><summary>Lobby and execution logs</summary><div class="logs">${dispatch.logs.map(log => `${when(log.receivedAt)} [${escape(log.level)}] ${diagnostic(log.message, config)}`).join('\n')}</div></details>` : ''}</article>`).join('');
  // Render only known diagnostic labels and counts; archive payloads stay server-side.
  const labels: Record<string, string> = { 'malformed result': 'Malformed results', 'unscheduled result': 'Unscheduled results', attempts: 'Unscheduled attempt reports', logs: 'Unscheduled logs', recording: 'Unscheduled recordings' };
  const counts = new Map<string, number>();
  for (const archive of archives) { const label = labels[archive.kind] || 'Other diagnostics'; counts.set(label, (counts.get(label) || 0) + 1); }
  const diagnostics = [...counts].map(([label, count]) => `<p>${label}: ${count} retained entries</p>`).join('');
  const transcriptUi = `<style>${transcriptDrawerStyles}</style>${renderTranscriptDrawer()}<script>${transcriptDrawerScript(config?.basePath || '')}</script>`;
  return layout('History', 'Execution evidence and recordings from the past 7 days.', `${diagnostics ? `<section class="banner"><h2>Result diagnostics</h2>${diagnostics}</section>` : ''}<div class="history-list">${rows || `<section class="empty">${icon('clock')}<h2>No execution history yet</h2><p>Recordings and outcomes appear here as your meetings run.</p><a class="button" href="${escape(config?.basePath || '')}/">View schedule</a></section>`}</div>${transcriptUi}`, false, config?.basePath);
}
export function renderAccounts(state: SchedulerState, basePath = ''): string {
  // Older saved calendars lack Google's primary flag; their primary calendar ID is the account email.
  return layout('Accounts', 'Check calendars to sync events and automatically record eligible meetings.', `<div class="actions accounts-actions">${control('Connect account', `${basePath}/auth/connect`, undefined, true)}</div>${state.accounts.map(account => `<section class="card account-card"><div class="rowhead"><div class="account-identity">${icon('users')}<div><h2>${escape(account.email)}</h2><p class="muted">${account.needsReconnect ? 'Reconnect required. Cached meetings cannot join.' : 'Connected Google account'}</p></div></div>${control('Disconnect', `${basePath}/accounts/${encodeURIComponent(account.id)}/disconnect`)}</div>${account.needsReconnect ? control('Reconnect account', `${basePath}/auth/connect`) : ''}${state.calendars.filter(calendar => calendar.accountId === account.id).map((calendar, index) => `<div class="calendar"><input type="checkbox" id="calendar-${escape(account.id)}-${index}" data-account="${escape(account.id)}" data-calendar="${escape(calendar.id)}"${calendar.watched ? ' checked' : ''}><label for="calendar-${escape(account.id)}-${index}">${escape(calendar.summary)}${calendar.primary === true || (calendar.primary === undefined && calendar.id.toLowerCase() === account.email.toLowerCase()) ? ' <span class="badge">Default calendar</span>' : ''}<small>${escape(calendar.timeZone)}${calendar.watched && !calendar.verified ? ' · Waiting for fresh events' : ''}</small></label></div>`).join('') || '<p class="muted">No readable calendars were returned.</p>'}</section>`).join('') || '<section class="card empty"><h2>Connect your first account</h2><p class="muted">Calendars start unwatched. Select the ones you want to record.</p></section>'}<p class="notice">Connecting an account adds its verified email to meeting owner identities. Dashboard access follows the configured owner allowlist.</p>`, false, basePath);
}

export function renderBotSettings(settings: BotSettings, basePath = ''): string {
  const thumbnail = settings.thumbnailId ? `${basePath}/bot-settings/thumbnail/${settings.thumbnailId}` : '';
  return layout('Bot Settings', 'Choose how your bot appears to meeting participants.', `<form id="bot-settings" class="settings-form" action="${escape(`${basePath}/bot-settings`)}" method="post"><div class="settings-grid"><div class="settings-fields"><div class="settings-field"><label for="bot-name">Bot name</label><input id="bot-name" name="name" type="text" required maxlength="100" value="${escape(settings.name)}" aria-describedby="name-help"><small id="name-help">The name participants see in the meeting. Google Meet adjusts names containing "bot", "robot" or "note taker" to "AI Notes".</small></div><div class="settings-field"><label for="bot-image">Default camera image</label><small id="image-help">PNG, JPEG or WebP, up to 2 MiB and 16 million pixels. Shown in the bot's camera tile when the meeting allows video. With no image, the camera stays off.</small><input id="bot-image" name="thumbnail" type="file" accept="image/png,image/jpeg,image/webp" aria-describedby="image-help"><div class="actions"><button id="remove-image" type="button"${thumbnail ? '' : ' disabled'}>Remove image</button></div></div></div><section class="settings-preview" aria-label="Camera preview"><h2>Camera preview</h2><div class="thumbnail-preview"><img id="image-preview" alt="Default bot camera image preview"${thumbnail ? ` src="${escape(thumbnail)}"` : ' hidden'}><p id="image-empty"${thumbnail ? ' hidden' : ''}>${icon('camera-off')}<span>Camera off</span></p></div><p class="preview-caption">Your image will fit inside the camera tile without being cropped.</p></section></div><div class="settings-footer"><p class="notice">Changes apply to future and still-pending meetings. Active meetings keep the appearance they started with.</p><div class="actions"><button id="save-settings" class="primary" type="submit">Save settings</button></div><p id="settings-status" role="status" aria-live="polite"></p></div></form><script>
(() => {
  const form = document.getElementById('bot-settings');
  const name = document.getElementById('bot-name');
  const file = document.getElementById('bot-image');
  const preview = document.getElementById('image-preview');
  const empty = document.getElementById('image-empty');
  const remove = document.getElementById('remove-image');
  const save = document.getElementById('save-settings');
  const status = document.getElementById('settings-status');
  let thumbnailDataUrl;
  let removeThumbnail = false;
  let sequence = 0;
  const showImage = value => {
    preview.hidden = !value;
    empty.hidden = !!value;
    if (value) preview.src = value;
    else preview.removeAttribute('src');
    remove.disabled = !value;
  };
  file.addEventListener('change', () => {
    const selected = file.files[0];
    const current = ++sequence;
    if (!selected) { save.disabled = false; return; }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(selected.type) || selected.size > 2 * 1024 * 1024) {
      status.textContent = 'Choose a PNG, JPEG or WebP image up to 2 MiB.';
      file.value = '';
      save.disabled = false;
      return;
    }
    save.disabled = true;
    const reader = new FileReader();
    reader.onload = () => {
      if (current !== sequence) return;
      thumbnailDataUrl = reader.result;
      removeThumbnail = false;
      showImage(thumbnailDataUrl);
      status.textContent = 'Image preview ready. Save settings to apply it.';
      save.disabled = false;
    };
    reader.onerror = () => {
      if (current !== sequence) return;
      status.textContent = 'The image could not be read. Choose it again.';
      file.value = '';
      save.disabled = false;
    };
    reader.readAsDataURL(selected);
  });
  remove.addEventListener('click', () => {
    sequence++;
    thumbnailDataUrl = undefined;
    removeThumbnail = true;
    file.value = '';
    showImage('');
    save.disabled = false;
    status.textContent = 'Image removed from preview. Save settings to apply it.';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const trimmedName = name.value.trim();
    if (!trimmedName || trimmedName.length > 100 || /[\\u0000-\\u001f\\u007f-\\u009f]/.test(name.value)) {
      status.textContent = 'Enter a bot name up to 100 characters without control characters.';
      name.focus();
      return;
    }
    const controls = [name, file, remove, save];
    controls.forEach(control => { control.disabled = true; });
    form.setAttribute('aria-busy', 'true');
    status.textContent = 'Saving settings...';
    try {
      const response = await fetch(form.action, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Scheduler-Request': '1' },
        body: JSON.stringify({ name: trimmedName, thumbnailDataUrl, removeThumbnail })
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Settings could not be saved');
      name.value = trimmedName;
      thumbnailDataUrl = undefined;
      removeThumbnail = false;
      file.value = '';
      status.textContent = 'Settings saved. Future and still-pending meetings will use this appearance.';
    } catch (error) { status.textContent = error.message || 'Settings could not be saved. Try again.'; }
    finally {
      controls.forEach(control => { control.disabled = false; });
      remove.disabled = preview.hidden;
      form.removeAttribute('aria-busy');
    }
  });
})();
</script>`, false, basePath);
}
