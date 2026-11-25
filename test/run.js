process.env.NO_COLOR = '1';
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

test('failed turns are written to the relay log', async () => {
  const log = require('../lib/log');
  reset({ order: ['ghost'], backends: { ghost: { command: '/no/such/cli-binary', dialect: 'claude' } } });
  const { app } = ctx();
  await app.turn('anything');
  assert.ok(log.tail(10).some((l) => /turn failed on ghost/.test(l)), 'expected a "turn failed" line in relay.log');
});

test('relay --new starts a fresh session instead of continuing the last one', () => {
  const { spawnSync } = require('child_process');
  const run = (...args) => spawnSync(process.execPath, [path.join(DIR, '..', 'bin', 'relay.js'), ...args], { cwd: CWD, encoding: 'utf8', input: '/exit\n', env: { ...process.env, NO_COLOR: '1' } });
  const sid = (out) => ((out.stdout || '').match(/session ([0-9a-f]{8}) saved/) || [])[1];
  const a = sid(run());
  const b = sid(run());
  const c = sid(run('--new'));
  assert.ok(a && a === b, 'plain relay should continue the same session');
  assert.ok(c && c !== a, '--new should create a different session');
});

test('a full-screen app is driven through a pseudo-terminal and its reply is read off the screen', async () => {
  const { runPty } = require('../lib/ptyrun');
  const def = { command: process.execPath, pty: { cols: 100, rows: 24, startupMs: 8000, quietMs: 400, idleMs: 900, minWaitMs: 500 } };
  const r = await runPty({ def, args: [path.join(DIR, 'fake-tui.js')], prompt: 'Reply with exactly the nine characters: RELAY_OK', cwd: CWD, env: process.env, timeoutMs: 30000 });
  assert.equal(r.ok, true, `kind=${r.kind} raw=${r.raw}`);
  assert.equal(r.text, 'RELAY_OK', `got: ${JSON.stringify(r.text)}`);
});

test('pty backend returns a normal result through Backend.run, with multi-line prompts', async () => {
  const { Backend } = require('../lib/backend');
  const def = { command: process.execPath, dialect: 'pty', protocol: { args: [path.join(DIR, 'fake-tui.js')] }, pty: { cols: 100, rows: 24, startupMs: 8000, quietMs: 400, idleMs: 900, minWaitMs: 500 }, quota: [], auth: [] };
  const res = await new Backend(def, { timeoutMs: 30000 }).run({ prompt: 'first line\nsecond line please echo', digest: '', systemPrompt: '', cwd: CWD });
  assert.equal(res.ok, true, `kind=${res.kind} raw=${res.raw}`);
  assert.match(res.text, /ECHO: .*please echo/);
  assert.equal(res.dialect, 'pty');
});

test('an app that objects to scripted use is reported as blocked, not as an answer', async () => {
  const { Backend } = require('../lib/backend');
  const def = { command: process.execPath, dialect: 'pty', protocol: { args: [path.join(DIR, 'fake-tui.js')] }, env: { FAKE_REPLY: 'Error: this message breaks the usage policy (Scripted or automated use). Strike 1 today.' }, pty: { cols: 100, rows: 24, startupMs: 8000, quietMs: 400, idleMs: 900, minWaitMs: 500 }, quota: [], auth: [] };
  const res = await new Backend(def, { timeoutMs: 30000 }).run({ prompt: 'hello there friend', digest: '', systemPrompt: '', cwd: CWD });
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'blocked');
});

test('agent assignment runs on its pinned cli + model and persists the session', async () => {
  const qc = { command: process.execPath, prefixArgs: [path.join(DIR, 'fake-claude.js')], dialect: 'claude', env: { FAKE_MODE: 'ok', FAKE_NAME: 'qc', FAKE_STATE_DIR: root } };
  reset({ order: ['qc', 'jd', 'tx'], backends: { qc, jd: LAYOUT.backends.jd, tx: LAYOUT.backends.tx } });
  const config = loadConfig();
  const registry = new Registry(config.home, config);
  const cwdA = path.join(root, 'repo-a');
  fs.mkdirSync(cwdA, { recursive: true });
  const agent = new (require('../lib/agent').Agent)({ name: 'alpha', backend: 'qc', model: 'sonnet-4', cwd: cwdA, home: config.home, config, registry });
  const out = await agent.turn('deploy the login feature');
  assert.equal(out.ok, true);
  assert.equal(out.backend, 'qc');
  assert.match(out.res.text, /\[qc\]/);
  const seen = JSON.parse(fs.readFileSync(path.join(root, 'last-seen'), 'utf8'));
  assert.ok(seen.argv.includes('-m') && seen.argv.includes('sonnet-4'), 'model flag travels to the CLI');
  assert.equal(agent.sessionId, sessionIdOf(agent), 'session id recorded');
  const listed = require('../lib/agent').listAgents(config.home);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'alpha');
  assert.equal(listed[0].backend, 'qc');
  assert.equal(listed[0].model, 'sonnet-4');
  assert.equal(listed[0].cwd, cwdA);
});

