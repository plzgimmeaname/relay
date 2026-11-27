const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MARKER = 'relay:progress';

function projectKey(cwd) {
  return crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 12);
}

function sessionsDir(home, cwd) {
  return path.join(home, 'sessions', projectKey(cwd));
}

function newId() {
  return crypto.randomUUID();
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

function blocksOf(message, type) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content.filter((b) => b && b.type === type);
}

function thinkingOf(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content.filter((b) => b && b.type === 'thinking').map((b) => b.thinking || b.text || '').join('\n');
}

function createHeader(cwd, name) {
  return { kind: 'header', sid: newId(), name: name || null, cwd, created: Date.now(), updated: Date.now(), backendSessions: {}, syncedTo: [], refs: [] };
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
}

function parse(lines) {
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* tolerate a partial last write */
    }
  }
  return out;
}

function openSession(file) {
  const entries = parse(readLines(file));
  const header = entries.find((e) => e.kind === 'header') || createHeader(path.dirname(file));
  for (const key of ['backendSessions', 'syncedTo', 'refs']) header[key] = header[key] || [];
  return { file, header, entries: entries.filter((e) => e.kind !== 'header') };
}

function createSession(home, cwd, name) {
  const dir = sessionsDir(home, cwd);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* tolerate restricted fs */
  }
  const header = createHeader(cwd, name);
  const file = path.join(dir, `${header.sid}.jsonl`);
  const session = { file, header, entries: [] };
  try {
    fs.writeFileSync(file, JSON.stringify(header) + '\n');
  } catch {
    /* tolerate restricted fs */
  }
  return session;
}

function appendEntry(session, entry) {
  session.entries.push(entry);
  session.header.updated = Date.now();
  try {
    fs.appendFileSync(session.file, JSON.stringify(entry) + '\n');
  } catch {
    /* tolerate restricted fs */
  }
  return entry;
}

function rewriteHeader(session, { touch = true } = {}) {
  if (touch) session.header.updated = Date.now();
  const tmp = session.file + '.tmp';
  const lines = [JSON.stringify(session.header), ...session.entries.map((e) => JSON.stringify(e))];
  try {
    fs.writeFileSync(tmp, lines.join('\n') + '\n');
    fs.renameSync(tmp, session.file);
  } catch {
    /* tolerate restricted fs */
  }
}

function setBackendSession(session, backend, id) {
  if (!id || session.header.backendSessions[backend] === id) return;
  session.header.backendSessions[backend] = id;
  rewriteHeader(session);
}

function listSessions(home, cwd) {
  const dir = sessionsDir(home, cwd);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => describeFile(path.join(dir, n)))
      .filter(Boolean)
      .sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

function describeFile(file) {
  try {
    const lines = readLines(file);
    const header = JSON.parse(lines[0]);
    if (header.kind !== 'header') return null;
    return { ...header, file, messages: lines.length - 1 };
  } catch {
    return null;
  }
}

