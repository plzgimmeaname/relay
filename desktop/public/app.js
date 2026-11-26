// Relay Desktop Client Application

let currentStatus = null;
let activeEventSource = null;
let currentSessionData = null;
let isBusy = false;

// DOM Elements
const elCwdText = document.getElementById('cwdText');
const elStrategyPills = document.getElementById('strategyPills');
const elBackendCards = document.getElementById('backendCardsContainer');
const elCreditSummary = document.getElementById('creditSummary');
const elCurrentSessionId = document.getElementById('currentSessionId');
const elActiveBackendTag = document.getElementById('activeBackendTag');
const elMessagesContainer = document.getElementById('messagesContainer');
const elTerminalContainer = document.getElementById('terminalContainer');
const elTerminalOutput = document.getElementById('terminalOutput');
const elWelcomeBanner = document.getElementById('welcomeBanner');
const elPromptInput = document.getElementById('promptInput');
const elBtnSend = document.getElementById('btnSend');
const elBtnAbort = document.getElementById('btnAbort');
const elBackendPinSelect = document.getElementById('backendPinSelect');
const elStatusDot = document.getElementById('statusDot');
const elStatusText = document.getElementById('statusText');
const elFailoverToast = document.getElementById('failoverToast');
const elFailoverText = document.getElementById('failoverText');
const elSessionList = document.getElementById('sessionList');
const elAgentsPreview = document.getElementById('agentsPreview');
const elLogsContainer = document.getElementById('logsContainer');

// Modals
const elScanModal = document.getElementById('scanModal');
const elScanResultsList = document.getElementById('scanResultsList');
const elBtnScan = document.getElementById('btnScan');
const elBtnCloseScanModal = document.getElementById('btnCloseScanModal');
const elBtnCancelScan = document.getElementById('btnCancelScan');
const elBtnAutoConnectAll = document.getElementById('btnAutoConnectAll');
const elBtnResetQuota = document.getElementById('btnResetQuota');
const elBtnNewSession = document.getElementById('btnNewSession');
const elBtnSyncAgents = document.getElementById('btnSyncAgents');
const elBtnRefreshSessions = document.getElementById('btnRefreshSessions');
const elBtnRefreshLogs = document.getElementById('btnRefreshLogs');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  setupChrome();
  loadStatus().then(loadSessions);
  setInterval(loadStatus, 3000);

  if (new URLSearchParams(window.location.search).get('view') === 'terminal') {
    document.querySelector('.view-mode-btn[data-mode="terminal"]')?.click();
  }
});

const elApp = document.getElementById('app');
const elCommandMenu = document.getElementById('commandMenu');
const elBtnCommands = document.getElementById('btnCommands');

// slide each segmented control's thumb under its selected button
function placeThumbs() {
  document.querySelectorAll('.segmented').forEach((group) => {
    const on = group.querySelector('.segment.active');
    const thumb = group.querySelector('.segment-thumb');
    if (!on || !thumb || !on.offsetWidth) return;
    thumb.style.width = `${on.offsetWidth}px`;
    thumb.style.transform = `translateX(${on.offsetLeft}px)`;
    // animate only after the first placement
    if (!group.classList.contains('ready')) requestAnimationFrame(() => group.classList.add('ready'));
  });
}

function setMenu(open) {
  elCommandMenu.classList.toggle('open', open);
  elBtnCommands.setAttribute('aria-expanded', String(open));
}

// wide windows collapse a side panel; narrow ones slide it over the conversation
function togglePanel(name, narrowAt) {
  if (window.matchMedia(`(max-width: ${narrowAt}px)`).matches) elApp.classList.toggle(`${name}-open`);
  else elApp.classList.toggle(`${name}-hidden`);
  placeThumbs();
}

function closeDrawers() {
  elApp.classList.remove('sidebar-open', 'inspector-open');
}

function closeScan() {
  elScanModal.classList.remove('open');
}

