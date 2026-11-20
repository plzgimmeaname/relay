const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.RELAY_HOME || path.join(os.homedir(), '.relay');

const PROTOCOL_DEFAULTS = {
  args: ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json'],
  resumeArgs: ['-r'],
  systemArgs: ['--append-system-prompt-file'],
  permissionMode: 'auto',
};

const QUOTA_PATTERNS = [
  /credit[s]? (?:limit|exhausted|depleted)/i,
  /out of credits/i,
  /insufficient (?:credit|quota|balance)/i,
  /quota (?:exceeded|exhausted|limit)/i,
  /rate limit(?:ed)?\b/i,
  /\b429\b/,
  /usage limit/i,
  /billing/i,
  /too many requests/i,
  /payment required/i,
];

const AUTH_PATTERNS = [
  /authentication_failed/i,
  /failed to authenticate/i,
  /oauth session expired/i,
  /not logged in/i,
  /invalid (?:api )?key/i,
  /unauthorized/i,
  /\b401\b/,
  /\b403\b/,
  /please (?:run|use).*login/i,
];

const BUILTIN_BACKENDS = {
  qwen: { command: 'qwen', model: null, dialect: 'claude', quota: QUOTA_PATTERNS, auth: AUTH_PATTERNS },
  claude: { command: 'claude', model: null, dialect: 'claude', extraArgs: ['--verbose'], quota: QUOTA_PATTERNS, auth: AUTH_PATTERNS },
  junie: {
    command: 'junie',
    model: null,
    dialect: 'junie',
    quota: QUOTA_PATTERNS,
    auth: [...AUTH_PATTERNS, /invalid token|authentication token|unauthorized request/i],
  },
};

function loadConfig() {
  const file = path.join(HOME, 'config.json');
  let user = {};
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`relay: bad config at ${file}: ${err.message}`);
    }
  }
  const declared = user.order || Object.keys(BUILTIN_BACKENDS);
  const order = [...declared, ...Object.keys(user.backends || {}).filter((n) => !declared.includes(n))];
  const backends = {};
  for (const name of order) {
    const builtin = BUILTIN_BACKENDS[name] || {};
    const override = (user.backends || {})[name] || {};
    const merged = { ...builtin, ...override, name };
    if (override.quota) merged.quota = [...(builtin.quota || []), ...override.quota];
    if (override.auth) merged.auth = [...(builtin.auth || []), ...override.auth];
    if (!merged.command) continue;
    merged.protocol = { ...PROTOCOL_DEFAULTS, ...(merged.protocol || {}) };
    // an empty list means "nothing custom" — the built-in signals still apply
    merged.quota = merged.quota && merged.quota.length ? merged.quota : QUOTA_PATTERNS;
    merged.auth = merged.auth && merged.auth.length ? merged.auth : AUTH_PATTERNS;
    backends[name] = merged;
  }
  return {
    home: HOME,
    order,
    backends,
    digestWindow: user.digestWindow ?? 40,
    hardResetMs: user.hardResetMs ?? 3 * 3600_000,
    permissionMode: user.permissionMode ?? 'auto',
    skipPermissions: user.skipPermissions === true,
  };
}

function writeConfig() {
  const target = path.join(HOME, 'config.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const template = {
    order: ['qwen', 'claude'],
    permissionMode: 'auto',
    digestWindow: 40,
    backends: {
      qwen: { command: 'qwen' },
      claude: { command: 'claude', extraArgs: ['--verbose'] },
      mycli: {
        command: 'mycli',
        model: 'gpt-x',
        env: { MYCLI_TOKEN: '...' },
        quota: ['credits depleted'],
        auth: ['invalid token'],
        protocol: { args: ['-p', '--format', 'stream-json'], resumeArgs: [] },
      },
    },
  };
  fs.writeFileSync(target, JSON.stringify(template, null, 2) + '\n');
  return target;
}

module.exports = { HOME, loadConfig, writeConfig, QUOTA_PATTERNS, AUTH_PATTERNS, BUILTIN_BACKENDS, PROTOCOL_DEFAULTS };