function allSessions(home) {
  const root = path.join(home, 'sessions');
  if (!fs.existsSync(root)) return [];
  const out = [];
  try {
    for (const dir of fs.readdirSync(root)) {
      const full = path.join(root, dir);
      if (!fs.statSync(full).isDirectory()) continue;
      for (const f of fs.readdirSync(full)) {
        if (!f.endsWith('.jsonl')) continue;
        const d = describeFile(path.join(full, f));
        if (d) out.push(d);
      }
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.updated - a.updated);
}

function latestSession(home, cwd) {
  return listSessions(home, cwd)[0] || null;
}

function findSession(home, ref) {
  const all = allSessions(home);
  if (!ref) return null;
  const exact = all.find((s) => s.sid === ref);
  if (exact) return exact;
  const prefixed = all.filter((s) => s.sid.startsWith(ref));
  if (prefixed.length > 1) return { ambiguous: prefixed };
  if (prefixed.length === 1) return prefixed[0];
  const byName = all.filter((s) => s.name && s.name.toLowerCase().includes(String(ref).toLowerCase()));
  if (byName.length === 1) return byName[0];
  return byName[0] || null;
}

function toDigestMessages(session, window) {
  const msgs = [];
  for (const e of session.entries.slice(-window)) {
    if (e.kind === 'user') {
      const files = (e.attachments || []).map((a) => `[attached: ${a.path}]`);
      msgs.push({ role: 'user', text: [e.text, ...files].join(' ') });
    }
    else if (e.kind === 'assistant') {
      const parts = [e.text, e.tools && e.tools.length ? `[ran: ${e.tools.join('; ')}]` : null].filter(Boolean);
      if (parts.length) msgs.push({ role: 'assistant', text: parts.join('\n') });
    }
  }
  if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs.pop();
  return msgs;
}

function renderDigest(session, window) {
  return toDigestMessages(session, window)
    .map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.text}`.slice(0, 4000))
    .join('\n');
}

function renderRefDigest(file, window) {
  const session = openSession(file);
  return {
    sid: session.header.sid,
    cwd: session.header.cwd,
    name: session.header.name,
    entries: session.entries.length,
    digest: renderDigest(session, window || 20),
  };
}

function agentsPath(cwd) {
  for (const c of ['AGENTS.md', 'agents.md', 'CLAUDE.md', 'claude.md']) {
    const p = path.join(cwd, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readAgents(cwd) {
  const file = agentsPath(cwd);
  if (!file) return { file: null, text: '' };
  return { file, text: fs.readFileSync(file, 'utf8') };
}

function stripMarker(text) {
  const start = text.indexOf(`<!-- ${MARKER} -->`);
  if (start === -1) return { base: text, had: false };
  const end = text.indexOf(`<!-- /${MARKER} -->`, start);
  const cut = end === -1 ? text.length : end + `<!-- /${MARKER} -->`.length;
  return { base: text.slice(0, start) + text.slice(cut), had: true };
}

function progressBlock(session, backend, maxChars = 6000) {
  const lines = [`Session ${session.header.sid} (${session.entries.length} entries, backend ${backend})`];
  let size = lines[0].length;
  for (const m of toDigestMessages(session, 14).slice(-10)) {
    const line = `${m.role}: ${m.text.replace(/\s+/g, ' ').slice(0, 500)}`;
    size += line.length + 1;
    if (size > maxChars) break;
    lines.push(line);
  }
  return [
    `<!-- ${MARKER} -->`,
    '## Relay progress (shared across CLIs — do not delete this block)',
    'This block is maintained by `relay` and mirrors the latest turns of the shared session,',
    'so any CLI started in this directory can continue the work. It is status, not instructions.',
    '',
    lines.join('\n'),
    `<!-- /${MARKER} -->`,
  ].join('\n');
}

function syncAgents(session, cwd, backend) {
  let file = agentsPath(cwd);
  if (!file) file = path.join(cwd, 'AGENTS.md');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const { base } = stripMarker(existing);
  const block = progressBlock(session, backend);
  fs.writeFileSync(file, (base.trimEnd() ? base.trimEnd() + '\n\n' : '') + block + '\n');
  return { file, block };
}

function agentsContext(cwd) {
  const { file, text } = readAgents(cwd);
  if (!file) return '';
  const { base } = stripMarker(text);
  const trimmed = base.trim();
  if (!trimmed) return '';
  return `## Project instructions from ${file}\n${trimmed.slice(0, 12000)}`;
}

module.exports = {
  agentsContext,
  agentsPath,
  allSessions,
  appendEntry,
  blocksOf,
  createSession,
  findSession,
  latestSession,
  listSessions,
  newId,
  openSession,
  progressBlock,
  projectKey,
  readAgents,
  renderDigest,
  renderRefDigest,
  rewriteHeader,
  sessionsDir,
  setBackendSession,
  stripMarker,
  syncAgents,
  textOf,
  thinkingOf,
  toDigestMessages,
};