function setupChrome() {
  document.getElementById('btnToggleSidebar').addEventListener('click', () => togglePanel('sidebar', 720));
  document.getElementById('btnToggleInspector').addEventListener('click', () => togglePanel('inspector', 1040));
  document.getElementById('drawerScrim').addEventListener('click', closeDrawers);
  elBtnCommands.addEventListener('click', () => setMenu(!elCommandMenu.classList.contains('open')));
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.menu-anchor')) setMenu(false);
  });
  elScanModal.addEventListener('click', (e) => {
    if (e.target === elScanModal) closeScan();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    setMenu(false);
    closeScan();
    closeDrawers();
  });
  elBackendCards.addEventListener('click', (e) => {
    const row = e.target.closest('.backend');
    if (row) pinBackend(row.dataset.name);
  });
  elSessionList.addEventListener('click', (e) => {
    const item = e.target.closest('.session-item');
    if (item) switchSession(item.dataset.sid);
  });
  window.addEventListener('resize', placeThumbs);
  new ResizeObserver(placeThumbs).observe(elApp);
  placeThumbs();
}

function setupEventListeners() {
  // Strategy Pills
  elStrategyPills.addEventListener('click', async (e) => {
    const btn = e.target.closest('.pill-btn');
    if (!btn) return;
    const strategy = btn.dataset.strategy;
    await setStrategy(strategy);
  });

  // Prompt Send & Auto-resize
  elBtnSend.addEventListener('click', sendPrompt);
  elPromptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });

  elPromptInput.addEventListener('input', () => {
    elPromptInput.style.height = 'auto';
    elPromptInput.style.height = Math.min(elPromptInput.scrollHeight, 140) + 'px';
  });

  // Abort
  elBtnAbort.addEventListener('click', abortTurn);

  // Quick Chips
  document.querySelectorAll('.chip').forEach((c) => {
    c.addEventListener('click', () => {
      elPromptInput.value = c.dataset.prompt;
      sendPrompt();
    });
  });

  // Quick Commands
  document.querySelectorAll('.quick-cmd').forEach((b) => {
    b.addEventListener('click', () => {
      setMenu(false);
      if (APP_COMMANDS.includes(b.dataset.cmd.split(/\s+/)[0]) || b.dataset.cmd.endsWith(' ')) handleQuickCommand(b.dataset.cmd);
      else {
        elPromptInput.value = b.dataset.cmd;
        sendPrompt();
      }
    });
  });

  // View Mode Toggle
  document.querySelectorAll('.view-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-mode-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      placeThumbs();
      const mode = btn.dataset.mode;
      if (mode === 'chat') {
        elMessagesContainer.style.display = 'flex';
        elTerminalContainer.style.display = 'none';
      } else {
        elMessagesContainer.style.display = 'none';
        elTerminalContainer.style.display = 'flex';
      }
    });
  });

  // Sidebar Tabs
  document.querySelectorAll('.sidebar-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      const panelId = 'tab' + tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1);
      document.getElementById(panelId)?.classList.add('active');
      placeThumbs();
      if (tab.dataset.tab === 'logs') loadLogs();
      if (tab.dataset.tab === 'agents') loadAgentsMd();
    });
  });

  // Modals & Action buttons
  elBtnScan.addEventListener('click', openScanModal);
  elBtnCloseScanModal.addEventListener('click', closeScan);
  elBtnCancelScan.addEventListener('click', closeScan);
  elBtnAutoConnectAll.addEventListener('click', performAutoConnect);
  elBtnResetQuota.addEventListener('click', resetAllLimits);
  elBtnNewSession.addEventListener('click', createNewSession);
  elBtnSyncAgents.addEventListener('click', syncAgents);
  elBtnRefreshSessions.addEventListener('click', loadSessions);
  elBtnRefreshLogs.addEventListener('click', loadLogs);
}

// Fetch & Update Status
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (!data.ok) throw new Error('API returned error');

    currentStatus = data;
    renderHeader(data);
    renderCreditCards(data.backends, data.status.backend);
    updateStrategyPills(data.strategy);
    updateBackendPinOptions(data.backends);
    setOffline(false);
  } catch (err) {
    setOffline(true);
  }
}

