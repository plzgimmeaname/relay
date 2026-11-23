const readline = require('readline');
const os = require('os');
const { c, rule, table, badge, truncate, spinnerFrame, indent, strip, WIDTH, resetTerminal, gradient, logoLines, dot, LOGO, TIPS } = require('./ui');
const { version: VERSION } = require('../package.json');
const { wizard } = require('./connect');
const store = require('./store');
const { listAgents } = require('./agent');
const fs = require('fs');
const path = require('path');
const log = require('./log');

const HELP = [
  ['<prompt>', 'send to the current backend; relay picks the CLI'],
  ['/help', 'this list'],
  ['/status', 'session, backends, credit state, AGENTS.md'],
  ['/priority [a b c]', 'show or set the CLI failover order'],
  ['/priority move <cli> <n>', 'move one CLI to position n'],
  ['/use <cli>', 'pin a CLI for the following turns'],
  ['/backends', 'every connected CLI and its state'],
  ['/connect [command]', 'guided wizard: add any CLI to the rotation'],
  ['/commands [cli] [text]', 'commands relay has seen, grouped; filter by text'],
  ['/run <cli> /cmd [args]', 'run a CLI-native command verbatim'],
  ['/sync', 'write the progress block into AGENTS.md'],
  ['/note <text>', 'pin a durable note into every backend prompt'],
  ['/agents', 'list every agent assignment (name, cli, model, directory, session)'],
  ['/switch <name>', 'switch the TUI to an agent assignment (its cli, model, directory)'],
  ['/sessions [--all]', 'saved sessions, here or everywhere'],
  ['/resume [id|#]', 'continue a saved session from any directory'],
  ['/ref <id|#|name>', 'keep a past session in context'],
  ['/refs', 'show referenced sessions'],
  ['/unref <id>', 'stop referencing one'],
  ['/retry', 're-run the last prompt'],
  ['/history [n]', 'last n turns of this session (default 6)'],
  ['/export [file]', 'save this session as a markdown transcript'],
  ['/cost', 'tokens and time per CLI for this session'],
  ['/verbose [full|compact]', 'show everything the CLI prints (default) or a short view'],
  ['/native [cli] [--all]', 'history other CLIs kept (claude, qwen, junie)'],
  ['/import <#|id> [--resume]', 'bring a CLI\'s own session into relay (and /ref it)'],
  ['/theme [name]', 'colors: dark (default), light, mono'],
  ['/log [n]', 'recent relay errors and failovers'],
  ['/forget [cli]', 'clear credit / cooldown marks'],
  ['/clear', 'start a fresh session here'],
  ['/quit', 'exit (or Ctrl-D; Ctrl-C twice)'],
];

class Tui {
  constructor(app, config) {
    this.app = app;
    this.config = config;
    this.rl = null;
    this.tty = false;
    this.busy = false;
    this.ctrlC = 0;
    this.frame = 0;
    this.spinnerTimer = null;
    this.lastSessionList = null;
    this.chain = Promise.resolve();
    this.closed = false;
    this.streamed = false;
    this.midLine = false;
    this.verbosity = this.loadVerbosity();
    this.out = (s) => process.stdout.write(s + '\n');
  }

  banner() {
    const st = this.app.status();
    const cols = process.stdout.columns || 80;
    const w = Math.min(cols - 4, 62);
    const lines = [''];
    if (cols >= 50) lines.push(...logoLines());
    else lines.push('  ' + gradient('◆ relay'));
    const version = c.gray('v' + VERSION);
    const tagline = `${c.bold(c.text('one session'))} ${c.gray('·')} ${c.bold(c.text('every coding CLI'))}`;
    lines.push('', `  ${tagline}${' '.repeat(Math.max(2, w - 30 - 6))}${version}`);
    lines.push(c.gray('  ' + '─'.repeat(w)));

    if (!st.order.length) lines.push(`  ${c.yellow('no CLI connected yet')} ${c.gray('· run /connect to add one')}`);
    else {
      const reg = this.app.registry;
      const chips = st.order.map((n, i) => {
        const ex = reg.exhausted[n];
        const state = ex?.hard ? 'out' : ex?.until > Date.now() ? 'cooldown' : 'ready';
        const tag = reg.backend(n)?.dialect === 'pty' ? c.gray(' pty') : '';
        return `${dot(state)} ${n === st.backend ? c.bold(c.cyan(n)) : c.bold(c.text(n))}${tag}`;
      });
      lines.push(`  ${c.gray('asks    ')}${chips.join(c.gray('  ›  '))}`);
    }
    const home = os.homedir();
    const dir = this.app.cwd.startsWith(home) ? '~' + this.app.cwd.slice(home.length) : this.app.cwd;
    lines.push(`  ${c.gray('session ')}${c.text(st.session.slice(0, 8))} ${c.gray('·')} ${c.text(String(st.entries))} ${c.gray('turns ·')} ${c.gray(truncate(dir, Math.max(16, w - 28)))}`);
    lines.push(`  ${c.gray('tip     ')}${c.gray(TIPS[(Date.now() / 60000 | 0) % TIPS.length])}`);
    lines.push('');
    return lines.join('\n');
  }