test('re-running an agent resumes its own session natively instead of re-sending the digest', async () => {
  reset();
  const config = loadConfig();
  const registry = new Registry(config.home, config);
  const cwdB = path.join(root, 'repo-b');
  fs.mkdirSync(cwdB, { recursive: true });
  const agent = new (require('../lib/agent').Agent)({ name: 'beta', backend: 'jd', model: null, cwd: cwdB, home: config.home, config, registry });
  await agent.turn('remember delta');
  const firstSid = agent.sessionId;
  await agent.turn('remember epsilon');
  const seen = JSON.parse(fs.readFileSync(path.join(root, 'last-seen-junie'), 'utf8'));
  assert.equal(seen.resumed, true, 'second turn passes --session-id');
  assert.equal(seen.digest, false, 'no digest on native resume');
  assert.equal(agent.sessionId, firstSid, 'same session across turns');
});

test('agent pins its cli so a credit failure on it does not silently fail over', async () => {
  reset({ order: ['qc', 'jd'], backends: { qc: LAYOUT.backends.qc, jd: LAYOUT.backends.jd } });
  const config = loadConfig();
  const registry = new Registry(config.home, config);
  const cwdC = path.join(root, 'repo-c');
  fs.mkdirSync(cwdC, { recursive: true });
  // qc is out of credits; agent beta pinned to jd should still answer on jd
  registry.markExhausted('qc', { hard: true, reason: 'credits' });
  const agent = new (require('../lib/agent').Agent)({ name: 'gamma', backend: 'jd', model: null, cwd: cwdC, home: config.home, config, registry });
  const out = await agent.turn('override on jd');
  assert.equal(out.ok, true);
  assert.equal(out.backend, 'jd');
  assert.match(out.res.text, /\[jd\]/);
});

test('built-in configurations exist for widely used coding CLIs', async () => {
  const { BUILTIN_BACKENDS } = require('../lib/config');
  const expected = [
    'agy', 'claude', 'kilo', 'freebuff', 'qwen', 'junie', 'opencode',
    'aider', 'cursor', 'copilot', 'ollama', 'gemini', 'openai', 'goose',
    'cody', 'openhands', 'llm', 'sgpt', 'mentat', 'plandex', 'cline', 'amazon-q'
  ];
  for (const name of expected) {
    assert.ok(BUILTIN_BACKENDS[name], `preset for ${name} exists`);
    assert.ok(BUILTIN_BACKENDS[name].command, `${name} has a command`);
    assert.ok(BUILTIN_BACKENDS[name].dialect, `${name} has a dialect`);
    assert.ok(BUILTIN_BACKENDS[name].quota?.length > 0, `${name} has quota signals`);
  }
});

test('scanner detects installed CLIs and reports their paths', async () => {
  const { scanInstalledCLIs } = require('../lib/scanner');
  const results = scanInstalledCLIs();
  assert.ok(Array.isArray(results));
  assert.ok(results.length >= 7);
  const agy = results.find((r) => r.name === 'agy');
  assert.ok(agy);
  assert.equal(agy.label, 'Antigravity (Google)');
  assert.equal(agy.freeTier, true);
});

test('credit pool round-robin strategy balances turns across ready backends', async () => {
  reset({
    order: ['b1', 'b2'],
    strategy: 'pool',
    backends: {
      b1: fake('fake-junie.js', 'b1', 'ok', 'junie'),
      b2: fake('fake-junie.js', 'b2', 'ok', 'junie'),
    },
  });
  const { app, registry } = ctx();
  assert.equal(registry.getStrategy(), 'pool');

  // First turn picks one
  const first = await app.turn('turn 1');
  assert.ok(first.ok);
  const firstBackend = first.backend;

  // Second turn picks the other backend under pool strategy!
  const second = await app.turn('turn 2');
  assert.ok(second.ok);
  const secondBackend = second.backend;

  assert.notEqual(firstBackend, secondBackend, 'pool strategy alternates backends to balance rate limits');
});

