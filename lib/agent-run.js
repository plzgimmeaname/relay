#!/usr/bin/env node
// Detached entry point for `relay agent <name> --detach`.
// Reads a JSON payload on argv[2], builds the Agent, runs one turn, exits.
const fs = require('fs');
const { Agent, loadConfig } = require('./agent');
const { Registry } = require('./registry');

const payload = JSON.parse(process.argv[2] || '{}');
const { name, backend, model, cwd, prompt, home } = payload;

if (!name || !backend || !cwd || !prompt) {
  process.stderr.write('relay agent-run: name, backend, cwd and prompt are required\n');
  process.exit(2);
}

(async () => {
  const config = loadConfig();
  const registry = new Registry(home, config);
  const agent = new Agent({ name, backend, model, cwd, home, config, registry });
  try {
    const out = await agent.turn(prompt);
    if (out.ok) {
      process.stdout.write((out.res.text || '') + '\n');
      process.exit(0);
    }
    process.stderr.write(`relay agent ${name}: ${out.res?.kind || out.reason}\n`);
    process.exit(1);
  } catch (err) {
    process.stderr.write(`relay agent ${name}: ${err.message}\n`);
    process.exit(1);
  }
})();
