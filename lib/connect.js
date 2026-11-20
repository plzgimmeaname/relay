const fs = require('fs');
const path = require('path');
const { Backend } = require('./backend');
const { Probe } = require('./probe');
const { QUOTA_PATTERNS, PROTOCOL_DEFAULTS } = require('./config');
const { dialectCandidates, DIALECTS } = require('./dialects');
const { c, table, truncate, bullets, rule, indent } = require('./ui');

const PROBE_TIMEOUT_MS = 90_000;
const HANDSHAKE = 'Reply with exactly the nine characters: RELAY_OK';

function defaultProtocol() {
  return { ...PROTOCOL_DEFAULTS };
}

function candidates(help) {
  return dialectCandidates(help);
}

function buildDef(command, dialect, help) {
  const text = String(help || '');
  const has = (re) => re.test(text);
  const def = {
    command,
    dialect,
    model: null,
    prefixArgs: [],
    extraArgs: [],
    env: {},
    quota: [],
    auth: [],
    protocol: defaultProtocol(),
  };
  if (dialect === 'claude') {
    def.protocol = {
      ...PROTOCOL_DEFAULTS,
      resumeArgs: has(/--resume\b/) ? ['-r'] : [],
      systemArgs: has(/append-system-prompt\[-file\]|--append-system-prompt-file/) ? ['--append-system-prompt-file'] : [],
    };
    if (has(/--verbose\b/)) def.extraArgs = ['--verbose'];
  } else if (dialect === 'junie') {
    def.protocol = { preArgs: has(/--skip-update-check/) ? ['--output-format=json-stream', '--skip-update-check'] : ['--output-format=json-stream'] };
  } else {
    def.protocol = { args: has(/--print|-p,/) ? ['-p'] : [], resumeArgs: has(/--resume\b/) ? ['--resume'] : [] };
  }
  return def;
}

function classify(command, help, which) {
  const dialect = candidates(help)[0];
  return { def: buildDef(command, dialect, help), dialect, which: which || null };
}

async function handshake(def, cwd) {
  const backend = new Backend(def, { timeoutMs: PROBE_TIMEOUT_MS });
  return backend.run({ prompt: HANDSHAKE, cwd, timeoutMs: PROBE_TIMEOUT_MS });
}

async function findWorkingDialect(command, help, cwd, note, run = handshake) {
  const tried = [];
  let answered = null;
  for (const dialect of candidates(help)) {
    const def = buildDef(command, dialect, help);
    const res = await run(def, cwd);
    tried.push({ dialect, def, res });
    if (res.ok && /RELAY_OK/.test(res.text)) {
      if (tried.length > 1) note(c.gray(`  ${tried[0].dialect} did not answer cleanly; ${dialect} did`));
      return { def, dialect, res, tried };
    }
    if (res.ok && !answered) answered = { def, dialect, res };
    else if (!res.ok) note(c.yellow(`  ${dialect}: ${res.kind}`) + c.gray(' — trying the next protocol'));
  }
  // nothing said the magic words: keep the best-supported guess instead of the last thing tried
  return { ...(answered || tried[0]), tried };
}

function summaryRows(def, res, verified) {
  const dialect = DIALECTS[def.dialect];
  const reply = verified
    ? c.green('answered the probe')
    : res.ok
      ? c.yellow('answered, but not with the expected text')
      : res.kind === 'spawn'
        ? c.red('binary not found')
        : c.yellow(`probe: ${res.kind}`);
  const rows = [
    ['command', def.command],
    ['dialect', `${def.dialect} ${c.gray(`— ${dialect?.hint || ''}`)}`],
    ['reply', reply],
    ['session resume', def.dialect === 'claude' ? (def.protocol.resumeArgs?.length ? c.green('native --resume') : c.gray('digest every turn')) : def.dialect === 'junie' ? c.green('native --session-id') : c.gray('digest every turn')],
    ['shared instructions', def.dialect === 'claude' ? (def.protocol.systemArgs?.length ? c.green(def.protocol.systemArgs.join(' ')) : c.yellow('none')) : def.dialect === 'junie' ? c.green('--ide-guidelines file') : c.gray('inlined in the prompt')],
    ['credit signals', `${QUOTA_PATTERNS.length} built-in${def.quota.length ? c.green(` + ${def.quota.length} custom`) : ''}`],
  ];
  return table(rows, ['capability', 'how relay uses it']);
}

