const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_BYTES = 1024 * 1024;

function home() {
  return process.env.RELAY_HOME || path.join(os.homedir(), '.relay');
}

function file() {
  return path.join(home(), 'relay.log');
}

// Append one line: ISO time, level, message, optional JSON detail. Never throws.
function write(level, message, detail) {
  try {
    fs.mkdirSync(home(), { recursive: true });
    const f = file();
    try {
      if (fs.statSync(f).size > MAX_BYTES) fs.renameSync(f, f + '.1');
    } catch {
      /* no log yet */
    }
    let tail = '';
    if (detail !== undefined) {
      const d = detail instanceof Error ? { message: detail.message, stack: String(detail.stack || '').split('\n').slice(0, 6).join(' | ') } : detail;
      try {
        tail = ' ' + JSON.stringify(d);
      } catch {
        tail = ' ' + String(d);
      }
    }
    fs.appendFileSync(f, `${new Date().toISOString()} ${level.padEnd(5)} ${String(message).replace(/\n/g, ' ')}${tail}\n`);
  } catch {
    /* logging must never break relay */
  }
}

function tail(n = 30) {
  try {
    const lines = fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

module.exports = {
  file,
  tail,
  info: (m, d) => write('info', m, d),
  warn: (m, d) => write('warn', m, d),
  error: (m, d) => write('error', m, d),
};
