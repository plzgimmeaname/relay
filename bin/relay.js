#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { loadConfig, writeConfig, HOME } = require('../lib/config');
const { Registry } = require('../lib/registry');
const store = require('../lib/store');
const { App } = require('../lib/app');
const { Tui } = require('../lib/tui');
const { c, table, truncate } = require('../lib/ui');

const VERSION = '0.1.0';

function parseArgs(argv) {
  const out = { _: [], cwd: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-c' || a === '--continue') out.continue = true;
    else if (a === '--new') out.newSession = true;
    else if (a === '--all') out.all = true;
    else if (a === '--cwd' || a === '-C') out.cwd = path.resolve(argv[++i] || '.');
    else if (a === '-r' || a === '--resume') out.resume = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
    else if (a === '-n' || a === '--name') out.name = argv[++i];
    else if (a === '-p' || a === '--print') out.print = argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('-') ? argv[++i] : '';
    else if (a === '--permission-mode') out.permissionMode = argv[++i];
    else if (a === '--yolo' || a === '--dangerously-skip-permissions') out.skipPermissions = true;
    else if (a === '--timeout') out.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === '-v' || a === '--version') return { ...out, version: true };
    else if (a === '-h' || a === '--help') return { ...out, help: true };
    else if (a.startsWith('-') && a.length > 1) throw new Error(`unknown flag: ${a}`);
    else out._.push(a);
  }
  return out;
}

const HELP = `${c.bold('relay')} ${c.gray(VERSION)} — one session across every coding CLI

  ${c.bold('relay')}                     interactive shell, continuing your last session here
  ${c.bold('relay')} -c                  continue the most recent session in this directory
  ${c.bold('relay')} -r <id|#>           resume a saved session, from any directory
  ${c.bold('relay')} --new                start a fresh session
  ${c.bold('relay')} -p "prompt"          one shot: print the answer and exit
  ${c.bold('relay')} --cwd <dir>          run as if started in <dir>
  ${c.bold('relay')} -n <name>            name the session
  ${c.bold('relay')} --yolo               let CLIs act without permission prompts
  ${c.bold('relay')} init                 write a starter ${HOME}/config.json
  ${c.bold('relay')} connect <command>    probe a CLI and print what relay detected
  ${c.bold('relay')} backends             priority order and credit state
  ${c.bold('relay')} sessions [--all]     saved sessions
  ${c.bold('relay')} commands [cli]       every command relay has seen
  ${c.bold('relay')} sync                refresh the AGENTS.md progress block

  Inside relay, /help lists everything. When a CLI runs out of credits mid-task, relay
  marks it, replays the turn on the next one in your priority order, and imports the
  transcript. Progress is written to AGENTS.md so any CLI can pick the work up.
`;

async function main() {
  const argv = process.argv.slice(2);
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    process.stderr.write(c.red('relay: ') + err.message + '\n' + c.gray('  relay --help\n'));
    process.exit(2);
  }

  if (flags.version) return console.log(VERSION);
  if (flags.help) return process.stdout.write(HELP);

  const config = loadConfig();
  fs.mkdirSync(config.home, { recursive: true });
  const registry = new Registry(config.home, config);
  const sub = flags._[0];

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

  if (sub === 'sync') {
    const header = store.latestSession(config.home, flags.cwd) || store.findSession(config.home, flags._[1]);
    if (!header) return console.log(c.yellow('no session to sync from here — try: relay sync <session-id>'));
    const session = store.openSession(header.file);
    const r = store.syncAgents(session, flags.cwd, session.header.lastBackend || registry.pick());
    return console.log(c.green('✓ ') + r.file);
  }

  if (sub === 'connect') {
    const command = flags._[1];
    if (!command) return console.log(c.red('usage: relay connect <command>') + c.gray('\n  or inside relay: /connect for the guided version'));
    const { Probe } = require('../lib/probe');
    const { classify, handshake, summaryRows } = require('../lib/connect');
    const probe = new Probe(flags.cwd);
    const help = probe.helpText(command, flags.cwd);
    const { def } = classify(command, help, probe.which(command));
    console.log(c.gray(`\nprobing ${command} (${def.dialect} dialect) — one small request\n`));
    const res = await handshake(def, flags.cwd);
    console.log(summaryRows(def, res, res.ok && /RELAY_OK/.test(res.text)));
    console.log(
      res.ok
        ? c.green('\n✓ works — add it to the rotation with: relay') + c.gray(' then /connect\n')
        : c.yellow(`\nprobe ${res.kind}${res.raw ? ': ' + truncate(res.raw.split('\n').slice(-2).join(' '), 200) : ''}\n`),
    );
    return;
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
  } else if (flags.new) {
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

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

main().catch((err) => {
  process.stderr.write(c.red('relay: ') + (err?.message || String(err)) + '\n');
  process.exit(1);
});
