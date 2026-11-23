// Read the conversation history other coding CLIs keep on disk (claude, qwen, junie) so it can
// be listed, imported into a relay session, and referenced from any other CLI.
// Read-only: nothing here writes to those CLIs' folders.
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');

const CLIS = ['claude', 'qwen', 'junie'];
const HEAD_BYTES = 256 * 1024;
const WHOLE_LIMIT = 8 * 1024 * 1024;

function base() {
  return process.env.RELAY_NATIVE_HOME || os.homedir();
}

function dirs() {
  return {
    claude: path.join(base(), '.claude', 'projects'),
    qwen: path.join(base(), '.qwen', 'projects'),
    junie: path.join(base(), '.junie', 'sessions'),
  };
}

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, HEAD_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    const text = buf.toString('utf8');
    return { text: len < size ? text.slice(0, text.lastIndexOf('\n')) : text, size };
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* partial or foreign line */
    }
  }
  return out;
}

// What the person actually typed, without tool results or injected scaffolding.
function userText(message) {
  if (!message) return '';
  let text = '';
  if (typeof message.content === 'string') text = message.content;
  else if (Array.isArray(message.content)) text = message.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (/^<(?:command-|local-command|bash-)/.test(text) || /^Caveat:/.test(text)) return '';
  return text;
}

function assistantParts(message) {
  const parts = { text: '', tools: [] };
  if (!message || !Array.isArray(message.content)) return parts;
  for (const b of message.content) {
    if (b?.type === 'text' && b.text) parts.text += (parts.text ? '\n\n' : '') + b.text;
    else if (b?.type === 'tool_use') parts.tools.push(`${b.name || 'tool'} ${hint(b.input)}`.trim());
  }
  return parts;
}

function hint(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['command', 'file_path', 'path', 'pattern', 'prompt', 'description', 'url']) {
    if (typeof input[k] === 'string') return `${k}=${input[k].length > 60 ? input[k].slice(0, 59) + '…' : input[k]}`;
  }
  return '';
}

function isRealUser(e) {
  return e && e.type === 'user' && !e.isMeta && !e.isSidechain && e.message?.role === 'user';
}

// ---- listing ---------------------------------------------------------------
function scanProjects(cli) {
  const root = dirs()[cli];
  const items = [];
  let projects = [];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return items;
  }
  for (const p of projects) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(root, p.name)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(root, p.name, f);
      try {
        const st = fs.statSync(file);
        const { text, size } = readHead(file);
        const head = parseLines(text);
        let cwd = null;
        let title = '';
        for (const e of head) {
          if (!cwd) cwd = e.cwd || e.directories?.[0] || null;
          if (!title && isRealUser(e)) title = userText(e.message);
          if (cwd && title) break;
        }
        if (!title) continue; // never had a real prompt
        let turns = 0;
        const whole = size <= WHOLE_LIMIT ? fs.readFileSync(file, 'utf8') : text;
        turns = (whole.match(/"type":\s*"user"/g) || []).length;
        items.push({ cli, id: f.replace(/\.jsonl$/, ''), file, cwd: cwd || null, updated: st.mtimeMs, turns, title: title.replace(/\s+/g, ' ').slice(0, 80) });
      } catch {
        /* unreadable session: skip it */
      }
    }
  }
  return items;
}

function scanJunie() {
  const root = dirs().junie;
  const items = new Map();
  let lines = [];
  try {
    lines = parseLines(fs.readFileSync(path.join(root, 'index.jsonl'), 'utf8'));
  } catch {
    return [];
  }
  for (const e of lines) {
    if (!e.sessionId) continue;
    const dir = path.join(root, e.sessionId);
    if (!fs.existsSync(dir)) continue;
    items.set(e.sessionId, {
      cli: 'junie',
      id: e.sessionId,
      file: dir,
      cwd: e.projectDir || null,
      updated: e.updatedAt || e.createdAt || 0,
      turns: 0,
      title: String(e.taskName || '').replace(/\s+/g, ' ').slice(0, 80),
      task: e.taskName || '',
    });
  }
  return [...items.values()];
}

// native ids relay itself already recorded (those turns exist in relay sessions)
function relayOwned(home) {
  const owned = new Set();
  for (const s of store.allSessions(home)) {
    try {
      const h = store.openSession(s.file).header;
      for (const id of Object.values(h.backendSessions || {})) owned.add(id);
    } catch {
      /* skip */
    }
  }
  return owned;
}

