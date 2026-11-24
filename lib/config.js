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
  agy: {
    command: 'agy',
    model: null,
    dialect: 'claude',
    freeTier: true,
    label: 'Antigravity (Google)',
    quota: [...QUOTA_PATTERNS, /resource.*exhausted/i, /quota limit exceeded/i, /daily (?:usage|request) limit/i],
    auth: [...AUTH_PATTERNS, /agy (?:auth|login)/i],
  },
  claude: {
    command: 'claude',
    model: null,
    dialect: 'claude',
    extraArgs: ['--verbose'],
    freeTier: false,
    label: 'Claude Code (Anthropic)',
    quota: QUOTA_PATTERNS,
    auth: AUTH_PATTERNS,
  },
  kilo: {
    command: 'kilo',
    model: null,
    dialect: 'text',
    freeTier: true,
    label: 'Kilo Code',
    quota: [...QUOTA_PATTERNS, /kilo.*credit/i, /no credits remaining/i],
    auth: AUTH_PATTERNS,
  },
  freebuff: {
    command: 'freebuff',
    model: null,
    dialect: 'text',
    freeTier: true,
    label: 'Freebuff AI',
    quota: [...QUOTA_PATTERNS, /out of buff/i, /buff limit/i, /free tier exhausted/i],
    auth: AUTH_PATTERNS,
  },
  qwen: {
    command: 'qwen',
    model: null,
    dialect: 'claude',
    freeTier: true,
    label: 'Qwen Code',
    quota: QUOTA_PATTERNS,
    auth: AUTH_PATTERNS,
  },
  junie: {
    command: 'junie',
    model: null,
    dialect: 'junie',
    freeTier: false,
    label: 'Junie (JetBrains)',
    quota: QUOTA_PATTERNS,
    auth: [...AUTH_PATTERNS, /invalid token|authentication token|unauthorized request/i],
  },
  opencode: {
    command: 'opencode',
    model: null,
    dialect: 'text',
    freeTier: true,
    label: 'OpenCode',
    quota: [...QUOTA_PATTERNS, /token limit/i, /credits exhausted/i],
    auth: AUTH_PATTERNS,
  },
  aider: {
    command: 'aider',
    model: null,
    dialect: 'text',
    prefixArgs: ['--yes', '--no-auto-commits', '--message'],
    freeTier: false,
    label: 'Aider AI Pair',
    quota: [...QUOTA_PATTERNS, /rate limit reached/i, /exceeded your current quota/i],
    auth: [...AUTH_PATTERNS, /api key not set/i, /invalid openai_api_key/i],
  },
  cursor: {
    command: 'cursor',
    model: null,
    dialect: 'text',
    freeTier: false,
    label: 'Cursor CLI',
    quota: QUOTA_PATTERNS,
    auth: AUTH_PATTERNS,
  },
  copilot: {
    command: 'gh',
    prefixArgs: ['copilot'],
    model: null,
    dialect: 'text',
    freeTier: false,
    label: 'GitHub Copilot',
    quota: QUOTA_PATTERNS,
    auth: AUTH_PATTERNS,
  },
  ollama: {
    command: 'ollama',
    prefixArgs: ['run'],
    model: 'llama3',
    dialect: 'text',
    freeTier: true,
    label: 'Ollama (Local Unlimited)',
    quota: QUOTA_PATTERNS,
    auth: AUTH_PATTERNS,
  },
  gemini: {
    command: 'gemini',
    model: null,
    dialect: 'text',
    freeTier: true,
    label: 'Google Gemini CLI',
    quota: [...QUOTA_PATTERNS, /quota exceeded/i, /resource exhausted/i],
    auth: AUTH_PATTERNS,
  },
  openai: {
    command: 'openai',
    model: null,
    dialect: 'text',
    freeTier: false,
    label: 'OpenAI CLI',
    quota: QUOTA_PATTERNS,
    auth: AUTH_PATTERNS,
  },
  goose: {
    command: 'goose',
    prefixArgs: ['run'],
    model: null,
    dialect: 'text',
    freeTier: true,
    label: 'Goose Developer Agent',
    quota: QUOTA_PATTERNS,
    auth: AUTH_PATTERNS,
  },
  cody: {
    command: 'cody',
    prefixArgs: ['chat', '-m'],
    model: null,
    dialect: 'text',
    freeTier: false,
    label: 'Sourcegraph Cody',
    quota: QUOTA_PATTERNS,
    auth: AUTH_PATTERNS,
  },
  openhands: {
    command: 'openhands',
    model: null,
    dialect: 'text',
    freeTier: true,
    label: 'OpenHands (OpenDevin)',
    quota: QUOTA_PATTERNS,
    auth: AUTH_PATTERNS,
  },
  llm: {
    command: 'llm',
    prefixArgs: ['prompt'],
    model: null,
    dialect: 'text',
    freeTier: true,
    label: 'Simon Willison LLM',
    quota: QUOTA_PATTERNS,
    auth: AUTH_PATTERNS,
  },
  sgpt: {
    command: 'sgpt',
    prefixArgs: ['--code'],
    model: null,
    dialect: 'text',
    freeTier: false,
    label: 'Shell GPT (sgpt)',
    quota: QUOTA_PATTERNS,
    auth: AUTH_PATTERNS,
  },
  mentat: {
    command: 'mentat',
    model: null,
    dialect: 'text',
    freeTier: true,
    label: 'Mentat AI',
    quota: QUOTA_PATTERNS,
    auth: AUTH_PATTERNS,
  },
  plandex: {
    command: 'plandex',
    model: null,
    dialect: 'text',
    freeTier: true,
    label: 'Plandex',
    quota: QUOTA_PATTERNS,
    auth: AUTH_PATTERNS,
  },
  cline: {
    command: 'cline',
    model: null,
    dialect: 'text',
    freeTier: true,
    label: 'Cline CLI',
    quota: QUOTA_PATTERNS,
    auth: AUTH_PATTERNS,
  },
  'amazon-q': {
    command: 'q',
    prefixArgs: ['chat'],
    model: null,
    dialect: 'text',
    freeTier: true,
    label: 'Amazon Q Developer',
    quota: QUOTA_PATTERNS,
    auth: AUTH_PATTERNS,
  },
};

const STRATEGIES = ['priority', 'pool', 'free-first'];

function loadConfig() {
  const file = path.join(HOME, 'config.json');
  let user = {};
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        user = {};
      } else {
        throw new Error(`relay: bad config at ${file}: ${err.message}`);
      }
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
    if (merged.freeTier === undefined) merged.freeTier = builtin.freeTier ?? true;
    if (!merged.label) merged.label = builtin.label || name;
    backends[name] = merged;
  }
  return {
    home: HOME,
    order,
    backends,
    strategy: user.strategy && STRATEGIES.includes(user.strategy) ? user.strategy : 'priority',
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

module.exports = { HOME, loadConfig, writeConfig, QUOTA_PATTERNS, AUTH_PATTERNS, BUILTIN_BACKENDS, PROTOCOL_DEFAULTS, STRATEGIES };