  async intro() {
    const lines = this.banner().split('\n');
    const animate = this.tty && process.stdout.isTTY && !process.env.NO_COLOR && !process.env.RELAY_NO_ANIM;
    for (let i = 0; i < lines.length; i += 1) {
      this.out(lines[i]);
      if (animate) await new Promise((r) => setTimeout(r, i > 0 && i <= LOGO.length ? 55 : 14));
    }
  }

  prompt() {
    const name = this.app.backendName;
    return c.bold(c.cyan('relay')) + (name ? c.gray(` · ${name}`) : '') + c.bold(c.magenta(' ❯ ')) + (c.text('') ? '' : '') + brightOn();
  }

  complete(line) {
    const names = this.app.registry.all;
    const cmds = HELP.map((h) => h[0].split(/\s/)[0]).filter((x) => x.startsWith('/'));
    const parts = line.split(/\s+/);
    if (parts.length <= 1) {
      const hits = cmds.filter((x) => x.startsWith(line));
      return [hits.length ? hits : line.startsWith('/') ? cmds : [], line];
    }
    const last = parts[parts.length - 1];
    if (/^\/(use|forget|run|commands|priority)$/.test(parts[0])) return [names.filter((n) => n.startsWith(last)), last];
    if (/^\/(switch)$/.test(parts[0])) {
      const agents = listAgents(this.config.home).map((a) => a.name);
      return [agents.filter((n) => n.startsWith(last)), last];
    }
    return [[], last];
    return [[], last];
  }

  historyFile() {
    return path.join(this.config.home, 'history');
  }

  loadHistory() {
    try {
      return fs.readFileSync(this.historyFile(), 'utf8').split('\n').filter(Boolean).slice(-500).reverse();
    } catch {
      return [];
    }
  }

  saveHistory(line) {
    if (!line.trim()) return;
    try {
      fs.appendFileSync(this.historyFile(), line.replace(/\n/g, ' ') + '\n');
    } catch {
      /* history is a convenience */
    }
  }

  line(s) {
    if (this.spinnerTimer) {
      // keep log lines clean while the spinner owns the bottom row
      process.stdout.write('\r\x1b[K');
      this.out(s);
      this.drawSpinner();
      return;
    }
    this.out(s);
  }

  onTurnStart({ backend, dialect, hop, digest, resumeId }) {
    const how = resumeId ? 'native resume' : digest ? 'importing transcript' : dialect;
    this.line(c.gray(`  ↳ ${hop === 0 ? 'asking' : 'handing off to'} ${c.bold(backend)} ${c.gray(`(${how})`)}`));
  }

  onFailover({ from, reason, detail, next }) {
    if (reason === 'aborted') return this.line(c.yellow(`  ⏹  ${from} interrupted`));
    const icon = reason === 'quota' ? c.red('⛔') : c.yellow('⚠ ');
    const head = `${icon} ${c.bold(from)}: ${reason}${detail ? ' — ' + truncate(detail, 120) : ''}`;
    this.line(next ? `${head}\n${indent(c.gray('→ retrying on ' + c.bold(next)), '     ')}` : `${head}\n${indent(c.red('no CLI left — /forget, /priority or /connect'), '     ')}`);
  }

  verbosityFile() {
    return path.join(this.config.home, 'verbose');
  }

  loadVerbosity() {
    try {
      const v = fs.readFileSync(this.verbosityFile(), 'utf8').trim();
      if (v === 'full' || v === 'compact') return v;
    } catch {
      /* default */
    }
    return 'full';
  }

  setVerbosity(v) {
    this.verbosity = v;
    try {
      fs.writeFileSync(this.verbosityFile(), v + '\n');
    } catch {
      /* per-run only */
    }
  }