let isOffline = false;
function setOffline(offline) {
  if (offline === isOffline) return;
  isOffline = offline;
  elBtnSend.disabled = offline;
  if (!isBusy) {
    elStatusDot.className = `status-dot ${offline ? 'offline' : 'ready'}`;
    elStatusText.textContent = offline ? "Can't reach Relay. Check that relay desktop is still running." : 'Ready';
  }
}

function renderHeader(data) {
  elCwdText.textContent = data.cwd;
  document.getElementById('cwdBadge').title = data.cwd;
  elCurrentSessionId.textContent = data.session.slice(0, 8);
  elActiveBackendTag.textContent = data.status.backend || 'Auto';
}

const STRATEGY_HINTS = {
  priority: 'Uses your first CLI, and moves down the list only when it runs out.',
  pool: 'Takes turns across ready CLIs so no single one hits its limit early.',
  'free-first': 'Uses free tiers before spending paid credits.',
};

function updateStrategyPills(activeStrategy) {
  document.querySelectorAll('.pill-btn').forEach((btn) => {
    const on = btn.dataset.strategy === activeStrategy;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
  document.getElementById('strategyHint').textContent = STRATEGY_HINTS[activeStrategy] || '';
  placeThumbs();
}

// rebuild only on change: the poll would otherwise drop focus, an open list or a press
let lastPinHtml = '';
let lastBackendHtml = '';

function updateBackendPinOptions(backends) {
  let html = '<option value="">Automatic</option>';
  for (const b of backends) {
    const note = b.state === 'ready' ? '' : b.state === 'cooldown' ? ' (cooling down)' : ' (out of credits)';
    html += `<option value="${escapeHtml(b.name)}">${escapeHtml(b.label || b.name)}${note}</option>`;
  }
  if (html === lastPinHtml) return;
  lastPinHtml = html;
  const currentVal = elBackendPinSelect.value;
  elBackendPinSelect.innerHTML = html;
  elBackendPinSelect.value = currentVal;
}

function renderCreditCards(backends, activeBackend) {
  if (!backends || !backends.length) {
    elCreditSummary.textContent = 'None connected';
    elBackendCards.innerHTML = lastBackendHtml = '';
    return;
  }

  const readyCount = backends.filter((b) => b.state === 'ready').length;
  elCreditSummary.textContent = `${readyCount} of ${backends.length} ready`;

  let html = '';
  for (const b of backends) {
    const isCurActive = b.name === activeBackend;
    const state = b.state === 'ready' ? 'ready' : b.state === 'cooldown' ? 'cooldown' : 'out';
    const statusText = state === 'ready' ? 'Ready' : state === 'cooldown' ? `Cooling down ${b.cooldownText}` : 'Out of credits';

    html += `
      <button class="backend ${isCurActive ? 'active' : ''}" data-name="${escapeHtml(b.name)}" aria-pressed="${isCurActive}" title="${escapeHtml(b.label || b.name)} · ${escapeHtml(b.dialect)} protocol · ${escapeHtml(b.successRate)} success">
        <span class="backend-row">
          <span class="backend-dot ${state}"></span>
          <span class="backend-name">${escapeHtml(b.label || b.name)}</span>
          ${isCurActive ? '<svg class="ic ic-sm"><use href="#i-check"/></svg>' : ''}
        </span>
        <span class="backend-meta" style="display:block">
          <span class="${state}">${escapeHtml(statusText)}</span> · ${b.freeTier ? 'Free' : 'Paid'} · ${b.turns} ${b.turns === 1 ? 'turn' : 'turns'}
        </span>
      </button>
    `;
  }
  if (html === lastBackendHtml) return;
  elBackendCards.innerHTML = lastBackendHtml = html;
}

// Strategy Switcher
async function setStrategy(strategy) {
  try {
    const res = await fetch('/api/strategy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy }),
    });
    const data = await res.json();
    if (data.ok) {
      updateStrategyPills(strategy);
      showToast(`Routing: ${strategy.replace('-', ' ')}`);
      loadStatus();
    }
  } catch (err) {
    console.error(err);
  }
}

// Pin Backend
async function pinBackend(name) {
  try {
    const res = await fetch('/api/use', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: name }),
    });
    const data = await res.json();
    if (data.ok) {
      elBackendPinSelect.value = name;
      showToast(`Next turn goes to ${name}`);
      loadStatus();
    }
  } catch (err) {
    console.error(err);
  }
}

