// Chat management for the desktop app. A chat is a relay session; nothing here is a second store.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const INLINE_LIMIT = 100_000; // characters of attached text placed straight into the prompt, per message
const FILE_LIMIT = 8 * 1024 * 1024;
const MAX_FILES = 8;

const oneLine = (text, max) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function titleOf(header, entries) {
  if (header.name) return header.name;
  const first = entries.find((e) => e.kind === 'user');
  return first ? oneLine(first.text, 60) : 'New chat';
}

function snippetAround(text, needle) {
  const flat = String(text).replace(/\s+/g, ' ');
  const at = flat.toLowerCase().indexOf(needle);
  if (at < 0) return null;
  const from = Math.max(0, at - 30);
  return `${from ? '…' : ''}${flat.slice(from, at + needle.length + 60)}`;
}

// Newest first. With a query, only chats whose title or messages contain it.
function list(home, { query = '', keep = null } = {}) {
  const needle = String(query).trim().toLowerCase();
  const out = [];
  for (const found of store.allSessions(home)) {
    let session;
    try {
      session = store.openSession(found.file);
    } catch {
      continue;
    }
    const { header, entries } = session;
    if (!entries.length && header.sid !== keep) continue; // untouched sessions are noise
    const title = titleOf(header, entries);
    let snippet = null;
    if (needle) {
      const hit = entries.find((e) => String(e.text || '').toLowerCase().includes(needle));
      if (!hit && !title.toLowerCase().includes(needle)) continue;
      snippet = hit ? snippetAround(hit.text, needle) : null;
    }
    out.push({ sid: header.sid, title, snippet, pinned: Boolean(header.pinned), updated: header.updated, cwd: header.cwd, messages: entries.length });
  }
  return out;
}

// Exact ids only: these calls rename and delete files.
function locate(home, sid) {
  const found = store.allSessions(home).find((s) => s.sid === sid);
  if (!found) throw new Error('chat not found');
  return found;
}

function update(session, { name, pinned }) {
  if (name !== undefined) session.header.name = oneLine(name, 120) || null;
  if (pinned !== undefined) session.header.pinned = Boolean(pinned);
  store.rewriteHeader(session, { touch: false }); // renaming shouldn't reorder history
  return session;
}

const trashFile = (home, sid) => path.join(home, 'trash', `${sid}.jsonl`);

function remove(home, sid) {
  const found = locate(home, sid);
  fs.mkdirSync(path.join(home, 'trash'), { recursive: true });
  fs.renameSync(found.file, trashFile(home, sid));
}

function restore(home, sid) {
  if (!/^[\w-]+$/.test(String(sid))) throw new Error('chat not found');
  const from = trashFile(home, sid);
  if (!fs.existsSync(from)) throw new Error('chat not found');
  const { header } = store.openSession(from);
  const dir = store.sessionsDir(home, header.cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(from, path.join(dir, `${sid}.jsonl`));
}

// A copy of the chat up to (not including) a user message, so it can be edited or
// asked again without touching the original.
function branch(home, session, index) {
  const at = session.entries[index];
  if (!at || at.kind !== 'user') throw new Error('can only branch from one of your messages');
  if (index === session.entries.length - 1) {
    // never answered, so nothing would be lost: replace it where it is
    session.entries.pop();
    store.rewriteHeader(session);
    return { session, entry: at };
  }
  const base = titleOf(session.header, session.entries).replace(/ \(branch(?: \d+)?\)$/, '');
  const taken = new Set(store.listSessions(home, session.header.cwd).map((s) => s.name));
  let name = `${base} (branch)`;
  for (let n = 2; taken.has(name); n += 1) name = `${base} (branch ${n})`;
  const copy = store.createSession(home, session.header.cwd, name);
  copy.entries = session.entries.slice(0, index);
  copy.header.refs = [...(session.header.refs || [])];
  copy.header.lastBackend = session.header.lastBackend;
  // the CLIs' own conversations include what came after, so none of them may be resumed
  copy.header.needsDigest = copy.entries.length > 0;
  store.rewriteHeader(copy);
  return { session: copy, entry: at };
}

function folders(home, current) {
  const seen = new Set([current]);
  for (const s of store.allSessions(home)) {
    if (seen.size >= 12) break;
    if (s.cwd && fs.existsSync(s.cwd)) seen.add(s.cwd);
  }
  return [...seen];
}

/* ---------- Attachments ---------- */

const attachmentRoot = (home) => path.join(home, 'attachments');

const looksLikeText = (buffer) => !buffer.subarray(0, 8000).includes(0);

function saveAttachment(home, { name, data }) {
  const buffer = Buffer.from(String(data || ''), 'base64');
  if (buffer.length > FILE_LIMIT) throw new Error('files can be up to 8 MB');
  const safe = path.basename(String(name || 'file')).replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '') || 'file';
  const id = crypto.randomUUID();
  fs.mkdirSync(path.join(attachmentRoot(home), id), { recursive: true });
  fs.writeFileSync(path.join(attachmentRoot(home), id, safe), buffer);
  return { id, name: safe, size: buffer.length };
}

// ids come from the client, so they are resolved only inside the attachment folder
function resolveAttachments(home, ids = []) {
  if (ids.length > MAX_FILES) throw new Error(`attach up to ${MAX_FILES} files at a time`);
  return ids.map((id) => {
    if (!/^[0-9a-f-]{36}$/.test(String(id))) throw new Error('unknown attachment');
    const dir = path.join(attachmentRoot(home), id);
    const name = fs.existsSync(dir) ? fs.readdirSync(dir)[0] : null;
    if (!name) throw new Error('that attachment is no longer available');
    const file = path.join(dir, name);
    return { id, name, size: fs.statSync(file).size, path: file };
  });
}

// What gets added to the prompt. Text is inlined so every CLI can read it; anything
// else (images, PDFs) is handed over as a path.
function attachmentPrompt(files) {
  let room = INLINE_LIMIT;
  const parts = files.map((f) => {
    const buffer = fs.readFileSync(f.path);
    if (looksLikeText(buffer)) {
      const text = buffer.toString('utf8');
      if (text.length <= room) {
        room -= text.length;
        const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) || []).map((m) => m.length + 1)));
        return `Attached file "${f.name}":\n${fence}\n${text}\n${fence}`;
      }
    }
    return `Attached file "${f.name}" — read it from: ${f.path}`;
  });
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

module.exports = { list, locate, update, remove, restore, branch, folders, titleOf, saveAttachment, resolveAttachments, attachmentPrompt };
