// `@claude …`, `@claude:opus …`, `@opus …`: talk to one CLI or model directly.
//
//   @cli <prompt>          one prompt to that CLI, without changing what relay uses next
//   @cli /command [args]   the CLI's own slash command, sent exactly as typed
//   @cli !subcommand       the CLI's own subcommand, e.g. @claude !mcp list
//   @cli                   its own interactive UI (for commands that only work there)
//
// A direct command never fails over: another CLI would not know what it means.
const { spawnSync } = require('child_process');
const store = require('./store');
const { Backend } = require('./backend');
const { BUILTIN_BACKENDS, PROTOCOL_DEFAULTS } = require('./config');
const { MODEL_TIERS, onPath } = require('./auto');
const { resetTerminal } = require('./ui');

// How each CLI's own UI takes a conversation to resume and an opening prompt.
const INTERACTIVE = {
  claude: { resume: ['--resume', '{id}'], prompt: ['{prompt}'] },
  qwen: { resume: ['--resume', '{id}'], prompt: ['-i', '{prompt}'] },
  agy: { resume: ['--conversation', '{id}'], prompt: ['-i', '{prompt}'] },
  junie: { resume: ['--session-id={id}', '--resume'], prompt: ['--prompt={prompt}'] },
};

// parts of prefixArgs that belong to every invocation, not only to one-shot prompts
const BASE_ARGS = { copilot: ['copilot'] };

const SLASH = /^\/[a-z][\w:.-]*(?=\s|$)/i;

function definition(app, name) {
  if (app.config.backends[name]) return app.config.backends[name];
  const builtin = BUILTIN_BACKENDS[name];
  return builtin && onPath(builtin.command) ? { ...builtin, name, protocol: { ...PROTOCOL_DEFAULTS } } : null;
}

function modelsOf(def, name) {
  const tiers = Object.values(def.models || MODEL_TIERS[name] || {}).map((v) => (typeof v === 'string' ? v : v?.model));
  return [def.model, ...tiers].filter(Boolean);
}

// Which CLI (and model) does a tag mean? `@src/app.js` resolves to nothing and
// stays part of an ordinary prompt.
function resolveTag(app, tag) {
  const word = String(tag).replace(/^@/, '');
  const cut = word.search(/[:/]/);
  const head = cut < 0 ? word : word.slice(0, cut);
  const model = cut < 0 ? null : word.slice(cut + 1) || null;
  if (definition(app, head)) return { backend: head, model };
  const owner = app.registry.all.find((name) => modelsOf(app.registry.backend(name), name).includes(word));
  return owner ? { backend: owner, model: word } : null;
}

function splitArgs(line) {
  const out = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word = word ?? '';
    } else if (/\s/.test(ch)) {
      if (word !== null) out.push(word);
      word = null;
    } else word = (word ?? '') + ch;
  }
  if (quote) throw new Error(`unclosed ${quote} quote`);
  if (word !== null) out.push(word);
  return out;
}

// What the text after a tag asks for, as typed inside relay.
function actionFor(rest) {
  const text = String(rest || '').trim();
  if (!text) return { kind: 'open' };
  const open = text.match(/^open(?:\s+(\/[\s\S]*))?$/);
  if (open) return { kind: 'open', prompt: open[1] || null };
  if (text.startsWith('!')) return { kind: 'exec', args: splitArgs(text.slice(1)) };
  if (/^--?[a-z]/i.test(text)) return { kind: 'exec', args: splitArgs(text) };
  if (SLASH.test(text)) return { kind: 'slash', command: text };
  return { kind: 'prompt', prompt: text };
}

// Same, for `relay @cli …` from the shell, where the words arrive already split:
// one quoted sentence is a prompt, anything else belongs to the CLI as written.
function actionForArgv(argv) {
  if (!argv.length) return { kind: 'open' };
  if (argv[0] === 'open' && (argv.length === 1 || argv[1].startsWith('/'))) return { kind: 'open', prompt: argv.slice(1).join(' ') || null };
  if (SLASH.test(argv[0])) return { kind: 'slash', command: argv.join(' ') };
  if (argv.length === 1 && /\s/.test(argv[0]) && !argv[0].startsWith('!')) return { kind: 'prompt', prompt: argv[0] };
  return { kind: 'exec', args: [argv[0].replace(/^!/, ''), ...argv.slice(1)].filter(Boolean) };
}