  // Print while a spinner may be running: lift the spinner, print, put it back.
  emit(fn) {
    const spinning = Boolean(this.spinnerTimer);
    if (spinning) this.stopSpinner();
    if (this.midLine) {
      process.stdout.write('\n');
      this.midLine = false;
    }
    fn();
    if (spinning) this.startSpinner(this.spinnerText);
  }

  block(text, bar, paint) {
    const lines = String(text).replace(/\s+$/, '').split('\n');
    const cap = this.verbosity === 'compact' ? 8 : Infinity;
    const shown = lines.slice(0, cap);
    for (const l of shown) this.out(`  ${bar} ${paint(l)}`);
    if (lines.length > cap) this.out(`  ${bar} ${c.gray(`… ${lines.length - cap} more lines (/verbose full)`)}`);
  }

  renderEvent(evt) {
    const full = this.verbosity !== 'compact';
    switch (evt.type) {
      case 'init':
        if (full) this.emit(() => this.line(c.gray(`  ◇ ${evt.model || 'session'} started${evt.sessionId ? ' · ' + evt.sessionId.slice(0, 8) : ''}`)));
        return;
      case 'assistant_text':
        this.streamed = true;
        this.emit(() => {
          this.out('\n' + c.cyan('● ') + c.bold(this.app.backendName || 'reply'));
          this.out(String(evt.text).split('\n').map((l) => `${c.cyan('│')} ${c.text(l)}`).join('\n'));
        });
        return;
      case 'tool_use':
        this.emit(() => {
          this.line(`  ${c.magenta('⚙')} ${c.bold(evt.name)} ${full ? '' : c.gray(toolHint(evt.input))}`.trimEnd());
          if (full && evt.input !== undefined) this.block(typeof evt.input === 'string' ? evt.input : fullInput(evt.input), c.magenta('╎'), c.gray);
        });
        return;
      case 'tool_result':
        this.emit(() => {
          if (!String(evt.text || '').trim()) return this.line(c.gray(`  ${evt.isError ? '✗' : '↳'} (no output)`));
          this.block(evt.text, evt.isError ? c.red('╎') : c.gray('╎'), evt.isError ? c.red : c.gray);
        });
        return;
      case 'thinking':
        this.emit(() => {
          if (full) this.block(evt.text, c.gray('◌'), (l) => c.gray(c.italic(l)));
          else this.line(`  ${c.gray('◌ ' + truncate(String(evt.text).replace(/\s+/g, ' '), 90))}`);
        });
        return;
      case 'step':
        if (full) this.emit(() => this.line(c.gray(`  · ${evt.name}${evt.text ? ': ' + truncate(String(evt.text).replace(/\s+/g, ' '), 160) : ''}`)));
        return;
      case 'stdout': {
        this.streamed = true;
        const spinning = Boolean(this.spinnerTimer);
        if (spinning) this.stopSpinner();
        process.stdout.write(String(evt.text));
        this.midLine = !/\n$/.test(evt.text);
        if (spinning) {
          if (this.midLine) {
            process.stdout.write('\n');
            this.midLine = false;
          }
          this.startSpinner(this.spinnerText);
        }
        return;
      }
      case 'stderr':
      case 'noise':
        if (full) this.emit(() => String(evt.text).replace(/\s+$/, '').split('\n').forEach((l) => this.line(c.gray('  ! ') + c.gray(l))));
        return;
      default:
    }
  }

  renderResult(res) {
    const text = String(res.text || '').trim();
    const who = this.app.backendName;
    if (text && !this.streamed) {
      const bar = c.cyan('│');
      this.out('\n' + c.cyan('● ') + c.bold(who || 'reply'));
      this.out(styleReply(text).map((l) => `${bar} ${l}`).join('\n'));
    }
    const r = res.result || {};
    const bits = [];
    if (r.usage?.context_usage_ratio) bits.push(`context ${Math.round(r.usage.context_usage_ratio * 100)}%`);
    if (r.usage?.input_tokens != null && r.usage?.input_tokens > 0) bits.push(`${r.usage.input_tokens} in / ${r.usage.output_tokens || 0} out`);
    if (Array.isArray(r.usage)) {
      const u = r.usage.reduce((a, m) => ({ i: a.i + (m.inputTokens || 0), o: a.o + (m.outputTokens || 0) }), { i: 0, o: 0 });
      bits.push(`${u.i} in / ${u.o} out`);
    }
    if (r.durationMs) bits.push(`${(r.durationMs / 1000).toFixed(1)}s`);
    if (r.credits) bits.push(`credits ${r.credits}`);
    if (bits.length) this.line(c.gray('╰─ ' + bits.join(' · ') + '\n'));
  }

