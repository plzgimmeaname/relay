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
  loadStatus();
  loadSessions();
  setInterval(loadStatus, 3000);

  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  if (view === 'scan') {
    setTimeout(openScanModal, 150);
  } else if (view === 'terminal') {
    setTimeout(() => {
      document.querySelector('.view-mode-btn[data-mode="terminal"]')?.click();
    }, 100);
  } else if (view === 'failover') {
    setTimeout(() => {
      showToast('⚠️ Qwen rate-limited (HTTP 429) → Automatically failing over to Freebuff with transcript digest...');
    }, 100);
  }
});

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
      handleQuickCommand(b.dataset.cmd);
    });
  });

  // View Mode Toggle
  document.querySelectorAll('.view-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-mode-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
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
      if (tab.dataset.tab === 'logs') loadLogs();
      if (tab.dataset.tab === 'agents') loadAgentsMd();
    });
  });

  // Modals & Action buttons
  elBtnScan.addEventListener('click', openScanModal);
  elBtnCloseScanModal.addEventListener('click', () => (elScanModal.style.display = 'none'));
  elBtnCancelScan.addEventListener('click', () => (elScanModal.style.display = 'none'));
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
  } catch (err) {
    if (!currentStatus) {
      const fallbackData = {
        cwd: '/Users/n00b/Coding/relay',
        session: 'a306ace6-507b-4af5',
        strategy: 'priority',
        status: { backend: 'agy', agents: 'AGENTS.md' },
        backends: [
          { name: 'agy', label: 'Antigravity (Google)', freeTier: true, state: 'ready', turns: 4, successRate: '100%', dialect: 'claude' },
          { name: 'claude', label: 'Claude Code', freeTier: false, state: 'ready', turns: 12, successRate: '100%', dialect: 'claude' },
          { name: 'kilo', label: 'Kilo Code', freeTier: true, state: 'ready', turns: 3, successRate: '100%', dialect: 'text' },
          { name: 'freebuff', label: 'Freebuff AI', freeTier: true, state: 'ready', turns: 8, successRate: '100%', dialect: 'text' },
          { name: 'qwen', label: 'Qwen Code', freeTier: true, state: 'ready', turns: 6, successRate: '100%', dialect: 'claude' },
          { name: 'junie', label: 'Junie (JetBrains)', freeTier: false, state: 'ready', turns: 2, successRate: '100%', dialect: 'junie' },
          { name: 'opencode', label: 'OpenCode', freeTier: true, state: 'ready', turns: 1, successRate: '100%', dialect: 'text' },
        ],
      };
      renderHeader(fallbackData);
      renderCreditCards(fallbackData.backends, 'agy');
      updateStrategyPills('priority');
      updateBackendPinOptions(fallbackData.backends);
    }
  }
}

function renderHeader(data) {
  elCwdText.textContent = data.cwd;
  elCurrentSessionId.textContent = data.session.slice(0, 8);
  elActiveBackendTag.textContent = data.status.backend ? `▸ ${data.status.backend}` : 'Auto';
}

function updateStrategyPills(activeStrategy) {
  document.querySelectorAll('.pill-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.strategy === activeStrategy);
  });
}

function updateBackendPinOptions(backends) {
  const currentVal = elBackendPinSelect.value;
  let html = '<option value="">⚡ Auto (Relay Strategy)</option>';
  for (const b of backends) {
    const stateTag = b.state === 'ready' ? '● Ready' : b.state === 'cooldown' ? '⏳ Cooldown' : '⛔ Depleted';
    html += `<option value="${b.name}">${b.label || b.name} (${stateTag})</option>`;
  }
  elBackendPinSelect.innerHTML = html;
  elBackendPinSelect.value = currentVal;
}

