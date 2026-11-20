const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = __dirname;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
process.env.RELAY_HOME = path.join(root, 'home');
const CWD = path.join(root, 'proj');
fs.mkdirSync(CWD, { recursive: true });
fs.writeFileSync(path.join(CWD, 'AGENTS.md'), '# Project rules\nUse pnpm. Never force-push.\n');

const { loadConfig } = require('../lib/config');
const { Registry } = require('../lib/registry');
const store = require('../lib/store');
const { App } = require('../lib/app');

function fake(script, name, mode, dialect) {
  return {
    command: process.execPath,
    prefixArgs: [path.join(DIR, script)],
    dialect,
    env: { FAKE_MODE: mode, FAKE_NAME: name, FAKE_STATE_DIR: root },
    protocol: dialect === 'claude' ? undefined : { args: [], resumeArgs: [], systemArgs: [], permissionModeArgs: false },
  };
}

const LAYOUT = {
  order: ['qc', 'jd', 'tx'],
  backends: {
    qc: fake('fake-claude.js', 'qc', 'quota', 'claude'),
    jd: fake('fake-junie.js', 'jd', 'ok', 'junie'),
    tx: fake('fake-text.js', 'tx', 'ok', 'text'),
  },
};

fs.mkdirSync(process.env.RELAY_HOME, { recursive: true });

function reset(overrides = {}) {
  const conf = JSON.parse(JSON.stringify(overrides.order ? overrides : LAYOUT));
  fs.writeFileSync(path.join(process.env.RELAY_HOME, 'config.json'), JSON.stringify(conf, null, 2));
  fs.rmSync(path.join(process.env.RELAY_HOME, 'state.json'), { force: true });
}

