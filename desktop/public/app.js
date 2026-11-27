// Relay desktop client. Chats are relay sessions; the server is the source of truth.
/* global renderMarkdown, escapeHtml */

const $ = (id) => document.getElementById(id);
const esc = escapeHtml;
const icon = (name, small = true) => `<svg class="ic ${small ? 'ic-sm' : ''}"><use href="#i-${name}"/></svg>`;

const state = {
  status: null,
  chat: null, // { sid, title, pinned, cwd, entries }
  chats: [],
  skills: [],
  files: [], // uploaded, waiting to be sent
  uploading: 0,
  extras: {}, // sid -> notes that exist only on screen (relay output, failovers, errors)
  drafts: {},
  turn: null, // the reply being streamed
  offline: false,
  menuFor: null, // sid the chat menu acts on
};

/* ---------- Preferences ---------- */

const PREF_DEFAULTS = { theme: 'system', text: 'default', enterSends: true, dictation: false, choice: null, sidebarHidden: false };
const prefs = { ...PREF_DEFAULTS };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem('relay.prefs') || '{}'));
} catch {
  /* start from the defaults */
}

function savePref(key, value) {
  prefs[key] = value;
  try {
    localStorage.setItem('relay.prefs', JSON.stringify(prefs));
  } catch {
    /* private windows can refuse storage */
  }
  applyPrefs();
}

const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;

function applyPrefs() {
  const root = document.documentElement;
  if (prefs.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = prefs.theme;
  root.dataset.text = prefs.text;
  document.querySelectorAll('.segmented[data-pref] button').forEach((b) => {
    b.classList.toggle('active', prefs[b.parentElement.dataset.pref] === b.dataset.value);
  });
  $('prefEnter').checked = prefs.enterSends;
  $('prefDictation').checked = Boolean(Speech) && prefs.dictation;
  $('prefDictation').disabled = !Speech;
  if (!Speech) $('dictationNote').textContent = "This browser doesn't offer speech recognition.";
  $('btnMic').hidden = !Speech || !prefs.dictation;
  $('app').classList.toggle('sidebar-hidden', prefs.sidebarHidden);
}

/* ---------- Server ---------- */

async function api(path, body) {
  const res = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

// for actions started by the person: failures are shown, not swallowed
async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err.message === 'Failed to fetch' ? "Can't reach Relay" : err.message);
    return null;
  }
}

/* ---------- Toast ---------- */

let toastTimer = null;
function toast(message, action) {
  $('toastText').textContent = message;
  const button = $('toastAction');
  button.hidden = !action;
  if (action) {
    button.textContent = action.label;
    button.onclick = () => {
      $('toast').classList.remove('show');
      action.run();
    };
  }
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), action ? 8000 : 3500);
}

/* ---------- Status ---------- */

const backendOf = (name) => state.status?.backends.find((b) => b.name === name);
const labelOf = (name) => (name === 'relay' ? 'Relay' : backendOf(name)?.label || name || 'Relay');
const stateClass = (b) => (b.state === 'ready' ? '' : b.state === 'cooldown' ? 'cooldown' : 'out');
const folderLabel = (dir) => String(dir || '').split('/').filter(Boolean).pop() || dir;

async function loadStatus() {
  try {
    state.status = await api('/api/status');
    setOffline(false);
  } catch {
    setOffline(true);
    return;
  }
  const s = state.status;
  $('folderName').textContent = folderLabel(s.cwd);
  $('btnFolder').title = s.cwd;
  if (prefs.choice && !s.backends.some((b) => b.name === prefs.choice.backend)) savePref('choice', null);
  renderModelButton();
  if ($('settings').open) renderBackends();
  // another window may have switched chats
  if (state.chat && s.session !== state.chat.sid && !state.turn) await loadChat();
  updateComposer();
}

function setOffline(offline) {
  if (offline === state.offline) return;
  state.offline = offline;
  updateComposer();
}

function updateComposer() {
  const running = Boolean(state.turn) || Boolean(state.status?.busy);
  $('btnSend').hidden = running;
  $('btnStop').hidden = !running;
  const empty = !$('prompt').value.trim() && !state.files.length;
  $('btnSend').disabled = state.offline || empty || state.uploading > 0;
  const line = $('statusLine');
  line.classList.toggle('error', state.offline);
  line.textContent = state.offline
    ? "Can't reach Relay. Check that relay desktop is still running."
    : state.uploading
      ? 'Attaching…'
      : state.status?.busy && !state.turn
        ? 'A reply is still running.'
        : 'Relay runs real coding CLIs. They can edit files in this folder, so check their work.';
}

/* ---------- Chat list ---------- */

async function loadChats() {
  try {
    state.chats = (await api('/api/chats')).chats;
  } catch {
    return;
  }
  renderChats();
}

function groupOf(chat) {
  if (chat.pinned) return 'Pinned';
  const midnight = new Date().setHours(0, 0, 0, 0);
  if (chat.updated >= midnight) return 'Today';
  if (chat.updated >= midnight - 864e5) return 'Yesterday';
  if (chat.updated >= midnight - 7 * 864e5) return 'Previous 7 days';
  return 'Older';
}

function renderChats() {
  if ($('chatList').querySelector('input')) return; // don't interrupt a rename
  const groups = new Map(['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Older'].map((g) => [g, []]));
  state.chats.filter((c) => c.messages).slice(0, 200).forEach((c) => groups.get(groupOf(c)).push(c));
  const here = state.chat?.cwd;
  let html = '';
  for (const [name, chats] of groups) {
    if (!chats.length) continue;
    html += `<div class="chat-group">${name}</div>`;
    for (const c of chats) {
      const elsewhere = c.cwd !== here ? `<small>${esc(folderLabel(c.cwd))}</small>` : '';
      html += `<div class="chat-item ${c.sid === state.chat?.sid ? 'active' : ''}" data-sid="${esc(c.sid)}">
        <button class="chat-open" title="${esc(c.title)}">${esc(c.title)}${elsewhere}</button>
        <button class="icon-btn chat-more" title="Chat options" aria-label="Options for ${esc(c.title)}">${icon('more')}</button>
      </div>`;
    }
  }
  $('chatList').innerHTML = html || '<div class="placeholder">Your chats will appear here.</div>';
}