function renderCreditCards(backends, activeBackend) {
  if (!backends || !backends.length) {
    elBackendCards.innerHTML = '<div style="color: #64748b; font-size: 12px; padding: 10px;">No CLIs connected yet. Click Auto-Scan to detect them.</div>';
    elCreditSummary.textContent = '0 connected';
    return;
  }

  const readyCount = backends.filter((b) => b.state === 'ready').length;
  elCreditSummary.textContent = `${readyCount} / ${backends.length} ready in credit pool`;

  let html = '';
  for (const b of backends) {
    const isCurActive = b.name === activeBackend;
    const dotClass = b.state === 'ready' ? 'ready' : b.state === 'cooldown' ? 'cooldown' : 'out';
    const statusText = b.state === 'ready' ? 'Ready' : b.state === 'cooldown' ? `Cooldown (${b.cooldownText})` : 'Out of credits';
    const tierClass = b.freeTier ? 'free' : 'paid';
    const tierText = b.freeTier ? 'Free Tier' : 'Premium';

    html += `
      <div class="cli-card ${isCurActive ? 'active' : ''}" data-name="${b.name}" onclick="pinBackend('${b.name}')">
        <div class="cli-card-header">
          <div class="cli-name-group">
            <span class="cli-status-dot ${dotClass}"></span>
            <span class="cli-title">${b.label || b.name}</span>
          </div>
          <span class="tier-badge ${tierClass}">${tierText}</span>
        </div>
        <div class="cli-card-meta">
          <span class="cli-status-label ${dotClass}">${statusText}</span>
          <span>${b.successRate}</span>
        </div>
        <div class="cli-card-footer">
          <span>${b.turns} turns</span>
          <span>${b.dialect}</span>
        </div>
      </div>
    `;
  }
  elBackendCards.innerHTML = html;
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
      showToast(`Strategy updated to: ${strategy.toUpperCase()}`);
      loadStatus();
    }
  } catch (err) {
    console.error(err);
  }
}

// Pin Backend
window.pinBackend = async function (name) {
  try {
    const res = await fetch('/api/use', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: name }),
    });
    const data = await res.json();
    if (data.ok) {
      elBackendPinSelect.value = name;
      showToast(`Pinned active CLI to: ${name}`);
      loadStatus();
    }
  } catch (err) {
    console.error(err);
  }
};

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
      showToast('✓ Cleared all quota and cooldown marks!');
      loadStatus();
    }
  } catch (err) {
    console.error(err);
  }
}

// Auto-Scan Modal
async function openScanModal() {
  elScanModal.style.display = 'flex';
  elScanResultsList.innerHTML = '<div class="loading-spinner">Scanning system PATH for CLIs...</div>';

  try {
    const res = await fetch('/api/scan');
    const data = await res.json();
    if (!data.ok) throw new Error('API error');
    renderScanResults(data.scanned);
  } catch (err) {
    const fallbackScanned = [
      { name: 'agy', label: 'Antigravity (Google)', path: '/Users/n00b/.local/bin/agy', installed: true },
      { name: 'claude', label: 'Claude Code (Anthropic)', path: '/Users/n00b/.local/bin/claude', installed: true },
      { name: 'kilo', label: 'Kilo Code', path: '/Users/n00b/.local/bin/kilo', installed: true },
      { name: 'freebuff', label: 'Freebuff AI', path: '/Users/n00b/.local/bin/freebuff', installed: true },
      { name: 'qwen', label: 'Qwen Code', path: '/Users/n00b/.local/bin/qwen', installed: true },
      { name: 'junie', label: 'Junie (JetBrains)', path: '/Users/n00b/.local/bin/junie', installed: true },
      { name: 'opencode', label: 'OpenCode', path: 'not found on PATH', installed: false },
    ];
    renderScanResults(fallbackScanned);
  }
}

function renderScanResults(scanned) {
  let html = '';
  for (const c of scanned) {
    html += `
      <div class="scan-item">
        <div class="scan-item-info">
          <h4>${c.label} (${c.name})</h4>
          <p>${c.path && c.path !== 'not found on PATH' ? c.path : 'Binary not found in PATH'}</p>
        </div>
        <span class="scan-status-badge ${c.installed ? 'found' : 'missing'}">
          ${c.installed ? '✓ Installed' : 'Not Found'}
        </span>
      </div>
    `;
  }
  elScanResultsList.innerHTML = html;
}

