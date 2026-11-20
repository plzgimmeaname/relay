const { c, rule, table, badge, truncate, bullets, WIDTH } = require('./ui');
const store = require('./store');
const { wizard } = require('./connect');
const { HELP } = require('./tui');

function rows(entries) {
  return entries.map(([k, v]) => `  ${c.gray(String(k).padEnd(22))}${v}`);
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function dispatch(tui, line) {
  const [cmd, ...rest] = line.replace(/^\/+/, '').split(/\s+/);
  const arg = rest.join(' ');
  const app = tui.app;
  const registry = app.registry;
  const config = tui.config;

  switch (cmd) {
    case 'help':
    case '?':
      tui.line('\n' + table(HELP.map((h) => [c.bold(h[0]), c.gray(h[1])]), ['command', 'does']) + '\n');
      return;

    case 'quit':
    case 'exit':
      return tui.exit();

    case 'status': {
      const st = app.status();
      const credits = Object.entries(st.exhausted || {});
      tui.line(
        '\n' +
          rows([
            ['session', st.session.slice(0, 8)],
            ['transcript', c.gray(st.file)],
            ['cwd', st.cwd],
            ['current cli', st.backend ? c.bold(c.cyan(st.backend)) + c.gray(` · ${st.dialect}`) : c.red('none')],
            ['priority', st.order.map((n, i) => (i === 0 ? c.bold(n) : n)).join(c.gray(' > ')) || c.gray('empty')],
            ['ready', st.available.length ? st.available.join(', ') : c.red('none')],
            ['credit state', credits.length ? credits.map(([k, v]) => (v.hard ? `${c.red(k + ' out of credits')}${v.reason ? c.gray(` — ${truncate(v.reason, 60)}`) : ''}` : `${c.yellow(k + ' cooling down')}`)).join('\n                     ') : c.gray('none')],
            ['turns', String(st.entries)],
            ['context shared with', st.syncedTo.length ? st.syncedTo.join(', ') : c.gray('this CLI only')],
            ['referenced sessions', st.refs.length ? st.refs.map((r) => r.sid.slice(0, 8)).join(', ') : c.gray('none')],
            ['AGENTS.md', st.agents ? c.green(st.agents) : c.yellow('missing — /sync creates it')],
            ['commands seen', Object.entries(st.commands).map(([k, v]) => `${k}:${v}`).join('  ') || c.gray('none yet')],
          ]).join('\n') +
          '\n',
      );
      return;
    }

    case 'priority': {
      if (!arg) {
        const list = registry.all;
        if (!list.length) return tui.line(c.yellow('  no CLIs connected — /connect\n'));
        tui.line('\n' + list.map((n, i) => `  ${c.bold(String(i + 1))}. ${n}${i === 0 ? c.green('   ← asked first') : ''}`).join('\n') + '\n');
        tui.line(c.gray('  /priority claude qwen junie        reorder absolutely'));
        tui.line(c.gray('  /priority move junie 1             one CLI, to a position') + '\n');
        return;
      }
      if (arg.startsWith('move ')) {
        const [, name, pos] = arg.split(/\s+/);
        if (!registry.all.includes(name)) return tui.line(c.red(`  unknown CLI: ${name}`) + '\n');
        const list = registry.all.filter((n) => n !== name);
        const index = Math.max(0, Math.min(list.length, (Number(pos) || list.length + 1) - 1));
        list.splice(index, 0, name);
        registry.setOrder(list);
      } else {
        const names = arg.split(/[\s,]+/).filter(Boolean);
        const unknown = names.filter((n) => !registry.all.includes(n));
        if (unknown.length) return tui.line(c.red(`  unknown CLI(s): ${unknown.join(', ')}`) + c.gray(' — see /backends') + '\n');
        registry.setOrder([...names, ...registry.all.filter((n) => !names.includes(n))]);
      }
      tui.line(c.green('  ✓ priority ') + registry.all.map((n, i) => (i === 0 ? c.bold(n) : n)).join(c.gray(' > ')) + '\n');
      return;
    }

    case 'use': {
      if (!registry.all.includes(arg)) return tui.line(c.red(`  unknown CLI: ${arg}`) + c.gray(' — see /backends') + '\n');
      app.session.header.lastBackend = arg;
      store.rewriteHeader(app.session);
      const ex = registry.exhausted[arg];
      return tui.line(
        c.green(`  ✓ next turns go to ${c.bold(arg)}`) +
          c.gray(' (a credit failure still falls over)') +
          (ex?.hard ? c.red(`\n     ⛔ ${arg} is marked out of credits — /forget ${arg} to try it now`) : '') +
          '\n',
      );
    }

    case 'backends': {
      const list = registry.all;
      if (!list.length) return tui.line(c.yellow('  nothing connected yet — run /connect\n'));
      const rows0 = list.map((n) => {
        const def = registry.backend(n);
        const ex = registry.exhausted[n];
        const state = ex?.hard ? c.red('out of credits') : ex?.until > Date.now() ? c.yellow('cooldown') : c.green('ready');
        return [n === app.backendName ? c.bold('▸ ' + n) : '  ' + n, def.command, def.dialect || 'claude', state, String(registry.commands(n).length)];
      });
      tui.line('\n' + table(rows0, ['cli', 'command', 'dialect', 'state', 'cmds']) + '\n');
      tui.line(c.gray('  /connect adds a CLI · /priority sets the order · /forget clears a credit mark\n'));
      return;
    }

    case 'commands': {
      const map = registry.allCommands();
      const names = Object.keys(map).filter((b) => !arg || b === arg);
      if (!names.length) {
        return tui.line(
          c.yellow('  no command catalogs yet.') + c.gray('\n  relay records what each CLI advertises the first time it runs a turn for you.\n'),
        );
      }
      for (const b of names) {
        const entry = map[b];
        const cmds = (entry.cmds || []).map((x) => '/' + x);
        tui.line(`\n  ${c.bold(b)} ${c.gray(`(${cmds.length} · seen ${new Date(entry.at).toLocaleString()})`)}`);
        const size = Math.max(1, Math.floor((WIDTH() - 4) / 22));
        for (const col of chunk(cmds, size)) tui.line('    ' + col.map((x) => c.gray(x.padEnd(22))).join(''));
      }
      tui.line(c.gray('\n  run one verbatim: /run <cli> /command args\n'));
      return;
    }

    case 'run': {
      const [backend, ...native] = rest;
      if (!backend || !native.length) return tui.line(c.red('  usage: /run <cli> /native-command [args]') + '\n');
      if (!registry.all.includes(backend)) return tui.line(c.red(`  unknown CLI: ${backend}`) + '\n');
      tui.line(c.gray(`  ↳ ${native.join(' ')} on ${backend}`));
      const out = await app.turn(native.join(' '), {}, { force: backend });
      if (out.ok) tui.renderResult(out.res);
      else tui.line(c.yellow(`  ✗ ${out.res?.kind || out.reason}${out.res?.raw ? ': ' + truncate(out.res.raw, 160) : ''}`));
      return;
    }

    case 'connect':
      await wizard({ ask: (q) => tui.ask(q), confirm: (q) => tui.confirm(q), note: (s) => tui.line(s), cwd: app.cwd, registry, config, target: arg || null });
      return;

    case 'sync': {
      const s = app.sync();
      tui.line(c.green('  ✓ progress block written ') + `→ ${s.file}\n`);
      tui.line(c.gray('  any CLI started in this directory now reads the same session state\n'));
      return;
    }

    case 'note': {
      if (!arg) return tui.line(c.red('  usage: /note <text>') + '\n');
      return tui.line(c.green('  ✓ pinned → ') + app.note(arg) + c.gray(' (sent with every future turn)') + '\n');
    }

    case 'sessions': {
      const all = /\-\-all|^all$/.test(arg);
      const list = all ? store.allSessions(config.home) : store.listSessions(config.home, app.cwd);
      tui.lastSessionList = list;
      if (!list.length) return tui.line(c.yellow(`  no saved sessions${all ? '' : ' here'} — try /sessions --all\n`));
      tui.line(
        '\n' +
          table(
            list.slice(0, 30).map((s, i) => [c.bold(String(i + 1)), s.sid.slice(0, 8), new Date(s.updated).toLocaleString(), String(s.messages), truncate(s.cwd || '', 26), truncate(s.name || '', 14)]),
            ['#', 'id', 'updated', 'turns', 'directory', 'name'],
          ) +
          '\n',
      );
      tui.line(c.gray('  /resume <#|id> continues one · /ref <#|id> keeps one in context · /sessions --all spans every directory\n'));
      return;
    }

    case 'resume': {
      let target = null;
      if (!arg) target = store.latestSession(config.home, app.cwd);
      else if (/^\d+$/.test(arg)) target = (tui.lastSessionList || store.listSessions(config.home, app.cwd))[Number(arg) - 1];
      else {
        target = store.findSession(config.home, arg);
        if (target?.ambiguous) {
          tui.line(c.yellow(`  "${arg}" matches ${target.ambiguous.length} sessions:`));
          return tui.line(table(target.ambiguous.map((s) => [s.sid.slice(0, 8), new Date(s.updated).toLocaleString(), truncate(s.cwd, 30)]), ['id', 'updated', 'directory']));
        }
      }
      if (!target) return tui.line(c.red('  no matching session — /sessions --all') + '\n');
      app.session = store.openSession(target.file);
      tui.line(c.green(`  ✓ resumed ${target.sid.slice(0, 8)}`) + c.gray(` from ${truncate(target.cwd || '', 40)}`) + '\n' + tui.banner());
      return;
    }

    case 'ref':
    case 'refs': {
      if (!arg && cmd === 'refs') {
        const refs = app.session.header.refs || [];
        if (!refs.length) return tui.line(c.gray('  nothing referenced — /ref <id|#|name> (see /sessions --all)\n'));
        return tui.line('\n' + table(refs.map((r, i) => [c.bold(String(i + 1)), r.sid.slice(0, 8), truncate(r.cwd || '', 34), String(r.entries), new Date(r.added).toLocaleString()]), ['#', 'id', 'from', 'turns', 'added']) + c.gray('\n  /unref <#|id> drops one\n'));
      }
      if (!arg) return tui.line(c.red('  usage: /ref <id|#|name>') + '\n');
      let ref = arg;
      if (/^\d+$/.test(arg)) ref = tui.lastSessionList?.[Number(arg) - 1]?.sid || arg;
      const rendered = app.addRef(ref);
      if (!rendered.digest) return tui.line(c.yellow(`  ${rendered.sid.slice(0, 8)} has nothing to share yet`) + '\n');
      return tui.line(c.green(`  ✓ referencing ${rendered.sid.slice(0, 8)}`) + c.gray(` (${rendered.entries} entries from ${truncate(rendered.cwd || '', 30)}) — now part of every prompt\n`) + c.gray(`  /refs to list · /unref ${rendered.sid.slice(0, 8)} to drop\n`));
    }

    case 'unref': {
      let ref = arg;
      if (/^\d+$/.test(arg)) ref = (app.session.header.refs || [])[Number(arg) - 1]?.sid || arg;
      const removed = app.removeRef(ref);
      return tui.line(removed ? c.green(`  ✓ dropped ${removed} reference(s)`) + '\n' : c.yellow('  no matching reference') + '\n');
    }

    case 'retry': {
      const out = await app.retry();
      if (out.ok) return tui.renderResult(out.res);
      return tui.line(c.yellow(out.reason === 'nothing to retry' ? '  nothing to retry' : `  ✗ ${out.res?.kind || out.reason}`) + '\n');
    }

    case 'forget': {
      registry.reset(arg || null);
      return tui.line(c.green(arg ? `  ✓ ${arg} is back in the rotation` : '  ✓ all credit marks cleared') + '\n');
    }

    case 'clear': {
      app.session = store.createSession(config.home, app.cwd);
      return tui.line(c.green('  ✓ new session ') + app.session.header.sid.slice(0, 8) + c.gray(' — the old one stays in /sessions') + '\n');
    }

    case 'compact':
      return tui.line(c.gray(`  handoff digest = last ${config.digestWindow} entries (digestWindow in ${config.home}/config.json)\n`));

    default: {
      const near = HELP.map((h) => h[0].slice(1)).find((n) => n.startsWith(cmd));
      tui.line(c.yellow(`  unknown command /${cmd}`) + (near ? c.gray(` — did you mean /${near}?`) : c.gray(' — /help')) + '\n');
    }
  }
}

module.exports = { dispatch };
