const readline = require('readline');
const { c, rule, table, badge, truncate, spinnerFrame, indent, WIDTH } = require('./ui');
const { wizard } = require('./connect');
const store = require('./store');

const HELP = [
  ['<prompt>', 'send to the current backend; relay picks the CLI'],
  ['/help', 'this list'],
  ['/status', 'session, backends, credit state, AGENTS.md'],
  ['/priority [a b c]', 'show or set the CLI failover order'],
  ['/priority move <cli> <n>', 'move one CLI to position n'],
  ['/use <cli>', 'pin a CLI for the following turns'],
  ['/backends', 'every connected CLI and its state'],
  ['/connect [command]', 'guided wizard: add any CLI to the rotation'],
  ['/commands [cli]', 'commands relay has seen, from all CLIs'],
  ['/run <cli> /cmd [args]', 'run a CLI-native command verbatim'],
  ['/sync', 'write the progress block into AGENTS.md'],
  ['/note <text>', 'pin a durable note into every backend prompt'],
  ['/sessions [--all]', 'saved sessions, here or everywhere'],
  ['/resume [id|#]', 'continue a saved session from any directory'],
  ['/ref <id|#|name>', 'keep a past session in context'],
  ['/refs', 'show referenced sessions'],
  ['/unref <id>', 'stop referencing one'],
  ['/retry', 're-run the last prompt'],
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
    this.out = (s) => process.stdout.write(s + '\n');
  }

  banner() {
    const st = this.app.status();
    const order = (st.order.length ? st.order : ['(none)'])
      .map((n, i) => (i === 0 ? c.bold(n) : c.gray(n)))
      .join(c.gray(' > '));
    const backend = st.backend ? badge(st.backend, 'cyan') + c.gray(` · ${st.dialect}`) : c.red('no CLI connected');
    return [
      c.gray('┌' + '─'.repeat(WIDTH())),
      `${c.bold(c.cyan('relay'))}${c.gray('  ·  one session, every CLI')}`,
      `${c.gray('cli ')}${backend}${c.gray('   order ')}${order}${c.gray('   ·  ')}${st.entries} turns`,
      st.order.length ? '' : `${c.yellow('  run /connect to add your first CLI')}`,
      c.gray('└' + '─'.repeat(WIDTH())),
    ]
      .filter(Boolean)
      .join('\n');
  }

  prompt() {
    return c.bold(c.green('relay')) + c.gray(' ❯ ');
  }

  line(s) {
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

  renderEvent(evt) {
    if (evt.type === 'tool_use') this.line(`  ${c.magenta('⚙')} ${c.bold(evt.name)} ${c.gray(toolHint(evt.input))}`);
    else if (evt.type === 'thinking') this.line(`  ${c.gray('◌ ' + truncate(String(evt.text).replace(/\s+/g, ' '), 90))}`);
  }

  renderResult(res) {
    const text = String(res.text || '').trim();
    if (text) this.out(indent(text));
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
    if (bits.length) this.line(c.gray('\n  ' + bits.join('  ·  ')));
  }

  start() {
    this.tty = !!process.stdin.isTTY;
    this.out(this.banner());
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: this.tty, prompt: this.prompt() });
    if (this.tty) this.bindCtrlC();
    this.sayPrompt();
    this.rl.on('line', (line) => this.feed(line));
    this.rl.on('close', () => {
      this.closed = true;
      this.shutdown();
    });
  }

  sayPrompt() {
    if (this.closed) return;
    try {
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

  startSpinner(text) {
    if (!process.stdout.isTTY || this.closed) return;
    this.spinnerText = text;
    this.frame = 0;
    this.rl.setPrompt('');
    process.stdout.write('\x1b[s');
    this.spinnerTimer = setInterval(() => {
      this.frame += 1;
      process.stdout.write('\x1b[u\x1b[K' + spinnerFrame(this.spinnerText, this.frame));
    }, 110);
  }

  stopSpinner() {
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
    process.stdout.write('\x1b[u\x1b[K\x1b[u');
    this.rl.setPrompt(this.prompt());
  }

  exit() {
    this.stopSpinner();
    try {
      const s = this.app.sync();
      this.line(c.gray(`\n  session ${this.app.session.header.sid.slice(0, 8)} saved · progress → ${s.file}`));
    } catch {
      this.line('\n  saved');
    }
    process.exit(0);
  }
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
