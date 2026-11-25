#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { loadConfig, writeConfig, HOME } = require('../lib/config');
const { Registry } = require('../lib/registry');
const store = require('../lib/store');
const { App } = require('../lib/app');
const { Tui } = require('../lib/tui');
const { Agent, listAgents, findAgent } = require('../lib/agent');
const { c, table, truncate, heading } = require('../lib/ui');
const log = require('../lib/log');

const VERSION = '0.1.0';

function parseArgs(argv) {
  const out = { _: [], cwd: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-c' || a === '--continue') out.continue = true;
    else if (a === '--new') out.newSession = true;
    else if (a === '--all') out.all = true;
    else if (a === '--pty') out.pty = true;
    else if (a === '--cwd' || a === '-C') out.cwd = path.resolve(argv[++i] || '.');
    else if (a === '-r' || a === '--resume') out.resume = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
    else if (a === '-n' || a === '--name') out.name = argv[++i];
    else if (a === '-p' || a === '--print') out.print = argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('-') ? argv[++i] : '';
    else if (a === '--permission-mode') out.permissionMode = argv[++i];
    else if (a === '--yolo' || a === '--dangerously-skip-permissions') out.skipPermissions = true;
    else if (a === '--timeout') out.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === '-v' || a === '--version') return { ...out, version: true };
    else if (a === '-h' || a === '--help') return { ...out, help: true };
    else if (a === '--cli' || a === '-b') out.backend = argv[++i];
    else if (a === '--model' || a === '-m') out.model = argv[++i];
    else if (a === '--detach' || a === '-d') out.detach = true;
    else if (a === '--attach') out.attach = true;
    else if (a === '--stop') out.stop = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--offline') out.offline = true;
    else if (a === '--planner') out.planner = argv[++i];
    else if (a === '--use') out.use = String(argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--parallel' || a === '-j') out.parallel = Number(argv[++i]);
    else if (a === '--file' || a === '-f') out.file = argv[++i];
    else if (a === '--auto') out.auto = true;
    else if (a === '--force') out.force = true;
    else if (a === '--no-export') out.noExport = true;
    else if (a === '--as') out.as = argv[++i];
    else if (a.startsWith('-') && a.length > 1) throw new Error(`unknown flag: ${a}`);
    else out._.push(a);
  }
  return out;
}

