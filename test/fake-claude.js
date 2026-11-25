#!/usr/bin/env node
// Stands in for a stream-json CLI (the qwen/claude protocol family).
const mode = process.env.FAKE_MODE || 'ok';
const name = process.env.FAKE_NAME || 'fake';
const seen = require('fs');

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const lines = input
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const last = lines[lines.length - 1];
  const text = last?.message?.content?.[0]?.text || '';
  const sawDigest = /--- transcript digest ---/.test(text);
  const sid = `${name}-session-1`;
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

  emit({ type: 'system', subtype: 'init', protocol_version: '1.5.0', session_id: sid, slash_commands: ['auth', 'compact', 'resume', 'usage'], model: `${name}-model` });

  if (mode === 'quota') {
    process.stderr.write('ProviderError: You have run out of credits, please upgrade\n');
    emit({ type: 'result', is_error: true, subtype: 'error_during_execution', result: 'credit limit reached', session_id: sid });
    process.exit(1);
  }
  if (mode === 'auth') {
    emit({ type: 'assistant', error: 'authentication_failed', is_api_error_message: true, session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired' }] } });
    emit({ type: 'result', is_error: false, subtype: 'success', result: 'Failed to authenticate: OAuth session expired', session_id: sid });
    process.exit(0);
  }

  if (mode === 'planner' && /Split the instructions below/.test(text)) {
    require('fs').writeFileSync(require('path').join(process.env.FAKE_STATE_DIR, 'planner-argv'), JSON.stringify(process.argv.slice(2)));
    emit({ type: 'result', is_error: false, subtype: 'success', result: '```json\n' + process.env.FAKE_PLAN + '\n```', session_id: sid });
    return;
  }

  const reply = `[${name}] ${sawDigest ? 'digest' : 'native'} :: ${text.slice(0, 40)}`;
  emit({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'thinking hard' }, { type: 'tool_use', name: 'Read', input: { file_path: '/x/y.ts' } }] } });
  emit({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
  require('fs').writeFileSync(require('path').join(process.env.FAKE_STATE_DIR || '/tmp', 'last-seen'), JSON.stringify({ name, sawDigest, sid, turns: lines.length, text, argv: process.argv.slice(2) }, null, 2));
  emit({ type: 'result', is_error: false, subtype: 'success', result: reply, session_id: sid, usage: { context_usage_ratio: 0.2, input_tokens: 10, output_tokens: 3 }, duration_ms: 12 });
});
