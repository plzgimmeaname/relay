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
      strategy: saved?.strategy || this.config.strategy || 'priority',
      exhausted: Object.fromEntries(Object.entries(saved?.exhausted || {}).filter(([n]) => configured.includes(n))),
      commands: saved?.commands || {},
      stats: saved?.stats || {},
    };
  }

  #save() {
    try {
      fs.mkdirSync(this.home, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2) + '\n');
    } catch {
      /* tolerate read-only home */
    }
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

  getStrategy() {
    return this.state.strategy || this.config.strategy || 'priority';
  }

  setStrategy(strategy) {
    const valid = ['priority', 'pool', 'free-first'];
    if (!valid.includes(strategy)) {
      throw new Error(`unknown strategy "${strategy}" — try: ${valid.join(', ')}`);
    }
    this.state.strategy = strategy;
    this.#save();
    return strategy;
  }

  backend(name) {
    const def = this.config.backends[name];
    if (!def) throw new Error(`unknown backend: ${name}`);
    return def;
  }

  pick(exclude = [], strategy = this.getStrategy()) {
    const skip = new Set(exclude);
    const now = Date.now();
    const ready = [];

    for (const name of this.all) {
      if (skip.has(name)) continue;
      const ex = this.state.exhausted[name];
      if (!ex) {
        ready.push(name);
        continue;
      }
      if (ex.hard) {
        if ((ex.since || 0) + (this.config.hardResetMs || 3 * 3600_000) > now) continue;
        this.retryProbe(name);
        ready.push(name);
        continue;
      }
      if (ex.until && ex.until > now) continue;
      ready.push(name);
    }

    if (!ready.length) return null;

    if (strategy === 'pool') {
      // Round-robin / Least-Recently-Used to maximize credit lifetime across all providers
      ready.sort((a, b) => {
        const lastA = this.state.stats?.[a]?.lastUsed || 0;
        const lastB = this.state.stats?.[b]?.lastUsed || 0;
        return lastA - lastB;
      });
      return ready[0];
    }

    if (strategy === 'free-first') {
      // Prioritize free-tier backends to preserve paid credits for fallback
      const freeOnes = ready.filter((n) => this.config.backends[n]?.freeTier !== false);
      if (freeOnes.length > 0) return freeOnes[0];
      return ready[0];
    }

    // Default 'priority'
    return ready[0];
  }

  recordTurn(name, { ok = true, isQuota = false, usage = null, durationMs = null } = {}) {
    if (!name) return;
    this.state.stats = this.state.stats || {};
    const prev = this.state.stats[name] || { turns: 0, successes: 0, quotaHits: 0, totalTokens: 0, lastUsed: null };
    const tokens = (usage?.input_tokens || usage?.inputTokens || 0) + (usage?.output_tokens || usage?.outputTokens || 0);
    this.state.stats[name] = {
      turns: prev.turns + 1,
      successes: prev.successes + (ok ? 1 : 0),
      quotaHits: prev.quotaHits + (isQuota ? 1 : 0),
      totalTokens: prev.totalTokens + tokens,
      lastUsed: Date.now(),
      lastDurationMs: durationMs || null,
    };
    this.#save();
  }

  getStats(name) {
    if (name) return this.state.stats?.[name] || { turns: 0, successes: 0, quotaHits: 0, totalTokens: 0, lastUsed: null };
    return this.state.stats || {};
  }

  creditStatus() {
    const now = Date.now();
    return this.all.map((name) => {
      const def = this.backend(name);
      const ex = this.state.exhausted[name];
      const stats = this.getStats(name);
      let state = 'ready';
      let cooldownRemainingMs = null;
      let cooldownText = '';

      if (ex?.hard) {
        state = 'out_of_credits';
        const resetAt = (ex.since || now) + (this.config.hardResetMs || 3 * 3600_000);
        cooldownRemainingMs = Math.max(0, resetAt - now);
        const mins = Math.ceil(cooldownRemainingMs / 60_000);
        cooldownText = mins > 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
      } else if (ex?.until && ex.until > now) {
        state = 'cooldown';
        cooldownRemainingMs = ex.until - now;
        const mins = Math.ceil(cooldownRemainingMs / 60_000);
        cooldownText = `${mins}m`;
      }

      const rate = stats.turns > 0 ? Math.round((stats.successes / stats.turns) * 100) : 100;

      return {
        name,
        command: def.command,
        dialect: def.dialect || 'claude',
        label: def.label || name,
        freeTier: def.freeTier !== false,
        state,
        reason: ex?.reason || '',
        cooldownRemainingMs,
        cooldownText,
        turns: stats.turns,
        successes: stats.successes,
        quotaHits: stats.quotaHits,
        totalTokens: stats.totalTokens,
        successRate: `${rate}%`,
        lastUsed: stats.lastUsed,
      };
    });
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