  async start() {
    this.tty = !!process.stdin.isTTY;
    if (this.tty) resetTerminal();
    await this.intro();
    this.rl = readline.createInterface({ input: this.tty ? cleanInput(process.stdin) : process.stdin, output: process.stdout, terminal: this.tty, prompt: this.prompt(), history: this.tty ? this.loadHistory() : [], historySize: 500, completer: (l) => this.complete(l) });
    if (this.tty) this.bindCtrlC();
    this.sayPrompt();
    this.rl.on('line', (line) => {
      if (this.tty) process.stdout.write('\x1b[39m');
      if (this.tty && !this.pending?.length) this.saveHistory(line);
      this.feed(line);
    });
    this.rl.on('close', () => {
      this.closed = true;
      this.shutdown();
    });
  }

  sayPrompt() {
    if (this.closed) return;
    try {
      this.rl.setPrompt(this.prompt());
      this.rl.prompt();
    } catch {
      this.closed = true;
    }
  }

  pauseInput() {
    if (!this.tty || this.closed) return;
    try {
      this.rl.pause();
    } catch {
      /* input closed mid-turn */
    }
  }

  resumeInput() {
    if (!this.tty || this.closed) return;
    try {
      this.rl.resume();
    } catch {
      /* input closed mid-turn */
    }
  }

  feed(raw) {
    const line = raw.trim();
    if (this.pending?.length) return this.pending.shift()(line);
    this.chain = this.chain.then(() => this.handle(line)).catch((err) => this.line(c.red('  ✗ ') + err.message));
  }

  shutdown() {
    if (this.pending?.length) return this.exit();
    this.chain.then(() => this.exit(), () => this.exit());
  }

  bindCtrlC() {
    process.stdin.on('SIGINT', () => {
      if (this.busy && this.app.abort) {
        this.app.abort();
        return;
      }
      this.ctrlC += 1;
      if (this.ctrlC >= 2) return this.exit();
      this.line(c.gray('\n  (Ctrl-C again to quit · during a reply it interrupts that turn)'));
      this.sayPrompt();
    });
  }

  ask(question) {
    return new Promise((resolve) => {
      if (this.closed) return resolve('');
      if (!this.tty) {
        this.pending = this.pending || [];
        this.pending.push(resolve);
        this.sayPrompt();
        return;
      }
      try {
        this.rl.question(question, resolve);
      } catch {
        resolve('');
      }
    });
  }

  confirm(question) {
    return this.ask(question).then((a) => /^\s*(y|yes)/i.test(a || ''));
  }

  async handle(raw) {
    const line = raw.trim();
    if (!line) return this.sayPrompt();
    if (!isCommand(line)) return this.submit(line);
    this.pauseInput();
    try {
      await require('./commands').dispatch(this, line);
    } catch (err) {
      if (/cancel/i.test(err.message)) this.line(c.gray('  cancelled'));
      else this.line(c.red('  ✗ ') + err.message);
    }
    this.resumeInput();
    this.sayPrompt();
  }

  async submit(text) {
    this.busy = true;
    this.streamed = false;
    this.midLine = false;
    this.pauseInput();
    this.startSpinner(`waiting for ${this.app.backendName || 'a CLI'}`);
    try {
      const out = await this.app.turn(text, { onEvent: (e) => this.renderEvent(e) });
      this.stopSpinner();
      if (out.ok) this.renderResult(out.res);
      else if (!out.aborted) {
        this.line(c.red(`\n  no CLI could answer${out.tried?.length ? ` (tried ${out.tried.join(', ')})` : ''}.`));
        if (out.res) this.line(c.gray('  last error: ' + truncate(`${out.res.kind} ${out.res.raw || out.res.error || ''}`, 200)));
        this.line(c.gray('  /backends · /forget · /connect'));
      }
    } catch (err) {
      this.stopSpinner();
      this.line(c.red('  ✗ ') + err.message);
    }
    this.busy = false;
    this.resumeInput();
    this.sayPrompt();
  }

  setSpinnerText(text) {
    if (this.spinnerTimer) this.spinnerText = text;
  }

