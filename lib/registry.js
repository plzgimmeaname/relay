const fs = require('fs');
const path = require('path');

const STATE_VERSION = 1;

class Registry {
  constructor(home, config) {
    this.home = home;
    this.config = config;
    this.file = path.join(home, 'state.json');
    this.state = this.#read();
  }

  #read() {
    const configured = Object.keys(this.config.backends);
    let saved = null;
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(s.order)) saved = s;
    } catch {
      /* fresh start */
    }
    const kept = (saved?.order || []).filter((n) => configured.includes(n));
    const added = configured.filter((n) => !kept.includes(n));
    return {
      version: STATE_VERSION,
      order: [...kept, ...added],
      exhausted: Object.fromEntries(Object.entries(saved?.exhausted || {}).filter(([n]) => configured.includes(n))),
      commands: saved?.commands || {},
    };
  }

  #save() {
    fs.mkdirSync(this.home, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2) + '\n');
  }

  get all() {
    const configured = Object.keys(this.config.backends);
    const kept = this.state.order.filter((n) => configured.includes(n));
    const added = configured.filter((n) => !kept.includes(n));
    return [...kept, ...added];
  }

  get available() {
    return this.all.filter((n) => this.state.exhausted[n]?.hard !== true);
  }

  get exhausted() {
    return this.state.exhausted;
  }

  backend(name) {
    const def = this.config.backends[name];
    if (!def) throw new Error(`unknown backend: ${name}`);
    return def;
  }

  pick(exclude = []) {
    const skip = new Set(exclude);
    const now = Date.now();
    for (const name of this.all) {
      if (skip.has(name)) continue;
      const ex = this.state.exhausted[name];
      if (!ex) return name;
      if (ex.hard) {
        if ((ex.since || 0) + (this.config.hardResetMs || 3 * 3600_000) > now) continue;
        this.retryProbe(name);
        continue;
      }
      if (ex.until && ex.until > now) continue;
      return name;
    }
    return null;
  }

  retryProbe(name) {
    delete this.state.exhausted[name];
    this.#save();
  }

  markExhausted(name, { hard = false, minutes = 15, reason = '' } = {}) {
    const prev = this.state.exhausted[name] || {};
    this.state.exhausted[name] = {
      ...prev,
      hard,
      reason,
      since: prev.since || Date.now(),
      until: hard ? null : Date.now() + minutes * 60_000,
    };
    this.#save();
  }

  reset(name) {
    if (name) delete this.state.exhausted[name];
    else this.state.exhausted = {};
    this.#save();
  }

  setOrder(order) {
    const configured = Object.keys(this.config.backends);
    const next = order.filter((n) => configured.includes(n));
    for (const n of configured) if (!next.includes(n)) next.push(n);
    this.state.order = next;
    this.#save();
    return next;
  }

  recordCommands(backend, cmds) {
    if (!Array.isArray(cmds) || !cmds.length) return;
    this.state.commands[backend] = { at: Date.now(), cmds: cmds.slice().sort() };
    this.#save();
  }

  commands(backend) {
    return this.state.commands[backend]?.cmds || [];
  }

  allCommands() {
    return this.state.commands || {};
  }
}

module.exports = { Registry };