// Reset Limits
async function resetAllLimits() {
  try {
    const res = await fetch('/api/forget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'all' }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast('All limits cleared');
      loadStatus();
    }
  } catch (err) {
    console.error(err);
  }
}

// Scan sheet
async function openScanModal() {
  // grow out of the button that was pressed
  const from = elBtnScan.getBoundingClientRect();
  const sheet = elScanModal.querySelector('.sheet');
  closeDrawers();
  sheet.style.transformOrigin = from.width ? `${from.left}px ${from.top}px` : '50% 50%';
  elScanModal.classList.add('open');
  elScanResultsList.innerHTML = '<div class="placeholder">Scanning…</div>';
  elBtnAutoConnectAll.disabled = true;

  try {
    const res = await fetch('/api/scan');
    const data = await res.json();
    if (!data.ok) throw new Error('API error');
    renderScanResults(data.scanned);
    elBtnAutoConnectAll.disabled = false;
  } catch (err) {
    elScanResultsList.innerHTML = '<div class="placeholder">The scan failed. Check that relay desktop is still running.</div>';
  }
}

function renderScanResults(scanned) {
  // what was found goes first
  const sorted = [...scanned].sort((a, b) => Number(b.installed) - Number(a.installed));
  elScanResultsList.innerHTML = sorted
    .map((c) => {
      const where = c.installed && c.path ? c.path : 'Not installed';
      return `
      <div class="scan-item">
        <div>
          <h3>${escapeHtml(c.label || c.name)}</h3>
          <p title="${escapeHtml(where)}">${escapeHtml(where)}</p>
        </div>
        <span class="scan-status ${c.installed ? 'found' : ''}">
          ${c.installed ? '<svg class="ic ic-sm"><use href="#i-check"/></svg> Installed' : escapeHtml(c.name)}
        </span>
      </div>`;
    })
    .join('');
}

async function performAutoConnect() {
  elScanResultsList.innerHTML = '<div class="placeholder">Connecting…</div>';
  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoConnect: true }),
    });
    const data = await res.json();
    if (data.ok) {
      closeScan();
      const added = data.autoConnect.added.length;
      showToast(added ? `Connected ${added} new ${added === 1 ? 'CLI' : 'CLIs'}` : 'No new CLIs to connect');
      loadStatus();
    }
  } catch (err) {
    console.error(err);
  }
}

const APP_COMMANDS = ['/scan', '/strategy', '/forget', '/sync', '/credits', '/status', '/backends'];

// Prompt Submission via SSE Stream
async function sendPrompt() {
  const prompt = elPromptInput.value.trim();
  if (!prompt || isBusy) return;

  // the app handles its own view commands; skills, /auto, @tags and the rest go to relay
  if (APP_COMMANDS.includes(prompt.split(/\s+/)[0])) {
    handleQuickCommand(prompt);
    elPromptInput.value = '';
    return;
  }

  isBusy = true;
  setRunningState(true);
  elWelcomeBanner.style.display = 'none';
  if (viewingSid) showCurrentSession();

  // Append User Bubble
  appendMessage({ role: 'user', text: prompt, time: clock() });
  elPromptInput.value = '';
  elPromptInput.style.height = 'auto';

  // Prepare Assistant Placeholder Bubble
  const botMessageEl = createBotMessagePlaceholder();
  elMessagesContainer.appendChild(botMessageEl);
  scrollToBottom();

  const chosenBackend = elBackendPinSelect.value || null;

  try {
    const response = await fetch('/api/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, backend: chosenBackend }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        const eventMatch = line.match(/^event: (.*)$/m);
        const dataMatch = line.match(/^data: (.*)$/m);
        const eventType = eventMatch ? eventMatch[1] : 'message';
        const eventData = dataMatch ? JSON.parse(dataMatch[1]) : {};

        handleSseEvent(eventType, eventData, botMessageEl);
      }
    }
  } catch (err) {
    appendTerminalLine(`Error: ${err.message}`, 'error');
  } finally {
    isBusy = false;
    setRunningState(false);
    loadStatus();
    loadSessions();
  }
}