  drawSpinner() {
    const secs = Math.floor((Date.now() - this.spinnerStart) / 1000);
    const who = this.app.backendName ? c.gray(` · ${this.app.backendName}`) : '';
    const hint = c.gray(` · ${secs}s · Ctrl-C interrupts`);
    const cols = process.stdout.columns || 80;
    const room = Math.max(10, cols - 30 - strip(who).length);
    process.stdout.write('\r\x1b[K' + spinnerFrame(truncate(this.spinnerText, room), this.frame) + who + hint);
  }

  startSpinner(text) {
    if (!process.stdout.isTTY || this.closed) return;
    this.spinnerText = text;
    this.spinnerStart = Date.now();
    this.frame = 0;
    this.rl.setPrompt('');
    process.stdout.write('\x1b[?25l');
    this.drawSpinner();
    this.spinnerTimer = setInterval(() => {
      this.frame += 1;
      this.drawSpinner();
    }, 110);
  }

  stopSpinner() {
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
    process.stdout.write('\r\x1b[K\x1b[?25h');
    this.rl.setPrompt(this.prompt());
  }

  exit() {
    this.stopSpinner();
    resetTerminal();
    try {
      const s = this.app.sync();
      this.line(c.gray(`\n  session ${this.app.session.header.sid.slice(0, 8)} saved · progress → ${s.file}`));
    } catch {
      this.line('\n  saved');
    }
    process.exit(0);
  }
}

// Terminals answer capability queries (DA, DECRQM, XTVERSION, OSC colors) on stdin.
// Readline would type those replies into the prompt, so drop them before it sees them.
// Plain keys and arrow/home/end sequences pass through untouched.
const TERM_REPLY = new RegExp(
  [
    '\\x1b\\[[?>=<][0-9;:.]*[ -/]*[@-~]', // CSI with a private marker: ?...$y, >...c, ?...u
    '\\x1b\\[<[0-9;]+[Mm]', // SGR mouse reports
    '\\x1b\\[M[\\s\\S]{3}', // legacy mouse reports
    '\\x1b\\[[IO]', // focus in/out
    '\\x1b\\[[0-9;]+R', // cursor position report
    '\\x1b[P_\\]^X][\\s\\S]*?(?:\\x1b\\\\|\\x07)', // DCS / OSC / APC strings
  ].join('|'),
  'g'
);

function cleanInput(src) {
  const { PassThrough } = require('stream');
  const out = new PassThrough();
  out.isTTY = true;
  out.setRawMode = (mode) => src.setRawMode && src.setRawMode(mode);
  src.on('data', (buf) => {
    const text = buf.toString('utf8').replace(TERM_REPLY, '');
    if (text) out.write(text);
  });
  src.on('end', () => out.end());
  return out;
}

// Light markdown styling: headings, **bold**, `code`, fenced blocks.
function styleReply(text) {
  let fence = false;
  return text.split('\n').map((l) => {
    if (/^\s*```/.test(l)) {
      fence = !fence;
      return c.gray(l.trim());
    }
    if (fence) return c.green(l);
    if (/^#{1,6}\s/.test(l)) return c.bold(c.cyan(l.replace(/^#+\s*/, '')));
    return l.replace(/\*\*([^*]+)\*\*/g, (_, t) => c.bold(t)).replace(/`([^`]+)`/g, (_, t) => c.yellow(t));
  });
}

// start of the body-text colour, left open so what you type is bright too
function brightOn() {
  const mark = c.text('\u0000');
  return mark.includes('\u0000') ? mark.slice(0, mark.indexOf('\u0000')) : '';
}

function fullInput(input) {
  if (input && typeof input === 'object') {
    // show commands / paths / patterns as themselves, everything else as JSON
    const keys = Object.keys(input);
    if (keys.length === 1 && typeof input[keys[0]] === 'string') return input[keys[0]];
    return JSON.stringify(input, null, 2);
  }
  return String(input ?? '');
}

function toolHint(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'details']) {
    if (typeof input[k] === 'string') return `${k}: ${truncate(input[k], 70)}`;
  }
  return truncate(Object.keys(input).join(','), 40);
}

// "/help" is a command, "/Users/me/file.ts" is a prompt.
function isCommand(line) {
  return /^\/[a-z][a-z0-9_-]*(\s|$)/i.test(line);
}

module.exports = { Tui, HELP, toolHint, isCommand };