test('free-first strategy prioritizes free tiers before paid credits', async () => {
  reset({
    order: ['paid1', 'free1'],
    strategy: 'free-first',
    backends: {
      paid1: { ...fake('fake-junie.js', 'paid1', 'ok', 'junie'), freeTier: false },
      free1: { ...fake('fake-junie.js', 'free1', 'ok', 'junie'), freeTier: true },
    },
  });
  const { app, registry } = ctx();
  assert.equal(registry.getStrategy(), 'free-first');

  const picked = registry.pick();
  assert.equal(picked, 'free1', 'free-first strategy selects free tier CLI before paid CLI');
});

test('creditStatus tracks turns, quota hits, and cooldown countdown', async () => {
  reset({
    order: ['c1'],
    backends: {
      c1: { ...fake('fake-junie.js', 'c1', 'ok', 'junie'), label: 'Test Provider', freeTier: true },
    },
  });
  const { app, registry } = ctx();
  await app.turn('count turns');

  const status = registry.creditStatus();
  assert.equal(status.length, 1);
  assert.equal(status[0].name, 'c1');
  assert.equal(status[0].label, 'Test Provider');
  assert.equal(status[0].turns, 1);
  assert.equal(status[0].state, 'ready');
  assert.equal(status[0].successRate, '100%');
});

test('server API provides status, backend credit stats, and strategy updating', async () => {
  const { createServerInstance } = require('../lib/server');
  const instance = createServerInstance({ cwd: CWD, home: process.env.RELAY_HOME });
  const server = instance.server;
  const { Readable, Writable } = require('stream');

  const dispatchReq = ({ method = 'GET', url = '/', body = null } = {}) =>
    new Promise((resolve) => {
      const payload = body ? JSON.stringify(body) : null;
      let sent = false;
      const req = new Readable({
        read() {
          if (!sent && payload) {
            this.push(payload);
            sent = true;
          }
          this.push(null);
        },
      });
      req.method = method;
      req.url = url;
      req.headers = { host: 'localhost', 'content-type': 'application/json' };

      let chunks = '';
      const res = new Writable({
        write(chunk, enc, cb) {
          chunks += chunk.toString();
          cb();
        },
      });
      res.setHeader = () => {};
      res.writeHead = (code) => {
        res.statusCode = code;
      };
      res.end = (finalChunk) => {
        if (finalChunk) chunks += finalChunk.toString();
        try {
          resolve({ status: res.statusCode || 200, data: JSON.parse(chunks) });
        } catch {
          resolve({ status: res.statusCode || 200, raw: chunks });
        }
      };

      server.emit('request', req, res);
    });

  const status = await dispatchReq({ url: '/api/status' });
  assert.equal(status.status, 200);
  assert.equal(status.data.ok, true);
  assert.ok(status.data.backends.length > 0);

  const setStrat = await dispatchReq({ method: 'POST', url: '/api/strategy', body: { strategy: 'pool' } });
  assert.equal(setStrat.status, 200);
  assert.equal(setStrat.data.ok, true);
  assert.equal(setStrat.data.strategy, 'pool');
});

test('parseMultiStepPrompt parses numbered steps with explicit backend & model', async () => {
  const { parseMultiStepPrompt } = require('../lib/multistep');
  const input = `
    1. [@claude/claude-3-7-sonnet] Plan the database architecture
    2. [@qwen] Write the SQL migration queries
    3. [@freebuff] Create unit tests for models
  `;
  const parsed = parseMultiStepPrompt(input, ['claude', 'qwen', 'freebuff']);
  assert.equal(parsed.isMultiStep, true);
  assert.equal(parsed.steps.length, 3);
  assert.equal(parsed.steps[0].backend, 'claude');
  assert.equal(parsed.steps[0].model, 'claude-3-7-sonnet');
  assert.equal(parsed.steps[1].backend, 'qwen');
  assert.equal(parsed.steps[2].backend, 'freebuff');
});

test('parseMultiStepPrompt parses delimited blocks with @backend', async () => {
  const { parseMultiStepPrompt } = require('../lib/multistep');
  const input = `
    @claude
    Design the API contract and endpoints
    ---
    @kilo
    Implement the Express route handlers
    ---
    @junie
    Run verification and test coverage
  `;
  const parsed = parseMultiStepPrompt(input);
  assert.equal(parsed.isMultiStep, true);
  assert.equal(parsed.type, 'delimited');
  assert.equal(parsed.steps.length, 3);
  assert.equal(parsed.steps[0].backend, 'claude');
  assert.equal(parsed.steps[1].backend, 'kilo');
  assert.equal(parsed.steps[2].backend, 'junie');
});