async function wizard({ ask, confirm, note, cwd, registry, config, probeLib, target }) {
  const probe = probeLib || new Probe(cwd);
  const guess = String(target || '').trim();
  note(c.bold('\nConnect a CLI to relay\n') + c.gray(rule('─')));
  note(
    c.gray(
      'relay can drive any CLI that answers a prompt on stdout. Three checks: the binary exists,\nit replies to a tiny probe, and how it reports being out of credits. Nothing is saved until you confirm.',
    ),
  );

  const name = ((await ask(`\n  name for this CLI  ${guess ? c.gray(`[${guess}]`) + ' ' : ''}`)).trim() || guess).trim();
  if (!name) throw new Error('cancelled');
  if (registry.all.includes(name)) throw new Error(`"${name}" is already connected — /use ${name}`);

  const command = (await ask(`  command to run  ${c.gray(`[${name}]`)} `)).trim() || name;
  const which = probe.which(command);
  if (which) note(c.green('  ✓ found ') + c.gray(which));
  else {
    const file = probe.pathOf(command);
    note(c.red('  ✗ ') + (file ? `${c.bold(file)} exists but is not executable — ${c.bold('chmod +x ' + file)}` : `\`${command}\` is not on your PATH.`));
    if (!(await confirm('  add it anyway? '))) throw new Error('cancelled');
  }

  note(c.dim('\n  reading --help and probing which protocol it speaks…'));
  const help = probe.helpText(command, cwd);
  let { def, dialect, res } = await findWorkingDialect(command, help, cwd, note);
  let verified = res.ok && /RELAY_OK/.test(res.text);
  report(note, dialect, res, verified);
  note('\n' + summaryRows(def, res, verified));

  const opts = candidates(help);
  if (!verified && opts.length > 1) {
    note(c.gray('\n  relay could not confirm the protocol with a live reply — pick one, or Enter to keep ') + c.bold(dialect));
    note(opts.map((d, i) => `    ${c.bold(String(i + 1))}. ${c.bold(d)} ${c.gray('— ' + DIALECTS[d].hint)}`).join('\n'));
    const pick = (await ask('  protocol  ')).trim();
    const chosen = /^\d+$/.test(pick) ? opts[Number(pick) - 1] : null;
    if (chosen && chosen !== dialect) {
      def = buildDef(command, chosen, help);
      dialect = chosen;
      res = await handshake(def, cwd);
      verified = res.ok && /RELAY_OK/.test(res.text);
      report(note, dialect, res, verified);
      note('\n' + summaryRows(def, res, verified));
    }
  }

  if (!res.ok && res.kind !== 'quota') {
    note(c.gray('\n  last output from the probe:'));
    note(indent(truncate(String(res.raw || res.text || '(nothing)').split('\n').slice(-6).join('\n'), 900), '    '));
    if (!(await confirm('\n  save it anyway and fix later? '))) throw new Error('cancelled');
  }

  note(c.bold('\nCredit signals'));
  note(c.gray('  built-ins already cover: "credit limit", "out of credits", "quota exceeded", "rate limit", 429.'));
  const extra = (await ask('  anything this CLI prints when you run out? (Enter to skip) ')).trim();
  if (extra) {
    def.quota.push(extra);
    note(c.green(`  ✓ will fail over on: ${c.bold(truncate(extra, 70))}`));
  }

  const first = registry.all.length ? await confirm(`\n  ask ${c.bold(name)} before ${c.bold(registry.all[0])} from now on? `) : true;

  if (!(await confirm(`  save ${c.bold(name)} to ${c.underline(path.join(config.home, 'config.json'))}? `))) throw new Error('cancelled');

  save(config, registry, name, def, { first });
  note(c.green('\n  ✓ connected ') + c.bold(name) + (verified ? c.gray(' · protocol verified live') : c.yellow(' · protocol unverified')));
  note('  ' + c.gray('priority: ') + registry.all.map((n, i) => (i === 0 ? c.bold(n) : n)).join(c.gray(' > ')));
  note('\n' + bullets([
    `talk to it:        ${c.bold('/use ' + name)}`,
    `reorder anytime:   ${c.bold('/priority ' + registry.all.join(' '))}`,
    `its own commands:  ${c.bold('/commands ' + name)} ${c.gray('(populated after its first turn)')}`,
  ]));
  return { name, def, res };
}

function report(note, dialect, res, verified) {
  note(
    `  speaking dialect: ${c.bold(dialect)}` +
      (dialect === 'text' ? c.gray('  (lowest capability: context travels inside the prompt)') : '') +
      (verified ? c.green('  ✓ answered the live probe') : res.ok ? c.yellow('  ! answered, but not the expected text') : c.yellow(`  ! probe ${res.kind}: ${truncate(res.raw || res.error || res.text || '', 140)}`)),
  );
}

function save(config, registry, name, def, { first = false } = {}) {
  const userFile = path.join(config.home, 'config.json');
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  } catch {
    existing = { order: registry.all.slice(), backends: {} };
  }
  existing.backends = existing.backends || {};
  existing.backends[name] = {
    command: def.command,
    dialect: def.dialect,
    model: def.model,
    prefixArgs: def.prefixArgs,
    extraArgs: def.extraArgs,
    env: def.env,
    quota: def.quota,
    auth: def.auth,
    protocol: def.protocol,
  };
  if (!existing.order) existing.order = registry.all.slice();
  const rest = existing.order.filter((n) => n !== name);
  existing.order = first ? [name, ...rest] : [...rest, name];
  fs.mkdirSync(config.home, { recursive: true });
  fs.writeFileSync(userFile, JSON.stringify(existing, null, 2) + '\n');

  config.backends[name] = { ...def, name, protocol: def.protocol };
  config.order = existing.order;
  registry.setOrder(existing.order);
}

module.exports = { wizard, classify, candidates, buildDef, findWorkingDialect, handshake, summaryRows, save, HANDSHAKE };