/* ---------- The open chat ---------- */

function setChat(chat) {
  if (state.chat) state.drafts[state.chat.sid] = $('prompt').value;
  const switched = state.chat?.sid !== chat.sid;
  state.chat = chat;
  if (switched) {
    setPrompt(state.drafts[chat.sid] || '');
    closePreview();
  }
  renderThread();
  renderChats();
}

async function loadChat() {
  try {
    setChat((await api('/api/chat')).chat);
  } catch {
    /* the status poll reports being offline */
  }
}

async function chatAction(action, body = {}) {
  const data = await attempt(() => api(`/api/chat/${action}`, body));
  if (data) {
    setChat(data.chat);
    await Promise.all([loadChats(), loadStatus()]);
  }
  return data;
}

async function newChat(cwd) {
  if (!(await chatAction('new', cwd ? { cwd } : {}))) return false;
  closeSidebarDrawer();
  $('prompt').focus();
  return true;
}

async function openChat(sid) {
  closeSidebarDrawer();
  if (sid !== state.chat?.sid) await chatAction('open', { sid });
}

/* ---------- Messages ---------- */

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function usageText(entry) {
  const parts = [];
  if (entry.durationMs) parts.push(`${(entry.durationMs / 1000).toFixed(1)}s`);
  const u = entry.usage || {};
  const out = u.output_tokens ?? u.outputTokens;
  if (out) parts.push(`${out.toLocaleString()} tokens out`);
  return parts.join(' · ');
}

const action = (act, name, label) => `<button class="icon-btn" data-act="${act}" title="${label}" aria-label="${label}">${icon(name)}</button>`;

function disclosure(kind, label, body, mono) {
  return `<details class="activity-item" data-kind="${kind}"><summary>${icon(kind === 'tools' ? 'tool' : 'activity')}<span>${esc(label)}</span><svg class="ic ic-sm chev"><use href="#i-chevron"/></svg></summary><div class="body ${mono ? 'tools' : ''}">${esc(body)}</div></details>`;
}

const filesHtml = (files = []) =>
  files.length ? `<div class="files">${files.map((f) => `<span class="file">${icon('file')}<span>${esc(f.name)}</span></span>`).join('')}</div>` : '';

function userHtml(text, index, files) {
  const edit = index === null ? '' : action('edit', 'edit', 'Edit and resend');
  return `<article class="msg user" ${index === null ? '' : `data-index="${index}"`}>
    ${filesHtml(files)}<div class="bubble">${esc(text)}</div>
    <div class="msg-actions">${action('copy', 'copy', 'Copy')}${edit}</div>
  </article>`;
}

const botHead = (backend, time) =>
  `<div class="msg-head"><span class="mark" aria-hidden="true">${icon('arrow-right')}</span>${esc(labelOf(backend))}${time ? `<small>${clock(time)}</small>` : ''}</div>`;

function botHtml(entry, index) {
  const tools = entry.tools?.length ? disclosure('tools', `Used ${entry.tools.length} ${entry.tools.length === 1 ? 'tool' : 'tools'}`, entry.tools.join('\n'), true) : '';
  return `<article class="msg bot" data-index="${index}">
    ${botHead(entry.backend, entry.t)}
    <div class="msg-extras">${tools}</div>
    <div class="msg-body md">${renderMarkdown(entry.text)}</div>
    <div class="msg-actions">${action('copy', 'copy', 'Copy')}${action('regenerate', 'refresh', 'Regenerate')}<small>${esc(usageText(entry))}</small></div>
  </article>`;
}

function extraHtml(extra) {
  if (extra.kind === 'user') return userHtml(extra.text, null);
  if (extra.kind === 'relay') {
    return `<article class="msg bot">${botHead('relay')}<div class="msg-body"><div class="columns">${esc(extra.text)}</div></div></article>`;
  }
  const retry = extra.retry === undefined ? '' : `<button class="btn" data-act="retry" data-at="${extra.retry}">Try again</button>`;
  return `<div class="notice ${extra.kind === 'error' ? 'error' : ''}"><span>${esc(extra.text)}</span>${retry}</div>`;
}

const scroller = () => $('messages');
const nearBottom = () => scroller().scrollHeight - scroller().scrollTop - scroller().clientHeight < 80;
function scrollToEnd() {
  scroller().scrollTop = scroller().scrollHeight;
  $('btnJump').hidden = true;
}

function renderThread() {
  const chat = state.chat;
  if (!chat) return;
  const extras = state.extras[chat.sid] || [];
  const after = (n) => extras.filter((x) => x.at === n).map(extraHtml).join('');
  let html = after(0);
  chat.entries.forEach((entry, i) => {
    if (entry.kind === 'user') html += userHtml(entry.text, i, entry.attachments);
    else if (entry.kind === 'assistant') html += botHtml(entry, i);
    html += after(i + 1);
  });
  $('thread').innerHTML = html;
  $('thread').querySelector('.msg:last-of-type')?.classList.add('last');
  // a reply that is still streaming belongs to this chat
  if (state.turn?.sid === chat.sid) $('thread').append(state.turn.userEl, state.turn.el);
  $('chatTitle').textContent = chat.title;
  document.title = chat.entries.length ? `${chat.title} · Relay` : 'Relay';
  const empty = !chat.entries.length && !extras.length && state.turn?.sid !== chat.sid;
  $('content').classList.toggle('is-home', empty);
  scrollToEnd();
}

const fromHtml = (html) => {
  const box = document.createElement('template');
  box.innerHTML = html.trim();
  return box.content.firstElementChild;
};

function logActivity(text, kind = '') {
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = text;
  $('activityLog').appendChild(line);
  $('activityLog').scrollTop = $('activityLog').scrollHeight;
}

/* ---------- Sending ---------- */

