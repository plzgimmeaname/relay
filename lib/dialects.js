const os = require('os');
const fs = require('fs');
const path = require('path');

function createJsonParser(cb) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          cb(JSON.parse(line), null);
        } catch {
          cb(null, line);
        }
      }
    },
    end() {
      const rest = buffer;
      buffer = '';
      return rest.trim();
    },
  };
}

function blocks(message, type) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content.filter((b) => b && b.type === type);
}

function joinText(message) {
  return blocks(message, 'text')
    .map((b) => b.text)
    .join('\n');
}

const claudeDialect = {
  name: 'claude',
  hint: 'stream-json protocol shared by qwen and claude',
  input: 'stdin-json',

  args(ctx) {
    const { protocol, def, resumeId, systemFile, permissionMode, skipPermissions } = ctx;
    const args = [...(def.prefixArgs || []), ...protocol.args];
    if (resumeId && protocol.resumeArgs?.length) args.push(...protocol.resumeArgs, resumeId);
    if (def.model && protocol.modelArgs !== false) args.push('-m', def.model);
    if (systemFile && protocol.systemArgs?.length) args.push(...protocol.systemArgs, systemFile);
    if (permissionMode && protocol.permissionModeArgs !== false) args.push('--permission-mode', permissionMode);
    if (skipPermissions && protocol.skipPermissionsArgs !== false) args.push('--dangerously-skip-permissions');
    if (Array.isArray(def.extraArgs)) args.push(...def.extraArgs);
    return args;
  },

  payload(prompt) {
    return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null }) + '\n';
  },

  parse(push) {
    return createJsonParser((evt, nonJson) => {
      if (nonJson) return push({ kind: 'noise', text: nonJson });
      if (evt.type === 'system' && evt.subtype === 'init') {
        return push({ kind: 'init', raw: evt, commands: evt.slash_commands || [], model: evt.model, sessionId: evt.session_id });
      }
      if (evt.type === 'assistant') {
        const out = [{ kind: 'result-part', raw: evt, sessionId: evt.session_id }];
        const text = joinText(evt.message);
        if (text) out.push({ kind: 'text', text, raw: evt });
        for (const b of blocks(evt.message, 'tool_use')) out.push({ kind: 'tool', name: b.name, input: b.input, raw: evt });
        for (const b of blocks(evt.message, 'thinking')) out.push({ kind: 'thinking', text: b.thinking || b.text || '', raw: evt });
        if (evt.error || evt.is_api_error_message) out.push({ kind: 'api-error', text: String(evt.error || 'api error'), raw: evt });
        return out.forEach(push), undefined;
      }
      if (evt.type === 'result') {
        return push({
          kind: 'result',
          raw: evt,
          text: typeof evt.result === 'string' ? evt.result : joinText(evt.message || {}),
          sessionId: evt.session_id,
          isError: evt.is_error === true,
          errorText: evt.is_error === true ? [evt.result, evt.subtype, evt.terminal_reason].filter(Boolean).join('\n') : '',
          usage: evt.usage,
          credits: evt.total_credits,
          durationMs: evt.duration_ms,
          commands: evt.slash_commands,
        });
      }
      return push({ kind: 'other', raw: evt, sessionId: evt.session_id });
    });
  },

  fallbackResult() {
    return null;
  },
};

const junieDialect = {
  name: 'junie',
  hint: 'JetBrains Junie json-stream',
  input: 'argv',

  args(ctx) {
    const { def, protocol, prompt, resumeId, systemFile } = ctx;
    const args = [...(def.prefixArgs || []), ...(protocol?.preArgs || ['--output-format=json-stream', '--skip-update-check'])];
    if (def.model) args.push(`--model=${def.model}`);
    if (def.effort) args.push(`--effort=${def.effort}`);
    if (resumeId) args.push(`--session-id=${resumeId}`);
    if (systemFile) args.push(`--ide-guidelines=${systemFile}`);
    if (Array.isArray(def.extraArgs)) args.push(...def.extraArgs);
    args.push(`--task=${prompt}`);
    return args;
  },

  payload() {
    return '';
  },

  parse(push) {
    return createJsonParser((evt, nonJson) => {
      if (nonJson) return push({ kind: 'noise', text: nonJson });
      if (evt.type === 'session') return push({ kind: 'init', sessionId: evt.sessionId, raw: evt });
      if (evt.type === 'step') {
        const info = { kind: 'step', name: evt.name, text: evt.details || '', raw: evt };
        if (/^(assistant|message|llm output|agent)/i.test(evt.name || '')) return push({ kind: 'text', text: evt.details || '', raw: evt });
        if (/tool|command|edit|write|bash/i.test(evt.name || '')) return push({ kind: 'tool', name: evt.name, input: { details: evt.details }, raw: evt });
        return push(info);
      }
      if (evt.type === 'result') {
        return push({
          kind: 'result',
          raw: evt,
          text: typeof evt.result === 'string' ? evt.result : '',
          sessionId: null,
          isError: Boolean(evt.status) && !/completed|success/i.test(evt.status),
          errorText: Boolean(evt.status) && !/completed|success/i.test(evt.status) ? [evt.status, evt.error, evt.result].filter(Boolean).join('\n') : '',
          usage: evt.llmUsage,
          durationMs: null,
        });
      }
      return push({ kind: 'other', raw: evt });
    });
  },

  fallbackResult(events) {
    const last = [...events].reverse().find((e) => e.kind === 'result');
    return last || null;
  },
};

const textDialect = {
  name: 'text',
  hint: 'plain text in and out (any CLI that just prints an answer)',
  input: 'stdin-text',

  args(ctx) {
    const { protocol, def, resumeId } = ctx;
    const args = [...(def.prefixArgs || []), ...(protocol.args || [])];
    if (resumeId && protocol.resumeArgs?.length) args.push(...protocol.resumeArgs, resumeId);
    if (def.model && protocol.modelArgs !== false) args.push('-m', def.model);
    if (Array.isArray(def.extraArgs)) args.push(...def.extraArgs);
    return args;
  },

  payload(prompt) {
    return prompt + '\n';
  },

  parse(push) {
    return {
      push() {
        push({ kind: 'text-chunk', text: '' });
      },
      end() {
        return '';
      },
    };
  },

  fallbackResult() {
    return null;
  },
};

const DIALECTS = { claude: claudeDialect, junie: junieDialect, text: textDialect };

function dialectFor(def) {
  const name = def.dialect || (def.protocol?.dialect) || 'claude';
  const d = DIALECTS[name];
  if (!d) throw new Error(`unknown dialect "${name}" — try ${Object.keys(DIALECTS).join(', ')}`);
  return d;
}

function detectDialect(help) {
  const text = String(help || '');
  if (/json-stream/.test(text) || /--task=/.test(text)) return 'junie';
  if (/stream-json/.test(text) || (/--input-format/.test(text) && /--output-format/.test(text))) return 'claude';
  return 'text';
}

function dialectCandidates(help) {
  const primary = detectDialect(help);
  return primary === 'text' ? ['text'] : [primary, 'text'];
}

function writeSystemFile(text) {
  if (!text) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sys-'));
  const file = path.join(dir, 'system.md');
  fs.writeFileSync(file, text);
  return file;
}

function cleanupSystem(file) {
  if (!file) return;
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

module.exports = { DIALECTS, dialectFor, detectDialect, dialectCandidates, createJsonParser, writeSystemFile, cleanupSystem, joinText, blocks };