test('parseMultiStepPrompt parses pipeline arrows and auto-assigns roles', async () => {
  const { parseMultiStepPrompt } = require('../lib/multistep');
  const arrowInput = '[claude] Plan system -> [qwen] Write code -> [freebuff] Write tests';
  const parsedArrow = parseMultiStepPrompt(arrowInput);
  assert.equal(parsedArrow.isMultiStep, true);
  assert.equal(parsedArrow.type, 'pipeline');
  assert.equal(parsedArrow.steps.length, 3);
  assert.equal(parsedArrow.steps[0].backend, 'claude');
  assert.equal(parsedArrow.steps[1].backend, 'qwen');
  assert.equal(parsedArrow.steps[2].backend, 'freebuff');

  // Semantic natural language steps
  const nlInput = `
    Step 1: Plan and architect the new caching system
    Step 2: Write the implementation in redis.js
    Step 3: Test and assert edge case performance
  `;
  const parsedNl = parseMultiStepPrompt(nlInput, ['agy', 'kilo', 'freebuff']);
  assert.equal(parsedNl.isMultiStep, true);
  assert.equal(parsedNl.steps.length, 3);
  assert.equal(parsedNl.steps[0].backend, 'agy'); // auto-assigned plan
  assert.equal(parsedNl.steps[1].backend, 'kilo'); // auto-assigned code
  assert.equal(parsedNl.steps[2].backend, 'freebuff'); // auto-assigned test
});

test('app.turn delivers multi-step prompts to different backends sequentially', async () => {
  reset({
    order: ['qc', 'jd'],
    backends: {
      qc: fake('fake-claude.js', 'qc', 'ok', 'claude'),
      jd: fake('fake-junie.js', 'jd', 'ok', 'junie'),
    },
  });
  const { app } = ctx();

  const multiPrompt = `
    1. [@qc] Outline the plan
    2. [@jd] Implement the feature based on that plan
  `;

  const stepsVisited = [];
  const hooks = {
    onStepStart: ({ stepNumber, backend }) => stepsVisited.push({ stepNumber, backend }),
  };

  const res = await app.turn(multiPrompt, hooks);
  assert.equal(res.ok, true);
  assert.equal(res.isMultiStep, true);
  assert.equal(res.totalSteps, 2);
  assert.equal(stepsVisited.length, 2);
  assert.equal(stepsVisited[0].backend, 'qc');
  assert.equal(stepsVisited[1].backend, 'jd');
});

const auto = require('../lib/auto');

test('auto: local splitter separates tasks, classifies them and orders dependencies', async () => {
  const tasks = auto.heuristicSplit('fix the crash on startup, add a dark theme to the app, then write tests for both. Also review the auth code for security problems');
  assert.deepEqual(tasks.map((t) => t.type), ['debug', 'code', 'test', 'review']);
  assert.deepEqual(tasks[1].dependsOn, [], 'unrelated work does not wait');
  assert.deepEqual(tasks[2].dependsOn, ['t1', 't2'], 'tests wait for the changes');
  assert.equal(tasks[3].difficulty, 'hard');
  assert.equal(tasks[3].writes, false);
  assert.equal(auto.classify('review the parser and fix what you find'), 'debug', 'a review that fixes must be able to write');
  assert.equal(auto.heuristicSplit('fix the login bug. It happens on Safari.').length, 1, 'detail stays with its task');
});

test('auto: local splitter keeps list preambles and never drops items past the cap', async () => {
  const listed = auto.heuristicSplit('Use pnpm only.\n- add a settings page\n- document the settings page');
  assert.equal(listed.length, 2);
  assert.ok(listed.every((t) => t.prompt.startsWith('Use pnpm only.')));
  const many = auto.heuristicSplit(Array.from({ length: 15 }, (_, i) => `- add widget${i + 1}`).join('\n'));
  assert.equal(many.length, 12);
  assert.match(many[11].prompt, /widget15/);
});

test('auto: planner output is repaired into an ordered, acyclic task list', async () => {
  const tasks = auto.normalizeTasks([
    { id: 'b', prompt: 'write tests', type: 'test', dependsOn: ['a', 'ghost', 'b'] },
    { id: 'a', prompt: 'add the feature', type: 'nonsense', difficulty: 'extreme' },
  ]);
  assert.deepEqual(tasks.map((t) => t.prompt), ['add the feature', 'write tests']);
  assert.deepEqual(tasks[1].dependsOn, ['t1']);
  assert.equal(tasks[0].type, 'code');
  assert.equal(tasks[0].difficulty, 'medium');
  const cycle = auto.normalizeTasks([{ id: 'x', prompt: 'one', dependsOn: ['y'] }, { id: 'y', prompt: 'two', dependsOn: ['x'] }]);
  assert.deepEqual(cycle.map((t) => t.dependsOn), [[], ['t1']]);
  assert.equal(auto.normalizeTasks([{ id: 'a' }]), null);
});