function handleSseEvent(type, data, botEl) {
  const textBody = botEl.querySelector('.msg-text');
  const authorTag = botEl.querySelector('.msg-badge');

  if (type === 'turn_start') {
    authorTag.textContent = data.backend;
    appendTerminalLine(`[Turn Start] Backend: ${data.backend} | Hop: ${data.hop}`);
  } else if (type === 'pipeline_start') {
    let stepper = botEl.querySelector('.pipeline-stepper');
    if (!stepper) {
      stepper = document.createElement('div');
      stepper.className = 'pipeline-stepper';
      botEl.querySelector('.msg-bubble').insertBefore(stepper, textBody);
    }
    const stepsHtml = data.steps.map((s, idx) => {
      const tag = escapeHtml(s.model ? `${s.backend}:${s.model}` : s.backend);
      return `<span class="pipeline-step ${idx === 0 ? 'active' : ''}" data-step="${s.stepNumber}">
        ${s.stepNumber}. ${escapeHtml(s.title)}: <b>${tag}</b>
      </span>`;
    }).join(' <span class="pipeline-arrow">→</span> ');
    stepper.innerHTML = `
      <div class="pipeline-title">Multi-agent pipeline · ${data.totalSteps} stages</div>
      <div class="pipeline-steps">${stepsHtml}</div>
    `;
    authorTag.textContent = 'Multi-Agent';
    appendTerminalLine(`[Multi-Step Pipeline] Initialized with ${data.totalSteps} stages`);
  } else if (type === 'step_start') {
    authorTag.textContent = data.model ? `${data.backend}:${data.model}` : data.backend;
    const stepper = botEl.querySelector('.pipeline-stepper');
    if (stepper) {
      stepper.querySelectorAll('.pipeline-step').forEach((el) => {
        const num = Number(el.dataset.step);
        if (num < data.stepNumber) {
          el.className = 'pipeline-step completed';
        } else if (num === data.stepNumber) {
          el.className = 'pipeline-step active';
        }
      });
    }
    appendTerminalLine(`[Stage ${data.stepNumber}/${data.totalSteps}] Dispatched to ${data.backend} (${data.step.title})`);
  } else if (type === 'step_end') {
    const stepper = botEl.querySelector('.pipeline-stepper');
    if (stepper) {
      const stepEl = stepper.querySelector(`.pipeline-step[data-step="${data.stepNumber}"]`);
      if (stepEl) {
        stepEl.className = 'pipeline-step completed';
      }
    }
  } else if (type === 'pipeline_complete') {
    const stepper = botEl.querySelector('.pipeline-stepper');
    if (stepper) {
      stepper.querySelectorAll('.pipeline-step').forEach((el) => {
        el.className = 'pipeline-step completed';
      });
    }
    showToast(`All ${data.totalSteps} steps finished`);
    appendTerminalLine(`[Multi-Step Pipeline] All ${data.totalSteps} stages completed`);
  } else if (type === 'cli_event') {
    const evt = data.event;
    if (evt.type === 'assistant_text') {
      if (data.backend === 'relay') textBody.classList.add('columns');
      textBody.innerHTML += escapeHtml(evt.text);
      appendTerminalLine(evt.text, 'stream');
      scrollToBottom();
    } else if (evt.type === 'thinking') {
      let thinkingBox = botEl.querySelector('.thinking-box');
      if (!thinkingBox) {
        thinkingBox = document.createElement('div');
        thinkingBox.className = 'thinking-box';
        botEl.querySelector('.msg-bubble').insertBefore(thinkingBox, textBody);
      }
      thinkingBox.textContent = evt.text;
    } else if (evt.type === 'tool_use') {
      const toolBox = document.createElement('div');
      toolBox.className = 'tool-box';
      toolBox.innerHTML = `<svg class="ic ic-sm"><use href="#i-tool"/></svg><span>${escapeHtml(evt.name)} ${escapeHtml(JSON.stringify(evt.input || ''))}</span>`;
      botEl.querySelector('.msg-bubble').insertBefore(toolBox, textBody);
      appendTerminalLine(`[Tool Call] ${evt.name}`);
    }
  } else if (type === 'failover') {
    showToast(`${data.from} hit its limit. Switching to ${data.next || 'the next CLI'}.`);
    appendTerminalLine(`[Failover] ${data.from} quota exceeded -> Switching to ${data.next}`, 'warn');
  } else if (type === 'turn_end') {
    if (!textBody.innerHTML && data.text) {
      textBody.innerHTML = escapeHtml(data.text);
    }
    if (!textBody.innerHTML && !data.ok) textBody.textContent = 'No CLI could answer. See the Logs tab.';
    if (authorTag.textContent === 'Processing') authorTag.textContent = data.backend || 'relay';
    appendTerminalLine(`[Turn End] Finished with ${data.backend || 'relay'}`);
  } else if (type === 'turn_error') {
    textBody.textContent += data.error;
    authorTag.textContent = 'error';
    appendTerminalLine(`[Error] ${data.error}`, 'error');
  }
}