const APP_COMMANDS = {
  '/new': ['Start a new chat', () => newChat()],
  '/settings': ['Open settings', () => openSettings('general')],
  '/search': ['Search chats', () => openPalette()],
  '/status': ['CLI status and limits', () => openSettings('models')],
  '/scan': ['Find installed CLIs', () => openSettings('models').then(runScan)],
  '/sync': ['Update AGENTS.md', () => syncAgents()],
  '/forget': ['Reset limits', () => resetLimits()],
  '/export': ['Export this chat', () => exportChat(state.chat.sid)],
};

function setPrompt(value) {
  $('prompt').value = value;
  growPrompt();
  updateComposer();
}

function growPrompt() {
  const box = $('prompt');
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, 220)}px`;
}

async function sendFromComposer() {
  const text = $('prompt').value.trim();
  const command = APP_COMMANDS[text.split(/\s+/)[0]];
  if (command && !state.files.length) {
    setPrompt('');
    command[1]();
    return;
  }
  if (state.turn || state.status?.busy || state.offline || state.uploading) return;
  if (!text && !state.files.length) return;
  const files = state.files;
  state.files = [];
  renderFiles();
  setPrompt('');
  closeSuggest();
  await send(text || 'Take a look at the attached files.', files);
}

async function send(prompt, files = []) {
  const sid = state.chat.sid;
  const before = state.chat.entries.length;
  const extras = (state.extras[sid] ||= []);

  const userEl = fromHtml(userHtml(prompt, null, files));
  const el = fromHtml(`<article class="msg bot fresh">${botHead(prefs.choice?.backend || 'relay')}<div class="msg-extras"></div><div class="msg-body md"></div><div class="working"><i></i><span>Working</span></div></article>`);
  userEl.classList.add('fresh');
  const turn = { sid, userEl, el, text: '', relay: '', thinking: '', tools: [], notes: [], failed: null, ok: false, started: Date.now(), frame: 0 };
  state.turn = turn;
  $('content').classList.remove('is-home');
  $('thread').querySelector('.last')?.classList.remove('last');
  $('thread').append(userEl, el);
  scrollToEnd();
  updateComposer();

  turn.timer = setInterval(() => {
    el.querySelector('.working span').textContent = `Working ${Math.round((Date.now() - turn.started) / 1000)}s`;
  }, 1000);

  let accepted = false;
  try {
    const response = await fetch('/api/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, backend: prefs.choice?.backend || null, model: prefs.choice?.model || null, attachments: files.map((f) => f.id) }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'the message was not sent');
    accepted = true;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop();
      for (const chunk of chunks) {
        const type = chunk.match(/^event: (.*)$/m)?.[1];
        const data = chunk.match(/^data: (.*)$/m)?.[1];
        if (type && data) onStream(turn, type, JSON.parse(data));
      }
    }
  } catch (err) {
    turn.failed = err.message;
    logActivity(`Error: ${err.message}`, 'error');
  }

  clearInterval(turn.timer);
  cancelAnimationFrame(turn.frame);
  state.turn = null;

  if (!accepted) {
    // nothing reached a CLI, so give the person their message back
    state.files = files.concat(state.files);
    renderFiles();
    setPrompt(prompt);
    toast(turn.failed || 'The message was not sent');
  }

  let chat = null;
  try {
    chat = (await api('/api/chat')).chat;
  } catch {
    setOffline(true);
  }

  if (chat && chat.sid === sid) {
    if (accepted) {
      const grew = chat.entries.length > before;
      // keep what only ever existed on screen
      if (turn.relay) {
        if (!grew) extras.push({ at: before, kind: 'user', text: prompt });
        extras.push({ at: chat.entries.length, kind: 'relay', text: turn.relay.trimEnd() });
      }
      for (const note of turn.notes) extras.push({ at: Math.min(before + 1, chat.entries.length), kind: 'note', text: note });
      const answered = chat.entries.at(-1)?.kind === 'assistant';
      if (turn.failed && !turn.relay) {
        if (!grew) extras.push({ at: before, kind: 'user', text: prompt });
        const retry = grew && !answered ? chat.entries.length - 1 : undefined;
        extras.push({ at: chat.entries.length, kind: 'error', text: turn.failed, retry });
      }
    }
    setChat(chat);
  } else {
    userEl.remove();
    el.remove();
    if (chat) setChat(chat);
  }
  await Promise.all([loadChats(), loadStatus()]);
  updateComposer();
}

function paintStream(turn) {
  if (turn.frame) return;
  turn.frame = requestAnimationFrame(() => {
    turn.frame = 0;
    const stick = nearBottom();
    const body = turn.el.querySelector('.msg-body');
    body.innerHTML = turn.relay ? `<div class="columns">${esc(turn.relay)}</div>` : renderMarkdown(turn.text);
    if (stick) scrollToEnd();
  });
}

// keep a disclosure's open state while its content streams in
function liveDisclosure(turn, kind, label, body, mono) {
  const box = turn.el.querySelector('.msg-extras');
  let item = box.querySelector(`[data-kind="${kind}"]`);
  if (!item) {
    item = fromHtml(disclosure(kind, label, body, mono));
    box.appendChild(item);
  }
  item.querySelector('summary span').textContent = label;
  item.querySelector('.body').textContent = body;
}

function setLiveBackend(turn, backend) {
  turn.el.querySelector('.msg-head').outerHTML = botHead(backend);
}

function onStream(turn, type, data) {
  if (type === 'turn_start') {
    setLiveBackend(turn, data.backend);
    logActivity(`[start] ${data.backend}`);
  } else if (type === 'pipeline_start') {
    logActivity(`[steps] ${data.totalSteps} stages`);
  } else if (type === 'step_start') {
    setLiveBackend(turn, data.backend);
    turn.text += `${turn.text ? '\n\n' : ''}### Step ${data.stepNumber} of ${data.totalSteps}: ${data.step.title}\n\n`;
    paintStream(turn);
    logActivity(`[step ${data.stepNumber}/${data.totalSteps}] ${data.backend}`);
  } else if (type === 'cli_event') {
    const evt = data.event;
    if (evt.type === 'assistant_text') {
      if (data.backend === 'relay') turn.relay += evt.text;
      else turn.text += evt.text;
      paintStream(turn);
      logActivity(evt.text, 'stream');
    } else if (evt.type === 'thinking') {
      turn.thinking = evt.text;
      liveDisclosure(turn, 'thinking', 'Thinking', turn.thinking, false);
    } else if (evt.type === 'tool_use') {
      turn.tools.push(`${evt.name} ${JSON.stringify(evt.input || '')}`.slice(0, 200));
      liveDisclosure(turn, 'tools', `Using ${evt.name}`, turn.tools.join('\n'), true);
      logActivity(`[tool] ${evt.name}`);
    }
  } else if (type === 'failover') {
    const reason = data.reason === 'quota' ? 'hit its limit' : data.reason === 'auth' ? 'needs you to sign in' : "couldn't answer";
    const note = `${labelOf(data.from)} ${reason}.${data.next ? ` Switched to ${labelOf(data.next)}.` : ''}`;
    turn.notes.push(note);
    turn.text = ''; // the next CLI answers from the start
    paintStream(turn);
    toast(note);
    logActivity(`[failover] ${data.from} -> ${data.next || 'nothing left'} (${data.reason})`, 'warn');
  } else if (type === 'turn_end') {
    if (!turn.text && !turn.relay && data.text) {
      turn.text = data.text;
      paintStream(turn);
    }
    turn.ok = data.ok;
    if (!data.ok) turn.failed = turn.stopped ? 'Stopped.' : 'No CLI could answer. Check CLIs and logs in Settings.';
    logActivity(`[end] ${data.backend || 'relay'}${data.ok ? '' : ' (failed)'}`);
  } else if (type === 'turn_error') {
    turn.failed = data.error;
    logActivity(`[error] ${data.error}`, 'error');
  }
}

