const readline = require('readline');
const os = require('os');
const { c, truncate, spinnerFrame, indent, strip, resetTerminal, gradient, logoLines, dot, LOGO, TIPS, fields, heading, visibleWidth } = require('./ui');
const { version: VERSION } = require('../package.json');
const { wizard } = require('./connect');
const store = require('./store');
const { listAgents } = require('./agent');
const fs = require('fs');
const path = require('path');
const log = require('./log');
const tags = require('./tags');
const skills = require('./skills');
const { runTagged } = require('./tagview');
const { parseMultiStepPrompt } = require('./multistep');

const HELP = [
  ['<prompt>', 'send to the current CLI; relay picks which one', 'conversation'],
  ['/help', 'this list', 'conversation'],
  ['/status', 'session, routing, credits and AGENTS.md', 'conversation'],
  ['/retry', 're-send the last prompt', 'conversation'],
  ['/history [n]', 'last n turns of this session (default 6)', 'conversation'],
  ['/export [file]', 'save this session as a markdown transcript', 'conversation'],
  ['/note <text>', 'pin a durable note into every backend prompt', 'conversation'],
  ['/sync', 'write the progress block into AGENTS.md', 'conversation'],
  ['/clear', 'start a fresh session here', 'conversation'],
  ['/quit', 'exit (or Ctrl-D; Ctrl-C twice)', 'conversation'],

  ['/credits', 'credit pool health, rate limit countdowns and stats', 'routing'],
  ['/strategy [name]', 'routing: priority, pool (round-robin), free-first', 'routing'],
  ['/priority [a b c]', 'show or set the CLI failover order', 'routing'],
  ['/priority move <cli> <n>', 'move one CLI to position n', 'routing'],
  ['/use <cli>', 'pin a CLI for the following turns', 'routing'],
  ['/backends', 'every connected CLI and its state', 'routing'],
  ['/connect [command]', 'guided wizard: add any CLI to the rotation', 'routing'],
  ['/scan [--auto]', 'detect installed AI CLIs and connect them', 'routing'],
  ['/forget [cli]', 'clear credit / cooldown marks', 'routing'],

  ['/auto [--dry-run] <text>', 'split into tasks and assign each an agent, CLI and model', 'sessions'],
  ['/agents', 'agent assignments: name, cli, model, directory', 'sessions'],
  ['/switch <name>', 'switch the TUI to an agent assignment', 'sessions'],
  ['/sessions [--all]', 'saved sessions, here or everywhere', 'sessions'],
  ['/resume [id|#]', 'continue a saved session from any directory', 'sessions'],
  ['/ref <id|#|name>', 'keep a past session in context', 'sessions'],
  ['/refs', 'show referenced sessions', 'sessions'],
  ['/unref <id>', 'stop referencing one', 'sessions'],
  ['/native [cli] [--all]', 'history other CLIs kept (claude, qwen, junie)', 'sessions'],
  ['/import <#|id> [--resume]', 'bring a CLI\'s own session into relay (and /ref it)', 'sessions'],

  ['/commands [cli] [text]', 'commands relay has seen, grouped; filter by text', 'tools'],
  ['/run <cli> /cmd [args]', 'run a CLI-native command verbatim', 'tools'],
  ['@cli[:model] <prompt>', 'ask one CLI or model, without switching (also @opus)', 'tools'],
  ['@cli /command [args]', 'any slash command of that CLI, sent as typed', 'tools'],
  ['@cli !subcommand', "its terminal subcommands, e.g. @claude !mcp list", 'tools'],
  ['@cli [open /command]', 'its own UI, for interactive-only commands', 'tools'],
  ['/skill [import|list|…]', 'convert skills so every CLI can use them', 'tools'],
  ['/<skill> <request>', 'run an imported skill on the current CLI', 'tools'],
  ['/verbose [full|compact]', 'show everything the CLI prints (default) or a short view', 'tools'],
  ['/theme [name]', 'colors: dark (default), light, mono', 'tools'],
  ['/log [n]', 'recent relay errors and failovers', 'tools'],
];