const TIERS = (p) => ({ light: `${p}-small`, standard: `${p}-mid`, heavy: `${p}-big` });

test('auto: a planner splits the work, each task gets an agent, cli and model, and results flow on', async () => {
  const qa = { ...fake('fake-claude.js', 'qa', 'planner', 'claude'), models: TIERS('qa'), modelFlag: '--model' };
  qa.env.FAKE_PLAN = JSON.stringify({ tasks: [
    { id: 't1', title: 'find the bug', prompt: 'investigate the bug', type: 'research', difficulty: 'hard' },
    { id: 't2', title: 'fix it', prompt: 'fix the bug', type: 'debug', difficulty: 'easy', dependsOn: ['t1'] },
  ] });
  reset({ order: ['qa'], backends: { qa } });
  const { app, session, config } = ctx();
  const plan = await auto.createPlan(app, 'find and fix the bug');
  assert.equal(plan.source, 'planner');
  assert.deepEqual(plan.tasks.map((t) => [t.agent, t.backend, t.model]), [['auto-researcher', 'qa', 'qa-big'], ['auto-debugger', 'qa', 'qa-small']]);
  const planner = JSON.parse(fs.readFileSync(path.join(root, 'planner-argv'), 'utf8'));
  assert.equal(planner[planner.indexOf('--permission-mode') + 1], 'default');

  const done = await auto.runPlan(app, plan);
  assert.equal(done.ok, true);
  const seen = JSON.parse(fs.readFileSync(path.join(root, 'last-seen'), 'utf8'));
  assert.equal(seen.argv[seen.argv.indexOf('--model') + 1], 'qa-small', 'the assigned model reaches the CLI by its own flag');
  assert.match(seen.text, /## Result of t1/);
  const saved = JSON.parse(fs.readFileSync(path.join(config.home, '.relay', 'agents', 'auto-debugger.json'), 'utf8'));
  assert.equal(saved.model, 'qa-small');
  assert.equal(saved.auto, true);
  assert.equal(store.latestSession(config.home, CWD).sid, session.header.sid, 'relay -c still opens the main session');
});

test('auto: failover follows the task route and swaps to the next cli\'s own model', async () => {
  const qc = { ...fake('fake-claude.js', 'qc', 'quota', 'claude'), models: TIERS('qc') };
  const qb = { ...fake('fake-claude.js', 'qb', 'ok', 'claude'), models: TIERS('qb') };
  reset({ order: ['qc', 'qb'], backends: { qc, qb } });
  const { app } = ctx();
  const plan = await auto.createPlan(app, 'add a button', {}, { offline: true });
  assert.equal(plan.tasks[0].backend, 'qc');
  const done = await auto.runPlan(app, plan);
  assert.equal(done.results[0].backend, 'qb');
  assert.equal(done.results[0].model, 'qb-mid');
  const argv = JSON.parse(fs.readFileSync(path.join(root, 'last-seen'), 'utf8')).argv;
  assert.equal(argv[argv.indexOf('-m') + 1], 'qb-mid');
});

test('auto: read-only tasks never skip permissions, and a failed task skips only its dependents', async () => {
  const qb = fake('fake-claude.js', 'qb', 'ok', 'claude');
  reset({ order: ['qb'], backends: { qb } });
  const { app } = ctx();
  app.opts.skipPermissions = true;
  let plan = await auto.createPlan(app, 'review the parser', {}, { offline: true });
  await auto.runPlan(app, plan);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(root, 'last-seen'), 'utf8')).argv.includes('--dangerously-skip-permissions'));

  reset({ order: ['qc'], backends: { qc: LAYOUT.backends.qc } });
  const broken = ctx();
  plan = await auto.createPlan(broken.app, '- add a page\n- then style it\n- explain the router', {}, { offline: true });
  const done = await auto.runPlan(broken.app, plan);
  assert.equal(done.ok, false);
  assert.deepEqual(done.results.map((r) => Boolean(r.skipped)), [false, true, false]);
});

test('auto: writers run alone while read-only tasks run together', async () => {
  const qb = fake('fake-claude.js', 'qb', 'ok', 'claude');
  reset({ order: ['qb'], backends: { qb } });
  const { app } = ctx();
  const plan = await auto.createPlan(app, '- explain the router\n- explain the store\n- add a page\n- explain the parser', {}, { offline: true });
  for (const t of plan.tasks) t.dependsOn = [];
  let live = [];
  let peak = 0;
  await auto.runPlan(app, plan, {
    onTaskStart: (t) => {
      assert.ok(!live.some((o) => o.writes) && !(t.writes && live.length), 'a writer overlapped another task');
      live.push(t);
      peak = Math.max(peak, live.length);
    },
    onTaskEnd: (t) => (live = live.filter((o) => o.id !== t.id)),
  });
  assert.equal(peak, 2);
});

