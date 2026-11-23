const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const { App } = require('./app');
const { Registry } = require('./registry');
const { loadConfig } = require('./config');

const RELAY_HOME = path.join(os.homedir(), '.relay');
const AGENTS_DIR = path.join(RELAY_HOME, 'agents');

function agentDir(home) {
  return path.join(home, '.relay', 'agents');
}

function agentFile(home, name) {
  return path.join(agentDir(home), `${name}.json`);
}

function agentLogFile(home, name) {
  return path.join(agentDir(home), `${name}.log`);
}

function listAgents(home = RELAY_HOME) {
  const dir = agentDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => {
      try {
        const a = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
        a.name = n.slice(0, -5);
        a.file = path.join(dir, n);
        return a;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function findAgent(home, name) {
  const file = agentFile(home, name);
  if (!fs.existsSync(file)) return null;
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    a.name = name;
    a.file = file;
    return a;
  } catch {
    return null;
  }
}

class Agent {
  constructor({ name, backend, model, cwd, home = RELAY_HOME, config, registry, sessionId }) {
    this.name = name;
    this.backend = backend;
    this.model = model || null;
    this.cwd = path.resolve(cwd);
    this.home = home;
    this.sessionId = sessionId || null;
    this.session = null;
    this.app = null;
    this._config = config;
    this._registry = registry;
  }

  static load(home, name) {
    return findAgent(home, name);
  }

  static all(home = RELAY_HOME) {
    return listAgents(home);
  }

  remove() {
    const file = agentFile(this.home, this.name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const log = agentLogFile(this.home, this.name);
    if (fs.existsSync(log)) fs.unlinkSync(log);
  }

  save() {
    const dir = agentDir(this.home);
    fs.mkdirSync(dir, { recursive: true });
    const data = {
      name: this.name,
      backend: this.backend,
      model: this.model,
      cwd: this.cwd,
      sessionId: (this.session && this.session.header.sid) || this.sessionId,
      updated: Date.now(),
    };
    fs.writeFileSync(agentFile(this.home, this.name), JSON.stringify(data, null, 2) + '\n');
    return data;
  }

  ensureApp() {
    if (this.app) return this.app;
    const config = this._config || loadConfig();
    const base = config.backends[this.backend];
    if (!base) throw new Error(`unknown backend "${this.backend}" — known: ${Object.keys(config.backends).join(', ')}`);
    const agentConfig = JSON.parse(JSON.stringify(config));
    agentConfig.backends[this.backend] = { ...base, model: this.model || base.model, name: this.backend };
    const registry = new Registry(this.home, agentConfig);
    if (!registry.all.includes(this.backend)) {
      registry.setOrder([this.backend, ...registry.all.filter((n) => n !== this.backend)]);
    }
    let session;
    if (this.sessionId) {
      const found = store.findSession(this.home, this.sessionId);
      if (found && !found.ambiguous) session = store.openSession(found.file);
    }
    if (!session) {
      const latest = store.latestSession(this.home, this.cwd);
      session = latest ? store.openSession(latest.file) : store.createSession(this.home, this.cwd, this.name);
    }
    session.header.lastBackend = this.backend;
    session.header.name = session.header.name || this.name;
    store.rewriteHeader(session);
    this.session = session;
    this.sessionId = session.header.sid;
    this.app = new App({ config: agentConfig, registry, session, cwd: this.cwd, ui: {}, opts: {} });
    return this.app;
  }

  async turn(prompt, hooks = {}) {
    const app = this.ensureApp();
    const out = await app.turn(prompt, hooks, { force: this.backend });
    this.session = app.session;
    this.sessionId = this.session.header.sid;
    this.save();
    return out;
  }

  async retry(hooks = {}) {
    const app = this.ensureApp();
    const out = await app.retry(hooks);
    this.session = app.session;
    this.save();
    return out;
  }

  status() {
    const app = this.app;
    const st = app ? app.status() : null;
    return {
      name: this.name,
      backend: this.backend,
      model: this.model,
      cwd: this.cwd,
      session: this.sessionId,
      entries: this.session ? this.session.entries.length : 0,
      backendName: st ? st.backend : null,
    };
  }

  async spawnDetached(prompt) {
    const script = path.join(__dirname, 'agent-run.js');
    const payload = JSON.stringify({
      name: this.name,
      backend: this.backend,
      model: this.model,
      cwd: this.cwd,
      prompt,
      home: this.home,
    });
    const logStream = fs.createWriteStream(agentLogFile(this.home, this.name), { flags: 'a' });
    const child = spawn(process.execPath, [script, payload], {
      cwd: this.cwd,
      detached: true,
      stdio: ['ignore', logStream, logStream],
      env: { ...process.env },
    });
    child.unref();
    return { pid: child.pid, log: agentLogFile(this.home, this.name) };
  }
}

module.exports = { Agent, listAgents, findAgent, agentDir, agentFile, agentLogFile, RELAY_HOME };
