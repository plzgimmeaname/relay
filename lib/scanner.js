const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { BUILTIN_BACKENDS, QUOTA_PATTERNS } = require('./config');
const { Probe } = require('./probe');
const { save } = require('./connect');

const COMMON_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
  path.join(os.homedir(), '.nvm', 'versions', 'node'),
  path.join(os.homedir(), '.cargo', 'bin'),
  '/usr/bin',
];

function findInPathOrDirs(command) {
  const probe = new Probe(process.cwd());
  const found = probe.which(command);
  if (found) return found;

  for (const dir of COMMON_DIRS) {
    if (!fs.existsSync(dir)) continue;
    // Check direct binary
    const target = path.join(dir, command);
    try {
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        try {
          fs.accessSync(target, fs.constants.X_OK);
          return target;
        } catch {
          // not executable
        }
      }
    } catch {
      // ignore
    }
    // Check if dir has subdirectories (like .nvm/versions/node/v.../bin)
    if (dir.includes('.nvm')) {
      try {
        const versions = fs.readdirSync(dir);
        for (const ver of versions) {
          const binPath = path.join(dir, ver, 'bin', command);
          if (fs.existsSync(binPath)) {
            return binPath;
          }
        }
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function probeVersion(commandPath) {
  try {
    const res = spawnSync(commandPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
    const out = (res.stdout || res.stderr || '').trim().split('\n')[0];
    return out ? out.slice(0, 60) : null;
  } catch {
    return null;
  }
}

function scanInstalledCLIs(cwd = process.cwd()) {
  const results = [];
  const knownKeys = Object.keys(BUILTIN_BACKENDS);

  for (const key of knownKeys) {
    const preset = BUILTIN_BACKENDS[key];
    const binPath = findInPathOrDirs(preset.command);
    const installed = Boolean(binPath);
    let version = null;
    if (installed) {
      version = probeVersion(binPath);
    }

    results.push({
      name: key,
      command: preset.command,
      path: binPath,
      installed,
      dialect: preset.dialect,
      freeTier: preset.freeTier ?? true,
      label: preset.label || key,
      version,
    });
  }

  return results;
}

function autoConnectAll(config, registry, { note = () => {} } = {}) {
  const scanned = scanInstalledCLIs();
  const added = [];
  const existing = [];

  for (const cli of scanned) {
    if (!cli.installed) continue;

    if (registry.all.includes(cli.name)) {
      existing.push(cli.name);
      continue;
    }

    const preset = BUILTIN_BACKENDS[cli.name];
    if (!preset) continue;

    const def = {
      command: cli.path || preset.command,
      dialect: preset.dialect,
      model: preset.model || null,
      prefixArgs: [],
      extraArgs: preset.extraArgs || [],
      env: {},
      quota: preset.quota || QUOTA_PATTERNS,
      auth: preset.auth || [],
      freeTier: preset.freeTier ?? true,
      label: preset.label || cli.name,
      protocol: preset.protocol || {
        args: preset.dialect === 'junie' ? [] : ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json'],
        resumeArgs: preset.dialect === 'claude' ? ['-r'] : preset.dialect === 'junie' ? ['--session-id'] : [],
        systemArgs: preset.dialect === 'claude' ? ['--append-system-prompt-file'] : [],
        permissionMode: 'auto',
      },
    };

    save(config, registry, cli.name, def, { first: false });
    added.push(cli.name);
    note(`  ✓ Auto-connected ${cli.label} (${cli.name}) at ${cli.path}`);
  }

  return { added, existing, totalInstalled: scanned.filter((c) => c.installed).length };
}

module.exports = {
  scanInstalledCLIs,
  autoConnectAll,
  findInPathOrDirs,
  COMMON_DIRS,
};