const tags = require('../lib/tags');
const skills = require('../lib/skills');
const { execFileSync } = require('child_process');
process.env.RELAY_USER_HOME = path.join(root, 'userhome');
const CLI = path.join(DIR, '..', 'bin', 'relay.js');
const lastSeen = () => JSON.parse(fs.readFileSync(path.join(root, 'last-seen'), 'utf8'));
const put = (rel, body) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};
const claudes = (...names) => ({ order: names, backends: Object.fromEntries(names.map((n) => [n, fake('fake-claude.js', n, 'ok', 'claude')])) });

test('tags: cli, cli:model and bare model names resolve, file mentions do not', async () => {
  const qa = { ...fake('fake-claude.js', 'qa', 'ok', 'claude'), models: { heavy: 'big-1.5' } };
  reset({ order: ['qa'], backends: { qa } });
  const { app } = ctx();
  assert.deepEqual(tags.resolveTag(app, '@qa'), { backend: 'qa', model: null });
  assert.deepEqual(tags.resolveTag(app, '@qa:vendor/m-2'), { backend: 'qa', model: 'vendor/m-2' });
  assert.deepEqual(tags.resolveTag(app, '@big-1.5'), { backend: 'qa', model: 'big-1.5' });
  assert.equal(tags.parseTagLine(app, '@src/app.js explain this'), null);
  assert.equal(tags.actionFor('/compact keep the plan').kind, 'slash');
  assert.equal(tags.actionFor('/Users/me/x.ts is broken').kind, 'prompt');
  assert.equal(tags.actionFor('open the file and fix it').kind, 'prompt');
  assert.deepEqual(tags.actionFor('open /model'), { kind: 'open', prompt: '/model' });
  assert.deepEqual(tags.actionFor('!mcp add "my server"').args, ['mcp', 'add', 'my server']);
  assert.equal(tags.actionFor('').kind, 'open');
  assert.deepEqual(tags.actionForArgv(['mcp', 'list', '--json']), { kind: 'exec', args: ['mcp', 'list', '--json'] });
  assert.equal(tags.actionForArgv(['explain this repo']).kind, 'prompt');
  assert.equal(tags.actionForArgv(['/cost']).kind, 'slash');
});

test('tags: a slash command reaches the cli exactly as typed, even without a system flag', async () => {
  const qa = fake('fake-claude.js', 'qa', 'ok', 'claude');
  qa.protocol = { systemArgs: [] };
  reset({ order: ['qa'], backends: { qa } });
  const { app } = ctx();
  const res = await tags.runSlash(app, 'qa', '/compact keep the plan', { model: 'm-1' });
  assert.equal(res.ok, true);
  assert.equal(lastSeen().text, '/compact keep the plan');
  assert.equal(lastSeen().argv[lastSeen().argv.indexOf('-m') + 1], 'm-1');
});

test('tags: a direct command never fails over to another cli', async () => {
  reset({ order: ['qc', 'qb'], backends: { qc: LAYOUT.backends.qc, qb: fake('fake-claude.js', 'qb', 'ok', 'claude') } });
  fs.rmSync(path.join(root, 'last-seen'), { force: true });
  const { app } = ctx();
  assert.equal((await tags.runSlash(app, 'qc', '/usage')).ok, false);
  const out = await app.turn('hello', {}, tags.routeTo(app, { backend: 'qc' }));
  assert.equal(out.ok, false);
  assert.equal(fs.existsSync(path.join(root, 'last-seen')), false, 'qb must not have been asked');
});

test('tags: a tagged prompt leaves the current cli as it was', async () => {
  reset(claudes('qa', 'qb'));
  const { app } = ctx();
  await app.turn('start');
  const out = await tags.keepingPin(app, () => app.turn('just this one', {}, tags.routeTo(app, { backend: 'qb', model: 'm-9' })));
  assert.equal(out.backend, 'qb');
  assert.equal(app.backendName, 'qa');
});

test('tags: relay @cli passes subcommands and their flags straight through', async () => {
  const echo = put('echo-args.js', 'console.log(JSON.stringify(process.argv.slice(2)))');
  reset({ order: ['ec'], backends: { ec: { command: process.execPath, baseArgs: [echo], dialect: 'text' } } });
  const out = execFileSync(process.execPath, [CLI, '@ec', 'mcp', 'list', '--json', '-x'], { cwd: CWD, env: process.env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), ['mcp', 'list', '--json', '-x']);
});