const HELP_SECTIONS = [
  [
    'start here',
    [
      ['relay', 'interactive shell, continuing your last session here'],
      ['relay -c', 'continue the most recent session in this directory'],
      ['relay -r <id|#>', 'resume a saved session, from any directory'],
      ['relay --new', 'start a fresh session'],
      ['relay -p "prompt"', 'one shot: print the answer and exit'],
      ['relay --cwd <dir>', 'run as if started in <dir>'],
      ['relay -n <name>', 'name the session'],
      ['relay --yolo', 'let CLIs act without permission prompts'],
    ],
  ],
  [
    'routing & credits',
    [
      ['relay scan [--auto]', 'scan for AI CLIs and connect them'],
      ['relay credits', 'credit pool, quota health and usage stats'],
      ['relay strategy [name]', 'priority, pool (round-robin), free-first'],
      ['relay backends', 'priority order and credit state'],
      ['relay connect <command>', 'probe a CLI and print what relay detected'],
      ['relay init', `write a starter ${HOME}/config.json`],
    ],
  ],
  [
    'sessions & agents',
    [
      ['relay sessions [--all]', 'saved sessions'],
      ['relay native [cli] [--all]', 'history other CLIs kept'],
      ['relay import <id>', 'bring one of those sessions into relay'],
      ['relay agents', 'list every agent assignment'],
      ['relay agent <name> ...', 'run a turn on an agent (--cli, --model, --cwd, --detach)'],
      ['relay agent <name> --attach', 'interactive TUI pinned to that agent'],
      ['relay agent <name> --stop', 'drop an agent assignment'],
      ['relay switch <name>', 'open an agent in the TUI'],
      ['relay sync', 'refresh the AGENTS.md progress block'],
    ],
  ],
  [
    'tags & skills',
    [
      ['relay @cli[:model] "prompt"', 'ask one CLI or model (also @opus, @haiku)'],
      ['relay @cli /command [args]', 'any slash command of that CLI, sent as typed'],
      ['relay @cli <subcommand…>', 'its own subcommands, e.g. relay @claude mcp list'],
      ['relay @cli [open /command]', 'its own interactive UI, resuming this conversation'],
      ['relay skill import <path>', 'convert a skill (folder, .md, .toml, .mdc) for every CLI'],
      ['relay skill list|show|export|remove', 'manage imported skills'],
      ['relay skill run <name> "request"', 'run one (--cli, --model to choose)'],
    ],
  ],
  [
    'automation',
    [
      ['relay auto "instructions"', 'split into tasks, assign an agent + CLI + model, run them'],
      ['  --dry-run', 'show the plan only'],
      ['  --file <path>', 'read instructions from a file'],
      ['  --planner <cli[:model]>', 'choose the planner'],
      ['  --offline', 'split locally, no planner call'],
      ['  --use <cli,cli>', 'limit which CLIs may be used'],
      ['  --parallel <n>', 'run read-only tasks at once (default 3)'],
    ],
  ],
  [
    'tools',
    [
      ['relay desktop', 'launch the companion desktop app'],
      ['relay serve [--port 4242]', 'run the local API server daemon'],
      ['relay commands [cli]', 'every command relay has seen'],
      ['relay logs [n]', 'recent errors and failovers'],
    ],
  ],
];

function helpText() {
  const out = ['', `${c.bold(c.text('relay'))} ${c.gray(VERSION)}  ${c.gray('one session across every coding CLI')}`, ''];
  for (const [title, items] of HELP_SECTIONS) {
    const w = Math.max(...items.map(([k]) => k.length));
    out.push(heading(title));
    for (const [k, d] of items) out.push(`  ${c.bold(c.text(k.padEnd(w)))}  ${c.gray(d)}`);
    out.push('');
  }
  out.push(c.gray('  Inside relay, /help lists everything — routing, sessions, agents and tools.'));
  out.push(c.gray('  When a CLI runs out of credits mid-task, relay replays the turn on the next one in'));
  out.push(c.gray('  your priority order and imports the transcript. Progress lands in AGENTS.md, so any'));
  out.push(c.gray('  CLI started by hand can pick the work up.'));
  out.push('');
  return out.join('\n');
}

const HELP = helpText();

