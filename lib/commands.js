const fs = require('fs');
const path = require('path');
const log = require('./log');
const { c, table, truncate, indent, heading, fields, padVisible, WIDTH } = require('./ui');
const store = require('./store');
const { wizard } = require('./connect');
const { HELP, HELP_GROUPS } = require('./tui');
const { listAgents, findAgent } = require('./agent');

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
    case '?': {
      const width = Math.max(...HELP.map(([cmd]) => cmd.length));
      const out = [''];
      let last = null;
      for (const [cmd, desc, group] of HELP) {
        if (group !== last) {
          if (last) out.push('');
          out.push(heading(HELP_GROUPS[group] || group));
          last = group;
        }
        out.push(`  ${c.bold(c.text(padVisible(cmd, width)))}  ${c.gray(desc)}`);
      }
      out.push('', c.gray('  Tab completes commands and CLI names · /verbose compact for quieter tool output'));
      tui.line(out.join('\n') + '\n');
      return;
    }

    case 'quit':
    case 'exit':
      return tui.exit();

    case 'status': {
      const st = app.status();
      const credits = Object.entries(st.exhausted || {});
      const strategy = registry.getStrategy ? registry.getStrategy() : 'priority';
      const creditLines = credits.length
        ? credits.map(([k, v]) => {
            if (v.hard) return `${c.red('○ ' + k)} ${c.gray('out of credits')}${v.reason ? c.gray(' · ' + truncate(v.reason, 52)) : ''}`;
            const mins = v.until ? Math.max(0, Math.ceil((v.until - Date.now()) / 60000)) : 0;
            return `${c.yellow('◐ ' + k)} ${c.gray(`cooldown${mins ? ` · ${mins}m` : ''}`)}`;
          })
        : [c.green('● all healthy')];
      const order = st.order.slice(0, 6).map((n, i) => (i === 0 ? c.bold(n) : n)).join(c.gray(' › '));
      const orderMore = st.order.length > 6 ? c.gray(` › +${st.order.length - 6}`) : '';
      const ready = st.available.slice(0, 8).join(', ');
      const readyMore = st.available.length > 8 ? c.gray(` +${st.available.length - 8} more`) : '';
      const commandsSeen = Object.entries(st.commands).filter(([, v]) => v > 0);
      tui.line(
        '\n' +
          [
            heading('session'),
            fields([
              ['id', c.text(st.session.slice(0, 8))],
              ['turns', String(st.entries)],
              ['folder', truncate(st.cwd, WIDTH() - 30)],
              ['transcript', c.gray(truncate(st.file, WIDTH() - 16))],
              ['AGENTS.md', st.agents ? c.green(st.agents) : c.yellow('missing — /sync creates one')],
            ]),
            '',
            heading('routing'),
            fields([
              ['current', st.backend ? c.bold(c.cyan(st.backend)) + c.gray(` (${st.dialect})`) : c.red('none')],
              ['strategy', c.bold(strategy)],
              ['priority', st.order.length ? order + orderMore : c.gray('empty')],
              ['ready', st.available.length ? ready + readyMore : c.red('none')],
              ['credits', creditLines.join('\n')],
              ['shared with', st.syncedTo.length ? st.syncedTo.join(', ') : c.gray('this CLI only')],
            ]),
            '',
            heading('context'),
            fields([
              ['referenced', st.refs.length ? st.refs.map((r) => r.sid.slice(0, 8)).join(', ') : c.gray('none')],
              ['commands', commandsSeen.length ? commandsSeen.map(([k, v]) => `${k}:${v}`).join('  ') : c.gray('none yet')],
            ]),
          ].join('\n') +
          '\n',
      );
      return;
    }

    case 'priority': {
      if (!arg) {
        const list = registry.all;
        if (!list.length) return tui.line(c.yellow('  no CLIs connected — /connect\n'));
        tui.line('\n' + heading('priority'));
        tui.line(
          list
            .map((n, i) => `  ${c.gray(String(i + 1).padStart(2) + '.')} ${i === 0 ? c.bold(c.cyan(n)) : c.text(n)}${i === 0 ? c.gray('   asked first') : ''}`)
            .join('\n') +
            '\n',
        );
        tui.line(c.gray('  /priority claude qwen junie     reorder · /priority move junie 1') + '\n');
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
        const state = ex?.hard ? c.red('○ out') : ex?.until > Date.now() ? c.yellow('◐ cooldown') : c.green('● ready');
        return [n === app.backendName ? c.bold('▸ ' + n) : '  ' + n, def.command, def.dialect || 'claude', state, String(registry.commands(n).length)];
      });
      tui.line('\n' + table(rows0, ['cli', 'command', 'dialect', 'state', 'cmds']) + '\n');
      tui.line(c.gray('  /connect adds a CLI · /priority sets the order · /forget clears a credit mark\n'));
      return;
    }

    case 'commands': {
      const map = registry.allCommands();
      const [first, ...more] = arg.split(/\s+/).filter(Boolean);
      const isBackend = first && Object.prototype.hasOwnProperty.call(map, first);
      const needle = (isBackend ? more : first ? [first, ...more] : []).join(' ').toLowerCase();
      const names = Object.keys(map).filter((b) => !isBackend || b === first);
      if (!names.length) {
        return tui.line(
          c.yellow('  no command catalogs yet.') + c.gray('\n  relay records what each CLI advertises the first time it runs a turn for you.\n'),
        );
      }
      for (const b of names) {
        const entry = map[b];
        const all = (entry.cmds || []).filter((x) => !needle || x.toLowerCase().includes(needle));
        tui.line(`\n  ${c.bold(c.cyan(b))} ${c.gray(`(${all.length}${needle ? ` matching "${needle}"` : ''} · seen ${new Date(entry.at).toLocaleString()})`)}`);
        if (!all.length) continue;
        // group "plugin:skill" names under their plugin; bare names go under "built-in"
        const groups = new Map();
        for (const x of all) {
          const i = x.indexOf(':');
          const key = i > 0 ? x.slice(0, i) : '';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(i > 0 ? x.slice(i + 1) : x);
        }
        const bare = groups.get('') || [];
        groups.delete('');
        const section = (title, items, prefix) => {
          tui.line(`\n    ${c.bold(title)} ${c.gray(String(items.length))}`);
          const w = Math.min(34, Math.max(...items.map((x) => (prefix + x).length)) + 2);
          const per = Math.max(1, Math.floor((WIDTH() - 6) / w));
          for (const col of chunk(items, per)) tui.line('      ' + col.map((x) => c.gray(truncate('/' + prefix + x, w - 2).padEnd(w))).join('').trimEnd());
        };
        if (bare.length) section('built-in & skills', bare, '');
        for (const [g, items] of [...groups.entries()].sort()) section(g, items, g + ':');
      }
      tui.line(c.gray('\n  filter: /commands [cli] <text> · run one verbatim: /run <cli> /command args\n'));
      return;
    }

    case 'history': {
      const n = Math.max(1, Number(arg) || 6);
      const entries = app.session.entries.filter((e) => e.kind === 'user' || e.kind === 'assistant').slice(-n * 2);
      if (!entries.length) return tui.line(c.gray('  nothing said yet in this session\n'));
      tui.line('');
      for (const e of entries) {
        const when = new Date(e.t).toLocaleTimeString();
        if (e.kind === 'user') tui.line(`  ${c.bold(c.green('you'))} ${c.gray(when)}\n${indent(truncate(e.text, 600), '    ')}`);
        else tui.line(`  ${c.bold(c.cyan(e.backend || 'cli'))} ${c.gray(when)}${e.tools?.length ? c.gray(`  · ${e.tools.length} tool call(s)`) : ''}\n${indent(truncate(e.text || '', 600), '    ')}`);
      }
      tui.line('');
      return;
    }

    case 'export': {
      const sid = app.session.header.sid.slice(0, 8);
      const file = path.resolve(app.cwd, arg || `relay-${sid}.md`);
      const out = [`# relay session ${sid}${app.session.header.name ? ` — ${app.session.header.name}` : ''}`, '', `- directory: ${app.session.header.cwd}`, `- created: ${new Date(app.session.header.created).toLocaleString()}`, ''];
      for (const e of app.session.entries) {
        if (e.kind === 'user') out.push(`## You  <sub>${new Date(e.t).toLocaleString()}</sub>`, '', e.text, '');
        else if (e.kind === 'assistant') {
          out.push(`## ${e.backend || 'assistant'}  <sub>${new Date(e.t).toLocaleString()}</sub>`, '');
          if (e.tools?.length) out.push(...e.tools.map((t) => `- \`${t}\``), '');
          out.push(e.text || '', '');
        }
      }
      fs.writeFileSync(file, out.join('\n'));
      return tui.line(c.green('  ✓ exported ') + `${app.session.entries.length} entries → ${file}\n`);
    }

    case 'cost': {
      const per = {};
      for (const e of app.session.entries) {
        if (e.kind !== 'assistant') continue;
        const b = (per[e.backend || '?'] = per[e.backend || '?'] || { turns: 0, i: 0, o: 0, ms: 0 });
        b.turns += 1;
        b.ms += e.durationMs || 0;
        const us = Array.isArray(e.usage) ? e.usage : e.usage ? [e.usage] : [];
        for (const u of us) {
          b.i += (u.input_tokens || u.inputTokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          b.o += u.output_tokens || u.outputTokens || 0;
        }
      }
      const names = Object.keys(per);
      if (!names.length) return tui.line(c.gray('  no answered turns yet\n'));
      const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
      tui.line('\n' + table(names.map((n) => [c.bold(n), String(per[n].turns), fmt(per[n].i), fmt(per[n].o), (per[n].ms / 1000).toFixed(1) + 's']), ['cli', 'turns', 'tokens in', 'tokens out', 'time']) + '\n');
      return;
    }

    case 'verbose': {
      if (arg === 'full' || arg === 'compact') tui.setVerbosity(arg);
      else if (arg) return tui.line(c.red('  usage: /verbose full|compact') + '\n');
      return tui.line(c.green('  ✓ output ') + c.bold(tui.verbosity) + c.gray(tui.verbosity === 'full' ? ' — everything the CLI prints, live' : ' — tool calls and thinking shortened') + '\n');
    }

    case 'native': {
      const native = require('./native');
      const all = /--all/.test(arg);
      const cli = rest.find((a) => native.CLIS.includes(a)) || null;
      const list = native.list(config.home, { cwd: all ? null : app.cwd, cli });
      tui.lastNativeList = list;
      if (!list.length) return tui.line(c.yellow(`  no ${cli || 'claude/qwen/junie'} history${all ? '' : ' for this directory'} outside relay`) + c.gray(all ? '\n' : ' — try /native --all\n'));
      tui.line('\n' + table(list.slice(0, 40).map((s, i) => [c.bold(String(i + 1)), s.cli, native.shortId(s), new Date(s.updated).toLocaleString(), String(s.turns), truncate(s.cwd || '?', 26), truncate(s.title, 34)]), ['#', 'cli', 'id', 'updated', 'turns', 'directory', 'first prompt']) + '\n');
      tui.line(c.gray('  /import <#|id> brings one into relay and keeps it in context · add --resume to continue it as your session\n'));
      return;
    }

    case 'import': {
      const native = require('./native');
      const ref = rest.find((a) => !a.startsWith('--'));
      if (!ref) return tui.line(c.red('  usage: /import <#|id> [--resume]') + c.gray('  (see /native)') + '\n');
      const pool = tui.lastNativeList && /^\d+$/.test(ref) ? tui.lastNativeList : native.list(config.home, { cwd: null });
      const item = native.find(pool, ref);
      if (item?.ambiguous) return tui.line(c.yellow(`  "${ref}" matches ${item.ambiguous.length} sessions: `) + item.ambiguous.map((i) => i.cli + ':' + native.shortId(i)).join(', ') + '\n');
      if (!item) return tui.line(c.red('  no matching history — /native --all') + '\n');
      const got = native.importSession(config.home, item, app.cwd);
      const sid = got.session.header.sid;
      tui.line(c.green(`  ✓ ${got.reused ? 'already imported' : 'imported'} ${item.cli} ${native.shortId(item)}`) + c.gray(` → relay session ${sid.slice(0, 8)} (${got.entries} entries)`));
      if (/--resume/.test(arg)) {
        app.session = got.session;
        return tui.line(c.green('  ✓ resumed it') + '\n' + tui.banner() + '\n');
      }
      app.addRef(sid);
      return tui.line(c.gray('  now part of every prompt · /unref ' + sid.slice(0, 8) + ' to drop · /import ' + ref + ' --resume to continue it\n'));
    }

    case 'theme': {
      const { THEMES, setTheme, getTheme, swatches } = require('./ui');
      if (!arg) {
        const cur = getTheme();
        tui.line(
          '\n' +
            heading('theme') +
            '\n' +
            fields(Object.keys(THEMES).map((n) => [n, n === cur ? c.cyan('● current') : c.gray('available')])) +
            '\n\n  ' +
            swatches() +
            '\n' +
            c.gray('  /theme <name> · saved for future runs') +
            '\n',
        );
        return;
      }
      try {
        setTheme(arg);
      } catch (err) {
        return tui.line(c.red('  ' + err.message) + '\n');
      }
      return tui.line(c.green('  ✓ theme ') + c.bold(arg) + c.gray(' saved') + '\n  ' + swatches() + '\n\n' + tui.banner() + '\n');
    }

    case 'log': {
      const lines = log.tail(Number(arg) || 15);
      if (!lines.length) return tui.line(c.gray(`  nothing logged yet — ${log.file()}\n`));
      tui.line('');
      for (const l of lines) tui.line('  ' + truncate(l, WIDTH() - 2).replace(/ error /, c.red(' error ')).replace(/ warn  /, c.yellow(' warn  ')));
      tui.line(c.gray(`\n  ${log.file()}\n`));
      return;
    }

    case 'run': {
      const [backend, ...native] = rest;
      if (!backend || !native.length) return tui.line(c.red('  usage: /run <cli> /native-command [args]') + '\n');
      if (!registry.all.includes(backend)) return tui.line(c.red(`  unknown CLI: ${backend}`) + '\n');
      // same path as `@cli /command`: sent untouched, never handed to another CLI
      const { actionFor } = require('./tags');
      const { runTagged } = require('./tagview');
      await runTagged(app, { backend, model: null }, actionFor(native.join(' ')), {
        log: (s) => tui.line(s),
        submit: (text, opts) => tui.submit(text, opts, { prompt: false }),
        slash: (name, command, model) => tui.slash(name, command, model),
      });
      return;
    }

    case 'skill': {
      const { splitArgs } = require('./tags');
      const { skillCommand } = require('./skillview');
      const { reservedNames } = require('./tui');
      const words = splitArgs(arg);
      const flags = {};
      const rest = [];
      for (let i = 0; i < words.length; i += 1) {
        if (words[i] === '--force') flags.force = true;
        else if (words[i] === '--no-export') flags.noExport = true;
        else if (words[i] === '--as') flags.as = words[(i += 1)];
        else rest.push(words[i]);
      }
      if (rest[0] === 'use') return tui.line(c.yellow(`  no skill called "${rest[1] || ''}" — /skill list`) + '\n');
      skillCommand(config, rest, flags, (s) => tui.line(s), reservedNames());
      return;
    }

    case 'agents': {
      const list = listAgents(config.home);
      if (!list.length) return tui.line(c.gray('  no agent assignments yet — relay agent <name> --cli <cli> --model <model> --cwd <dir> "<prompt>"\n'));
      tui.line('\n' + table(
        list.map((a) => [c.bold(a.name), a.backend, a.model || '—', truncate(a.cwd, 30), a.sessionId ? a.sessionId.slice(0, 8) : '—']),
        ['name', 'cli', 'model', 'directory', 'session'],
      ) + '\n');
      tui.line(c.gray('  /switch <name>   open that agent in the TUI   ·   relay agent <name> --stop to drop\n'));
      return;
    }

    case 'switch': {
      const name = arg;
      if (!name) return tui.line(c.red('  usage: /switch <name>') + c.gray('  (see /agents)') + '\n');
      const found = findAgent(config.home, name);
      if (!found) return tui.line(c.red(`  no agent named "${name}"`) + c.gray(' — /agents') + '\n');
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
      app.session = session;
      app.cwd = found.cwd;
      app.config = agentConfig;
      app.registry = new Registry(config.home, agentConfig);
      return tui.line(c.green(`  ✓ switched to agent "${name}" (${found.backend} · ${found.model || 'default model'})`) + c.gray(` · ${truncate(found.cwd, 40)}\n`) + tui.banner());
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

    case 'auto': {
      // flags are only read from the front, so the instructions can mention them
      const flags = arg.match(/^(?:--(?:dry-run|offline)\s*)*/)[0];
      const instructions = arg.slice(flags.length).trim();
      if (!instructions) return tui.line(c.yellow('  usage: /auto [--dry-run] [--offline] <instructions>') + '\n');
      const { createControl } = require('./auto');
      const { runAuto } = require('./autoview');
      const control = createControl();
      // Ctrl-C needs live input while the tasks run
      tui.busy = true;
      app.abort = () => control.abort();
      try {
        await runAuto(app, instructions, {
          control,
          dryRun: flags.includes('--dry-run'),
          offline: flags.includes('--offline'),
          log: (s) => tui.line(s),
          out: (s) => tui.line(s),
        });
      } finally {
        tui.busy = false;
        app.abort = null;
      }
      return;
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

    case 'scan': {
      const { scanInstalledCLIs, autoConnectAll } = require('./scanner');
      const scanned = scanInstalledCLIs(app.cwd);
      const rows = scanned.map((c0) => [
        c0.installed ? c.green('✓ ' + c0.name) : c.gray('  ' + c0.name),
        c0.label,
        c0.freeTier ? c.green('free') : c.magenta('paid'),
        c0.installed ? c.cyan(c0.path) : c.gray('not found on PATH'),
        c0.installed ? (registry.all.includes(c0.name) ? c.green('connected') : c.yellow('available')) : c.gray('-'),
      ]);
      tui.line('\n' + table(rows, ['cli', 'provider', 'tier', 'binary path', 'status']) + '\n');
      if (arg === '--auto' || arg === 'auto') {
        const result = autoConnectAll(config, registry);
        tui.line(c.green(`  ✓ Auto-connected ${result.added.length} newly found CLI(s): ${result.added.join(', ')}\n`));
      } else {
        const unadded = scanned.filter((c0) => c0.installed && !registry.all.includes(c0.name));
        if (unadded.length) {
          tui.line(c.yellow(`  ${unadded.length} installed CLI(s) not yet in relay. Run: /scan --auto to connect them all!\n`));
        } else {
          tui.line(c.gray('  all detected CLIs are connected.\n'));
        }
      }
      return;
    }

    case 'credits': {
      const statuses = registry.creditStatus();
      if (!statuses.length) return tui.line(c.yellow('  no backends connected — /scan or /connect\n'));
      const rows = statuses.map((s, i) => {
        const stateColor = s.state === 'ready' ? c.green('● ready') : s.state === 'cooldown' ? c.yellow(`◐ ${s.cooldownText}`) : c.red('○ depleted');
        const tier = s.freeTier ? c.green('FREE') : c.magenta('PAID');
        const prefix = s.name === app.backendName ? c.bold('▸ ' + s.name) : '  ' + s.name;
        return [prefix, s.label, tier, stateColor, String(s.turns), s.successRate, truncate(s.reason || '', 30)];
      });
      const ready = statuses.filter((s) => s.state === 'ready').length;
      tui.line('\n' + heading(`credit pool · ${registry.getStrategy()} · ${ready}/${statuses.length} ready`));
      tui.line(table(rows, ['cli', 'provider', 'tier', 'quota state', 'turns', 'success', 'last signal']) + '\n');
      tui.line(c.gray('  /strategy pool balances requests · /strategy free-first uses free quotas first · /forget clears marks\n'));
      return;
    }

    case 'strategy': {
      if (!arg) {
        const cur = registry.getStrategy();
        tui.line(
          '\n' +
            [
              heading('strategy'),
              fields([
                ['current', c.bold(c.cyan(cur))],
                ['priority', 'ask the first CLI, fall over on credit failures'],
                ['pool', 'round-robin across ready CLIs to balance rate limits'],
                ['free-first', 'burn free tiers before paid credits'],
              ]),
              '',
              c.gray('  change with /strategy priority · /strategy pool · /strategy free-first'),
            ].join('\n') +
            '\n',
        );
        return;
      }
      try {
        const strat = registry.setStrategy(arg.trim().toLowerCase());
        tui.line(c.green(`  ✓ Routing strategy set to: ${c.bold(strat)}`) + '\n');
      } catch (err) {
        tui.line(c.red(`  ${err.message}`) + '\n');
      }
      return;
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