test('skills: folders, commands, toml and cursor rules all convert to one shape', async () => {
  reset();
  const { config } = ctx();
  put('src/Deep Review/SKILL.md', '---\nname: deep-review\ndescription: >\n  Review code\n  carefully\nallowed-tools: Bash\n---\nRead ${CLAUDE_SKILL_DIR}/list.txt\n');
  put('src/Deep Review/list.txt', 'items');
  put('secret.txt', 'private');
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(root, 'src/Deep Review/link.txt'));
  const [folder] = skills.importSkills(config.home, path.join(root, 'src/Deep Review')).imported;
  assert.equal(folder.name, 'deep-review');
  assert.equal(folder.description, 'Review code carefully');
  assert.ok(fs.existsSync(path.join(folder.dir, 'list.txt')));
  assert.equal(fs.existsSync(path.join(folder.dir, 'link.txt')), false, 'links are never followed');
  assert.match(folder.notes.join(' '), /allowed-tools.*symbolic links/s);
  assert.ok(skills.expand(folder, 'x').includes(`${folder.dir}/list.txt`));

  const [command] = skills.importSkills(config.home, put('src/fix-issue.md', '# Fix\nFix issue $1. Details: $ARGUMENTS\n')).imported;
  assert.match(skills.expand(command, '42 now'), /Fix issue 42\. Details: 42 now/);
  const [toml] = skills.importSkills(config.home, put('src/explain.toml', 'description = "Explain it"\nprompt = """\nExplain {{args}} simply.\n"""\n')).imported;
  assert.match(skills.expand(toml, 'the router'), /Explain the router simply/);
  const [rule] = skills.importSkills(config.home, put('src/style.mdc', '---\ndescription: House style\nglobs: "*.ts"\n---\nUse tabs. Cost is $1.\n')).imported;
  assert.match(skills.expand(rule), /Cost is \$1/, 'only commands treat $1 as an argument');

  assert.throws(() => skills.importSkills(config.home, put('other/explain.md', 'different')), /already exists/);
  assert.throws(() => skills.importSkills(config.home, put('src/data.json', '{}')), /can't convert/);
  assert.equal(skills.load(config.home, '../..'), null);
});

test('skills: export covers each cli folder, and never touches skills relay did not write', async () => {
  reset();
  const { config } = ctx();
  skills.importSkills(config.home, path.dirname(put('exp/tidy/SKILL.md', '---\nname: tidy\ndescription: Tidy up\n---\nTidy.\n')));
  const mine = put('userhome/.junie/skills/tidy/SKILL.md', 'my own');
  const out = skills.exportSkill(config.home, 'tidy', ['claude', 'qwen', 'junie']);
  assert.equal(out.written.length, 2);
  assert.equal(out.skipped.length, 1);
  assert.equal(fs.readFileSync(mine, 'utf8'), 'my own');
  assert.ok(fs.existsSync(path.join(root, 'userhome/.agents/skills/tidy/SKILL.md')));
  assert.equal(skills.exportSkill(config.home, 'tidy', ['claude']).written.length, 1, 're-export replaces its own copy');
  assert.equal(skills.remove(config.home, 'tidy').removed.length, 2);
  assert.equal(fs.readFileSync(mine, 'utf8'), 'my own');
});

test('skills: every cli is told what skills exist, and /name runs one in the shell', async () => {
  fs.rmSync(path.join(process.env.RELAY_HOME, 'skills'), { recursive: true, force: true });
  reset(claudes('qa'));
  const { app, config } = ctx();
  skills.importSkills(config.home, path.dirname(put('idx/haiku/SKILL.md', '---\nname: haiku\ndescription: Write a haiku\n---\n1. count syllables\n2. write about $ARGUMENTS\n')));
  assert.match(app.systemPrompt('qa'), /Relay skills[\s\S]*haiku: Write a haiku/);

  const dir = path.join(root, 'shellproj');
  fs.mkdirSync(dir, { recursive: true });
  const shell = (line) => execFileSync(process.execPath, [CLI], { cwd: dir, input: `${line}\n/quit\n`, env: process.env, encoding: 'utf8' });
  shell('/haiku the sea');
  assert.match(lastSeen().text, /<skill name="haiku">[\s\S]*write about the sea/);
  assert.doesNotMatch(lastSeen().text, /Multi-Step Workflow/, 'numbered steps in a skill are not a pipeline');
  shell('@qa /haiku rain');
  assert.match(lastSeen().text, /write about rain/);
  shell('@qa /status');
  assert.ok(lastSeen().text.endsWith('/status'), 'a command that is not a skill goes to the cli');
  const entries = store.openSession(store.latestSession(config.home, fs.realpathSync(dir)).file).entries;
  assert.ok(entries.some((e) => e.kind === 'user' && e.text === '/haiku the sea'), 'the transcript keeps the short form');
});

