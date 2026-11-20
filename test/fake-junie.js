#!/usr/bin/env node
// Stands in for a Junie-style json-stream CLI: --task=<text>, session/step/result events.
const argv = process.argv.slice(2);
const taskArg = argv.find((a) => a.startsWith('--task='));
const task = taskArg ? taskArg.slice('--task='.length) : '';
const resumed = argv.some((a) => a.startsWith('--session-id='));
const guidelines = argv.find((a) => a.startsWith('--ide-guidelines='));
const mode = process.env.FAKE_MODE || 'ok';
const name = process.env.FAKE_NAME || 'fakejunie';
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (argv.includes('--help')) {
  process.stdout.write(
    [
      'Usage: junie [<options>] [<task>]',
      '  --task=<text>                Task description',
      '  --session-id=<text>          session to follow up',
      '  --output-format=<text>       Output format: text, json, json-stream',
      '  --ide-guidelines=<text>      Path to a file prepended to guidelines',
      '  --model=<text>               Model to use',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const digest = /transcript digest/.test(task);
if (guidelines) {
  const body = require('fs').readFileSync(guidelines.slice('--ide-guidelines='.length), 'utf8');
  if (!/Project instructions from/.test(body)) process.stderr.write('bad guidelines file\n');
}
const reply = `[${name}] ${digest ? 'digest' : resumed ? 'native' : 'fresh'} :: ${task.slice(0, 32)}`;

emit({ type: 'session', timestamp: Date.now(), sessionId: 'session-abc-123' });
emit({ type: 'step', name: 'TASK RESULT', details: reply });
require('fs').writeFileSync(
  require('path').join(process.env.FAKE_STATE_DIR || '/tmp', 'last-seen-junie'),
  JSON.stringify({ name, resumed, digest, guidelines: Boolean(guidelines), argv }, null, 2),
);

if (mode === 'quota') {
  emit({ type: 'result', name: 'task', result: 'quota exceeded for this plan', status: 'failed', changes: [], llmUsage: [] });
  process.exit(1);
}
emit({
  type: 'result',
  name: 'task',
  result: reply,
  status: 'completed',
  changes: [],
  llmUsage: [{ model: 'mix.lite', calls: 2, cost: 0, inputTokens: 500, outputTokens: 20 }],
});
