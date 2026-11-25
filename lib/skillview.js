// `relay skill …` and `/skill …`.
const os = require('os');
const skills = require('./skills');
const { onPath } = require('./auto');
const { BUILTIN_BACKENDS } = require('./config');
const { c, table, truncate } = require('./ui');

const USAGE = [
  'skill import <folder|file> [--as <name>] [--force] [--no-export]',
  'skill list',
  'skill show <name>',
  'skill export [name]        (re)copy into the CLIs\' own skill folders',
  'skill remove <name>',
];

const short = (p) => (p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p);

// every CLI on this machine that reads a skill folder, connected to relay or not
function installedReaders(config) {
  const names = new Set(skills.NATIVE_TARGETS.flatMap((t) => t.readers));
  return [...names].filter((n) => onPath((config.backends[n] || BUILTIN_BACKENDS[n])?.command));
}

function reportExport(result, log) {
  for (const w of result.written) log(c.green('  ✓ ') + `${short(w.dest)} ${c.gray(`→ ${w.readers.join(', ')}`)}`);
  for (const s of result.skipped) log(c.yellow('  ↷ ') + `${short(s.dest)} ${c.gray(`left alone: ${s.reason}`)}`);
}

// returns false when the command was not understood or failed
function skillCommand(config, words, flags, log, reserved = []) {
  const [action = 'list', ref] = words;

  if (action === 'list') {
    const all = skills.list(config.home);
    if (!all.length) log(c.gray('  no skills yet — skill import <folder|file>'));
    else log('\n' + table(all.map((s) => [c.bold(`/${s.name}`), s.format, truncate(s.description, 60)]), ['skill', 'from', 'description']) + '\n');
    return true;
  }

  if (action === 'import') {
    if (!ref) {
      log(c.red('  usage: skill import <folder|file>'));
      return false;
    }
    const { imported, failed } = skills.importSkills(config.home, ref, flags);
    const readers = installedReaders(config);
    for (const skill of imported) {
      log(`\n  ${c.green('✓ imported')} ${c.bold(skill.name)} ${c.gray(`(from ${skill.format})`)}`);
      for (const note of skill.notes) log(c.yellow('  ! ') + c.gray(note));
      if (flags.noExport) log(c.gray('  not copied into any CLI folder (--no-export)'));
      else reportExport(skills.exportSkill(config.home, skill.name, readers), log);
      const how = reserved.includes(skill.name) ? `/skill use ${skill.name} (relay already has a /${skill.name})` : `/${skill.name} <request>  or  @cli /${skill.name} <request>`;
      log(c.gray(`  in relay, on any CLI: ${how}`));
    }
    for (const f of failed) log(c.red(`  ✗ ${short(f.source)}: ${f.error}`));
    log('');
    return !failed.length;
  }

  if (action === 'export') {
    const names = ref ? [ref] : skills.list(config.home).map((s) => s.name);
    for (const name of names) {
      log(`\n  ${c.bold(name)}`);
      reportExport(skills.exportSkill(config.home, name, installedReaders(config)), log);
    }
    return true;
  }

  if (action === 'show') {
    const skill = skills.load(config.home, ref);
    if (!skill) {
      log(c.red(`  no skill called "${ref || ''}"`));
      return false;
    }
    log(`\n  ${c.bold(skill.name)} ${c.gray(`(from ${skill.format}${skill.source ? `: ${short(skill.source)}` : ''})`)}\n  ${skill.description}\n`);
    for (const note of skill.notes) log(c.yellow('  ! ') + c.gray(note));
    log('\n' + skill.body + '\n');
    return true;
  }

  if (action === 'remove') {
    const { removed } = skills.remove(config.home, ref);
    log(c.green(`  ✓ removed ${ref}`) + (removed.length ? c.gray(` and ${removed.length} copy(ies): ${removed.map(short).join(', ')}`) : ''));
    return true;
  }

  log(USAGE.map((u) => c.gray('  ' + u)).join('\n'));
  return false;
}

module.exports = { skillCommand, installedReaders };
