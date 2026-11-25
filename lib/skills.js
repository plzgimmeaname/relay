// Skill converter. A skill is imported once into ~/.relay/skills/<name>/ in one
// shape (SKILL.md plus its files), then reaches models two ways:
//   1. inside relay, on every CLI: `/name args` expands the instructions into the
//      prompt, and each prompt carries a short index so models can use skills unasked;
//   2. outside relay: copies go into the skill folders CLIs load by themselves.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { truncate } = require('./ui');

const MARKER = '.relay-skill'; // marks folders relay wrote, the only ones it may replace
const META = 'relay.json';
const MAX_FILES = 500;
const MAX_BYTES = 20 * 1024 * 1024;
const INLINE_CAP = 40_000; // longer skills are read from disk (argv-based CLIs cap prompt size)
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', MARKER, META]);

// Folders CLIs load skills from, and who reads each.
const NATIVE_TARGETS = [
  { id: 'claude', dir: ['.claude', 'skills'], readers: ['claude', 'kilo'] },
  { id: 'agents', dir: ['.agents', 'skills'], readers: ['qwen', 'kilo', 'agy'] },
  { id: 'junie', dir: ['.junie', 'skills'], readers: ['junie'] },
];

const userHome = () => process.env.RELAY_USER_HOME || os.homedir();
const skillsDir = (home) => path.join(home, 'skills');

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

const unquote = (v) => {
  const s = v.trim();
  if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  return s.length > 1 && s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s;
};

// Enough YAML for skill frontmatter: scalars, block scalars and continuation lines.
function parseFrontmatter(text) {
  const clean = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = clean.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return { meta: {}, body: clean.trim() };
  const meta = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (pair) {
      key = pair[1];
      meta[key] = /^[|>][+-]?$/.test(pair[2].trim()) ? '' : unquote(pair[2]);
    } else if (key && /^\s+\S/.test(line)) meta[key] = `${meta[key]} ${line.trim()}`.trim();
  }
  return { meta, body: clean.slice(m[0].length).trim() };
}

function parseToml(text) {
  const read = (key) => {
    const long = text.match(new RegExp(`^${key}\\s*=\\s*("""|''')\\n?([\\s\\S]*?)\\1`, 'm'));
    if (long) return long[2];
    const short = text.match(new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\\\n]|\\\\.)*"|'[^'\\n]*')`, 'm'));
    return short ? unquote(short[1]) : '';
  };
  return { meta: { description: read('description') }, body: read('prompt').replace(/\{\{\s*args\s*\}\}/g, '$ARGUMENTS').trim() };
}

function firstSentence(body) {
  const line = body.split('\n').map((l) => l.trim()).find((l) => l && !/^(#|```|---|<!--)/.test(l)) || body.split('\n')[0] || '';
  return line.replace(/^[#>*\-\s]+/, '');
}

// Work out what a path holds. Returns one or more things that can be imported.
function detect(source) {
  const full = path.resolve(source);
  if (!fs.existsSync(full)) throw new Error(`no such file or folder: ${source}`);
  if (fs.statSync(full).isDirectory()) {
    if (fs.existsSync(path.join(full, 'SKILL.md'))) return [{ format: 'skill', file: path.join(full, 'SKILL.md'), root: full }];
    const nested = fs
      .readdirSync(full, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(full, e.name, 'SKILL.md')))
      .map((e) => ({ format: 'skill', file: path.join(full, e.name, 'SKILL.md'), root: path.join(full, e.name) }));
    if (!nested.length) throw new Error(`${source} has no SKILL.md (point at a skill folder, or a .md, .toml or .mdc file)`);
    return nested;
  }
  if (path.basename(full) === 'SKILL.md') return [{ format: 'skill', file: full, root: path.dirname(full) }];
  const ext = path.extname(full).toLowerCase();
  const format = { '.md': 'command', '.toml': 'toml', '.mdc': 'rule' }[ext];
  if (!format) throw new Error(`can't convert ${ext || 'that'} files — use a skill folder, .md, .toml or .mdc`);
  return [{ format, file: full, root: null }];
}

// every regular file under a skill folder; links are left out, as they can point anywhere
function walk(root) {
  const files = [];
  const links = [];
  let bytes = 0;
  const visit = (rel) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const next = path.join(rel, entry.name);
      if (entry.isSymbolicLink()) links.push(next);
      else if (entry.isDirectory()) visit(next);
      else if (entry.isFile()) {
        files.push(next);
        bytes += fs.statSync(path.join(root, next)).size;
        if (files.length > MAX_FILES || bytes > MAX_BYTES) throw new Error(`${root} is too big for a skill (over ${MAX_FILES} files or 20 MB)`);
      }
    }
  };
  visit('');
  return { files, links };
}

// Things in a skill that only some CLIs understand, or that deserve a look first.
function inspect(body, meta, files, links) {
  const notes = [];
  const extra = Object.keys(meta).filter((k) => !['name', 'description', 'argument-hint'].includes(k));
  if (extra.length) notes.push(`dropped CLI-specific settings: ${extra.join(', ')}`);
  if (/(^|\s)!`[^`]+`/m.test(body)) notes.push('has !`command` lines — relay never runs them; the model is told to treat them as ordinary steps');
  if (/\$\{CLAUDE_PLUGIN_ROOT\}/.test(body)) notes.push('refers to ${CLAUDE_PLUGIN_ROOT}: files outside the skill folder were not imported');
  if (/\b(?:Task tool|subagents?|subagent_type|AskUserQuestion|TodoWrite|mcp__\w+)\b/.test(body)) notes.push('names tools some CLIs lack — they are told to use their closest equivalent');
  const scripts = files.filter((f) => /\.(?:sh|bash|zsh|py|js|mjs|cjs|rb|ps1)$/i.test(f));
  if (scripts.length) notes.push(`includes scripts a model may run: ${scripts.slice(0, 5).join(', ')}${scripts.length > 5 ? ` +${scripts.length - 5}` : ''}`);
  if (links.length) notes.push(`skipped symbolic links: ${links.slice(0, 5).join(', ')}`);
  return notes;
}

function render({ name, description, hint }, body) {
  const head = ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`, ...(hint ? [`argument-hint: ${JSON.stringify(hint)}`] : []), '---'];
  return `${head.join('\n')}\n\n${body}\n`;
}

