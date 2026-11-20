const { spawn } = require('child_process');
const { QuotaDetector } = require('./probe');
const { dialectFor, writeSystemFile, cleanupSystem } = require('./dialects');

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

  run({ prompt, digest, resumeId, systemPrompt, cwd, timeoutMs, onEvent }) {
    const dialect = this.dialect;
    const detector = new QuotaDetector(this.def.quota);
    const authDetector = new QuotaDetector(this.def.auth);
    const withSystem = this.canPassSystemFile();
    const base = digest ? `${digest}\n\n${prompt}` : prompt;
    const body = withSystem || !systemPrompt ? base : `${systemPrompt}\n\n${base}`;
    const guarded = dialect.input === 'argv' && body.length > ARGV_LIMIT ? body.slice(0, ARGV_LIMIT) : body;

    const systemFile = withSystem ? writeSystemFile(systemPrompt) : null;
    const args = this.buildArgs({ resumeId, systemFile, prompt: guarded });
    const env = { ...process.env, ...(this.def.env || {}) };
    const payload = dialect.payload ? dialect.payload(guarded) : '';

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.def.command, args, { cwd: cwd || process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] });
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

      const push = (evt) => {
        events.push(evt);
        if (evt.kind === 'text' || evt.kind === 'text-chunk') textOut += evt.text || '';
        if (evt.kind === 'text' && evt.text) onEvent?.({ type: 'assistant_text', text: evt.text });
        if (evt.kind === 'tool') onEvent?.({ type: 'tool_use', name: evt.name, input: evt.input });
        if (evt.kind === 'thinking') onEvent?.({ type: 'thinking', text: evt.text });
        if (evt.kind === 'init' && evt.commands?.length) this.opts.onInit?.(evt);
        if (evt.kind === 'noise') detector.feed(evt.text);
      };

      const parser = dialect.parse(push);

      const timer = setTimeout(() => {
        killedBy = 'timeout';
        child.kill('SIGKILL');
      }, timeoutMs || this.opts.timeoutMs || 900_000);

      const finish = (extra) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
        if (killedBy === 'timeout') kind = 'timeout';
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
        if (dialect.name === 'text') {
          textOut += s;
          detector.feed(s);
          authDetector.feed(s);
          return;
        }
        parser.push(s);
      });

      child.stderr.on('data', (chunk) => {
        const s = chunk.toString();
        errTail += s;
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
        child.kill('SIGINT');
        const hard = setTimeout(() => child.kill('SIGKILL'), 5_000);
        hard.unref();
      });
    });
  }
}

function lastSession(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].sessionId) return events[i].sessionId;
  return null;
}

module.exports = { Backend };