async function stop() {
  if (state.turn) state.turn.stopped = true;
  await attempt(() => api('/api/abort', {}));
}

/* ---------- Edit, regenerate, retry ---------- */

const idle = () => {
  if (!state.turn && !state.status?.busy) return true;
  toast('Wait for the reply to finish, or stop it');
  return false;
};

// Earlier history is kept: anything that would be lost is left behind in the original chat.
async function resendFrom(index, newText) {
  if (!idle()) return;
  const tail = index === state.chat.entries.length - 1;
  const data = await attempt(() => api('/api/chat/branch', { index }));
  if (!data) return;
  const original = state.chat.sid;
  if (data.chat.sid === original) state.extras[original] = (state.extras[original] || []).filter((x) => x.at <= index && x.kind !== 'error');
  setChat(data.chat);
  if (!tail) {
    toast('Branched into a new chat. File changes were not undone.', { label: 'View original', run: () => openChat(original) });
  }
  await send(newText ?? data.text, data.attachments);
}

function startEdit(article) {
  if (!idle()) return;
  const index = Number(article.dataset.index);
  const entry = state.chat.entries[index];
  const loses = index < state.chat.entries.length - 1;
  const editor = fromHtml(`<form class="editor">
    <textarea aria-label="Edit message">${esc(entry.text)}</textarea>
    <div><small>${loses ? 'Sends in a new branch. Your original chat is kept.' : ''}</small><button type="button" class="btn">Cancel</button><button class="btn primary">Send</button></div>
  </form>`);
  article.querySelector('.bubble').replaceWith(editor);
  article.querySelector('.msg-actions').hidden = true;
  const box = editor.querySelector('textarea');
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
  editor.querySelector('[type="button"]').onclick = renderThread;
  box.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      renderThread();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      editor.requestSubmit();
    }
  };
  editor.onsubmit = (e) => {
    e.preventDefault();
    if (box.value.trim()) resendFrom(index, box.value.trim());
  };
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast("Couldn't copy");
    return;
  }
  if (!button) return;
  const before = button.innerHTML;
  button.innerHTML = button.classList.contains('icon-btn') ? icon('check') : 'Copied';
  setTimeout(() => (button.innerHTML = before), 1400);
}

function onThreadClick(e) {
  const button = e.target.closest('[data-act]');
  if (!button) return;
  const act = button.dataset.act;
  if (act === 'copy-code' || act === 'preview') {
    const block = button.closest('.code');
    const code = block.querySelector('code').textContent;
    if (act === 'copy-code') copyText(code, button);
    else openPreview(code);
    return;
  }
  if (act === 'retry') {
    resendFrom(Number(button.dataset.at));
    return;
  }
  const article = button.closest('.msg');
  const index = article.dataset.index === undefined ? null : Number(article.dataset.index);
  if (act === 'copy') copyText(index === null ? article.querySelector('.bubble').textContent : state.chat.entries[index].text, button);
  else if (act === 'edit') startEdit(article);
  else if (act === 'regenerate') {
    for (let i = index - 1; i >= 0; i -= 1) {
      if (state.chat.entries[i].kind === 'user') return void resendFrom(i);
    }
  }
}

/* ---------- Preview ---------- */

// no scripts (sandbox without allow-scripts) and no network (policy): showing a reply must not run or fetch anything
function openPreview(code) {
  $('previewFrame').srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">${code}`;
  $('preview').hidden = false;
}

function closePreview() {
  $('preview').hidden = true;
  $('previewFrame').srcdoc = '';
}

/* ---------- Attachments ---------- */

const sizeLabel = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function renderFiles() {
  $('attachments').innerHTML = state.files
    .map((f, i) => `<span class="file">${icon('file')}<span>${esc(f.name)}</span><small>${sizeLabel(f.size)}</small><button data-remove="${i}" title="Remove" aria-label="Remove ${esc(f.name)}">${icon('x')}</button></span>`)
    .join('');
  updateComposer();
}

const readBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`couldn't read ${file.name}`));
    reader.readAsDataURL(file);
  });