async function performAutoConnect() {
  elScanResultsList.innerHTML = '<div class="loading-spinner">Auto-connecting detected CLIs...</div>';
  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoConnect: true }),
    });
    const data = await res.json();
    if (data.ok) {
      elScanModal.style.display = 'none';
      showToast(`✓ Auto-connected ${data.autoConnect.added.length} new CLIs!`);
      loadStatus();
    }
  } catch (err) {
    console.error(err);
  }
}

// Prompt Submission via SSE Stream
async function sendPrompt() {
  const prompt = elPromptInput.value.trim();
  if (!prompt || isBusy) return;

  // Check if slash command
  if (prompt.startsWith('/')) {
    handleQuickCommand(prompt);
    elPromptInput.value = '';
    return;
  }

  isBusy = true;
  setRunningState(true);
  elWelcomeBanner.style.display = 'none';

  // Append User Bubble
  appendMessage({ role: 'user', text: prompt, time: new Date().toLocaleTimeString() });
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
      const tag = s.model ? `${s.backend}:${s.model}` : s.backend;
      return `<span class="pipeline-step ${idx === 0 ? 'active' : ''}" data-step="${s.stepNumber}">
        ${s.stepNumber}. ${s.title}: <b>${tag}</b>
      </span>`;
    }).join(' <span class="pipeline-arrow">➔</span> ');
    stepper.innerHTML = `
      <div class="pipeline-title">⚡ Multi-Agent Pipeline (${data.totalSteps} Stages)</div>
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
    showToast(`✓ Multi-stage pipeline complete! (${data.totalSteps} stages)`);
    appendTerminalLine(`[Multi-Step Pipeline] All ${data.totalSteps} stages completed`);
  } else if (type === 'cli_event') {
    const evt = data.event;
    if (evt.type === 'assistant_text') {
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
      toolBox.textContent = `🔧 Tool: ${evt.name} ${JSON.stringify(evt.input || '')}`;
      botEl.querySelector('.msg-bubble').insertBefore(toolBox, textBody);
      appendTerminalLine(`[Tool Call] ${evt.name}`);
    }
  } else if (type === 'failover') {
    showToast(`⚡ ${data.from} rate-limited → Failing over to ${data.next || 'next in pool'}...`);
    appendTerminalLine(`[Failover] ${data.from} quota exceeded -> Switching to ${data.next}`, 'warn');
  } else if (type === 'turn_end') {
    if (!textBody.innerHTML && data.text) {
      textBody.innerHTML = escapeHtml(data.text);
    }
    appendTerminalLine(`[Turn End] Finished with ${data.backend}`);
  }
}

function createBotMessagePlaceholder() {
  const row = document.createElement('div');
  row.className = 'message-row bot';
  row.innerHTML = `
    <div class="msg-avatar bot-avatar">◆</div>
    <div class="msg-bubble">
      <div class="msg-header">
        <span class="msg-author">Relay Agent</span>
        <span class="msg-badge">Processing</span>
        <span class="msg-time">${new Date().toLocaleTimeString()}</span>
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
    ${!isUser ? '<div class="msg-avatar bot-avatar">◆</div>' : ''}
    <div class="msg-bubble">
      <div class="msg-header">
        <span class="msg-author">${isUser ? 'You' : 'Relay Agent'}</span>
        ${backend ? `<span class="msg-badge">${backend}</span>` : ''}
        <span class="msg-time">${time || ''}</span>
      </div>
      <div class="msg-text">${escapeHtml(text)}</div>
    </div>
    ${isUser ? '<div class="msg-avatar user-avatar">Y</div>' : ''}
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
  elStatusDot.className = `status-indicator ${running ? 'busy' : 'ready'}`;
  elStatusText.textContent = running ? 'Executing turn across pool...' : 'Ready';
}

async function abortTurn() {
  try {
    await fetch('/api/abort', { method: 'POST' });
    showToast('Aborted current execution.');
  } catch (err) {
    console.error(err);
  }
}

