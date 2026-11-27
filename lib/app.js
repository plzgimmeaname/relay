const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Backend } = require('./backend');
const { Probe } = require('./probe');
const { parseMultiStepPrompt, executeMultiStep } = require('./multistep');
const log = require('./log');
const skills = require('./skills');

const PREAMBLE = [
  'You are running inside `relay`, a thin driver that can hand this conversation to other coding CLIs.',
  'Keep answers concise. The project file AGENTS.md (or CLAUDE.md) holds project instructions and a',
  'machine-maintained "Relay progress" block describing the latest turns of the shared session.',
].join(' ');

class App {
  constructor({ config, registry, session, cwd, ui = {}, opts = {} }) {
    this.config = config;
    this.registry = registry;
    this.session = session;
    this.cwd = cwd;
    this.ui = ui;
    this.opts = opts;
    this.probe = new Probe(cwd);
    this.abort = null;
    this.lastPrompt = null;
  }

  get backendName() {
    return this.session.header.lastBackend || this.registry.pick() || this.registry.all[0] || null;
  }

  systemPrompt(backendName) {
    const parts = [PREAMBLE, store.agentsContext(this.cwd)];
    if (fs.existsSync(path.join(this.config.home, 'NOTES.md'))) {
      parts.push(`## Notes pinned by the user\n${fs.readFileSync(path.join(this.config.home, 'NOTES.md'), 'utf8')}`);
    }
    const index = skills.indexBlock(this.config.home);
    if (index) parts.push(index);
    const refs = this.refsBlock();
    if (refs) parts.push(refs);
    if (backendName) parts.push(`You are backend "${backendName}". If you cannot finish because of provider limits, say so plainly instead of guessing.`);
    return parts.filter(Boolean).join('\n\n');
  }

  addRef(ref) {
    const found = store.findSession(this.config.home, ref);
    if (!found) throw new Error(`no session matching "${ref}" — /sessions --all lists them`);
    if (found.ambiguous) {
      throw new Error(`"${ref}" matches ${found.ambiguous.length} sessions: ${found.ambiguous.map((s) => s.sid.slice(0, 8)).join(', ')}`);
    }
    const rendered = store.renderRefDigest(found.file, this.config.digestWindow);
    this.session.header.refs = (this.session.header.refs || []).filter((r) => r.sid !== rendered.sid);
    this.session.header.refs.push({ sid: rendered.sid, file: found.file, cwd: rendered.cwd, name: rendered.name, added: Date.now(), entries: rendered.entries });
    store.rewriteHeader(this.session);
    return rendered;
  }

  removeRef(ref) {
    const before = (this.session.header.refs || []).length;
    this.session.header.refs = (this.session.header.refs || []).filter((r) => r.sid !== ref && !r.sid.startsWith(ref) && r.file !== ref);
    store.rewriteHeader(this.session);
    return before - this.session.header.refs.length;
  }

  refsBlock() {
    const refs = this.session.header.refs || [];
    if (!refs.length) return '';
    const blocks = refs.map((r) => {
      const rendered = store.renderRefDigest(r.file, Math.ceil(this.config.digestWindow / 2));
      if (!rendered.digest) return '';
      return [`### referenced session ${r.sid.slice(0, 8)}${r.name ? ` (${r.name})` : ''} — from ${r.cwd}`, rendered.digest].join('\n');
    });
    return ['## Referenced past sessions (context the user asked you to keep in mind; read-only)', ...blocks.filter(Boolean)].join('\n\n');
  }

  async turn(prompt, hooks = {}, opts = {}) {
    const text = String(prompt || '').trim();
    if (!text) return { ok: false, reason: 'empty' };
    this.lastPrompt = text;

    if (!opts.skipPipeline) {
      const pipeline = parseMultiStepPrompt(text, this.registry.all);
      if (pipeline.isMultiStep && pipeline.steps.length > 1) {
        return executeMultiStep(this, pipeline, hooks, opts);
      }
    }

    // `display` keeps the transcript readable when the prompt is an expanded skill
    const attached = opts.attachments?.length ? { attachments: opts.attachments } : {};
    store.appendEntry(this.session, { kind: 'user', t: Date.now(), text: opts.display ?? text, ...attached });
    return this.#run(text, hooks, opts);
  }

  async retry(hooks = {}) {
    if (!this.lastPrompt) return { ok: false, reason: 'nothing to retry' };
    return this.#run(this.lastPrompt, hooks);
  }

