// Drive a full-screen terminal app (one with no headless/print mode) through a real
// pseudo-terminal: start it, type the prompt like a person, wait for the screen to go
// quiet, then read the reply off the emulated screen.
const { spawn } = require('child_process');
const { VT } = require('./vt');

// stdlib-only Python shim: gives the app a controlling pty with a fixed window size.
const HELPER = `
import os, pty, sys, select, struct, fcntl, termios, signal
cols, rows = int(sys.argv[1]), int(sys.argv[2])
cmd = sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    try:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    except Exception:
        pass
    try:
        os.execvp(cmd[0], cmd)
    except Exception as e:
        sys.stderr.write('relay-pty: cannot start %s: %s\\n' % (cmd[0], e))
        os._exit(127)
def stop(*_):
    try:
        os.kill(pid, signal.SIGHUP)
    except Exception:
        pass
    os._exit(0)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGHUP, stop)
stdin_open = True
while True:
    fds = [fd] + ([0] if stdin_open else [])
    try:
        r, _, _ = select.select(fds, [], [])
    except InterruptedError:
        continue
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 65536)
        if not data:
            stdin_open = False
        else:
            os.write(fd, data)
try:
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else (status >> 8))
except ChildProcessError:
    sys.exit(0)
`;

const DEFAULTS = {
  cols: 120,
  rows: 40,
  startupMs: 25_000, // longest we wait for the app to draw its first screen
  quietMs: 1_500, // screen unchanged this long = app is ready for input
  idleMs: 5_000, // screen unchanged this long after sending = reply finished
  minWaitMs: 3_000, // never judge a reply finished sooner than this
  submit: '\r',
  maxPromptChars: 8_000,
};

const RULE = /^[\s─━═╌╍┄┅┈┉\-_]{12,}$/;
const BOX_TOP = /^\s*[╭┌┏╔]/;
const SPINNER = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷◐◓◑◒]\s*\S{0,40}\s*(\(.*\))?$/;
// timing / copy-button chrome such as "⎘ • 4s • △▽"
const META = /^[\s⎘△▽•·]*(?:\d+(?:\.\d+)?m?s[\s⎘△▽•·]*)*$/;
const GUTTER = /^[│┃▌▎]\s?/;

function python() {
  return process.env.RELAY_PYTHON || 'python3';
}

function squash(s) {
  return String(s).replace(/\s+/g, '');
}

// Which screen line holds the end of what we typed? Everything after it is the reply.
// Take the FIRST new occurrence: apps often repeat the prompt later in a footer or title.
function findAnchor(lines, prompt, baseline = []) {
  const flat = squash(prompt);
  if (!flat) return -1;
  const needle = flat.slice(-14);
  const old = new Set(baseline.map((l) => l.trim()).filter(Boolean));
  for (let i = 0; i < lines.length; i += 1) {
    if (!old.has(lines[i].trim()) && squash(lines[i]).includes(needle)) return i;
    if (i + 1 < lines.length && squash(lines[i] + lines[i + 1]).includes(needle) && !squash(lines[i]).includes(needle)) return i + 1;
  }
  return -1;
}