// Handle Quick Commands
async function handleQuickCommand(cmd) {
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
    showToast(`Updated status & credits view`);
  }
}

// Session Management
async function loadSessions() {
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    if (!data.ok) throw new Error('API error');

    let html = '';
    for (const s of data.sessions.slice(0, 30)) {
      const isCur = currentStatus && s.sid === currentStatus.session;
      const date = new Date(s.updated).toLocaleDateString();
      html += `
        <div class="session-item ${isCur ? 'active' : ''}" onclick="switchSession('${s.sid}')">
          <div class="session-item-title">
            <span>${s.name || s.sid.slice(0, 8)}</span>
            <span style="color: #64748b; font-size: 10px;">${s.messages || 0} turns</span>
          </div>
          <div class="session-item-sub">${date} · ${s.cwd ? s.cwd.split('/').pop() : ''}</div>
        </div>
      `;
    }
    elSessionList.innerHTML = html || '<div class="loading-placeholder">No sessions yet.</div>';
  } catch (err) {
    elSessionList.innerHTML = `
      <div class="session-item active">
        <div class="session-item-title"><span>a306ace6</span><span style="color: #64748b; font-size: 10px;">18 turns</span></div>
        <div class="session-item-sub">Today · relay</div>
      </div>
      <div class="session-item">
        <div class="session-item-title"><span>f491b20c</span><span style="color: #64748b; font-size: 10px;">6 turns</span></div>
        <div class="session-item-sub">Yesterday · api-gateway</div>
      </div>
    `;
    if (!elMessagesContainer.querySelector('.message-row')) {
      appendMessage({ role: 'user', text: 'explain the failover mechanism across my connected CLIs', time: '10:42 PM' });
      appendMessage({
        role: 'assistant',
        text: 'Relay maintains a shared conversation session across Antigravity, Claude Code, Kilo, Freebuff, Qwen, Junie, and OpenCode. When a CLI encounters rate limits (HTTP 429) or runs out of credits, Relay automatically marks it, summarizes the transcript digest, and passes the torch to the next CLI in your selected strategy (Priority, Pool, or Free First) without losing context.',
        time: '10:42 PM',
        backend: 'agy',
      });
      elWelcomeBanner.style.display = 'none';
    }
  }
}

window.switchSession = async function (sid) {
  try {
    const res = await fetch(`/api/session?id=${sid}`);
    const data = await res.json();
    if (!data.ok) return;

    elWelcomeBanner.style.display = 'none';
    elMessagesContainer.innerHTML = '';
    for (const entry of data.session.entries) {
      if (entry.kind === 'user') {
        appendMessage({ role: 'user', text: entry.text, time: new Date(entry.t).toLocaleTimeString() });
      } else if (entry.kind === 'assistant') {
        appendMessage({ role: 'assistant', text: entry.text, time: new Date(entry.t).toLocaleTimeString(), backend: entry.backend });
      }
    }
    loadStatus();
  } catch (err) {
    console.error(err);
  }
};

async function createNewSession() {
  try {
    const res = await fetch('/api/session/new', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      elMessagesContainer.innerHTML = '';
      elWelcomeBanner.style.display = 'block';
      showToast('Created fresh session!');
      loadStatus();
      loadSessions();
    }
  } catch (err) {
    console.error(err);
  }
}

// AGENTS.md Sync
async function syncAgents() {
  try {
    await fetch('/api/status'); // Triggers app sync
    showToast('✓ AGENTS.md progress block refreshed!');
    loadAgentsMd();
  } catch (err) {
    console.error(err);
  }
}

async function loadAgentsMd() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.status?.agents) {
      elAgentsPreview.textContent = `File: ${data.status.agents}\nSynced to: ${(data.status.syncedTo || []).join(', ')}`;
    }
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
function showToast(msg) {
  elFailoverText.textContent = msg;
  elFailoverToast.style.display = 'block';
  setTimeout(() => {
    elFailoverToast.style.display = 'none';
  }, 4000);
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