  pinned() {
    const name = this.session.header.lastBackend;
    return name && this.registry.all.includes(name) ? name : null;
  }

  // The next CLI on a task's own route: first ready one, then any still untried.
  #nextOnRoute(route, tried) {
    const left = route.filter((r) => !tried.includes(r.backend));
    const ready = (r) => this.registry.pick(this.registry.all.filter((n) => n !== r.backend), 'priority') === r.backend;
    return (left.find(ready) || left[0])?.backend || null;
  }

  async #run(prompt, hooks, { force, model, route, onSpawn } = {}) {
    const tried = [];
    const synced = new Set(this.session.header.syncedTo || []);
    let lastRes = null;

    for (let hop = 0; hop < this.registry.all.length + 1; hop += 1) {
      const isPool = this.registry.getStrategy() === 'pool';
      const preferred = tried.length === 0 ? force || (isPool ? null : this.pinned()) : null;
      let name;
      // a route is exhaustive: failover never leaves it
      if (route) name = this.#nextOnRoute(route, tried);
      else name = preferred && this.registry.available.includes(preferred) ? preferred : this.registry.pick(tried);
      if (!name || tried.includes(name)) break;
      tried.push(name);
      const rawDef = this.registry.backend(name);
      // model names are per CLI, so a requested one must not follow a failover to another
      const step = route ? route.find((r) => r.backend === name) : !force || name === force ? { model } : null;
      const def = { ...rawDef, ...(step?.model ? { model: step.model } : {}), ...(step?.effort ? { effort: step.effort } : {}) };
      const resumeId = synced.has(name) ? this.session.header.backendSessions[name] : null;
      const digest = resumeId ? '' : this.#digestForHandoff(name, tried.length === 1);
      const readOnly = Boolean(this.opts.readOnly);
      const backend = new Backend(def, {
        permissionMode: readOnly ? 'default' : this.opts.permissionMode || this.config.permissionMode,
        skipPermissions: !readOnly && (this.opts.skipPermissions || this.config.skipPermissions),
        timeoutMs: this.opts.timeoutMs,
        registerAbort: (fn) => {
          this.abort = fn;
          onSpawn?.(fn);
        },
        onInit: (evt) => {
          if (evt.commands?.length) this.registry.recordCommands(name, evt.commands);
        },
      });
      if (readOnly) backend.protocol = { ...backend.protocol, skipPermissions: false };

      this.ui.onTurnStart?.({ backend: name, dialect: backend.dialect.name, hop, digest: Boolean(digest), resumeId });
      const res = await backend.run({
        prompt,
        digest,
        resumeId,
        systemPrompt: this.systemPrompt(name),
        cwd: this.cwd,
        onEvent: (evt) => hooks.onEvent?.(evt, name),
      });

      if (res.ok) {
        this.registry.recordTurn(name, { ok: true, usage: res.result?.usage, durationMs: res.result?.durationMs });
        this.#saveAssistant(name, res);
        return { ok: true, backend: name, res };
      }

      if (isUnknownFlag(res) && backend.canPassSystemFile()) {
        this.ui.onNote?.(`${name} rejected the system-prompt flag; inlining project instructions instead`);
        const protocol = { ...rawDef.protocol, systemArgs: [] };
        this.config.backends[name] = { ...rawDef, protocol };
        this.persistProtocol(name, protocol);
        continue;
      }

      lastRes = { backend: name, res };
      log.error(`turn failed on ${name}: ${res.kind}`, { kind: res.kind, hop, spawnError: res.spawnError || res.error || null, tail: tailOf(res) });

      if (res.kind === 'aborted') {
        this.registry.recordTurn(name, { ok: false });
        return { ok: false, backend: name, res, aborted: true };
      }
      if (res.kind === 'quota') {
        this.registry.recordTurn(name, { ok: false, isQuota: true });
        this.registry.markExhausted(name, { hard: true, reason: res.quota?.line || 'quota' });
        this.ui.onFailover?.({ from: name, reason: 'quota', detail: res.quota?.line, next: route ? this.#nextOnRoute(route, tried) : this.registry.pick(tried) });
        continue;
      }
      if (res.kind === 'blocked') {
        this.registry.recordTurn(name, { ok: false });
        this.registry.markExhausted(name, { hard: true, reason: 'blocked: the app forbids scripted use' });
        this.ui.onFailover?.({ from: name, reason: 'blocked', detail: 'the app objects to being driven by a script — relay will not use it again until /forget', next: route ? this.#nextOnRoute(route, tried) : this.registry.pick(tried) });
        continue;
      }
      if (res.kind === 'auth') {
        this.registry.recordTurn(name, { ok: false });
        this.registry.markExhausted(name, { hard: true, reason: res.auth?.line || 'auth' });
        this.ui.onFailover?.({ from: name, reason: 'auth', detail: res.auth?.line || 'authentication failed', next: route ? this.#nextOnRoute(route, tried) : this.registry.pick(tried) });
        continue;
      }
      this.registry.recordTurn(name, { ok: false });
      this.registry.markExhausted(name, { hard: false, minutes: 10, reason: res.kind });
      this.probe.save(name, this.probe.toCase(name, res.events, res.raw));
      this.ui.onFailover?.({ from: name, reason: res.kind, detail: tailOf(res), next: route ? this.#nextOnRoute(route, tried) : this.registry.pick(tried) });
    }
    return { ok: false, reason: 'exhausted', tried, res: lastRes?.res, backend: lastRes?.backend };
  }

  #digestForHandoff(name, firstHop) {
    // a branched chat has history but no CLI that has seen it
    if (firstHop && !(this.session.header.syncedTo || []).length && !this.session.header.needsDigest) return '';
    const body = store.renderDigest(this.session, this.config.digestWindow);
    if (!body) return '';
    return [
      `relay is handing this conversation to the ${name} backend because the previous backend could not continue.`,
      'The transcript below is a faithful digest of what happened so far. Do not re-answer the last request unless it is still unanswered.',
      '',
      '--- transcript digest ---',
      body,
      '--- end digest ---',
    ].join('\n');
  }

  #saveAssistant(name, res) {
    const tools = res.events.filter((e) => e.kind === 'tool').map((e) => `${e.name} ${summarizeInput(e.input)}`.trim());
    store.appendEntry(this.session, {
      kind: 'assistant',
      t: Date.now(),
      backend: name,
      text: res.text,
      tools,
      usage: res.result?.usage || null,
      durationMs: res.result?.durationMs ?? null,
    });
    if (res.sessionId) store.setBackendSession(this.session, name, res.sessionId);
    this.session.header.syncedTo = Array.from(new Set([...(this.session.header.syncedTo || []), name]));
    this.session.header.lastBackend = name;
    store.rewriteHeader(this.session);
    if (this.opts.autoSync !== false) this.sync();
  }

  persistProtocol(name, protocol) {
    const file = path.join(this.config.home, 'config.json');
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      existing = { order: this.registry.all.slice(), backends: {} };
    }
    existing.backends = existing.backends || {};
    existing.backends[name] = { ...(existing.backends[name] || {}), protocol };
    fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n');
  }

  sync() {
    return store.syncAgents(this.session, this.cwd, this.backendName);
  }

  note(text) {
    const file = path.join(this.config.home, 'NOTES.md');
    fs.mkdirSync(this.config.home, { recursive: true });
    fs.appendFileSync(file, `- ${new Date().toISOString()} ${text}\n`);
    return file;
  }

  status() {
    const st = this.registry;
    return {
      session: this.session.header.sid,
      file: this.session.file,
      cwd: this.cwd,
      backend: this.backendName,
      dialect: st.all.length ? this.registry.backend(this.backendName)?.dialect || 'claude' : null,
      order: st.all,
      strategy: this.registry.getStrategy(),
      available: st.available,
      exhausted: st.exhausted,
      credits: this.registry.creditStatus(),
      entries: this.session.entries.length,
      agents: store.agentsPath(this.cwd),
      syncedTo: this.session.header.syncedTo || [],
      refs: this.session.header.refs || [],
      commands: Object.fromEntries(st.all.map((b) => [b, st.commands(b).length])),
    };
  }
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['command', 'file_path', 'path', 'pattern', 'prompt', 'description', 'url', 'details']) {
    if (typeof input[k] === 'string') return `${k}=${truncate(input[k], 60)}`;
  }
  return truncate(Object.keys(input).join(','), 40);
}

function isUnknownFlag(res) {
  const text = String(res.raw || '') + String(res.text || '');
  return /unknown (?:option|argument|flag)|unrecognized (?:option|argument)|no such (?:option|flag)|invalid choice/i.test(text);
}

function truncate(value, max) {
  const s = String(value ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function tailOf(res) {
  const raw = [res.text, res.raw].filter(Boolean).join('\n');
  return raw.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 240);
}

module.exports = { App, PREAMBLE };