function clock(t = Date.now()) {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function createBotMessagePlaceholder() {
  const row = document.createElement('div');
  row.className = 'message-row bot';
  row.innerHTML = `
    <div class="msg-bubble">
      <div class="msg-header">
        <span class="msg-author">Relay</span>
        <span class="msg-badge">Processing</span>
        <span class="msg-time">${clock()}</span>
      </div>
      <div class="msg-text"></div>
    </div>
  `;
  return row;
}

function appendMessage({ role, text, time, backend }) {
  const isUser = role === 'user';
  const row = document.createElement('div');
  row.className = `message-row ${isUser ? 'user' : 'bot'}`;
  row.innerHTML = `
    <div class="msg-bubble">
      <div class="msg-header">
        <span class="msg-author">${isUser ? 'You' : 'Relay'}</span>
        ${backend ? `<span class="msg-badge">${escapeHtml(backend)}</span>` : ''}
        <span class="msg-time">${time || ''}</span>
      </div>
      <div class="msg-text">${escapeHtml(text)}</div>
    </div>
  `;
  elMessagesContainer.appendChild(row);
  scrollToBottom();
}

function appendTerminalLine(text, kind = 'info') {
  const line = document.createElement('div');
  line.className = `term-line ${kind}`;
  line.textContent = text;
  elTerminalOutput.appendChild(line);
  elTerminalOutput.scrollTop = elTerminalOutput.scrollHeight;
}

function scrollToBottom() {
  elMessagesContainer.scrollTop = elMessagesContainer.scrollHeight;
}

function setRunningState(running) {
  elBtnSend.style.display = running ? 'none' : 'flex';
  elBtnAbort.style.display = running ? 'flex' : 'none';
  elStatusDot.className = `status-dot ${running ? 'busy' : 'ready'}`;
  elStatusText.textContent = running ? 'Working…' : 'Ready';
}

async function abortTurn() {
  try {
    await fetch('/api/abort', { method: 'POST' });
    showToast('Stopped');
  } catch (err) {
    console.error(err);
  }
}

// Handle Quick Commands
async function handleQuickCommand(cmd) {
  // chips that prefill relay syntax rather than act on the app
  if (cmd.endsWith(' ')) {
    elPromptInput.value = cmd;
    elPromptInput.focus();
    return;
  }
  appendTerminalLine(`[User Command] ${cmd}`);
  const parts = cmd.split(/\s+/);
  const action = parts[0];

  if (action === '/scan') {
    openScanModal();
  } else if (action === '/strategy') {
    if (parts[1]) await setStrategy(parts[1]);
  } else if (action === '/forget') {
    await resetAllLimits();
  } else if (action === '/sync') {
    await syncAgents();
  } else if (action === '/credits' || action === '/status' || action === '/backends') {
    await loadStatus();
    showToast('Status refreshed');
  }
}

// Session Management
let viewingSid = null; // a saved session being read; prompts still go to the current one

function markViewing() {
  elSessionList.querySelectorAll('.session-item').forEach((el) => el.classList.toggle('viewing', el.dataset.sid === viewingSid));
}

async function loadSessions() {
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    if (!data.ok) throw new Error('API error');

    let html = '';
    for (const s of data.sessions.slice(0, 30)) {
      const isCur = currentStatus && s.sid === currentStatus.session;
      const date = new Date(s.updated).toLocaleDateString([], { month: 'short', day: 'numeric' });
      const turns = s.messages || 0;
      html += `
        <button class="session-item ${isCur ? 'active' : ''}" data-sid="${escapeHtml(s.sid)}">
          <span class="session-title">
            <span>${escapeHtml(s.name || s.sid.slice(0, 8))}</span>
            <span class="session-turns">${turns} ${turns === 1 ? 'turn' : 'turns'}</span>
          </span>
          <span class="session-sub" style="display:block">${escapeHtml(date)} · ${escapeHtml(s.cwd ? s.cwd.split('/').pop() : '')}</span>
        </button>
      `;
    }
    elSessionList.innerHTML = html || '<div class="placeholder">No sessions yet.</div>';
    markViewing();
  } catch (err) {
    elSessionList.innerHTML = '<div class="placeholder">Sessions are unavailable.</div>';
  }
}

