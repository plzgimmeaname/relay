const fs = require('fs');
const os = require('os');
const path = require('path');

function home() {
  return process.env.RELAY_HOME || path.join(os.homedir(), '.relay');
}

function toRe(pattern) {
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern !== 'string') return null;
  const m = pattern.match(/^\/(.*)\/([a-z]*)$/);
  if (m) return new RegExp(m[1], m[2] || 'i');
  return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

class QuotaDetector {
  constructor(patterns = []) {
    this.patterns = patterns.map(toRe).filter(Boolean);
    this.hits = [];
  }

  feed(text) {
    if (!this.patterns.length || typeof text !== 'string' || !text) return null;
    for (const re of this.patterns) {
      if (!re.test(text)) continue;
      const line = text.split('\n').find((l) => re.test(l)) || text.slice(0, 300);
      const hit = { pattern: re.source, line: line.trim().slice(0, 400) };
      this.hits.push(hit);
      return hit;
    }
    return null;
  }

  get matched() {
    return this.hits.length > 0;
  }

  get reason() {
    return this.hits[0]?.line || '';
  }
}

class Probe {
  constructor(cwd) {
    this.cwd = cwd;
  }

  toCase(name, events, raw) {
    const result = events.find((e) => e.kind === 'result') || {};
    const assistantErrors = events.filter((e) => (e.kind === 'result-part' || e.kind === 'api-error') && (e.raw?.error || e.raw?.is_api_error_message));
    const text = [result.errorText, result.raw?.subtype, assistantErrors.map((a) => a.raw?.error).join(' ')].filter(Boolean).join(' ');
    return {
      created: Date.now(),
      name,
      cwd: this.cwd,
      is_error: result.isError === true || assistantErrors.length > 0,
      subtype: result.subtype || null,
      terminal_reason: result.raw?.terminal_reason || null,
      api_error_status: result.raw?.api_error_status || null,
      error_text: String(text).slice(0, 1500),
      raw_tail: String(raw || '').slice(-2000),
      events: events.length,
    };
  }

  save(name, case_) {
    const dir = path.join(home(), 'probes');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(case_, null, 2) + '\n');
    return file;
  }

  cases(limit = 20) {
    const dir = path.join(home(), 'probes');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((f) => {
        try {
          return { file: path.join(dir, f), ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  helpText(command, cwd) {
    const { spawnSync } = require('child_process');
    const res = spawnSync(command, ['--help'], { cwd, encoding: 'utf8', timeout: 15_000 });
    if (res.error) return '';
    return [res.stdout || '', res.stderr || ''].join('\n');
  }

  which(command) {
    const { spawnSync } = require('child_process');
    const res = spawnSync('/usr/bin/env', ['bash', '-lc', `command -v ${quoteArg(command)}`], { encoding: 'utf8', timeout: 10_000 });
    const found = (res.stdout || '').trim().split('\n')[0];
    if (found) return found;
    const file = this.pathOf(command);
    return file && isExecutable(file) ? file : null;
  }

  // a path the user typed directly, when it exists on disk
  pathOf(command) {
    if (!command || !command.includes('/')) return null;
    const file = command.startsWith('/') ? command : path.join(this.cwd, command);
    return fs.existsSync(file) ? file : null;
  }
}

function quoteArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = { Probe, QuotaDetector, toRe, quoteArg, isExecutable };