function load(home, name) {
  if (!name || slug(name) !== name) return null;
  const dir = path.join(skillsDir(home), name);
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  let info = {};
  try {
    info = JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8'));
  } catch {
    /* a hand-made skill has no relay.json */
  }
  return { name, dir, file, body, description: meta.description || '', hint: meta['argument-hint'] || '', format: info.format || 'skill', source: info.source || null, notes: info.notes || [], exports: info.exports || [] };
}

function list(home) {
  const dir = skillsDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => load(home, name))
    .filter(Boolean);
}

function saveInfo(skill) {
  const info = { format: skill.format, source: skill.source, notes: skill.notes, exports: skill.exports };
  fs.writeFileSync(path.join(skill.dir, META), JSON.stringify(info, null, 2) + '\n');
}

function importOne(home, found, { force, as } = {}) {
  const text = fs.readFileSync(found.file, 'utf8');
  const parsed = found.format === 'toml' ? parseToml(text) : parseFrontmatter(text);
  if (!parsed.body) throw new Error(`${found.file} has no instructions in it${found.format === 'toml' ? ' (no prompt = "…")' : ''}`);
  const fallback = found.root ? path.basename(found.root) : path.basename(found.file, path.extname(found.file));
  const name = slug(as || (found.format === 'skill' ? parsed.meta.name : null) || fallback);
  if (!name) throw new Error(`can't make a skill name out of "${as || fallback}" — pass --as <name>`);

  const origin = found.root || found.file;
  if (path.resolve(origin).startsWith(path.resolve(skillsDir(home)) + path.sep)) throw new Error('that skill is already in relay');
  const existing = load(home, name);
  if (existing && existing.source !== origin && !force) throw new Error(`a skill called "${name}" already exists (from ${existing.source || 'unknown'}) — use --as <name> or --force`);

  const { files, links } = found.root ? walk(found.root) : { files: [], links: [] };
  const description = truncate(String(parsed.meta.description || firstSentence(parsed.body) || name).replace(/\s+/g, ' '), 500);
  const notes = inspect(parsed.body, found.format === 'rule' ? {} : parsed.meta, files, links);

  fs.mkdirSync(skillsDir(home), { recursive: true });
  const staging = fs.mkdtempSync(path.join(skillsDir(home), '.import-'));
  try {
    for (const rel of files) {
      if (rel === 'SKILL.md') continue;
      fs.mkdirSync(path.dirname(path.join(staging, rel)), { recursive: true });
      fs.copyFileSync(path.join(found.root, rel), path.join(staging, rel));
    }
    fs.writeFileSync(path.join(staging, 'SKILL.md'), render({ name, description, hint: parsed.meta['argument-hint'] }, parsed.body));
    const dir = path.join(skillsDir(home), name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  const skill = { ...load(home, name), format: found.format, source: origin, notes, exports: existing?.exports || [] };
  saveInfo(skill);
  return skill;
}

function importSkills(home, source, opts = {}) {
  const found = detect(source);
  if (found.length > 1 && opts.as) throw new Error('--as only works when importing a single skill');
  const imported = [];
  const failed = [];
  for (const item of found) {
    try {
      imported.push(importOne(home, item, opts));
    } catch (err) {
      if (found.length === 1) throw err;
      failed.push({ source: item.root || item.file, error: err.message });
    }
  }
  return { imported, failed };
}

const COMPAT = [
  'Follow these instructions with the tools you have. They may name tools from another coding CLI: use your closest equivalent,',
  'and if you cannot start subagents, do those steps yourself in order. A line like !`command` is a command to consider running, not output.',
].join(' ');

const withDir = (body, dir) => body.replace(/\$\{CLAUDE_SKILL_DIR\}/g, () => dir);

// The prompt that makes any model carry out a skill, native support or not.
function expand(skill, args = '') {
  const request = String(args).trim();
  let body = withDir(skill.body, skill.dir);
  let placed = /\$ARGUMENTS\b/.test(body);
  body = body.replace(/\$ARGUMENTS\b/g, () => request);
  // positional $1…$9 only mean arguments in converted commands; elsewhere they may be shell
  if (skill.format === 'command' || skill.format === 'toml') {
    const words = request.split(/\s+/).filter(Boolean);
    body = body.replace(/\$([1-9])(?!\d)/g, (_, n) => {
      placed = true;
      return words[n - 1] || '';
    });
  }
  const content = body.length > INLINE_CAP ? `The instructions are long. Read all of ${skill.file} first, then follow them.` : body;
  return [
    `Use the "${skill.name}" skill. ${COMPAT}`,
    `Files the skill mentions are relative to: ${skill.dir}`,
    `<skill name="${skill.name}">\n${content}\n</skill>`,
    request && (!placed || body.length > INLINE_CAP) ? `## Request\n${request}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// Short index added to every prompt, so a model can reach for a skill unasked.
function indexBlock(home) {
  const all = list(home);
  if (!all.length) return '';
  return [
    '## Relay skills',
    'If one of these clearly fits the request, read its file before you start and follow it. Otherwise ignore this list.',
    ...all.slice(0, 30).map((s) => `- ${s.name}: ${truncate(s.description, 160)} (${s.file})`),
  ].join('\n');
}

function readsFrom(target, installed) {
  return target.readers.filter((r) => installed.includes(r));
}

function lstat(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

const isOurs = (dir) => Boolean(lstat(dir)?.isDirectory() && fs.existsSync(path.join(dir, MARKER)));

// Copy a skill into each folder an installed CLI reads. Anything relay did not put
// there is left alone.
function exportSkill(home, name, installed) {
  const skill = load(home, name);
  if (!skill) throw new Error(`no skill called "${name}" — relay skill list`);
  const written = [];
  const skipped = [];
  for (const target of NATIVE_TARGETS) {
    const readers = readsFrom(target, installed);
    if (!readers.length) continue;
    const dest = path.join(userHome(), ...target.dir, name);
    if (lstat(dest) && !isOurs(dest)) {
      skipped.push({ dest, readers, reason: 'you already have a skill there' });
      continue;
    }
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      for (const rel of walk(skill.dir).files) {
        fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
        fs.copyFileSync(path.join(skill.dir, rel), path.join(dest, rel));
      }
      let body = withDir(skill.body, dest);
      if (skill.format === 'command' || skill.format === 'toml') body = `Wherever this says $ARGUMENTS or $1, use what the user asked for.\n\n${body}`;
      fs.writeFileSync(path.join(dest, 'SKILL.md'), render(skill, body));
      fs.writeFileSync(path.join(dest, MARKER), JSON.stringify({ name }) + '\n');
      written.push({ dest, readers });
    } catch (err) {
      skipped.push({ dest, readers, reason: err.message });
    }
  }
  skill.exports = [...new Set([...skill.exports, ...written.map((w) => w.dest)])];
  saveInfo(skill);
  return { skill, written, skipped };
}

function remove(home, name) {
  const skill = load(home, name);
  if (!skill) throw new Error(`no skill called "${name}" — relay skill list`);
  const removed = [];
  // recompute the paths: relay.json is only a record, never a list of things to delete
  for (const target of NATIVE_TARGETS) {
    const dest = path.join(userHome(), ...target.dir, name);
    if (isOurs(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
      removed.push(dest);
    }
  }
  fs.rmSync(skill.dir, { recursive: true, force: true });
  return { removed };
}

module.exports = { importSkills, exportSkill, remove, load, list, expand, indexBlock, parseFrontmatter, parseToml, slug, NATIVE_TARGETS };