function extractReply(lines, prompt, baseline, cfg = {}) {
  const anchor = findAnchor(lines, prompt, baseline);
  let body;
  if (anchor >= 0) body = lines.slice(anchor + 1);
  else {
    const seen = new Set(baseline.map((l) => l.trim()));
    body = lines.filter((l) => l.trim() && !seen.has(l.trim()));
  }

  // cut the input box / footer the app draws under the conversation
  const cut = cfg.cutBefore ? new RegExp(cfg.cutBefore) : null;
  for (let i = 0; i < body.length; i += 1) {
    const line = body[i];
    if (i > 0 && body.slice(0, i).some((l) => l.trim()) && (BOX_TOP.test(line) || RULE.test(line) || (cut && cut.test(line)))) {
      body = body.slice(0, i);
      break;
    }
  }

  const drop = (cfg.drop || []).map((p) => new RegExp(p));
  const out = body
    .map((l) => l.replace(GUTTER, '').replace(/\s+$/, ''))
    .filter((l) => !SPINNER.test(l) || !l.trim())
    .filter((l) => !l.trim() || !META.test(l))
    .filter((l) => !drop.some((re) => re.test(l)));

  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

function runPty({ def, args, prompt, cwd, env, timeoutMs, registerAbort, onEvent }) {
  const cfg = { ...DEFAULTS, ...(def.pty || {}) };
  const typed = prompt.length > cfg.maxPromptChars ? prompt.slice(-cfg.maxPromptChars) : prompt;

  return new Promise((resolve) => {
    let child;
    const argv = ['-u', '-c', HELPER, String(cfg.cols), String(cfg.rows), def.command, ...args];
    try {
      child = spawn(python(), argv, {
        cwd: cwd || process.cwd(),
        env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LINES: String(cfg.rows), COLUMNS: String(cfg.cols) },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      return resolve({ ok: false, kind: 'spawn', error: error.message, args, raw: '', text: '' });
    }

    const vt = new VT({ cols: cfg.cols, rows: cfg.rows, reply: (s) => child.stdin.writable && child.stdin.write(s) });
    const started = Date.now();
    let phase = 'startup';
    let lastChange = Date.now();
    let seenOutput = false;
    let sentAt = 0;
    let revAtSend = 0;
    let baseline = [];
    let stderr = '';
    let done = false;
    let aborted = false;
    let exit = null;

    const kill = (sig) => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* gone */
        }
      }
    };

    const finish = (kind, extra = {}) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      kill('SIGKILL');
      const all = vt.lines();
      const text = phase === 'wait' ? extractReply(all, typed, baseline, cfg) : '';
      const screenTail = all.filter((l) => l.trim()).slice(-12).join('\n');
      resolve({
        ok: kind === null,
        kind,
        text,
        raw: kind === null ? text : `${screenTail}\n${stderr}`.trim(),
        screen: screenTail,
        full: all.filter((l) => l.trim()).join('\n'),
        args,
        exitCode: exit?.code ?? null,
        signal: exit?.signal ?? null,
        ...extra,
      });
    };

    child.stdout.on('data', (chunk) => {
      seenOutput = true;
      if (vt.write(chunk)) lastChange = Date.now();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => finish('spawn', { error: error.message, spawnError: error.message }));
    child.on('close', (code, signal) => {
      exit = { code, signal };
      if (done) return;
      if (phase === 'wait') {
        const text = extractReply(vt.lines(), typed, baseline, cfg);
        if (text) return finish(null);
        return finish('noresult');
      }
      finish(code === 127 ? 'spawn' : 'noresult', code === 127 ? { spawnError: stderr.trim() || 'could not start' } : {});
    });

    registerAbort?.(() => {
      aborted = true;
      finish('aborted');
    });

    const send = () => {
      phase = 'wait';
      baseline = vt.lines();
      revAtSend = vt.revision;
      sentAt = Date.now();
      lastChange = sentAt;
      const oneLine = vt.bracketed ? typed : typed.replace(/\s*\n\s*/g, ' ');
      const body = vt.bracketed ? `\x1b[200~${typed}\x1b[201~` : oneLine;
      child.stdin.write(body);
      setTimeout(() => child.stdin.writable && child.stdin.write(cfg.submit), 400);
    };

    const poll = setInterval(() => {
      if (done) return;
      const now = Date.now();
      if (now - started > (timeoutMs || 900_000)) return finish('timeout');
      if (phase === 'startup') {
        const ready = seenOutput && now - lastChange >= cfg.quietMs;
        if (ready || now - started > cfg.startupMs) {
          if (!seenOutput) return finish('noresult');
          send();
        }
        return;
      }
      // waiting for the reply
      if (vt.revision === revAtSend) return;
      if (now - sentAt < cfg.minWaitMs || now - lastChange < cfg.idleMs) return;
      const text = extractReply(vt.lines(), typed, baseline, cfg);
      if (text) {
        onEvent?.({ type: 'assistant_text', text });
        finish(null);
      }
    }, 100);
    poll.unref?.();
    void aborted;
  });
}

module.exports = { runPty, extractReply, findAnchor, DEFAULTS, HELPER };
