// Runs a parsed `@tag` action, for the shell UI and for `relay @cli …`.
const tags = require('./tags');
const skills = require('./skills');
const { c, truncate } = require('./ui');

// `/name args` after a tag may be a relay skill. A command the CLI itself
// advertises wins; otherwise relay expands the skill so any CLI can run it.
function skillFor(app, backend, command) {
  const [, name, args = ''] = command.match(/^\/([\w:.-]+)\s*([\s\S]*)$/) || [];
  if (!name || app.registry.commands(backend).includes(name)) return null;
  const skill = skills.load(app.config.home, name);
  return skill ? { skill, args } : null;
}

// ui: { log, submit(text, turnOpts) -> out, slash(backend, command, model) -> res }
async function runTagged(app, target, action, ui) {
  const { backend, model } = target;
  const who = model ? `${backend}:${model}` : backend;

  if (action.kind === 'exec' || action.kind === 'open') {
    if (action.kind === 'open') ui.log(c.gray(`  ↳ opening ${who}'s own UI — exit it to come back${action.prompt ? ` (starting with ${action.prompt})` : ''}`));
    const status = action.kind === 'exec' ? tags.runExec(app, backend, action.args) : tags.runOpen(app, backend, { model, prompt: action.prompt });
    if (status) ui.log(c.yellow(`  ${backend} exited with status ${status}`));
    return status === 0;
  }

  if (action.kind === 'slash') {
    const found = skillFor(app, backend, action.command);
    if (found) {
      ui.log(c.gray(`  ↳ skill ${found.skill.name} on ${who}`));
      const opts = { ...tags.routeTo(app, target), display: `@${backend} ${action.command}` };
      return tags.keepingPin(app, () => ui.submit(skills.expand(found.skill, found.args), opts));
    }
    ui.log(c.gray(`  ↳ ${truncate(action.command, 60)} on ${who}`));
    const res = await ui.slash(backend, action.command, model);
    if (!res.ok) {
      // prefer the CLI's own explanation over the tail of its JSON stream
      const said = res.result?.raw?.error?.message || res.result?.errorText || res.text || res.raw || '';
      ui.log(c.yellow(`  ✗ ${res.kind}${said.trim() ? ': ' + truncate(said.trim().split('\n').slice(-2).join(' '), 200) : ''}`));
    }
    // some commands only exist in a CLI's own UI; say how to get there
    if (!res.ok || /(?:isn.t|not) available|unknown (?:slash )?command|only (?:available )?in interactive/i.test(res.text || '')) {
      ui.log(c.gray(`  if it only works interactively: @${backend} open ${action.command}`));
    }
    return res.ok;
  }

  return tags.keepingPin(app, () => ui.submit(action.prompt, tags.routeTo(app, target)));
}

module.exports = { runTagged, skillFor };