async function main() {
  const argv = process.argv.slice(2);
  // everything after `@cli` belongs to that CLI, so relay must not parse its flags
  const at = tagIndex(argv);
  let flags;
  try {
    flags = parseArgs(at < 0 ? argv : argv.slice(0, at));
  } catch (err) {
    process.stderr.write(c.red('relay: ') + err.message + '\n' + c.gray('  relay --help\n'));
    process.exit(2);
  }

  if (flags.version) return console.log(VERSION);
  if (flags.help) return process.stdout.write(HELP);

  const config = loadConfig();
  try {
    fs.mkdirSync(config.home, { recursive: true });
  } catch {
    /* tolerate restricted sandbox */
  }
  const registry = new Registry(config.home, config);
  const sub = flags._[0];

  if (at >= 0) return runTagCommand(config, registry, flags, argv[at], argv.slice(at + 1));

  if (sub === 'skill' || sub === 'skills') {
    const { skillCommand } = require('../lib/skillview');
    const { reservedNames } = require('../lib/tui');
    if (flags._[1] === 'run') {
      const skills = require('../lib/skills');
      const skill = skills.load(config.home, flags._[2]);
      if (!skill) {
        process.stderr.write(c.red(`relay: no skill called "${flags._[2] || ''}" — relay skill list\n`));
        process.exit(1);
      }
      const request = flags._.slice(3).join(' ');
      const app = openApp(config, registry, flags);
      const opts = { skipPipeline: true, display: `/${skill.name} ${request}`.trim() };
      if (flags.backend) {
        const { routeTo } = require('../lib/tags');
        Object.assign(opts, routeTo(app, { backend: flags.backend, model: flags.model }));
      }
      return printTurn(app, await app.turn(skills.expand(skill, request), {}, opts));
    }
    try {
      const ok = skillCommand(config, flags._.slice(1), flags, (s) => console.log(s), reservedNames());
      if (!ok) process.exitCode = 1;
    } catch (err) {
      process.stderr.write(c.red('relay: ') + err.message + '\n');
      process.exit(1);
    }
    return;
  }

  if (sub === 'init') return console.log(c.green('✓ wrote ') + writeConfig() + '\n' + c.gray('edit order/backends, or just run: relay (then /connect)'));

  if (sub === 'backends') {
    if (!registry.all.length) return console.log(c.yellow('no CLIs connected — run: relay connect <command>'));
    const rows = registry.all.map((n, i) => {
      const def = registry.backend(n);
      const ex = registry.exhausted[n];
      const state = ex?.hard ? c.red('out of credits') : ex?.until > Date.now() ? c.yellow('cooldown') : c.green('ready');
      return [i === 0 ? c.bold('▸ ' + n) : '  ' + n, def.command, def.dialect || 'claude', state, truncate(ex?.reason || '', 40)];
    });
    console.log('\n' + table(rows, ['order', 'command', 'dialect', 'state', 'note']) + '\n');
    console.log(c.gray(`  config: ${path.join(config.home, 'config.json')} · state: ${path.join(config.home, 'state.json')}\n`));
    return;
  }

  if (sub === 'credits') {
    const statuses = registry.creditStatus();
    if (!statuses.length) return console.log(c.yellow('no backends connected — run: relay scan or relay connect <command>'));
    const rows = statuses.map((s, i) => {
      const stateColor = s.state === 'ready' ? c.green('● ready') : s.state === 'cooldown' ? c.yellow(`⏳ cooldown (${s.cooldownText})`) : c.red('⛔ out of credits');
      const tier = s.freeTier ? c.green('FREE') : c.magenta('PAID');
      return [i === 0 ? c.bold('▸ ' + s.name) : '  ' + s.name, s.label, tier, stateColor, String(s.turns), s.successRate, truncate(s.reason || '', 35)];
    });
    console.log(`\n  ${c.bold('Credit Pool & Quota Health')} ${c.gray(`(Strategy: ${c.bold(c.cyan(registry.getStrategy()))})`)}\n`);
    console.log(table(rows, ['cli', 'provider', 'tier', 'quota state', 'turns', 'success', 'last signal']) + '\n');
    console.log(c.gray('  relay strategy pool balances turns · relay strategy free-first burns free quotas first\n'));
    return;
  }

  if (sub === 'strategy') {
    const target = flags._[1];
    if (!target) {
      console.log(`\nCurrent strategy: ${c.bold(c.cyan(registry.getStrategy()))}\n`);
      console.log(`  ${c.bold('priority')}   - strictly asks top CLI first, falls over if out of credits`);
      console.log(`  ${c.bold('pool')}       - round-robin across ready CLIs to balance rate limits`);
      console.log(`  ${c.bold('free-first')} - burns free quotas (agy, freebuff, kilo, etc.) before paid credits`);
      console.log(c.gray('\nChange strategy: relay strategy pool · relay strategy free-first · relay strategy priority\n'));
      return;
    }
    try {
      const s = registry.setStrategy(target.toLowerCase());
      console.log(c.green(`✓ Routing strategy set to: ${c.bold(s)}\n`));
    } catch (err) {
      console.error(c.red(`error: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  if (sub === 'scan') {
    const { scanInstalledCLIs, autoConnectAll } = require('../lib/scanner');
    const auto = flags.auto || flags._.includes('--auto') || flags._.includes('auto');
    const scanned = scanInstalledCLIs(flags.cwd);
    const rows = scanned.map((c0) => [
      c0.installed ? c.green('✓ ' + c0.name) : c.gray('  ' + c0.name),
      c0.label,
      c0.freeTier ? c.green('free') : c.magenta('paid'),
      c0.installed ? c.cyan(c0.path) : c.gray('not found on PATH'),
      c0.installed ? (registry.all.includes(c0.name) ? c.green('connected') : c.yellow('available')) : c.gray('-'),
    ]);
    console.log('\n' + table(rows, ['cli', 'provider', 'tier', 'binary path', 'status']) + '\n');
    if (auto) {
      const result = autoConnectAll(config, registry, { note: (msg) => console.log(msg) });
      console.log(c.green(`\n✓ Auto-connected ${result.added.length} newly found CLI(s): ${result.added.join(', ') || 'none'}\n`));
    } else {
      const unadded = scanned.filter((c0) => c0.installed && !registry.all.includes(c0.name));
      if (unadded.length) {
        console.log(c.yellow(`  ${unadded.length} installed CLI(s) not yet connected. Run: relay scan --auto to add them all!\n`));
      } else {
        console.log(c.gray('  all detected CLIs are connected.\n'));
      }
    }
    return;
  }

  if (sub === 'serve') {
    const { createServerInstance } = require('../lib/server');
    const port = Number(flags.port || flags._[1]) || 4242;
    const instance = createServerInstance({ cwd: flags.cwd, home: config.home });
    const info = await instance.listen(port);
    console.log(c.bold(c.cyan('◆ Relay Server')) + ` listening at ${c.underline(info.url)}`);
    console.log(c.gray('  Press Ctrl+C to stop.\n'));
    return;
  }

  if (sub === 'desktop') {
    const { launchDesktop } = require('../desktop/launcher');
    const port = Number(flags.port || flags._[1]) || 4242;
    await launchDesktop({ port, cwd: flags.cwd });
    return;
  }

  if (sub === 'commands') {
    const map = registry.allCommands();
    const names = Object.keys(map).filter((b) => !flags._[1] || b === flags._[1]);
    if (!names.length) return console.log(c.gray('nothing seen yet — relay records each CLI\'s commands the first time it runs a turn.'));
    for (const b of names) {
      console.log(`\n${c.bold(b)} (${map[b].cmds.length})`);
      console.log('  ' + map[b].cmds.map((x) => '/' + x).join('  '));
    }
    console.log('');
    return;
  }

  if (sub === 'sessions') {
    const list = flags.all ? store.allSessions(config.home) : store.listSessions(config.home, flags.cwd);
    if (!list.length) return console.log(c.gray(`no sessions saved${flags.all ? '' : ' for this directory'} — try: relay sessions --all`));
    console.log(
      '\n' +
        table(
          list.map((s, i) => [c.bold(String(i + 1)), s.sid.slice(0, 8), new Date(s.updated).toLocaleString(), String(s.messages), truncate(s.cwd || '', 30), truncate(s.name || '', 16)]),
          ['#', 'id', 'updated', 'turns', 'directory', 'name'],
        ) + '\n',
    );
    console.log(c.gray('  relay -r <id|number> resumes one\n'));
    return;
  }

  if (sub === 'logs') {
    const lines = log.tail(Number(flags._[1]) || 40);
    if (!lines.length) return console.log(c.gray(`nothing logged yet — ${log.file()}`));
    for (const l of lines) console.log(l.replace(/ error /, c.red(' error ')).replace(/ warn  /, c.yellow(' warn  ')));
    return console.log(c.gray(`\n  ${log.file()}`));
  }

  if (sub === 'native') {
    const native = require('../lib/native');
    const cli = native.CLIS.includes(flags._[1]) ? flags._[1] : null;
    const list = native.list(config.home, { cwd: flags.all ? null : flags.cwd, cli });
    if (!list.length) return console.log(c.gray(`no ${cli || 'claude/qwen/junie'} history${flags.all ? '' : ' for this directory — try: relay native --all'}`));
    console.log('\n' + table(list.slice(0, 60).map((s, i) => [c.bold(String(i + 1)), s.cli, native.shortId(s), new Date(s.updated).toLocaleString(), String(s.turns), truncate(s.cwd || '?', 28), truncate(s.title, 36)]), ['#', 'cli', 'id', 'updated', 'turns', 'directory', 'first prompt']) + '\n');
    return console.log(c.gray('  relay import <id> brings one into relay\n'));
  }

  if (sub === 'import') {
    const native = require('../lib/native');
    const ref = flags._[1];
    if (!ref) return console.log(c.red('usage: relay import <id|cli:id>') + c.gray('  (see: relay native --all)'));
    const item = native.find(native.list(config.home, {}), ref);
    if (item?.ambiguous) return console.log(c.yellow(`"${ref}" matches: `) + item.ambiguous.map((i) => i.cli + ':' + native.shortId(i)).join(', '));
    if (!item) return console.log(c.red(`no CLI history matching "${ref}" — relay native --all`));
    const got = native.importSession(config.home, item, flags.cwd);
    return console.log(c.green(`✓ ${got.reused ? 'already imported' : 'imported'} ${item.cli} ${native.shortId(item)}`) + c.gray(` → relay session ${got.session.header.sid.slice(0, 8)} (${got.entries} entries)\n  continue it: relay -r ${got.session.header.sid.slice(0, 8)}`));
  }

  if (sub === 'sync') {
    const header = store.latestSession(config.home, flags.cwd) || store.findSession(config.home, flags._[1]);
    if (!header) return console.log(c.yellow('no session to sync from here — try: relay sync <session-id>'));
    const session = store.openSession(header.file);
    const r = store.syncAgents(session, flags.cwd, session.header.lastBackend || registry.pick());
    return console.log(c.green('✓ ') + r.file);
  }

  if (sub === 'agents' || sub === 'agent') {
    const name = flags._[1];
    if (!name || sub === 'agents') {
      const list = listAgents(config.home);
      if (!list.length) return console.log(c.gray('no agent assignments yet — run: relay agent <name> --cli claude --model sonnet --cwd <dir> "prompt"\n'));
      console.log('\n' + table(
        list.map((a) => [c.bold(a.name), a.backend, a.model || '—', truncate(a.cwd, 30), a.sessionId ? a.sessionId.slice(0, 8) : '—']),
        ['name', 'cli', 'model', 'directory', 'session'],
      ) + '\n');
      console.log(c.gray('  relay agent <name> --cli <cli> --model <model> --cwd <dir> "<prompt>"   run one turn on an agent'));
      console.log(c.gray('  relay agent <name> --stop   ·   relay agent <name> --attach   ·   relay switch <name>\n'));
      return;
    }
    const found = findAgent(config.home, name);
    if (flags.stop) {
      if (!found) return console.log(c.red(`no agent named "${name}" — relay agents`));
      const agent = new Agent({ ...found, config, home: config.home });
      agent.remove();
      return console.log(c.green(`✓ dropped agent "${name}"\n`));
    }
    if (flags.attach) {
      if (!found) return console.log(c.red(`no agent named "${name}" — relay agents`));
      let session = null;
      if (found.sessionId) {
        const fsess = store.findSession(config.home, found.sessionId);
        if (fsess && !fsess.ambiguous) session = store.openSession(fsess.file);
      }
      if (!session) session = store.createSession(config.home, found.cwd, found.name);
      session.header.lastBackend = found.backend;
      session.header.name = found.name;
      store.rewriteHeader(session);
      const agentConfig = { ...config, backends: { ...config.backends, [found.backend]: { ...config.backends[found.backend], model: found.model || config.backends[found.backend].model } } };
      const app = new App({ config: agentConfig, registry: new Registry(config.home, agentConfig), session, cwd: found.cwd, ui: {}, opts: { permissionMode: flags.permissionMode, skipPermissions: flags.skipPermissions, timeoutMs: flags.timeoutMs } });
      const tui = new Tui(app, config);
      app.ui = tui;
      return tui.start();
    }
    if (!flags.print && !flags.detach) {
      const positional = flags._.slice(2).join(' ').trim();
      if (!positional) return console.log(c.red(`usage: relay agent <name> --cli <cli> --model <model> --cwd <dir> "<prompt>"`) + c.gray('\n  or: relay agent <name> --attach  ·  relay agent <name> --stop\n'));
    }
    const base = found || { name, backend: flags.backend, model: flags.model, cwd: flags.cwd ? path.resolve(flags.cwd) : null, sessionId: null };
    const agent = new Agent({ ...base, config, home: config.home, registry: new Registry(config.home, config) });
    if (flags.backend) agent.backend = flags.backend;
    if (flags.model) agent.model = flags.model;
    if (flags.cwd) agent.cwd = path.resolve(flags.cwd);
    if (!agent.backend || !agent.cwd) return console.log(c.red(`agent "${name}" is missing a cli or directory — re-run with --cli and --cwd`));
    const prompt = flags.print !== undefined ? flags.print : (flags._.slice(2).join(' ') || await readStdin());
    if (!prompt) return console.log(c.red('nothing to do: pass a prompt or use -p "text"'));
    agent.save();
    if (flags.detach) {
      const { pid, log: lf } = await agent.spawnDetached(prompt);
      return console.log(c.green(`✓ agent "${name}" running detached (pid ${pid}) — log: ${lf}\n`));
    }
    const out = await agent.turn(prompt);
    if (out.ok) {
      process.stdout.write((out.res.text || '') + '\n');
      agent.save();
      process.exit(0);
    }
    process.stderr.write(c.red(`relay agent ${name}: ${out.res?.kind || out.reason}`) + (out.res?.raw ? `: ${out.res.raw.split('\n').slice(-2).join(' ').slice(0, 300)}` : '') + '\n');
    process.exit(1);
  }

  if (sub === 'switch') {
    const name = flags._[1];
    if (!name) return console.log(c.red('usage: relay switch <name>') + c.gray('\n  see: relay agents\n'));
    const found = findAgent(config.home, name);
    if (!found) return console.log(c.red(`no agent named "${name}" — relay agents`));
    let session = null;
    if (found.sessionId) {
      const fsess = store.findSession(config.home, found.sessionId);
      if (fsess && !fsess.ambiguous) session = store.openSession(fsess.file);
    }
    if (!session) session = store.createSession(config.home, found.cwd, found.name);
    session.header.lastBackend = found.backend;
    session.header.name = found.name;
    store.rewriteHeader(session);
    const agentConfig = { ...config, backends: { ...config.backends, [found.backend]: { ...config.backends[found.backend], model: found.model || config.backends[found.backend].model } } };
    const app = new App({ config: agentConfig, registry: new Registry(config.home, agentConfig), session, cwd: found.cwd, ui: {}, opts: { permissionMode: flags.permissionMode, skipPermissions: flags.skipPermissions, timeoutMs: flags.timeoutMs } });
    const tui = new Tui(app, config);
    app.ui = tui;
    return tui.start();
  }

  if (sub === 'connect') {
    const command = flags._[1];
    if (!command) return console.log(c.red('usage: relay connect <command>') + c.gray('\n  or inside relay: /connect for the guided version'));
    const { Probe } = require('../lib/probe');
    const { findWorkingDialect, summaryRows } = require('../lib/connect');
    const probe = new Probe(flags.cwd);
    const help = probe.helpText(command, flags.cwd);
    console.log(c.gray(`\nprobing ${command} — one small request per protocol it might speak\n`));
    const { def, res } = await findWorkingDialect(command, help, flags.cwd, (m) => console.log(m), undefined, { confirmPty: async () => { if (!flags.pty) console.log(c.yellow('  not trying it: this sends the app a real message through a pseudo-terminal, and some apps forbid scripted use.\n  Read its terms, then re-run with --pty to allow it.')); return Boolean(flags.pty); } });
    console.log('\n' + summaryRows(def, res, res.ok && /RELAY_OK/.test(res.text)));
    console.log(
      res.ok
        ? c.green('\n✓ works — add it to the rotation with: relay') + c.gray(' then /connect\n')
        : c.yellow(`\nprobe ${res.kind}${res.raw ? ': ' + truncate(res.raw.replace(/\x1b(?:\[[0-9;?<>$ ]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, '').split('\n').slice(-2).join(' '), 200) : ''}\n`),
    );
    return;
  }

  if (sub === 'auto') {
    let instructions = flags.print || flags._.slice(1).join(' ');
    if (flags.file) instructions = [fs.readFileSync(path.resolve(flags.cwd, flags.file), 'utf8'), instructions].filter(Boolean).join('\n\n');
    if (!instructions) instructions = await readStdin();
    if (!instructions.trim()) {
      process.stderr.write(c.red('usage: relay auto "instructions"') + c.gray('  (or --file tasks.md, or pipe them in)\n'));
      process.exit(2);
    }
    const latest = flags.newSession ? null : store.latestSession(config.home, flags.cwd);
    const main = latest ? store.openSession(latest.file) : store.createSession(config.home, flags.cwd, flags.name);
    const app = new App({ config, registry, session: main, cwd: flags.cwd, ui: {}, opts: { permissionMode: flags.permissionMode, skipPermissions: flags.skipPermissions, timeoutMs: flags.timeoutMs } });
    const { createControl } = require('../lib/auto');
    const { runAuto } = require('../lib/autoview');
    const control = createControl();
    process.on('SIGINT', () => {
      if (control.aborted) process.exit(130);
      control.abort();
    });
    // progress goes to stderr so stdout carries only the results
    const out = await runAuto(app, instructions, {
      control,
      dryRun: flags.dryRun,
      offline: flags.offline,
      planner: flags.planner,
      only: flags.use,
      parallel: flags.parallel,
      log: (s) => process.stderr.write(s + '\n'),
      out: (s) => process.stdout.write(s + '\n'),
    });
    process.exit(out.aborted ? 130 : out.ok ? 0 : 1);
  }

  let session;
  if (flags.resume && flags.resume !== true) {
    const found = store.findSession(config.home, flags.resume);
    if (found?.ambiguous) {
      console.log(c.yellow(`"${flags.resume}" matches ${found.ambiguous.length} sessions:`));
      return console.log(table(found.ambiguous.map((s) => [s.sid.slice(0, 12), new Date(s.updated).toLocaleString(), truncate(s.cwd, 30)]), ['id', 'updated', 'directory']));
    }
    if (!found) throw new Error(`no session matching "${flags.resume}" — relay sessions --all`);
    session = store.openSession(found.file);
  } else if (flags.newSession) {
    session = store.createSession(config.home, flags.cwd, flags.name);
  } else {
    const latest = store.latestSession(config.home, flags.cwd);
    session = latest ? store.openSession(latest.file) : store.createSession(config.home, flags.cwd, flags.name);
  }
  if (flags.name && flags.name !== session.header.name) {
    session.header.name = flags.name;
    store.rewriteHeader(session);
  }

  const app = new App({ config, registry, session, cwd: flags.cwd, ui: {}, opts: { permissionMode: flags.permissionMode, skipPermissions: flags.skipPermissions, timeoutMs: flags.timeoutMs } });

  if (flags.print !== undefined) {
    const prompt = flags.print || (await readStdin());
    if (!prompt) throw new Error('nothing to do: pass a prompt, use -p "text", or pipe one on stdin');
    const out = await app.turn(prompt);
    if (out.ok) {
      process.stdout.write((out.res.text || '') + '\n');
      app.sync();
      process.exit(0);
    }
    process.stderr.write(c.red(`relay: ${out.res?.kind || out.reason}`) + (out.res?.raw ? `: ${out.res.raw.split('\n').slice(-2).join(' ').slice(0, 300)}` : '') + '\n');
    process.exit(1);
  }

  const tui = new Tui(app, config);
  app.ui = tui;
  tui.start();
}

// position of `@cli` when it is the first thing that isn't one of relay's own flags
function tagIndex(argv) {
  const withValue = new Set(['--cwd', '-C', '--permission-mode', '--timeout']);
  const bare = new Set(['--yolo', '--dangerously-skip-permissions', '--new']);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('@') && argv[i].length > 1) return i;
    if (withValue.has(argv[i])) i += 1;
    else if (!bare.has(argv[i])) return -1;
  }
  return -1;
}

function openApp(config, registry, flags) {
  const latest = flags.newSession ? null : store.latestSession(config.home, flags.cwd);
  const session = latest ? store.openSession(latest.file) : store.createSession(config.home, flags.cwd, flags.name);
  return new App({ config, registry, session, cwd: flags.cwd, ui: {}, opts: { permissionMode: flags.permissionMode, skipPermissions: flags.skipPermissions, timeoutMs: flags.timeoutMs } });
}

function printTurn(app, out) {
  if (out.ok) {
    process.stdout.write((out.res.text || '') + '\n');
    app.sync();
    process.exit(0);
  }
  process.stderr.write(c.red(`relay: ${out.res?.kind || out.reason}`) + (out.res?.raw ? `: ${out.res.raw.split('\n').slice(-2).join(' ').slice(0, 300)}` : '') + '\n');
  process.exit(1);
}

// `relay @cli …`
async function runTagCommand(config, registry, flags, tag, rest) {
  const tags = require('../lib/tags');
  const { runTagged } = require('../lib/tagview');
  // terminal subcommands need no relay session, so don't create one for them
  const probe = { config, registry };
  const target = tags.resolveTag(probe, tag);
  if (!target) {
    process.stderr.write(c.red(`relay: ${tag} is not a connected or installed CLI, or a model relay knows`) + c.gray('\n  relay backends\n'));
    process.exit(2);
  }
  const action = tags.actionForArgv(rest);
  if (action.kind === 'exec') process.exit(tags.runExec({ ...probe, cwd: flags.cwd }, target.backend, action.args));
  const app = openApp(config, registry, flags);
  const ok = await runTagged(app, target, action, {
    log: (s) => process.stderr.write(s + '\n'),
    submit: async (text, opts) => {
      const out = await app.turn(text, {}, opts);
      if (out.ok) process.stdout.write((out.res.text || '') + '\n');
      else process.stderr.write(c.red(`relay: ${out.res?.kind || out.reason}\n`));
      return out.ok;
    },
    slash: async (backend, command, model) => {
      const res = await tags.runSlash(app, backend, command, { model });
      if (res.ok) process.stdout.write((res.text || '') + '\n');
      return res;
    },
  });
  process.exitCode = ok ? 0 : 1;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', err);
  process.stderr.write(c.red('relay: ') + (err?.message || String(err)) + c.gray(`\n  details: ${log.file()}\n`));
  process.exit(1);
});

main().catch((err) => {
  log.error('fatal', err);
  process.stderr.write(c.red('relay: ') + (err?.message || String(err)) + '\n');
  process.exit(1);
});