const quiet = { onTurnStart() {}, onFailover() {} };
function ctx(cwd = CWD) {
  const config = loadConfig();
  const registry = new Registry(config.home, config);
  const session = store.createSession(config.home, cwd);
  const app = new App({ config, registry, session, cwd, ui: quiet });
  return { config, registry, session, app };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('quota failure falls over to the junie dialect', async () => {
  reset();
  const { app, registry } = ctx();
  const out = await app.turn('first prompt');
  assert.equal(out.ok, true, 'a working CLI should answer');
  assert.equal(out.backend, 'jd');
  assert.match(out.res.text, /\[jd\]/);
  assert.equal(registry.exhausted.qc.hard, true);
  assert.match(registry.exhausted.qc.reason, /credit/i);
});

test('junie is driven with --task= and reports its session id', async () => {
  reset();
  const { app } = ctx();
  const out = await app.turn('hello junie');
  const seen = JSON.parse(fs.readFileSync(path.join(root, 'last-seen-junie'), 'utf8'));
  assert.ok(seen.argv.some((a) => a.startsWith('--task=')), 'prompt travels in --task');
  assert.ok(seen.argv.includes('--output-format=json-stream'));
  assert.equal(out.res.sessionId, 'session-abc-123');
});

test('same CLI resumes natively instead of re-sending the digest', async () => {
  reset();
  const { app, session } = ctx();
  await app.turn('turn one');
  await app.turn('turn two');
  const seen = JSON.parse(fs.readFileSync(path.join(root, 'last-seen-junie'), 'utf8'));
  assert.equal(seen.resumed, true, 'second junie turn passes --session-id');
  assert.equal(seen.digest, false);
  assert.equal(session.header.backendSessions.jd, 'session-abc-123');
});

test('a CLI that never saw this session receives the transcript digest', async () => {
  reset({ order: ['qc', 'jd'], backends: { qc: LAYOUT.backends.qc, qb: fake('fake-claude.js', 'qb', 'ok', 'claude'), jd: LAYOUT.backends.jd } });
  const { app, registry } = ctx();
  const first = await app.turn('note this: purple-otter');
  assert.equal(first.backend, 'jd', 'qc is out of credits');
  registry.setOrder(['qb', 'qc', 'jd']);
  app.session.header.lastBackend = 'qb';
  store.rewriteHeader(app.session);
  await app.turn('and this: green-iguana');
  const seenClaude = JSON.parse(fs.readFileSync(path.join(root, 'last-seen'), 'utf8'));
  assert.equal(seenClaude.name, 'qb');
  assert.equal(seenClaude.sawDigest, true, 'qb joins mid-conversation, so it gets the digest');
  assert.match(seenClaude.text, /purple-otter/, 'the digest carries what happened before qb joined');
});

test('text-dialect CLI works with no JSON protocol at all', async () => {
  reset({ order: ['tx'], backends: LAYOUT.backends });
  const { app } = ctx();
  const out = await app.turn('plain question');
  assert.equal(out.ok, true);
  assert.match(out.res.text, /\[tx\] plain/);
  const seen = JSON.parse(fs.readFileSync(path.join(root, 'last-seen-text'), 'utf8'));
  assert.equal(seen.digest, false, 'first turn needs no digest');
  assert.ok(seen.prompt.includes('relay'), 'project preamble still reaches a text-only CLI');
});

test('text-dialect CLI gets history inlined because it cannot resume', async () => {
  reset({ order: ['tx', 'jd'], backends: LAYOUT.backends });
  const { app } = ctx();
  await app.turn('remember alpha');
  await app.turn('remember beta');
  const seen = JSON.parse(fs.readFileSync(path.join(root, 'last-seen-text'), 'utf8'));
  assert.equal(seen.digest, true, 'no resume support means the digest travels every turn');
  assert.match(seen.prompt, /alpha/);
});

test('AGENTS.md carries a replaceable progress block', async () => {
  reset();
  const { app } = ctx();
  await app.turn('we chose SQLite for storage');
  const r = app.sync();
  const text = fs.readFileSync(r.file, 'utf8');
  assert.match(text, /# Project rules/, 'existing instructions survive');
  assert.match(text, /SQLite for storage/);
  app.sync();
  const again = fs.readFileSync(r.file, 'utf8');
  assert.equal((again.match(/relay:progress/g) || []).length, 2, 'block is replaced, not appended');
  const injected = store.agentsContext(CWD);
  assert.match(injected, /Use pnpm/);
  assert.doesNotMatch(injected, /relay:progress/, 'the machine block is not fed back as instructions');
});

test('priority order is user-settable and survives reload', async () => {
  reset();
  const { registry } = ctx();
  assert.deepEqual(registry.all, ['qc', 'jd', 'tx']);
  registry.setOrder(['tx', 'qc', 'jd']);
  const r2 = new Registry(loadConfig().home, loadConfig());
  assert.deepEqual(r2.all, ['tx', 'qc', 'jd']);
  assert.equal(r2.pick(), 'tx');
});

test('newly added backends appear in the order without a restart', async () => {
  reset({ order: ['qc'], backends: { qc: LAYOUT.backends.qc } });
  const config = loadConfig();
  const registry = new Registry(config.home, config);
  assert.deepEqual(registry.all, ['qc']);
  const { classify, save } = require('../lib/connect');
  const { def } = classify('junie', fs.readFileSync(path.join(DIR, 'fixtures/junie-help.txt'), 'utf8'), '/usr/local/bin/junie');
  save(config, registry, 'junie', def);
  assert.deepEqual(registry.all, ['qc', 'junie']);
  assert.equal(config.backends.junie.dialect, 'junie');
});

test('cooldown vs hard credit marks', async () => {
  reset();
  const { registry } = ctx();
  registry.markExhausted('jd', { hard: false, minutes: 10, reason: 'timeout' });
  assert.equal(registry.pick(), 'qc', 'soft mark only skips that CLI');
  registry.reset('jd');
  registry.markExhausted('jd', { hard: true, reason: 'credits' });
  registry.markExhausted('qc', { hard: true, reason: 'credits' });
  assert.equal(registry.pick(), 'tx');
  registry.reset();
  assert.equal(registry.pick(), 'qc');
});

test('every CLI keeps its own session id in the shared transcript', async () => {
  reset();
  const { app, session } = ctx();
  await app.turn('one');
  app.registry.reset('qc');
  app.session.header.lastBackend = null;
  await app.turn('two');
  assert.ok(session.header.backendSessions.jd, 'junie session recorded');
  const reopened = store.openSession(session.file);
  assert.equal(reopened.entries.length, 4);
  assert.deepEqual(Object.keys(reopened.header.backendSessions).sort(), ['jd']);
});

test('a pinned CLI takes the next turns, but a dead pin still falls over', async () => {
  reset();
  const { app, session } = ctx();
  await app.turn('warm up');
  session.header.lastBackend = 'tx';
  store.rewriteHeader(session);
  const pinned = await app.turn('ask tx directly');
  assert.equal(pinned.backend, 'tx', 'the pin wins over the priority order');
  const seen = JSON.parse(fs.readFileSync(path.join(root, 'last-seen-text'), 'utf8'));
  assert.match(seen.prompt, /ask tx directly/);
  session.header.lastBackend = 'qc';
  store.rewriteHeader(session);
  app.registry.reset('qc');
  const fallen = await app.turn('pin an out-of-credits cli');
  assert.equal(fallen.ok, true);
  assert.notEqual(fallen.backend, 'qc', 'a credit failure moves to the next CLI');
});

test('a path in a prompt is not mistaken for a slash command', async () => {
  const { isCommand } = require('../lib/tui');
  assert.ok(isCommand('/priority jd tx'));
  assert.ok(isCommand('/quit'));
  assert.ok(!isCommand('/Users/n00b/Coding/app/src/index.ts has a bug'), 'absolute paths go to the CLI');
  assert.ok(!isCommand('./lib/ui.js looks wrong'));
  assert.ok(!isCommand('https://x.dev and /help'));
});

test('a successful reply that merely mentions credits is not a failure', async () => {
  reset({ order: ['qb'], backends: { qb: fake('fake-claude.js', 'qb', 'ok', 'claude') } });
  const { app, registry } = ctx();
  const out = await app.turn('out of credits — what does that error actually mean?');
  assert.equal(out.ok, true, 'talking about credits is not running out of them');
  assert.match(out.res.text, /out of credits/);
  assert.equal(registry.exhausted.qb, undefined, 'no credit mark from a clean turn');
});

test('a connected CLI with no custom signals still detects running out', async () => {
  reset({ order: ['plain'], backends: { plain: { command: 'plain-cli', dialect: 'text', quota: [], auth: [] } } });
  const { QUOTA_PATTERNS } = require('../lib/config');
  const config = loadConfig();
  assert.ok(config.backends.plain.quota.length >= QUOTA_PATTERNS.length, 'the built-in credit patterns are not lost');
  const { QuotaDetector } = require('../lib/probe');
  const d = new QuotaDetector(config.backends.plain.quota);
  assert.ok(d.feed('Error: insufficient quota for this account'), 'a fresh connection can fail over on the first try');
});

test('the connect wizard probes, offers a protocol pick, and saves in order', async () => {
  reset();
  const config = loadConfig();
  const registry = new Registry(config.home, config);
  const shim = path.join(root, 'cli-shim');
  fs.writeFileSync(shim, `#!/bin/sh\nFAKE_STATE_DIR=${root} exec ${process.execPath} ${path.join(DIR, 'fake-junie.js')} "$@"\n`);
  fs.chmodSync(shim, 0o755);

  const answers = ['mycli', shim, '', '', 'y', 'y'];
  const asked = [];
  const { wizard } = require('../lib/connect');
  const out = await wizard({
    ask: (q) => {
      asked.push(q);
      return Promise.resolve(answers.shift());
    },
    confirm: (q) => {
      asked.push(q);
      return Promise.resolve(answers.shift() === 'y');
    },
    note: () => {},
    cwd: CWD,
    registry,
    config,
  });
  assert.equal(out.name, 'mycli');
  assert.equal(config.backends.mycli.dialect, 'junie');
  assert.ok(asked.some((q) => /protocol/.test(q)), 'an inconclusive probe offers an explicit protocol pick');
  assert.ok(asked.some((q) => /ask mycli before/.test(q)), 'the wizard asks where it belongs in the order');
  assert.equal(registry.all[0], 'mycli');
  const reopened = loadConfig();
  assert.equal(reopened.backends.mycli.command, shim, 'survives a restart');
  assert.ok(reopened.backends.mycli.quota.length >= 8);
});

test('slash commands are catalogued per CLI', async () => {
  reset();
  const { app, registry } = ctx();
  app.registry.reset('qc');
  await app.turn('collect commands');
  assert.deepEqual(registry.commands('qc'), ['auth', 'compact', 'resume', 'usage']);
  assert.ok(registry.allCommands().qc);
});

test('past sessions are referenceable across directories', async () => {
  reset();
  const other = path.join(root, 'elsewhere');
  fs.mkdirSync(other, { recursive: true });
  const a = ctx(CWD);
  await a.app.turn('design decision: blue-print-42');
  const b = ctx(other);
  b.app.addRef(a.session.header.sid);
  assert.match(b.app.refsBlock(), /blue-print-42/);
  assert.match(b.app.systemPrompt('jd'), /Referenced past sessions/);
  const found = store.findSession(b.config.home, a.session.header.sid.slice(0, 8));
  assert.equal(found.sid, a.session.header.sid, 'resolvable from another project');
  b.app.removeRef(a.session.header.sid.slice(0, 8));
  assert.equal(b.app.session.header.refs.length, 0);
});

test('protocol classification is probed against real help output', async () => {
  const { classify, candidates } = require('../lib/connect');
  const { detectDialect } = require('../lib/dialects');
  const junieHelp = fs.readFileSync(path.join(DIR, 'fixtures/junie-help.txt'), 'utf8');
  const qwenHelp = fs.readFileSync(path.join(DIR, 'fixtures/qwen-help.txt'), 'utf8');
  const claudeHelp = fs.readFileSync(path.join(DIR, 'fixtures/claude-help.txt'), 'utf8');
  const dumbHelp = fs.readFileSync(path.join(DIR, 'fixtures/foreign-help.txt'), 'utf8');

  assert.equal(detectDialect(qwenHelp), 'claude', 'qwen speaks the stream-json family');
  assert.equal(detectDialect(junieHelp), 'junie');
  assert.equal(detectDialect(dumbHelp), 'text');

  assert.deepEqual(candidates(qwenHelp), ['claude', 'text']);
  assert.deepEqual(candidates(junieHelp), ['junie', 'text']);
  assert.deepEqual(candidates(dumbHelp), ['text']);

  const q = classify('qwen', qwenHelp);
  assert.equal(q.dialect, 'claude');
  assert.deepEqual(q.def.protocol.args, ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json']);
  assert.deepEqual(q.def.protocol.resumeArgs, ['-r']);
  assert.deepEqual(q.def.protocol.systemArgs, [], 'qwen has no --append-system-prompt-file, so instructions are inlined');

  const cl = classify('claude', claudeHelp);
  assert.deepEqual(cl.def.protocol.systemArgs, ['--append-system-prompt-file']);

  const j = classify('junie', junieHelp);
  assert.equal(j.dialect, 'junie');
  assert.ok(j.def.protocol.preArgs.includes('--output-format=json-stream'));

  const d = classify('dumb', dumbHelp);
  assert.equal(d.dialect, 'text');
  assert.deepEqual(d.def.protocol.args, ['-p']);
});

test('a missing binary reports spawn failure, not silence', async () => {
  reset({ order: ['ghost'], backends: { ghost: { command: '/no/such/cli-binary', dialect: 'claude' } } });
  const { app } = ctx();
  const out = await app.turn('anything');
  assert.equal(out.ok, false);
  assert.ok(['spawn', 'noresult'].includes(out.res.kind), `expected spawn failure, got ${out.res.kind}`);
});

test('interrupting a turn stops there and does not fail over', async () => {
  reset({ order: ['slow'], backends: { slow: { command: process.execPath, prefixArgs: [path.join(DIR, 'fake-slow.js')], dialect: 'claude', env: { FAKE_STATE_DIR: root } } } });
  const { app } = ctx();
  const pending = app.turn('take your time');
  setTimeout(() => app.abort && app.abort(), 300);
  const out = await pending;
  assert.equal(out.ok, false);
  assert.equal(out.aborted, true);
  assert.equal(out.res.kind, 'aborted');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${name}\n       ${String(err.message).split('\n').join('\n       ')}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
