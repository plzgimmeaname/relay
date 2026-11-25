// Gives the desktop app the same input syntax as the terminal shell: @tags, skills and /auto.
const tags = require('./tags');
const skills = require('./skills');
const { runTagged } = require('./tagview');
const { runAuto } = require('./autoview');
const { createControl } = require('./auto');
const { parseMultiStepPrompt } = require('./multistep');
const { strip } = require('./ui');

const done = (ok, extra = {}) => ({ ok, backend: 'relay', ...extra });

async function runInput(app, input, hooks = {}, { force = null } = {}) {
  const say = (text) => hooks.onEvent?.({ type: 'assistant_text', text: `${strip(text)}\n` }, 'relay');
  const turn = (text, opts) => app.turn(text, hooks, opts);

  const tag = input.startsWith('@') ? tags.parseTagLine(app, input) : null;
  if (tag && !parseMultiStepPrompt(input, app.registry.all).isMultiStep) {
    const action = tags.actionFor(tag.rest);
    if (action.kind === 'exec' || action.kind === 'open') {
      say(`That needs a terminal. Run it there: relay @${tag.backend} ${tag.rest}`.trim());
      return done(true);
    }
    let result = null;
    const ok = await runTagged(app, tag, action, {
      log: say,
      submit: async (text, opts) => {
        result = await turn(text, opts);
        return result.ok;
      },
      slash: async (backend, command, model) => {
        const res = await tags.runSlash(app, backend, command, { model, hooks });
        result = { ok: res.ok, backend, res };
        return res;
      },
    });
    return result || done(ok);
  }

  const [, name, rest = ''] = input.match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i) || [];

  if (name === 'auto') {
    const flags = rest.match(/^(?:--(?:dry-run|offline)\s*)*/)[0];
    const control = createControl();
    app.abort = () => control.abort();
    try {
      const out = await runAuto(app, rest.slice(flags.length), {
        control,
        dryRun: flags.includes('--dry-run'),
        offline: flags.includes('--offline'),
        log: say,
        out: say,
      });
      return done(out.ok);
    } finally {
      app.abort = null;
    }
  }

  if (name === 'skill') {
    const [action = 'list', ref] = rest.split(/\s+/).filter(Boolean);
    if (action === 'use') {
      const skill = skills.load(app.config.home, ref);
      if (!skill) throw new Error(`no skill called "${ref || ''}"`);
      return turn(skills.expand(skill, rest.replace(/^use\s+\S+\s*/, '')), { force, skipPipeline: true, display: input });
    }
    // changing skills writes into CLI config folders, so that stays in the terminal
    if (action !== 'list' && action !== 'show') {
      say(`Manage skills in a terminal: relay skill ${rest}`);
      return done(true);
    }
    const found = action === 'show' ? skills.load(app.config.home, ref) : null;
    if (action === 'show') say(found ? `${found.name}: ${found.description}\n\n${found.body}` : `no skill called "${ref || ''}"`);
    else {
      const all = skills.list(app.config.home);
      say(all.length ? all.map((s) => `/${s.name} — ${s.description}`).join('\n') : 'No skills yet. In a terminal: relay skill import <path>');
    }
    return done(true);
  }

  const skill = name ? skills.load(app.config.home, name) : null;
  if (skill) return turn(skills.expand(skill, rest), { force, skipPipeline: true, display: input });

  if (name) {
    say(`/${name} isn't available in the desktop app. To send it to a CLI as its own command: @<cli> ${input}`);
    return done(false);
  }
  return turn(input, { force });
}

module.exports = { runInput };