const HELP_GROUPS = {
  conversation: 'Conversation',
  routing: 'Routing & credits',
  sessions: 'Sessions & agents',
  tools: 'Tools & diagnostics',
};

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
    const width = Math.max(46, Math.min(cols - 4, 78));
    const lines = [''];

    if (cols >= 62) lines.push(...logoLines());
    else lines.push(`  ${gradient('◆ relay')}`);

    const tagline = `${c.bold(c.text('One session'))} ${c.gray('·')} ${c.bold(c.text('every coding CLI'))}`;
    const version = c.gray('v' + VERSION);
    const gap = Math.max(2, width - visibleWidth(tagline) - visibleWidth(version));
    lines.push('', `  ${tagline}${' '.repeat(gap)}${version}`);
    lines.push(c.border('  ' + '─'.repeat(width)));

    const reg = this.app.registry;
    let shown = st.order.slice(0, 6);
    if (st.backend && !shown.includes(st.backend)) shown = [...st.order.slice(0, 5), st.backend];
    const rest = st.order.filter((n) => !shown.includes(n)).length;
    const chips = st.order.length
      ? shown
          .map((n) => {
            const ex = reg.exhausted[n];
            const state = ex?.hard ? 'out' : ex?.until > Date.now() ? 'cooldown' : 'ready';
            const active = n === st.backend;
            const tag = reg.backend(n)?.dialect === 'pty' ? c.gray(' pty') : '';
            return `${dot(state)} ${active ? c.bold(c.cyan(n)) : c.text(n)}${tag}`;
          })
          .join(c.gray('  ›  ')) + (rest ? c.gray(`  +${rest}`) : '')
      : c.yellow('none') + c.gray('  ·  /connect or /scan --auto');

    const home = os.homedir();
    const dir = this.app.cwd.startsWith(home) ? '~' + this.app.cwd.slice(home.length) : this.app.cwd;
    const tip = TIPS[(Date.now() / 60000 | 0) % TIPS.length];
    lines.push(
      fields([
        ['backends', chips],
        ['session', `${c.text(st.session.slice(0, 8))} ${c.gray('·')} ${c.text(String(st.entries))} ${c.gray('turns')}`],
        ['folder', c.gray(truncate(dir, Math.max(16, width - 12)))],
        ['tip', c.gray(tip)],
      ]),
    );
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
    const head = c.bold(c.text('relay'));
    const where = name ? c.gray(' · ') + c.bold(c.cyan(name)) : '';
    return head + where + c.bold(c.accent(' ❯ ')) + brightOn();
  }

  complete(line) {
    const names = this.app.registry.all;
    const cmds = HELP.map((h) => h[0].split(/\s/)[0]).filter((x) => x.startsWith('/'));
    const parts = line.split(/\s+/);
    const skillNames = skills.list(this.config.home).map((s) => s.name);
    if (line.startsWith('@')) {
      const word = parts[parts.length - 1];
      if (parts.length === 1) return [names.map((n) => '@' + n).filter((n) => n.startsWith(word)), word];
      const target = parts.length === 2 && tags.resolveTag(this.app, parts[0]);
      if (!target || !word.startsWith('/')) return [[], word];
      const known = new Set([...this.app.registry.commands(target.backend), ...skillNames]);
      return [[...known].map((n) => '/' + n).filter((n) => n.startsWith(word)), word];
    }
    cmds.push(...skillNames.map((n) => '/' + n));
    if (parts.length <= 1) {
      const hits = cmds.filter((x) => x.startsWith(line));
      return [hits.length ? hits : line.startsWith('/') ? cmds : [], line];
    }
    const last = parts[parts.length - 1];
    if (/^\/(use|forget|run|commands|priority)$/.test(parts[0])) return [names.filter((n) => n.startsWith(last)), last];
    if (/^\/(strategy)$/.test(parts[0])) return [['priority', 'pool', 'free-first'].filter((s) => s.startsWith(last)), last];
    if (/^\/(switch)$/.test(parts[0])) {
      const agents = listAgents(this.config.home).map((a) => a.name);
      return [agents.filter((n) => n.startsWith(last)), last];
    }
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
    this.line(`  ${c.gray(hop === 0 ? '↳' : '⇢')} ${c.bold(backend)} ${c.gray('· ' + how)}`);
  }

  onFailover({ from, reason, detail, next }) {
    if (reason === 'aborted') return this.line(c.yellow(`  ⏹  ${from} interrupted`));
    const icon = reason === 'quota' ? c.red('⛔') : c.yellow('⚠');
    const head = `${icon} ${c.bold(from)} ${c.gray('·')} ${reason}${detail ? c.gray(' — ' + truncate(detail, 110)) : ''}`;
    this.line(
      next
        ? `${head}\n     ${c.gray('→ retry on')} ${c.bold(c.cyan(next))}`
        : `${head}\n     ${c.red('no CLI left')} ${c.gray('— /forget, /priority or /connect')}`,
    );
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
          this.out('\n' + c.accent('● ') + c.bold(this.speaker || this.app.backendName || 'reply'));
          this.out(String(evt.text).split('\n').map((l) => `${c.border('│')} ${c.text(l)}`).join('\n'));
        });
        return;
      case 'tool_use': {
        const hint = toolHint(evt.input);
        this.emit(() => {
          this.line(`  ${c.accent('⚙')} ${c.bold(evt.name)}${!full && hint ? ' ' + c.gray(hint) : ''}`);
          if (full && evt.input !== undefined) this.block(typeof evt.input === 'string' ? evt.input : fullInput(evt.input), c.border('│'), c.gray);
        });
        return;
      }
      case 'tool_result':
        this.emit(() => {
          if (!String(evt.text || '').trim()) return this.line(c.gray(`  ${evt.isError ? '✗' : '↳'} (no output)`));
          this.block(evt.text, evt.isError ? c.red('│') : c.border('│'), evt.isError ? c.red : c.gray);
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
    const who = this.speaker || this.app.backendName;
    if (text && !this.streamed) {
      const bar = c.border('│');
      this.out('\n' + c.accent('● ') + c.bold(who || 'reply'));
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
    if (bits.length) this.line(c.border('  ╰ ') + c.gray(bits.join(' · ')) + '\n');
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
    if (line.startsWith('@')) {
      const tag = tags.parseTagLine(this.app, line);
      // "[@a] plan -> [@b] code" and "---" blocks are pipelines, handled by submit
      if (tag && !parseMultiStepPrompt(line, this.app.registry.all).isMultiStep) return this.tagged(tag);
    }
    if (!isCommand(line)) return this.submit(line);
    const invoked = this.skillCall(line);
    if (invoked) return this.submit(invoked.prompt, { skipPipeline: true, display: line });
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

  // `/name args`, or `/skill use name args` when relay has a command of that name
  skillCall(line) {
    const used = line.match(/^\/skill\s+use\s+(\S+)\s*([\s\S]*)$/);
    const direct = used || line.match(/^\/([a-z0-9-]+)\s*([\s\S]*)$/i);
    if (!direct || (!used && reservedNames().includes(direct[1]))) return null;
    const skill = skills.load(this.config.home, direct[1]);
    return skill ? { prompt: skills.expand(skill, direct[2]) } : null;
  }

  async tagged(tag) {
    try {
      await runTagged(this.app, tag, tags.actionFor(tag.rest), {
        log: (s) => this.line(s),
        submit: (text, opts) => this.submit(text, opts, { prompt: false }),
        slash: (backend, command, model) => this.slash(backend, command, model),
      });
    } catch (err) {
      this.line(c.red('  ✗ ') + err.message);
    }
    // a child CLI may have taken the terminal; take input back
    this.resumeInput();
    if (this.tty && !this.closed) this.rl.input.setRawMode?.(true);
    this.sayPrompt();
  }

  async slash(backend, command, model) {
    this.busy = true;
    this.streamed = false;
    this.midLine = false;
    this.speaker = backend;
    this.pauseInput();
    this.startSpinner(`running ${command.split(/\s/)[0]} on ${backend}`);
    try {
      const res = await tags.runSlash(this.app, backend, command, { model, hooks: { onEvent: (e) => this.renderEvent(e) } });
      this.stopSpinner();
      if (res.ok) {
        if (!String(res.text || '').trim() && !this.streamed) this.line(c.gray('  (done — no output)'));
        else this.renderResult(res);
      }
      return res;
    } finally {
      this.stopSpinner();
      this.speaker = null;
      this.busy = false;
    }
  }

  async submit(text, turnOpts = {}, { prompt = true } = {}) {
    this.busy = true;
    this.speaker = turnOpts.route?.[0]?.backend || null;
    this.streamed = false;
    this.midLine = false;
    this.pauseInput();
    this.startSpinner(`waiting for ${this.speaker || this.app.backendName || 'a CLI'}`);
    let ok = false;
    try {
      const hooks = {
        onEvent: (e) => this.renderEvent(e),
        onPipelineStart: ({ totalSteps, steps }) => {
          this.line('\n' + heading(`pipeline · ${totalSteps} stages`));
          steps.forEach((s, i) => {
            const tag = s.model ? `${s.backend}:${s.model}` : s.backend;
            this.line(`  ${c.gray(String(i + 1).padStart(2) + '.')} ${c.bold(s.title)} ${c.gray('→')} ${c.cyan(tag)}`);
          });
          this.line('');
        },
        onStepStart: ({ stepNumber, totalSteps, step, backend, model }) => {
          const target = model ? `${backend}:${model}` : backend;
          this.line('\n' + heading(`stage ${stepNumber}/${totalSteps} · ${target}`));
          this.line(`  ${c.gray(step.title)}`);
          this.setSpinnerText(`stage ${stepNumber}/${totalSteps} on ${target}`);
        },
        onStepEnd: ({ stepNumber, totalSteps, backend, ok }) => {
          if (ok) this.line(c.green(`  ✓ stage ${stepNumber}/${totalSteps} done on ${backend}`));
          else this.line(c.red(`  ✗ stage ${stepNumber}/${totalSteps} failed on ${backend}`));
        },
      };
      const out = await this.app.turn(text, hooks, turnOpts);
      ok = out.ok;
      this.stopSpinner();
      if (out.ok) {
        if (out.isMultiStep) {
          this.line(c.green('\n  ✓ pipeline complete') + c.gray(` · ${out.totalSteps} stages\n`));
        } else if (out.res) {
          this.renderResult(out.res);
        }
      } else if (!out.aborted) {
        this.line(c.red(`\n  no CLI could answer${out.tried?.length ? ` (tried ${out.tried.join(', ')})` : ''}.`));
        if (out.res) this.line(c.gray('  last error: ' + truncate(`${out.res.kind} ${out.res.raw || out.res.error || ''}`, 200)));
        this.line(c.gray('  /backends · /forget · /connect'));
      }
    } catch (err) {
      this.stopSpinner();
      this.line(c.red('  ✗ ') + err.message);
    }
    this.busy = false;
    this.speaker = null;
    this.resumeInput();
    if (prompt) this.sayPrompt();
    return ok;
  }

  setSpinnerText(text) {
    if (this.spinnerTimer) this.spinnerText = text;
  }

  drawSpinner() {
    const secs = Math.floor((Date.now() - this.spinnerStart) / 1000);
    const name = this.speaker || this.app.backendName;
    const who = name ? c.gray(` · ${name}`) : '';
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
    if (/^\s*([-*_]\s*){3,}$/.test(l)) return c.border('─'.repeat(Math.max(8, Math.min(60, l.length))));
    if (/^\s*[-*]\s+/.test(l)) return l.replace(/^(\s*)[-*]\s+/, (_, pad) => `${pad}${c.accent('•')} `);
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

// names a skill can't take over
function reservedNames() {
  return [...HELP.map((h) => h[0].match(/^\/([a-z-]+)/)?.[1]).filter(Boolean), 'exit', 'refs', 'compact'];
}

// "/help" is a command, "/Users/me/file.ts" is a prompt.
function isCommand(line) {
  return /^\/[a-z][a-z0-9_-]*(\s|$)/i.test(line);
}

module.exports = { Tui, HELP, HELP_GROUPS, toolHint, isCommand, reservedNames };