function list(home, { cwd = null, cli = null, includeRelay = false } = {}) {
  const wanted = cli ? [cli] : CLIS;
  let items = [];
  for (const c of wanted) items = items.concat(c === 'junie' ? scanJunie() : scanProjects(c));
  if (cwd) items = items.filter((i) => i.cwd === cwd);
  if (!includeRelay) {
    const owned = relayOwned(home);
    items = items.filter((i) => !owned.has(i.id));
  }
  return items.sort((a, b) => b.updated - a.updated);
}

// ---- reading ---------------------------------------------------------------
function readJsonl(item) {
  const entries = [];
  let pending = null;
  const flush = () => {
    if (pending && (pending.text || pending.tools.length)) entries.push(pending);
    pending = null;
  };
  for (const e of parseLines(fs.readFileSync(item.file, 'utf8'))) {
    if (e.isSidechain) continue;
    const t = Date.parse(e.timestamp) || (typeof e.timestamp === 'number' ? e.timestamp : item.updated);
    if (isRealUser(e)) {
      const text = userText(e.message);
      if (!text) continue;
      flush();
      entries.push({ kind: 'user', t, text });
    } else if (e.type === 'assistant' && e.message?.role === 'assistant') {
      const parts = assistantParts(e.message);
      if (!pending) pending = { kind: 'assistant', t, backend: item.cli, text: '', tools: [], usage: null, durationMs: null };
      if (parts.text) pending.text += (pending.text ? '\n\n' : '') + parts.text;
      pending.tools.push(...parts.tools);
    }
  }
  flush();
  return entries;
}

function readJunie(item) {
  const entries = [];
  let transcript = '';
  try {
    transcript = fs.readFileSync(path.join(item.file, 'transcript.md'), 'utf8');
  } catch {
    /* no transcript */
  }
  const results = [];
  let cur = null;
  for (const line of transcript.split('\n')) {
    if (/^## Task result\s*$/.test(line)) {
      if (cur) results.push(cur.join('\n').trim());
      cur = [];
    } else if (/^#{2,3} /.test(line)) {
      if (cur) results.push(cur.join('\n').trim());
      cur = null;
    } else if (cur) cur.push(line);
  }
  if (cur) results.push(cur.join('\n').trim());
  const t = item.updated || Date.now();
  if (item.task) entries.push({ kind: 'user', t, text: item.task });
  results.filter(Boolean).forEach((r, i) => {
    if (i > 0) entries.push({ kind: 'user', t, text: '(a later task in this junie session — junie did not record the prompt)' });
    entries.push({ kind: 'assistant', t, backend: 'junie', text: r, tools: [], usage: null, durationMs: null });
  });
  return entries;
}

function read(item) {
  return item.cli === 'junie' ? readJunie(item) : readJsonl(item);
}

// ---- import ------------------------------------------------------------------
function importSession(home, item, fallbackCwd) {
  for (const s of store.allSessions(home)) {
    try {
      const ses = store.openSession(s.file);
      const imp = ses.header.imported;
      if (imp && imp.cli === item.cli && imp.id === item.id) return { session: ses, file: s.file, reused: true, entries: ses.entries.length };
    } catch {
      /* skip */
    }
  }
  const entries = read(item);
  if (!entries.length) throw new Error(`${item.cli} session ${item.id.slice(0, 8)} has no readable conversation`);
  const session = store.createSession(home, item.cwd || fallbackCwd, `${item.cli}: ${item.title.slice(0, 40)}`);
  session.header.imported = { cli: item.cli, id: item.id, at: Date.now() };
  store.rewriteHeader(session);
  for (const e of entries) store.appendEntry(session, e);
  return { session, file: session.file, reused: false, entries: entries.length };
}

function shortId(item) {
  return item.cli === 'junie' ? item.id.replace(/^session-/, '') : item.id.slice(0, 8);
}

function find(items, ref) {
  const r = String(ref || '').toLowerCase().replace(/^(claude|qwen|junie):/, '');
  if (/^\d+$/.test(r)) return items[Number(r) - 1] || null;
  const hits = items.filter((i) => i.id.toLowerCase().startsWith(r) || (r.length >= 4 && shortId(i).toLowerCase().includes(r)));
  return hits.length === 1 ? hits[0] : hits.length > 1 ? { ambiguous: hits } : null;
}

module.exports = { shortId, CLIS, list, read, importSession, find, userText };
