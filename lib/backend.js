const { spawn } = require('child_process');
const { QuotaDetector } = require('./probe');
const { dialectFor, writeSystemFile, cleanupSystem } = require('./dialects');
const { runPty } = require('./ptyrun');

const ARGV_LIMIT = 60_000;

class Backend {
  constructor(def, opts = {}) {
    this.def = def;
    this.protocol = def.protocol;
    this.dialect = dialectFor(def);
    this.opts = opts;
  }

  buildArgs({ resumeId, systemFile, prompt }) {
    return this.dialect.args({
      def: this.def,
      protocol: this.protocol,
      resumeId,
      systemFile,
      prompt,
      permissionMode: this.opts.permissionMode || this.protocol.permissionMode,
      skipPermissions: Boolean(this.opts.skipPermissions || this.protocol.skipPermissions),
    });
  }

  canPassSystemFile() {
    if (this.dialect.name === 'claude') return Boolean(this.protocol.systemArgs?.length);
    if (this.dialect.name === 'junie') return true;
    return false;
  }

  #ptyResult(r, detector, authDetector) {
    const signals = [r.ok ? '' : r.raw, r.text.split('\n').slice(-6).join('\n')].join('\n');
    detector.feed(signals);
    authDetector.feed(signals);
    const quota = detector.hits[0] || null;
    const auth = authDetector.hits[0] || null;
    let kind = r.kind;
    const blocked = BLOCKED.test(`${r.full || ''}\n${r.raw || ''}`);
    if (blocked) {
      return { ok: false, kind: 'blocked', dialect: 'pty', args: r.args, events: [], result: null, raw: r.screen || r.raw || '', text: '', sessionId: null, quota: null, auth: { line: 'this app forbids scripted or automated use' }, exitCode: r.exitCode ?? null, signal: r.signal ?? null, spawnError: null };
    }
    if (quota && (kind !== null || !r.text)) kind = 'quota';
    else if (auth && (kind !== null || !r.text)) kind = 'auth';
    const result = kind === null ? { kind: 'result', text: r.text, isError: false, sessionId: null, usage: null, durationMs: null } : null;
    return {
      ok: kind === null,
      kind,
      dialect: 'pty',
      args: r.args,
      events: result ? [result] : [],
      result,
      raw: r.raw || '',
      text: r.text || '',
      sessionId: null,
      quota,
      auth,
      exitCode: r.exitCode ?? null,
      signal: r.signal ?? null,
      spawnError: r.spawnError || r.error || null,
    };
  }

  run({ prompt, digest, resumeId, systemPrompt, cwd, timeoutMs, onEvent }) {
    const dialect = this.dialect;
    const detector = new QuotaDetector(this.def.quota);
    const authDetector = new QuotaDetector(this.def.auth);
    const withSystem = this.canPassSystemFile();
    const base = digest ? `${digest}\n\n${prompt}` : prompt;
    const body = withSystem || !systemPrompt ? base : `${systemPrompt}\n\n${base}`;
    const guarded = dialect.input === 'argv' && body.length > ARGV_LIMIT ? body.slice(0, ARGV_LIMIT) : body;

    if (dialect.name === 'pty') {
      const args = this.buildArgs({ resumeId: null, systemFile: null, prompt: body });
      const env = { ...process.env, ...(this.def.env || {}) };
      return runPty({ def: this.def, args, prompt: body, cwd: cwd || process.cwd(), env, timeoutMs: timeoutMs || this.opts.timeoutMs, registerAbort: this.opts.registerAbort, onEvent: (e) => onEvent?.(e) }).then((r) => this.#ptyResult(r, detector, authDetector));
    }

    const systemFile = withSystem ? writeSystemFile(systemPrompt) : null;
    const args = this.buildArgs({ resumeId, systemFile, prompt: guarded });
    const env = { ...process.env, ...(this.def.env || {}) };
    const payload = dialect.payload ? dialect.payload(guarded) : '';

    return new Promise((resolve) => {
      let child;
      const tty = process.stdout.isTTY;
      try {
        child = spawn(this.def.command, args, { cwd: cwd || process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
        LIVE.add(child);
      } catch (error) {
        cleanupSystem(systemFile);
        resolve({ ok: false, kind: 'spawn', error: error.message, args, events: [], text: '', raw: '', dialect: dialect.name });
        return;
      }

      const events = [];
      let raw = '';
      let errTail = '';
      let textOut = '';
      let settled = false;
      let killedBy = null;
      let sawTui = false;

      const push = (evt) => {
        events.push(evt);
        if (evt.kind === 'text' || evt.kind === 'text-chunk') textOut += evt.text || '';
        if (evt.kind === 'text' && evt.text) onEvent?.({ type: 'assistant_text', text: evt.text });
        if (evt.kind === 'tool') onEvent?.({ type: 'tool_use', name: evt.name, input: evt.input });
        if (evt.kind === 'thinking') onEvent?.({ type: 'thinking', text: evt.text });
        if (evt.kind === 'tool-result') onEvent?.({ type: 'tool_result', id: evt.id, text: evt.text, isError: evt.isError });
        if (evt.kind === 'step') onEvent?.({ type: 'step', name: evt.name, text: evt.text });
        if (evt.kind === 'init' && evt.commands?.length) this.opts.onInit?.(evt);
        if (evt.kind === 'init') onEvent?.({ type: 'init', model: evt.model, sessionId: evt.sessionId, commands: evt.commands?.length || 0 });
        if (evt.kind === 'noise') {
          detector.feed(evt.text);
          onEvent?.({ type: 'noise', text: evt.text });
        }
      };

      const parser = dialect.parse(push);

      const timer = setTimeout(() => {
        killedBy = 'timeout';
        killTree(child, 'SIGKILL');
      }, timeoutMs || this.opts.timeoutMs || 900_000);

      const finish = (extra) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        LIVE.delete(child);
        killTree(child, 'SIGKILL');
        if (tty && sawTui) resetTerminal();
        cleanupSystem(systemFile);

        const trailing = parser.end?.();
        if (trailing) detector.feed(trailing);

        if (dialect.name === 'text') {
          push({ kind: 'result', text: textOut.trim(), sessionId: resumeId || null, isError: (extra?.code ?? 0) !== 0, errorText: [textOut, errTail].join('\n') });
        }
        const result = events.filter((e) => e.kind === 'result').pop() || null;
        const apiError = events.filter((e) => e.kind === 'api-error').pop() || null;

        const signals = [result?.errorText, errTail];
        // a successful reply may legitimately talk about credits; only failures are scanned as signals
        if (result?.isError || dialect.name === 'text') signals.push(result?.text);
        detector.feed(signals.filter(Boolean).join('\n'));
        if (apiError) detector.feed(apiError.text);
        const quotaHit = detector.hits[0] || null;
        authDetector.feed([result?.errorText, apiError?.text, errTail].filter(Boolean).join('\n'));
        const authHit = authDetector.hits[0] || null;

        let kind = null;
        if (killedBy === 'interactive') kind = 'interactive';
        else if (killedBy === 'timeout') kind = 'timeout';
        else if (killedBy === 'abort') kind = 'aborted';
        else if (extra?.error) kind = 'spawn';
        else if (quotaHit) kind = 'quota';
        else if (authHit) kind = 'auth';
        else if (result && result.isError) kind = 'error';
        else if (!result) kind = 'noresult';

        resolve({
          ok: kind === null,
          kind,
          dialect: dialect.name,
          args,
          events,
          result,
          raw: raw + errTail,
          text: (result && result.text) || textOut.trim(),
          sessionId: result?.sessionId || apiError?.sessionId || lastSession(events),
          quota: quotaHit,
          auth: authHit,
          exitCode: extra?.code ?? null,
          signal: extra?.signal ?? null,
          spawnError: extra?.error?.message || null,
        });
      };

      child.stdout.on('data', (chunk) => {
        const s = chunk.toString();
        raw += s;
        if (!sawTui && TUI_SIGNATURE.test(s)) {
          // a full-screen UI, not a headless CLI: stop it before it touches the terminal further
          sawTui = true;
          killedBy = 'interactive';
          killTree(child, 'SIGKILL');
          return;
        }
        if (dialect.name === 'text') {
          textOut += s;
          onEvent?.({ type: 'stdout', text: s });
          detector.feed(s);
          authDetector.feed(s);
          return;
        }
        parser.push(s);
      });

      child.stderr.on('data', (chunk) => {
        const s = chunk.toString();
        errTail += s;
        onEvent?.({ type: 'stderr', text: s });
        if (errTail.length > 40_000) errTail = errTail.slice(-40_000);
        detector.feed(s);
        authDetector.feed(s);
      });

      child.on('error', (error) => finish({ error }));
      child.on('close', (code, signal) => finish({ code, signal }));

      child.stdin.on('error', () => {});
      if (dialect.input === 'argv') child.stdin.end();
      else {
        child.stdin.write(payload);
        child.stdin.end();
      }

      this.opts.registerAbort?.(() => {
        killedBy = 'abort';
        killTree(child, 'SIGINT');
        const hard = setTimeout(() => killTree(child, 'SIGKILL'), 5_000);
        hard.unref();
      });
    });
  }
}

// Escape sequences only a full-screen terminal UI emits: alt screen, mouse tracking,
// bracketed paste, terminal capability queries.
const TUI_SIGNATURE = /\x1b\[\?(?:1049|1000|1002|1003|1006|2004|2026|2027|2031)[hlp$]|\x1b\[>[0-9;]*q|\x1b\]1[01];\?/;

// an app telling us it noticed (and objects to) a script driving it
const BLOCKED = /scripted or automated use|automated (?:access|use) (?:is )?(?:not allowed|prohibited|forbidden)|breaks? the usage policy|violat\w+ (?:the |our )?(?:terms|usage policy)|strike \d+ today/i;

const LIVE = new Set();

function killTree(child, signal) {
  if (!child || !child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

process.on('exit', () => {
  for (const child of LIVE) killTree(child, 'SIGKILL');
});

function lastSession(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].sessionId) return events[i].sessionId;
  return null;
}

const { resetTerminal } = require('./ui');

module.exports = { Backend };