function parseTagLine(app, line) {
  const m = String(line).match(/^@(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const target = resolveTag(app, m[1]);
  return target ? { ...target, rest: (m[2] || '').trim() } : null;
}

function requireConnected(app, name) {
  if (!app.config.backends[name]) throw new Error(`${name} is installed but not connected — /connect ${name} or relay scan --auto`);
}

// the CLI's own conversation, if it has been part of this one
function resumeIdFor(app, name) {
  const header = app.session.header;
  return (header.syncedTo || []).includes(name) ? header.backendSessions?.[name] || null : null;
}

function modelArgs(def, model) {
  if (!model) return [];
  if (def.dialect === 'junie') return [`--model=${model}`];
  return [def.modelFlag || '-m', model];
}

// Run the CLI itself with the terminal handed over to it.
function handOver(app, def, args) {
  const ignore = () => {}; // Ctrl-C belongs to the child while it owns the terminal
  process.on('SIGINT', ignore);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  // synchronous on purpose: relay must not read any keystrokes meant for the child
  const run = spawnSync(def.command, args, { cwd: app.cwd, env: { ...process.env, ...(def.env || {}) }, stdio: 'inherit' });
  if (process.stdin.isTTY) resetTerminal();
  setImmediate(() => process.removeListener('SIGINT', ignore));
  if (run.error) throw new Error(`could not start ${def.command}: ${run.error.message}`);
  return run.status ?? 130;
}

function execArgs(def, name, args) {
  return [...(def.baseArgs || BASE_ARGS[name] || []), ...args];
}

function openArgs(app, def, name, { model, prompt }) {
  const spec = def.interactive || INTERACTIVE[name] || {};
  const id = resumeIdFor(app, name);
  const fill = (list, key, value) => list.map((a) => a.replace(`{${key}}`, () => value));
  if (prompt && !spec.prompt) throw new Error(`relay doesn't know how to open ${name} with a command — use @${name}, then type it there`);
  return execArgs(def, name, [
    ...(id && spec.resume ? fill(spec.resume, 'id', id) : []),
    ...modelArgs(def, model),
    ...(prompt ? fill(spec.prompt, 'prompt', prompt) : []),
  ]);
}

function runExec(app, name, args) {
  const def = definition(app, name);
  return handOver(app, def, execArgs(def, name, args));
}

function runOpen(app, name, opts = {}) {
  if (!process.stdin.isTTY) throw new Error(`@${name} on its own opens its interactive UI, which needs a terminal`);
  const def = definition(app, name);
  return handOver(app, def, openArgs(app, def, name, opts));
}

// Send a slash command untouched: no preamble or digest in front of it, or the CLI
// would read it as ordinary text.
async function runSlash(app, name, command, { model, hooks = {}, onSpawn } = {}) {
  requireConnected(app, name);
  const raw = app.registry.backend(name);
  const def = model ? { ...raw, model } : raw;
  const resumeId = resumeIdFor(app, name);
  const fresh = app.session.entries.length === 0;
  const backend = new Backend(def, {
    permissionMode: app.opts.permissionMode || app.config.permissionMode,
    skipPermissions: app.opts.skipPermissions || app.config.skipPermissions,
    timeoutMs: app.opts.timeoutMs,
    registerAbort: (fn) => {
      app.abort = fn;
      onSpawn?.(fn);
    },
    onInit: (evt) => {
      if (evt.commands?.length) app.registry.recordCommands(name, evt.commands);
    },
  });
  const res = await backend.run({ prompt: command, resumeId, systemPrompt: null, cwd: app.cwd, onEvent: (e) => hooks.onEvent?.(e, name) });

  app.registry.recordTurn(name, { ok: res.ok, isQuota: res.kind === 'quota', usage: res.result?.usage });
  if (res.kind === 'quota' || res.kind === 'auth') app.registry.markExhausted(name, { hard: true, reason: res.quota?.line || res.auth?.line || res.kind });
  if (res.ok) {
    store.appendEntry(app.session, { kind: 'user', t: Date.now(), text: `@${name} ${command}` });
    store.appendEntry(app.session, { kind: 'assistant', t: Date.now(), backend: name, text: res.text, tools: [], usage: res.result?.usage || null, durationMs: res.result?.durationMs ?? null });
    // only adopt this conversation if it isn't missing turns relay already has
    if (res.sessionId && (resumeId || fresh)) {
      store.setBackendSession(app.session, name, res.sessionId);
      app.session.header.syncedTo = Array.from(new Set([...(app.session.header.syncedTo || []), name]));
    }
    store.rewriteHeader(app.session);
    if (app.opts.autoSync !== false) app.sync();
  }
  return res;
}

// Turn options for a one-off tagged prompt: that CLI only, with that model.
function routeTo(app, target) {
  requireConnected(app, target.backend);
  return { route: [{ backend: target.backend, model: target.model || null }], skipPipeline: true };
}

// A tag is for one turn, so put back whatever relay was using before.
async function keepingPin(app, fn) {
  const before = app.session.header.lastBackend || null;
  try {
    return await fn();
  } finally {
    if (before) {
      app.session.header.lastBackend = before;
      store.rewriteHeader(app.session);
    }
  }
}

module.exports = { resolveTag, parseTagLine, actionFor, actionForArgv, splitArgs, definition, execArgs, openArgs, runExec, runOpen, runSlash, routeTo, keepingPin, INTERACTIVE };