async function addFiles(list) {
  for (const file of list) {
    if (state.files.length + state.uploading >= 8) {
      toast('You can attach up to 8 files at a time');
      break;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast(`${file.name} is over 8 MB`);
      continue;
    }
    state.uploading += 1;
    updateComposer();
    const saved = await attempt(async () => api('/api/attach', { name: file.name, data: await readBase64(file) }));
    state.uploading -= 1;
    if (saved) state.files.push(saved.file);
    renderFiles();
  }
  $('prompt').focus();
}

/* ---------- Model picker ---------- */

function renderModelButton() {
  const choice = prefs.choice;
  const b = choice && backendOf(choice.backend);
  $('modelLabel').textContent = b ? `${b.label || b.name}${choice.model ? ` · ${choice.model}` : ''}` : 'Automatic';
  const none = state.status && !state.status.backends.some((x) => x.state === 'ready');
  $('modelDot').className = `dot ${b ? stateClass(b) : none ? 'out' : ''}`;
}

function renderModelMenu() {
  const s = state.status;
  if (!s) return;
  const is = (backend, model) => (prefs.choice?.backend || null) === backend && (prefs.choice?.model || null) === model;
  const row = (backend, model, name, note, dot, sub) =>
    `<button class="${sub ? 'sub' : ''} ${is(backend, model) ? 'selected' : ''}" data-backend="${esc(backend || '')}" data-model="${esc(model || '')}">${dot}<span class="name">${esc(name)}</span><small>${esc(note)}</small><svg class="ic tick"><use href="#i-check"/></svg></button>`;
  let html = row(null, null, 'Automatic', 'Relay picks, with failover', '', false) + '<hr>';
  for (const b of s.backends) {
    const note = b.state === 'ready' ? (b.freeTier ? 'Free' : 'Paid') : b.state === 'cooldown' ? `Back in ${b.cooldownText}` : 'Out of credits';
    html += row(b.name, null, b.label || b.name, note, `<span class="dot ${stateClass(b)}"></span>`, false);
    for (const model of s.models[b.name] || []) html += row(b.name, model, model, '', '', true);
  }
  if (!s.backends.length) html += '<div class="placeholder">No CLIs connected yet.</div>';
  html += `<hr><button data-open="models">${icon('settings')}<span class="name">Manage CLIs and routing</span></button>`;
  $('modelMenu').innerHTML = html;
}

function toggleModelMenu(open) {
  if (open) renderModelMenu();
  $('modelMenu').classList.toggle('open', open);
  $('btnModel').setAttribute('aria-expanded', String(open));
}

/* ---------- / and @ suggestions ---------- */

let suggestions = [];
let cursor = 0;

function suggestionsFor(text) {
  const slash = text.match(/^\/([\w-]*)$/);
  if (slash) {
    const all = [
      { insert: '/auto ', name: '/auto', note: 'Split work into tasks and assign CLIs' },
      { insert: '/skill list', name: '/skill list', note: 'Show imported skills' },
      ...state.skills.map((s) => ({ insert: `/${s.name} `, name: `/${s.name}`, note: s.description })),
      ...Object.entries(APP_COMMANDS).map(([name, [note]]) => ({ insert: name, name, note })),
    ];
    return all.filter((c) => c.name.slice(1).startsWith(slash[1]) && c.insert !== text);
  }
  const at = text.match(/^@([\w:.-]*)$/);
  if (at && state.status) {
    const all = state.status.backends.flatMap((b) => [
      { insert: `@${b.name} `, name: `@${b.name}`, note: b.label || b.name },
      ...(state.status.models[b.name] || []).map((m) => ({ insert: `@${b.name}:${m} `, name: `@${b.name}:${m}`, note: `${b.label || b.name}, ${m}` })),
    ]);
    return all.filter((c) => c.name.slice(1).startsWith(at[1]));
  }
  return [];
}

function renderSuggest() {
  $('suggest').innerHTML = suggestions
    .map((s, i) => `<button role="option" aria-selected="${i === cursor}" class="${i === cursor ? 'cursor' : ''}" data-i="${i}"><b>${esc(s.name)}</b><small>${esc(s.note)}</small></button>`)
    .join('');
  $('suggest').classList.toggle('open', suggestions.length > 0);
  $('suggest').querySelector('.cursor')?.scrollIntoView({ block: 'nearest' });
}

function closeSuggest() {
  suggestions = [];
  $('suggest').classList.remove('open');
}

function pickSuggestion(i) {
  const picked = suggestions[i];
  if (!picked) return;
  closeSuggest();
  setPrompt(picked.insert);
  $('prompt').focus();
}

/* ---------- Dictation ---------- */

let recognition = null;
function toggleDictation() {
  if (recognition) {
    recognition.stop();
    return;
  }
  recognition = new Speech();
  recognition.continuous = true;
  recognition.interimResults = true;
  const start = $('prompt').value ? `${$('prompt').value.trimEnd()} ` : '';
  recognition.onresult = (e) => setPrompt(start + [...e.results].map((r) => r[0].transcript).join(''));
  recognition.onerror = (e) => {
    if (e.error !== 'aborted' && e.error !== 'no-speech') toast(e.error === 'not-allowed' ? 'Microphone access was not allowed' : `Dictation stopped: ${e.error}`);
  };
  recognition.onend = () => {
    recognition = null;
    $('btnMic').setAttribute('aria-pressed', 'false');
  };
  recognition.start();
  $('btnMic').setAttribute('aria-pressed', 'true');
}

/* ---------- Chat menu, rename, delete, export ---------- */

