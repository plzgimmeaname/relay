#!/usr/bin/env node
// Stands in for a plain-text CLI: no JSON protocol, reads a prompt, prints an answer.
const mode = process.env.FAKE_MODE || 'ok';
const name = process.env.FAKE_NAME || 'faketext';
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: dumb [options] [prompt]\n  -p, --print   print and exit\n');
  process.exit(0);
}
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const prompt = input.trim();
  if (mode === 'quota') {
    process.stderr.write('Error: You have run out of credits\n');
    process.exit(70);
  }
  const digest = /transcript digest/.test(prompt) ? 'digest' : 'plain';
  const answer = `[${name}] ${digest} :: ${prompt.split('\n').pop().slice(0, 30)}`;
  require('fs').writeFileSync(require('path').join(process.env.FAKE_STATE_DIR || '/tmp', 'last-seen-text'), JSON.stringify({ digest: digest === 'digest', argv: process.argv.slice(2), prompt }, null, 2));
  process.stdout.write(answer + '\n');
});