test('desktop app: tags, skills and /auto work there just as in the terminal', async () => {
  fs.rmSync(path.join(process.env.RELAY_HOME, 'skills'), { recursive: true, force: true });
  reset(claudes('qa', 'qb'));
  const { config } = ctx();
  skills.importSkills(config.home, path.dirname(put('web/rhyme/SKILL.md', '---\nname: rhyme\ndescription: Rhyme it\n---\nRhyme about $ARGUMENTS\n')));
  const { createServerInstance } = require('../lib/server');
  const dir = path.join(root, 'webproj');
  fs.mkdirSync(dir, { recursive: true });
  const web = createServerInstance({ cwd: dir });
  const { url } = await web.listen(0);
  const send = async (prompt) => (await fetch(`${url}/api/prompt`, { method: 'POST', body: JSON.stringify({ prompt }) })).text();
  try {
    await send('@qb hello there');
    assert.equal(lastSeen().name, 'qb');
    await send('@qb /usage');
    assert.equal(lastSeen().text, '/usage');
    await send('/rhyme cats');
    assert.match(lastSeen().text, /Rhyme about cats/);
    assert.match(await send('/skill list'), /\/rhyme/);
    assert.match(await send('/auto --offline --dry-run add a page'), /Auto plan[\s\S]*auto-coder/);
    fs.rmSync(path.join(root, 'last-seen'), { force: true });
    assert.match(await send('@qa !mcp list'), /needs a terminal/);
    assert.match(await send('/skill remove rhyme'), /in a terminal/);
    assert.match(await send('/nonsense'), /isn't available/);
    assert.equal(fs.existsSync(path.join(root, 'last-seen')), false, 'none of those reach a CLI');
    assert.ok(skills.load(config.home, 'rhyme'));
  } finally {
    await web.close();
  }
});

test('desktop server refuses other websites and rebound host names', async () => {
  reset(claudes('qa'));
  const { createServerInstance } = require('../lib/server');
  const web = createServerInstance({ cwd: CWD });
  const { port } = await web.listen(0);
  const status = (headers) =>
    new Promise((resolve, reject) => {
      require('http').get({ host: '127.0.0.1', port, path: '/api/status', headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
  try {
    assert.equal(await status({}), 200);
    assert.equal(await status({ origin: `http://127.0.0.1:${port}` }), 200);
    assert.equal(await status({ origin: 'https://example.com' }), 403);
    assert.equal(await status({ host: `attacker.example:${port}` }), 403);
  } finally {
    await web.close();
  }
});

test('scan keeps each cli\'s launch arguments, and text clis get no stream-json flags', async () => {
  reset();
  const config = loadConfig();
  assert.deepEqual(config.backends.qc.protocol.args.includes('stream-json'), true);
  fs.writeFileSync(path.join(process.env.RELAY_HOME, 'config.json'), JSON.stringify({ order: ['ollama', 'goose'], backends: { ollama: {}, goose: {} } }));
  for (const name of ['ollama', 'goose']) {
    const def = loadConfig().backends[name];
    assert.deepEqual(def.protocol.args, []);
    assert.deepEqual(def.prefixArgs, ['run']);
  }
  reset({ order: ['jd'], backends: { jd: LAYOUT.backends.jd } });
  const scanner = require('../lib/scanner');
  // stand-in binaries only, so the result doesn't depend on what this machine has installed
  for (const name of ['ollama', 'goose']) fs.chmodSync(put(`scanbin/${name}`, '#!/bin/sh\necho 1.0\n'), 0o755);
  const realPath = process.env.PATH;
  const realDirs = scanner.COMMON_DIRS.splice(0);
  process.env.PATH = `${path.join(root, 'scanbin')}:/usr/bin:/bin`;
  try {
    const cfg = loadConfig();
    const added = scanner.autoConnectAll(cfg, new Registry(cfg.home, cfg)).added;
    assert.ok(added.includes('ollama') && added.includes('goose'), added.join());
  } finally {
    process.env.PATH = realPath;
    scanner.COMMON_DIRS.push(...realDirs);
  }
  const reopened = loadConfig();
  for (const name of ['ollama', 'goose']) {
    assert.deepEqual(reopened.backends[name].prefixArgs, ['run'], name);
    assert.deepEqual(reopened.backends[name].protocol.args, [], name);
    assert.ok(reopened.backends[name].quota.every((q) => q instanceof RegExp), name);
  }
});

function sessionIdOf(agent) {
  return agent.session && agent.session.header.sid;
}

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