function showEntries(entries) {
  elMessagesContainer.innerHTML = '';
  for (const entry of entries) {
    if (entry.kind === 'user') {
      appendMessage({ role: 'user', text: entry.text, time: clock(entry.t) });
    } else if (entry.kind === 'assistant') {
      appendMessage({ role: 'assistant', text: entry.text, time: clock(entry.t), backend: entry.backend });
    }
  }
  if (!elMessagesContainer.children.length) showWelcome();
}

function showWelcome() {
  // clearing the list detaches the welcome screen, so put it back
  elMessagesContainer.replaceChildren(elWelcomeBanner);
  elWelcomeBanner.style.display = '';
}

// leave a saved session's history before adding to the current conversation
function showCurrentSession() {
  viewingSid = null;
  elMessagesContainer.innerHTML = '';
  markViewing();
}

async function switchSession(sid) {
  if (isBusy) return;
  try {
    const res = await fetch(`/api/session?id=${encodeURIComponent(sid)}`);
    const data = await res.json();
    if (!data.ok) return;

    showEntries(data.session.entries);
    viewingSid = currentStatus && sid === currentStatus.session ? null : sid;
    markViewing();
    closeDrawers();
    if (viewingSid) showToast('Viewing a saved session. New messages go to the current one.');
  } catch (err) {
    console.error(err);
  }
}

async function createNewSession() {
  try {
    const res = await fetch('/api/session/new', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      viewingSid = null;
      showWelcome();
      closeDrawers();
      showToast('New session');
      await loadStatus();
      loadSessions();
    }
  } catch (err) {
    console.error(err);
  }
}

// AGENTS.md
function showAgents(data) {
  elAgentsPreview.textContent = data.block || `Nothing synced yet.\n\n${data.file || ''}`;
}

async function syncAgents() {
  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    showAgents(data);
    showToast('AGENTS.md updated');
  } catch (err) {
    showToast("Couldn't update AGENTS.md");
  }
}

async function loadAgentsMd() {
  try {
    const res = await fetch('/api/agents');
    const data = await res.json();
    if (data.ok) showAgents(data);
  } catch (err) {
    console.error(err);
  }
}

// Logs
async function loadLogs() {
  try {
    const res = await fetch('/api/logs');
    const data = await res.json();
    if (data.ok) {
      elLogsContainer.innerHTML = data.logs.map((l) => `<div class="log-entry">${escapeHtml(l)}</div>`).join('');
    }
  } catch (err) {
    console.error(err);
  }
}

// Toast
let toastTimer = null;
function showToast(msg) {
  elFailoverText.textContent = msg;
  elFailoverToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elFailoverToast.classList.remove('show'), 4000);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