function openChatMenu(sid, anchor) {
  const chat = state.chats.find((c) => c.sid === sid) || state.chat;
  state.menuFor = sid;
  $('pinLabel').textContent = chat?.pinned ? 'Unpin' : 'Pin';
  const menu = $('chatMenu');
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 218))}px`;
  const below = r.bottom + 4 + menu.offsetHeight < innerHeight;
  menu.style.top = `${below ? r.bottom + 4 : r.top - menu.offsetHeight - 4}px`;
  menu.style.transformOrigin = below ? 'top left' : 'bottom left';
  menu.classList.add('open');
}

const closeChatMenu = () => $('chatMenu').classList.remove('open');

function startRename(sid) {
  const item = $('chatList').querySelector(`[data-sid="${CSS.escape(sid)}"]`);
  const chat = state.chats.find((c) => c.sid === sid);
  const visible = item && item.offsetParent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = chat?.title || state.chat.title;
  input.setAttribute('aria-label', 'Chat name');
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    input.remove();
    if (save && name) {
      await attempt(() => api('/api/chat/update', { sid, name }));
      await loadChats();
      if (sid === state.chat.sid) await loadChat();
    }
    $('btnTitle').hidden = false;
    renderChats();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  if (visible) item.replaceChildren(input);
  else {
    // the sidebar is closed: rename in the toolbar instead
    $('btnTitle').hidden = true;
    $('btnTitle').after(input);
  }
  input.focus();
  input.select();
}

async function deleteChat(sid) {
  if (!(await chatAction('delete', { sid }))) return;
  toast('Chat deleted', { label: 'Undo', run: async () => (await chatAction('restore', { sid })) && chatAction('open', { sid }) });
}

async function exportChat(sid) {
  const data = await attempt(() => api(`/api/session?id=${encodeURIComponent(sid)}`));
  if (!data) return;
  const title = state.chats.find((c) => c.sid === sid)?.title || state.chat.title;
  const body = data.session.entries
    .filter((e) => e.kind === 'user' || e.kind === 'assistant')
    .map((e) => `## ${e.kind === 'user' ? 'You' : labelOf(e.backend)}\n\n${e.text}${e.attachments ? `\n\nAttached: ${e.attachments.map((a) => a.name).join(', ')}` : ''}`)
    .join('\n\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([`# ${title}\n\n${body}\n`], { type: 'text/markdown' }));
  link.download = `${title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'chat'}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/* ---------- Search and command palette ---------- */

let paletteItems = [];
let paletteCursor = 0;
let paletteSeq = 0;

async function searchPalette() {
  const query = $('paletteInput').value.trim().toLowerCase();
  const seq = ++paletteSeq;
  const commands = [
    { title: 'New chat', icon: 'compose', key: '⇧⌘O', run: () => newChat() },
    { title: 'Settings', icon: 'settings', run: () => openSettings('general') },
    { title: 'Custom instructions', icon: 'edit', run: () => openSettings('instructions') },
    { title: 'CLIs and models', icon: 'settings', run: () => openSettings('models') },
    { title: 'Change project folder', icon: 'folder', run: () => openFolders() },
    { title: 'Show or hide sidebar', icon: 'sidebar', key: '⌘B', run: () => toggleSidebar() },
    { title: 'Show or hide activity log', icon: 'activity', run: () => toggleActivity() },
    { title: 'Export this chat', icon: 'download', run: () => exportChat(state.chat.sid) },
  ].filter((c) => c.title.toLowerCase().includes(query));
  let chats = state.chats;
  if (query) {
    try {
      chats = (await api(`/api/chats?q=${encodeURIComponent(query)}`)).chats;
    } catch {
      chats = [];
    }
  }
  if (seq !== paletteSeq) return; // a newer keystroke owns the list
  const found = chats.filter((c) => c.messages).slice(0, query ? 30 : 6).map((c) => ({ title: c.title, note: c.snippet || folderLabel(c.cwd), icon: 'file', run: () => openChat(c.sid) }));
  paletteItems = query ? [...found, ...commands] : [...commands, ...found];
  paletteCursor = 0;
  renderPalette();
}

function renderPalette() {
  $('paletteResults').innerHTML =
    paletteItems
      .map((p, i) => `<button role="option" aria-selected="${i === paletteCursor}" class="${i === paletteCursor ? 'cursor' : ''}" data-i="${i}">${icon(p.icon)}<span>${esc(p.title)}${p.note ? `<small>${esc(p.note)}</small>` : ''}</span>${p.key ? `<kbd>${p.key}</kbd>` : ''}</button>`)
      .join('') || '<div class="placeholder">Nothing found.</div>';
  $('paletteResults').querySelector('.cursor')?.scrollIntoView({ block: 'nearest' });
}

function runPalette(i) {
  const item = paletteItems[i];
  if (!item) return;
  $('palette').close();
  item.run();
}

function openPalette() {
  closeDialogs();
  $('paletteInput').value = '';
  $('palette').showModal();
  searchPalette();
}

/* ---------- Project folder ---------- */

async function openFolders() {
  closeDialogs();
  $('folderDialog').showModal();
  $('folderInput').value = '';
  const data = await attempt(() => api('/api/folders'));
  if (!data) return;
  $('folderList').innerHTML = data.folders
    .map((f) => `<button data-folder="${esc(f)}">${esc(folderLabel(f))}${f === state.status.cwd ? ' · current' : ''}<small>${esc(f)}</small></button>`)
    .join('');
}

async function useFolder(dir) {
  if (await newChat(dir)) $('folderDialog').close();
}

/* ---------- Settings ---------- */

const closeDialogs = () => document.querySelectorAll('dialog[open]').forEach((d) => d.close());

const STRATEGY_HINTS = {
  priority: 'Uses your first CLI, and moves down the list only when it runs out.',
  pool: 'Takes turns across ready CLIs so none hits its limit early.',
  'free-first': 'Uses free tiers before spending paid credits.',
};

function renderBackends() {
  const s = state.status;
  if (!s) return;
  document.querySelectorAll('#strategies button').forEach((b) => b.classList.toggle('active', b.dataset.strategy === s.strategy));
  $('strategyHint').textContent = STRATEGY_HINTS[s.strategy] || '';
  const html = s.backends
    .map((b, i) => {
      const status = b.state === 'ready' ? 'Ready' : b.state === 'cooldown' ? `Back in ${b.cooldownText}` : 'Out of credits';
      return `<div class="card"><span class="dot ${stateClass(b)}"></span><div><b>${esc(b.label || b.name)}</b><small>${esc(status)} · ${b.freeTier ? 'Free' : 'Paid'} · ${b.turns} ${b.turns === 1 ? 'turn' : 'turns'}${b.reason ? ` · ${esc(b.reason)}` : ''}</small></div>
        <button class="icon-btn up" data-move="-1" data-name="${esc(b.name)}" title="Move up" aria-label="Move ${esc(b.name)} up" ${i === 0 ? 'disabled' : ''}>${icon('arrow-down')}</button>
        <button class="icon-btn" data-move="1" data-name="${esc(b.name)}" title="Move down" aria-label="Move ${esc(b.name)} down" ${i === s.backends.length - 1 ? 'disabled' : ''}>${icon('arrow-down')}</button></div>`;
    })
    .join('');
  // rebuild only on change, so the poll doesn't steal focus
  if ($('backendList').dataset.html !== html) {
    $('backendList').innerHTML = html || '<div class="placeholder">No CLIs connected yet. Run a scan.</div>';
    $('backendList').dataset.html = html;
  }
}

async function showPane(name) {
  document.querySelectorAll('.settings-nav button').forEach((b) => b.classList.toggle('active', b.dataset.pane === name));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  if (name === 'models') renderBackends();
  if (name === 'instructions') {
    const data = await attempt(() => api('/api/notes'));
    if (data) $('notesInput').value = data.text;
  }
  if (name === 'skills') {
    await loadSkills();
    $('skillList').innerHTML = state.skills.length
      ? state.skills.map((s) => `<div class="card"><div><b>/${esc(s.name)}</b><small>${esc(s.description)}</small></div></div>`).join('')
      : '<div class="placeholder">No skills imported yet.</div>';
  }
  if (name === 'project') {
    const data = await attempt(() => api('/api/agents'));
    if (data) showAgents(data);
    await loadLogs();
  }
}

async function openSettings(pane = 'general') {
  closeDialogs();
  $('scanList').innerHTML = '';
  $('btnConnectAll').hidden = true;
  $('settings').showModal();
  await showPane(pane);
}

const showAgents = (data) => ($('agentsBox').textContent = data.block || `Nothing synced yet.\n${data.file || ''}`);

async function syncAgents() {
  const data = await attempt(() => api('/api/sync', {}));
  if (!data) return;
  showAgents(data);
  toast('AGENTS.md updated');
}

async function loadLogs() {
  const data = await attempt(() => api('/api/logs'));
  if (data) $('logsBox').textContent = data.logs.join('\n') || 'No log entries.';
}

async function resetLimits() {
  if (await attempt(() => api('/api/forget', { backend: 'all' }))) {
    toast('All limits cleared');
    await loadStatus();
  }
}

async function runScan() {
  $('scanList').innerHTML = '<div class="placeholder">Scanning…</div>';
  const data = await attempt(() => api('/api/scan'));
  if (!data) {
    $('scanList').innerHTML = '';
    return;
  }
  const found = data.scanned.filter((c) => c.installed);
  $('scanList').innerHTML = found.length
    ? found.map((c) => `<div class="card"><div><b>${esc(c.label || c.name)}</b><small>${esc(c.path || c.name)}</small></div>${icon('check')}</div>`).join('')
    : '<div class="placeholder">No coding CLIs found on this computer.</div>';
  $('btnConnectAll').hidden = !found.length;
}

async function connectAll() {
  const data = await attempt(() => api('/api/scan', { autoConnect: true }));
  if (!data) return;
  const added = data.autoConnect.added.length;
  toast(added ? `Connected ${added} new ${added === 1 ? 'CLI' : 'CLIs'}` : 'No new CLIs to connect');
  await loadStatus();
}

async function loadSkills() {
  try {
    state.skills = (await api('/api/skills')).skills;
  } catch {
    state.skills = [];
  }
}

/* ---------- Window ---------- */

const narrow = () => matchMedia('(max-width: 720px)').matches;
function toggleSidebar() {
  if (narrow()) $('app').classList.toggle('sidebar-open');
  else savePref('sidebarHidden', !prefs.sidebarHidden);
}
const closeSidebarDrawer = () => $('app').classList.remove('sidebar-open');

function toggleActivity() {
  const on = $('content').classList.toggle('show-activity');
  $('activity').hidden = !on;
  $('btnActivity').setAttribute('aria-pressed', String(on));
}

const ACTIONS = {
  'toggle-sidebar': toggleSidebar,
  'new-chat': () => newChat(),
  search: openPalette,
  folder: openFolders,
  settings: () => openSettings(),
  activity: toggleActivity,
  attach: () => $('fileInput').click(),
  dictate: toggleDictation,
  stop,
  send: sendFromComposer,
  'close-preview': closePreview,
  'save-notes': async () => (await attempt(() => api('/api/notes', { text: $('notesInput').value }))) && toast('Instructions saved'),
  'reset-limits': resetLimits,
  scan: runScan,
  'connect-all': connectAll,
  sync: syncAgents,
  logs: loadLogs,
};

function bind() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-do]');
    if (el) ACTIONS[el.dataset.do]?.();
    if (e.target.closest('[data-close]')) e.target.closest('dialog').close();
    // a click on the backdrop closes a dialog
    if (e.target.matches('dialog')) {
      const r = e.target.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.anchor')) toggleModelMenu(false);
    if (!e.target.closest('#chatMenu')) closeChatMenu();
    if (!e.target.closest('.composer-dock')) closeSuggest();
  });

  $('scrim').addEventListener('click', closeSidebarDrawer);
  $('thread').addEventListener('click', onThreadClick);
  $('messages').addEventListener('scroll', () => ($('btnJump').hidden = nearBottom()), { passive: true });
  $('btnJump').addEventListener('click', scrollToEnd);

  $('chatList').addEventListener('click', (e) => {
    const item = e.target.closest('.chat-item');
    if (!item) return;
    if (e.target.closest('.chat-more')) openChatMenu(item.dataset.sid, e.target.closest('.chat-more'));
    else if (e.target.closest('.chat-open')) openChat(item.dataset.sid);
  });
  $('chatList').addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.chat-item');
    if (!item) return;
    e.preventDefault();
    openChatMenu(item.dataset.sid, item);
  });
  $('btnTitle').addEventListener('click', () => openChatMenu(state.chat.sid, $('btnTitle')));
  $('chatMenu').addEventListener('click', async (e) => {
    const what = e.target.closest('[data-chat]')?.dataset.chat;
    if (!what) return;
    const sid = state.menuFor;
    closeChatMenu();
    if (what === 'rename') startRename(sid);
    else if (what === 'export') exportChat(sid);
    else if (what === 'delete') deleteChat(sid);
    else if (what === 'pin') {
      const pinned = !(state.chats.find((c) => c.sid === sid) || state.chat).pinned;
      if (await attempt(() => api('/api/chat/update', { sid, pinned }))) await loadChats();
    }
  });

  $('btnModel').addEventListener('click', () => toggleModelMenu(!$('modelMenu').classList.contains('open')));
  $('modelMenu').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    toggleModelMenu(false);
    if (button.dataset.open) openSettings(button.dataset.open);
    else savePref('choice', button.dataset.backend ? { backend: button.dataset.backend, model: button.dataset.model || null } : null);
    renderModelButton();
  });

  const box = $('prompt');
  box.addEventListener('input', () => {
    growPrompt();
    updateComposer();
    cursor = 0;
    suggestions = suggestionsFor(box.value);
    renderSuggest();
  });
  box.addEventListener('keydown', (e) => {
    if (e.isComposing) return; // an input method is still choosing characters
    if (suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
        return void renderSuggest();
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && suggestions[cursor].insert.trim() !== box.value.trim())) {
        e.preventDefault();
        return void pickSuggestion(cursor);
      }
      if (e.key === 'Escape') return void closeSuggest();
    }
    if (e.key === 'ArrowUp' && !box.value) {
      const mine = [...$('thread').querySelectorAll('.msg.user[data-index]')].pop();
      if (mine) {
        e.preventDefault();
        startEdit(mine);
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && (prefs.enterSends || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendFromComposer();
    }
  });
  box.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });
  // pointer and arrow keys move the same highlight
  $('suggest').addEventListener('pointermove', (e) => {
    const button = e.target.closest('[data-i]');
    if (!button || Number(button.dataset.i) === cursor) return;
    cursor = Number(button.dataset.i);
    $('suggest').querySelectorAll('[data-i]').forEach((b) => {
      b.classList.toggle('cursor', Number(b.dataset.i) === cursor);
      b.setAttribute('aria-selected', String(Number(b.dataset.i) === cursor));
    });
  });
  $('suggest').addEventListener('click', (e) => {
    const button = e.target.closest('[data-i]');
    if (button) pickSuggestion(Number(button.dataset.i));
  });
  $('suggestions').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    // suggestions fill the box; nothing runs until you send it
    setPrompt(chip.dataset.prompt || chip.dataset.fill);
    box.focus();
  });

  $('fileInput').addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });
  $('attachments').addEventListener('click', (e) => {
    const button = e.target.closest('[data-remove]');
    if (!button) return;
    state.files.splice(Number(button.dataset.remove), 1);
    renderFiles();
  });
  const hasFiles = (e) => e.dataTransfer?.types.includes('Files');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth += 1;
    $('content').classList.add('dropping');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) $('content').classList.remove('dropping');
  });
  window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $('content').classList.remove('dropping');
    addFiles([...e.dataTransfer.files]);
  });

  $('paletteInput').addEventListener('input', searchPalette);
  $('paletteInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (paletteItems.length) paletteCursor = (paletteCursor + (e.key === 'ArrowDown' ? 1 : -1) + paletteItems.length) % paletteItems.length;
      renderPalette();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runPalette(paletteCursor);
    }
  });
  $('paletteResults').addEventListener('click', (e) => {
    const button = e.target.closest('[data-i]');
    if (button) runPalette(Number(button.dataset.i));
  });

  $('folderList').addEventListener('click', (e) => {
    const button = e.target.closest('[data-folder]');
    if (button) useFolder(button.dataset.folder);
  });
  $('folderForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const dir = $('folderInput').value.trim();
    if (dir) useFolder(dir);
  });

  document.querySelector('.settings-nav').addEventListener('click', (e) => {
    const button = e.target.closest('[data-pane]');
    if (button) showPane(button.dataset.pane);
  });
  document.querySelectorAll('.segmented[data-pref]').forEach((group) =>
    group.addEventListener('click', (e) => {
      const button = e.target.closest('[data-value]');
      if (button) savePref(group.dataset.pref, button.dataset.value);
    }),
  );
  document.querySelectorAll('input[data-pref]').forEach((input) => input.addEventListener('change', () => savePref(input.dataset.pref, input.checked)));
  $('strategies').addEventListener('click', async (e) => {
    const button = e.target.closest('[data-strategy]');
    if (button && (await attempt(() => api('/api/strategy', { strategy: button.dataset.strategy })))) await loadStatus();
  });
  $('backendList').addEventListener('click', async (e) => {
    const button = e.target.closest('[data-move]');
    if (!button) return;
    const order = state.status.backends.map((b) => b.name);
    const from = order.indexOf(button.dataset.name);
    const to = from + Number(button.dataset.move);
    [order[from], order[to]] = [order[to], order[from]];
    if (await attempt(() => api('/api/priority', { order }))) await loadStatus();
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'k') {
      e.preventDefault();
      if ($('palette').open) $('palette').close();
      else openPalette();
    } else if (mod && e.shiftKey && key === 'o') {
      e.preventDefault();
      closeDialogs();
      newChat();
    } else if (mod && key === 'b') {
      e.preventDefault();
      toggleSidebar();
    } else if (mod && key === '.') {
      e.preventDefault();
      stop();
    } else if (e.key === 'Escape') {
      toggleModelMenu(false);
      closeChatMenu();
      closeSidebarDrawer();
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  applyPrefs();
  bind();
  const hour = new Date().getHours();
  $('greetingText').textContent = `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}. What are we working on?`;
  await loadStatus();
  await loadChat();
  await Promise.all([loadChats(), loadSkills()]);
  updateComposer();
  $('prompt').focus();
  setInterval(loadStatus, 3000);
});
