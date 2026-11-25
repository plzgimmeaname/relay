// `relay auto`: split instructions into tasks, then give each one an agent, a CLI
// and a model based on what the task says.
//
// A CLI does the split (it reads intent far better than regexes); relay does the
// assignment itself, so a planner can never name a CLI or model that isn't there.
// If no CLI can plan, a local splitter takes over.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Backend } = require('./backend');
const { Agent, findAgent } = require('./agent');
const { parseMultiStepPrompt } = require('./multistep');
const { truncate } = require('./ui');
const log = require('./log');

const MAX_TASKS = 12;
const CONTEXT_CAP = 8000; // chars of an earlier task's output handed to a later one
const SUMMARY_CAP = 1500; // chars per task kept in the main session

const TYPES = {
  plan: { agent: 'planner', writes: false, brief: 'You are the planning agent. Produce a concrete, ordered plan that names files and risks.' },
  research: { agent: 'researcher', writes: false, brief: 'You are the research agent. Investigate and report what you found, with file references.' },
  review: { agent: 'reviewer', writes: false, brief: 'You are the review agent. Report real defects with evidence, most severe first.' },
  code: { agent: 'coder', writes: true, brief: 'You are the implementation agent. Make the change and keep it to what the task asks.' },
  debug: { agent: 'debugger', writes: true, brief: 'You are the debugging agent. Find the root cause before changing code, then fix it.' },
  test: { agent: 'tester', writes: true, brief: 'You are the testing agent. Write or run tests and report the real results, failures included.' },
  design: { agent: 'designer', writes: true, brief: 'You are the UI agent. Match the existing visual language and cover empty and error states.' },
  docs: { agent: 'writer', writes: true, brief: 'You are the documentation agent. Write accurately from the code as it is now.' },
};

const DIFFICULTY_TIER = { easy: 'light', medium: 'standard', hard: 'heavy' };

// Override per CLI with backends.<name>.models in config.json. A CLI with no entry
// runs on its own default model.
const MODEL_TIERS = {
  claude: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
  agy: { light: 'gemini-3.8-flash-low', standard: 'gemini-3.8-flash-high', heavy: 'gemini-4-hydrogen-high' },
  junie: { light: { effort: 'low' }, standard: { effort: 'medium' }, heavy: { effort: 'high' } },
};

const STRONG = ['claude', 'agy', 'junie', 'gemini', 'qwen', 'cline', 'opencode', 'kilo'];
const THRIFTY = ['qwen', 'agy', 'kilo', 'opencode', 'gemini', 'cline', 'goose', 'junie', 'claude'];
const CODERS = ['qwen', 'claude', 'junie', 'agy', 'kilo', 'aider', 'opencode', 'cline', 'goose'];

// these answer questions but can't be relied on to edit a repository
const CHAT_ONLY = new Set(['ollama', 'openai', 'llm', 'sgpt', 'cody', 'copilot']);

function preferenceFor(type, difficulty) {
  if (difficulty === 'hard') return STRONG;
  if (difficulty === 'easy') return THRIFTY;
  if (type === 'code' || type === 'test' || type === 'docs') return CODERS;
  return STRONG;
}

// ---------------------------------------------------------------- classification

const SIGNALS = {
  plan: [/\b(?:plan|architect|outline|break ?down|roadmap|strategy|proposal)\b/g],
  research: [/\b(?:research|investigate|explore|explain|find out|look into|understand|compare|summari[sz]e|analy[sz]e|locate)\b/g],
  review: [/\b(?:review|audit|inspect|critique|double.?check|security check)\b/g],
  code: [/\b(?:implement|add|build|create|write code|refactor|migrate|rename|remove|delete|update|change|integrate|wire|port|support|make)\b/g],
  debug: [/\b(?:fix(?:es)?|debug|bug|crash(?:es|ing)?|broken|failing|fails|error|regression|not working|doesn.t work)\b/g],
  test: [/\b(?:tests?|testing|unit tests?|e2e|coverage|verify|validate)\b/g],
  design: [/\b(?:ui|ux|css|layout|styles?|styling|design|theme|colou?rs?|animation|responsive|art)\b/g],
  docs: [/\b(?:docs?|documentation|readme|changelog|docstrings?|comments?|guide|tutorial)\b/g],
};

// the verb a task opens with says more than words buried later in it
const LEAD = [
  ['plan', /^(?:plan|architect|outline|design (?:the |an? )?(?:architecture|approach|api|schema|system))\b/],
  ['research', /^(?:research|investigate|explore|explain|find out|look into|compare|summari[sz]e|analy[sz]e)\b/],
  ['review', /^(?:review|audit|inspect|critique)\b/],
  ['debug', /^(?:fix|debug|repair|resolve)\b/],
  ['test', /^(?:test|verify|validate|(?:write|add|run) (?:the |some |new )?(?:unit |e2e |integration )?tests?)\b/],
  ['docs', /^(?:document|(?:write|update|add) (?:the |some )?(?:docs?|documentation|readme|changelog|comments?))\b/],
  ['code', /^(?:implement|add|build|create|refactor|migrate|rename|remove|port|integrate)\b/],
];

const LEADIN = /^(?:(?:and|then|also|next|finally|lastly|please|after that|afterwards|once (?:that|it).{0,20}?done)\b[,:]?\s*)+/i;

function classify(text) {
  const t = String(text).toLowerCase().trim().replace(LEADIN, '');
  const score = {};
  for (const [type, patterns] of Object.entries(SIGNALS)) {
    score[type] = patterns.reduce((n, re) => n + (t.match(re) || []).length, 0);
  }
  for (const [type, re] of LEAD) if (re.test(t)) score[type] += 3;
  // "review X and fix what you find" has to be able to edit
  if (/\b(?:and|then) (?:fix|repair|resolve|edit|apply)\b/.test(t)) score.debug += 5;
  const [best, n] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : 'code';
}

const HARD = /\b(?:architect(?:ure)?|redesign|rewrite|refactor|migrat\w+|race condition|deadlock|concurren\w+|security|vulnerabilit\w+|performance|optimi[sz]\w+|memory leak|intermittent|flaky|distributed|end.to.end|entire|whole (?:codebase|project|app|repo)|across (?:the|all|every)|root cause|protocol|algorithm)\b/i;
const EASY = /\b(?:typos?|rename|comments?|readme|changelog|bump|format(?:ting)?|lint|spelling|wording|label|version number|one.?liner|small|simple|trivial|minor|quick)\b/i;

function rateDifficulty(text) {
  const t = String(text);
  if (HARD.test(t) || t.length > 700) return 'hard';
  if (EASY.test(t) && t.length < 240) return 'easy';
  return 'medium';
}

// ---------------------------------------------------------------- splitting

const VERBS = 'add|analy[sz]e|audit|build|bump|change|check|clean|compare|create|debug|delete|deploy|design|document|explain|explore|find|fix|implement|improve|integrate|investigate|make|migrate|optimi[sz]e|plan|port|redesign|refactor|remove|rename|repair|research|review|rewrite|run|test|update|upgrade|verify|write';
const SENTENCE_SPLIT = new RegExp(
  [
    '(?<=[.!?])\\s+(?=[A-Z])', // sentences
    '\\s*;\\s+',
    ',?\\s+(?=(?:and\\s+)?(?:then|after that|afterwards|finally|lastly)\\b)',
    `,?\\s+(?:and\\s+)?also\\s+(?=(?:${VERBS})\\b)`,
    `,\\s*(?:and\\s+)?(?=(?:${VERBS})\\b)`,
    `\\s+and\\s+(?=(?:${VERBS})\\s+(?:a|an|the|all|any|some|its|our|my|new|unit|tests?|docs?|readme)\\b)`,
  ].join('|'),
  'i',
);
const STARTS_WITH_VERB = new RegExp(`^(?:${VERBS})\\b`, 'i');
const SEQUENTIAL = /^(?:and\s+)?(?:then|after (?:that|this|which)|afterwards|next|finally|lastly|once)\b/i;
const BACKREF = /\b(?:it|them|those|these|that (?:change|fix|feature|code|plan)|the (?:plan|change|fix|feature|result)s?|above|previous)\b/i;
const LIST_ITEM = /^\s*(?:[-*•]|\d{1,2}[.)]|step\s+\d+[.:)]?)\s+/i;

function splitList(text) {
  const items = [];
  const preamble = [];
  let current = null;
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    // only the outermost bullets start a task; nested ones belong to their parent
    if (!fence && LIST_ITEM.test(line) && !/^\s{2,}/.test(line)) {
      current = [line.replace(LIST_ITEM, '')];
      items.push(current);
    } else if (current) current.push(line);
    else preamble.push(line);
  }
  if (items.length < 2) return null;
  return { items: items.map((i) => i.join('\n').trim()).filter(Boolean), preamble: preamble.join('\n').trim() };
}

function splitProse(text) {
  if (text.includes('```')) return [text];
  const pieces = text
    .split(/\n\s*\n/)
    .flatMap((para) => para.replace(/\s*\n\s*/g, ' ').split(SENTENCE_SPLIT))
    .map((p) => p.trim().replace(/[,;]+$/, ''))
    .filter(Boolean);
  // a fragment that asks for nothing ("It crashes on start.") is detail for its neighbour
  const out = [];
  let lead = '';
  for (const piece of pieces) {
    const bare = piece.replace(LEADIN, '');
    const asks = STARTS_WITH_VERB.test(bare) || /\b(?:should|must|needs? to|have to|i want|can you)\b/i.test(piece);
    if (asks) {
      out.push(lead ? `${lead} ${piece}` : piece);
      lead = '';
    } else if (out.length) out[out.length - 1] += `${/[.!?]$/.test(out[out.length - 1]) ? '' : '.'} ${piece}`;
    else lead = lead ? `${lead} ${piece}` : piece;
  }
  if (lead) out.push(lead);
  return out;
}

function heuristicSplit(text) {
  const list = splitList(text);
  const parts = list ? list.items : splitProse(text);
  const tasks = [];
  parts.slice(0, MAX_TASKS).forEach((part, i) => {
    // never drop work: anything past the cap rides along with the last task
    const body = i === MAX_TASKS - 1 ? parts.slice(i).join('\n') : part;
    const type = classify(body);
    const bare = body.replace(LEADIN, '');
    const clean = bare.charAt(0).toUpperCase() + bare.slice(1);
    const task = {
      id: `t${i + 1}`,
      title: truncate(clean.split('\n')[0], 60),
      prompt: list?.preamble ? `${list.preamble}\n\n${clean}` : clean,
      type,
      difficulty: rateDifficulty(body),
      writes: TYPES[type].writes,
      dependsOn: [],
    };
    if (tasks.length) {
      const prev = tasks[tasks.length - 1];
      if (type === 'test' || type === 'review' || type === 'docs') task.dependsOn = tasks.map((t) => t.id);
      else if (SEQUENTIAL.test(body) || BACKREF.test(body) || prev.type === 'plan' || prev.type === 'research') task.dependsOn = [prev.id];
    }
    tasks.push(task);
  });
  return tasks;
}

// ---------------------------------------------------------------- planner

function plannerPrompt(instructions) {
  return [
    'Split the instructions below into tasks for separate coding agents. Do not carry them out and do not modify any files.',
    'You may read files to understand the scope.',
    '',
    'Reply with only a JSON object, no prose:',
    '{"tasks":[{"id":"t1","title":"short label","prompt":"complete standalone instructions","type":"code","difficulty":"medium","writes":true,"dependsOn":[]}]}',
    '',
    `- type: one of ${Object.keys(TYPES).join(', ')}`,
    '- difficulty: easy (mechanical), medium, or hard (needs deep reasoning)',
    '- writes: true if the task may change files or system state',
    '- dependsOn: ids of earlier tasks whose result this one needs; leave empty when independent',
    '- each agent sees only its own prompt plus the output of its dependencies, so repeat any constraint, path or detail it needs',
    `- cover everything asked and nothing more; use the fewest tasks that make sense, at most ${MAX_TASKS}; one task is fine`,
    '',
    '<instructions>',
    instructions,
    '</instructions>',
  ].join('\n');
}

function extractJson(text) {
  const s = String(text || '');
  const candidates = [...s.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const first = s.indexOf('{"tasks"') >= 0 ? s.indexOf('{"tasks"') : s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(s.slice(first, last + 1));
  for (const raw of candidates) {
    try {
      const value = JSON.parse(raw);
      if (Array.isArray(value?.tasks)) return value;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// Planner output is untrusted: fill gaps, fix ids, and make the graph acyclic.
function normalizeTasks(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_TASKS) return null;
  if (raw.some((t) => !t || typeof t.prompt !== 'string' || !t.prompt.trim())) return null;
  const items = raw.map((t, i) => ({ ...t, key: String(t.id ?? `t${i + 1}`) }));
  const keys = new Set(items.map((t) => t.key));
  if (keys.size !== items.length) return null;
  for (const t of items) t.deps = (Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : []).filter((d) => d !== t.key && keys.has(d));

  const ordered = [];
  const placed = new Set();
  while (ordered.length < items.length) {
    // on a cycle, take the earliest remaining task and drop its unmet edges
    const next = items.find((t) => !placed.has(t.key) && t.deps.every((d) => placed.has(d))) || items.find((t) => !placed.has(t.key));
    next.deps = next.deps.filter((d) => placed.has(d));
    placed.add(next.key);
    ordered.push(next);
  }

  const ids = new Map(ordered.map((t, i) => [t.key, `t${i + 1}`]));
  return ordered.map((t, i) => {
    const prompt = t.prompt.trim();
    const type = Object.hasOwn(TYPES, t.type) ? t.type : classify(prompt);
    return {
      id: `t${i + 1}`,
      title: truncate(String(t.title || prompt.split('\n')[0]), 60),
      prompt,
      type,
      difficulty: Object.hasOwn(DIFFICULTY_TIER, t.difficulty) ? t.difficulty : rateDifficulty(prompt),
      writes: typeof t.writes === 'boolean' ? t.writes : TYPES[type].writes,
      dependsOn: [...new Set(t.deps.map((d) => ids.get(d)))],
    };
  });
}

// ---------------------------------------------------------------- assignment

function onPath(command, env = process.env) {
  if (!command) return false;
  if (command.includes('/') || command.includes('\\')) return fs.existsSync(command);
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return String(env.PATH || '')
    .split(path.delimiter)
    .some((dir) => dir && exts.some((ext) => fs.existsSync(path.join(dir, command + ext))));
}

// CLIs that may take auto tasks. Terminal-scraped (pty) apps are left out unless
// named, since some forbid scripted use and their replies are best effort.
function eligibleBackends(app, only) {
  const { registry, config } = app;
  const named = only?.length ? only : config.auto?.backends?.length ? config.auto.backends : null;
  if (named) {
    const unknown = named.filter((n) => !registry.all.includes(n));
    if (unknown.length) throw new Error(`not connected: ${unknown.join(', ')} — connected: ${registry.all.join(', ')}`);
  }
  return (named || registry.all).filter((name) => {
    const def = registry.backend(name);
    return (named || def.dialect !== 'pty') && onPath(def.command);
  });
}

function isReady(registry, name) {
  return registry.pick(registry.all.filter((n) => n !== name), 'priority') === name;
}

function modelFor(def, name, tier) {
  const tiers = def.models || MODEL_TIERS[name] || {};
  const pick = tiers[tier];
  const choice = typeof pick === 'string' ? { model: pick } : pick || {};
  return { model: choice.model || null, effort: choice.effort || null };
}

// Ordered fallback list for one task: ready CLIs by fit, cooling-down ones last.
function routeFor(task, app, eligible) {
  const { registry, config } = app;
  const custom = config.auto?.routes?.[task.type];
  const preferred = custom || preferenceFor(task.type, task.difficulty);
  const rank = (n) => (preferred.includes(n) ? preferred.indexOf(n) : preferred.length + registry.all.indexOf(n));
  const paidLast = registry.getStrategy() === 'free-first' && task.difficulty !== 'hard';
  const cost = (n) => (paidLast && registry.backend(n).freeTier === false ? 1 : 0);
  let names = eligible.filter((n) => !(task.writes && CHAT_ONLY.has(n)));
  names.sort((a, b) => Number(!isReady(registry, a)) - Number(!isReady(registry, b)) || cost(a) - cost(b) || rank(a) - rank(b));
  const tier = DIFFICULTY_TIER[task.difficulty];
  const route = names.map((n) => ({ backend: n, ...modelFor(registry.backend(n), n, tier) }));
  // a CLI/model the user typed on the task wins over relay's choice
  if (task.pinned && registry.all.includes(task.pinned.backend)) {
    const own = modelFor(registry.backend(task.pinned.backend), task.pinned.backend, tier);
    const first = { backend: task.pinned.backend, ...own, ...(task.pinned.model ? { model: task.pinned.model } : {}) };
    return [first, ...route.filter((r) => r.backend !== first.backend)];
  }
  return route;
}

function assign(tasks, app, eligible) {
  const used = {};
  return tasks.map((task) => {
    const route = routeFor(task, app, eligible);
    if (!route.length) throw new Error(`no connected CLI can take "${task.title}" — /backends · /connect`);
    const role = TYPES[task.type].agent;
    used[role] = (used[role] || 0) + 1;
    const agent = `auto-${role}${used[role] > 1 ? `-${used[role]}` : ''}`;
    return { ...task, agent, route, backend: route[0].backend, model: route[0].model, effort: route[0].effort };
  });
}

function label(t) {
  return `${t.backend}${t.model ? `:${t.model}` : ''}${t.effort ? ` (${t.effort} effort)` : ''}`;
}

// ---------------------------------------------------------------- planning

function plannerCandidates(app, eligible, wanted) {
  const spec = wanted || app.config.auto?.planner;
  const route = routeFor({ type: 'plan', difficulty: 'medium', writes: false }, app, eligible);
  if (!spec) return route.filter((r) => isReady(app.registry, r.backend)).slice(0, 2);
  const [backend, model] = String(spec).split(/:(.*)/s);
  if (!app.registry.all.includes(backend)) throw new Error(`planner "${backend}" is not connected`);
  return [{ backend, ...modelFor(app.registry.backend(backend), backend, 'standard'), ...(model ? { model } : {}) }];
}

async function aiSplit(app, instructions, candidates, hooks, control) {
  const problems = [];
  for (const pick of candidates) {
    if (control.aborted) break;
    hooks.onPlanning?.(pick);
    const raw = app.registry.backend(pick.backend);
    const def = { ...raw, ...(pick.model ? { model: pick.model } : {}), ...(pick.effort ? { effort: pick.effort } : {}) };
    let release = () => {};
    const backend = new Backend(def, {
      permissionMode: 'default',
      timeoutMs: app.config.auto?.plannerTimeoutMs || 240_000,
      registerAbort: (fn) => {
        release = control.track(fn);
      },
    });
    // planning never skips permissions, even if the CLI's protocol says to
    backend.protocol = { ...backend.protocol, skipPermissions: false };
    const res = await backend.run({
      prompt: plannerPrompt(instructions),
      systemPrompt: app.systemPrompt(pick.backend),
      cwd: app.cwd,
    });
    release();
    if (res.ok) {
      app.registry.recordTurn(pick.backend, { ok: true, usage: res.result?.usage });
      const tasks = normalizeTasks(extractJson(res.text)?.tasks);
      if (tasks) return { tasks, planner: pick, problems };
      problems.push(`${pick.backend} did not return a usable task list`);
      continue;
    }
    app.registry.recordTurn(pick.backend, { ok: false, isQuota: res.kind === 'quota' });
    if (res.kind === 'quota' || res.kind === 'auth') {
      app.registry.markExhausted(pick.backend, { hard: true, reason: res.quota?.line || res.auth?.line || res.kind });
    }
    log.error(`auto planner failed on ${pick.backend}: ${res.kind}`, { kind: res.kind });
    problems.push(`${pick.backend}: ${res.kind}`);
  }
  return { tasks: null, planner: null, problems };
}

// Tasks the user already laid out with explicit [@cli] tags are kept as written.
function explicitSplit(instructions, app) {
  if (!/(?:\[@|^\s*@)[a-z0-9_-]+/im.test(instructions)) return null;
  const parsed = parseMultiStepPrompt(instructions, app.registry.all);
  if (!parsed.isMultiStep) return null;
  return parsed.steps.map((s, i) => {
    const type = classify(s.prompt);
    const tagged = new RegExp(`(?:\\[@?|@)${s.backend}\\b`, 'i').test(instructions);
    return {
      id: `t${i + 1}`,
      title: s.title,
      prompt: s.prompt,
      type,
      difficulty: rateDifficulty(s.prompt),
      writes: TYPES[type].writes,
      dependsOn: i ? [`t${i}`] : [],
      pinned: tagged ? { backend: s.backend, model: s.model } : null,
    };
  });
}

async function createPlan(app, instructions, hooks = {}, opts = {}) {
  const text = String(instructions || '').trim();
  if (!text) throw new Error('nothing to do: give relay auto some instructions');
  const control = opts.control || createControl();
  const eligible = eligibleBackends(app, opts.only);
  if (!eligible.length) throw new Error('no installed CLI is available for auto tasks — relay scan');

  let source = 'tags';
  let planner = null;
  let problems = [];
  let tasks = explicitSplit(text, app);
  if (!tasks && !opts.offline) {
    ({ tasks, planner, problems } = await aiSplit(app, text, plannerCandidates(app, eligible, opts.planner), hooks, control));
    source = 'planner';
  }
  if (!tasks && !control.aborted) {
    tasks = heuristicSplit(text);
    source = 'local';
  }
  if (control.aborted) return { aborted: true, tasks: [] };
  return { instructions: text, source, planner, problems, tasks: assign(tasks, app, eligible) };
}

// ---------------------------------------------------------------- execution

// Collects abort handles so one Ctrl-C stops the planner and every running task.
function createControl() {
  const live = new Set();
  return {
    aborted: false,
    track(fn) {
      if (this.aborted) fn();
      live.add(fn);
      return () => live.delete(fn);
    },
    abort() {
      this.aborted = true;
      for (const fn of live) fn();
    },
  };
}

function taskPrompt(task, plan, results) {
  const parts = [TYPES[task.type].brief];
  if (!task.writes) parts.push('This task is read-only: do not modify any files.');
  if (plan.tasks.length > 1) {
    parts.push(`You are handling task ${task.id} of ${plan.tasks.length}. Other agents handle the rest, so do only yours.`);
    parts.push(`## Overall request (context only)\n${plan.instructions}`);
  }
  for (const id of task.dependsOn) {
    const done = results.get(id);
    if (!done) continue;
    const body = done.output.length > CONTEXT_CAP ? `…${done.output.slice(-CONTEXT_CAP)}` : done.output;
    parts.push(`## Result of ${id}: ${done.task.title}\n${body}`);
  }
  parts.push(`## Your task\n${task.prompt}`);
  return parts.join('\n\n');
}

async function runTask(app, task, plan, results, hooks, control) {
  const { App } = require('./app'); // app.js and multistep.js load before this module is needed
  const session = store.createSession(app.config.home, app.cwd, task.agent);
  let release = () => {};
  const worker = new App({
    config: app.config,
    registry: app.registry,
    session,
    cwd: app.cwd,
    ui: { onFailover: (info) => hooks.onFailover?.(task, info) },
    // workers must not each rewrite AGENTS.md; the main session syncs once at the end
    opts: { ...app.opts, autoSync: false, ...(task.writes ? {} : { readOnly: true }) },
  });
  const out = await worker.turn(
    taskPrompt(task, plan, results),
    { onEvent: (evt, backend) => hooks.onEvent?.(task, evt, backend) },
    {
      skipPipeline: true,
      route: task.route,
      onSpawn: (abort) => {
        release = control.track(abort);
      },
    },
  );
  release();

  const backend = out.backend || task.backend;
  const used = task.route.find((r) => r.backend === backend) || { model: null };
  saveAgent(app, task, backend, used.model, worker.session.header.sid);
  return {
    task,
    ok: out.ok,
    aborted: Boolean(out.aborted),
    backend,
    model: used.model,
    output: out.res?.text || '',
    error: out.ok ? null : out.res?.kind || out.reason || 'failed',
  };
}

// Each task leaves an agent behind, so `relay agent auto-coder --attach` can pick it up.
function saveAgent(app, task, backend, model, sessionId) {
  const home = app.config.home;
  let name = task.agent;
  // never overwrite an agent the user made that happens to use the same name
  for (let n = 2; findAgent(home, name) && !findAgent(home, name).auto; n += 1) name = `${task.agent}-x${n}`;
  task.agent = name;
  try {
    new Agent({ name, backend, model, cwd: app.cwd, home, sessionId, auto: true }).save();
  } catch (err) {
    log.error(`could not save agent ${name}`, err);
  }
}

// Read-only tasks share the directory in parallel. A task that writes runs alone,
// so agents never edit over each other or read half-finished changes.
async function runPlan(app, plan, hooks = {}, opts = {}) {
  const control = opts.control || createControl();
  const limit = Math.max(1, Number(opts.parallel || app.config.auto?.parallel || 3) || 1);
  const results = new Map();
  const skipped = new Map();
  const pending = [...plan.tasks];
  const running = new Map();
  let writing = false;

  while (pending.length || running.size) {
    for (let i = 0; i < pending.length && !control.aborted; ) {
      const task = pending[i];
      const broken = task.dependsOn.find((d) => skipped.has(d) || (results.has(d) && !results.get(d).ok));
      if (broken) {
        pending.splice(i, 1);
        skipped.set(task.id, broken);
        hooks.onTaskSkipped?.(task, broken);
        continue;
      }
      const waiting = task.dependsOn.some((d) => !results.has(d));
      const blocked = writing || running.size >= limit || (task.writes && running.size > 0);
      if (waiting || blocked) {
        // a ready writer holds the queue so later readers can't starve it
        if (!waiting && task.writes) break;
        i += 1;
        continue;
      }
      pending.splice(i, 1);
      if (task.writes) writing = true;
      hooks.onTaskStart?.(task, plan);
      const job = runTask(app, task, plan, results, hooks, control)
        .catch((err) => {
          log.error(`auto task ${task.id} crashed`, err);
          return { task, ok: false, backend: task.backend, model: task.model, output: '', error: err.message };
        })
        .then((result) => {
          running.delete(task.id);
          if (task.writes) writing = false;
          results.set(task.id, result);
          hooks.onTaskEnd?.(task, result);
        });
      running.set(task.id, job);
    }
    if (!running.size) break;
    await Promise.race(running.values());
  }

  const ordered = plan.tasks.map(
    (t) =>
      results.get(t.id) || {
        task: t,
        ok: false,
        skipped: true,
        backend: null,
        model: null,
        output: '',
        error: skipped.has(t.id) ? `skipped: ${skipped.get(t.id)} did not finish` : 'not run: interrupted',
      },
  );
  record(app, plan, ordered);
  return { ok: ordered.every((r) => r.ok), aborted: control.aborted, results: ordered };
}

function record(app, plan, results) {
  const summary = results
    .map((r) => {
      const head = `${r.task.id} [${r.task.agent}${r.backend ? ` on ${r.backend}` : ''}] ${r.task.title} — ${r.ok ? 'done' : r.error}`;
      return r.output ? `${head}\n${truncate(r.output, SUMMARY_CAP)}` : head;
    })
    .join('\n\n');
  // appended last, so this stays the directory's latest session for `relay -c`.
  // Sessions are ordered by millisecond, so step past the last worker's write.
  const stamp = Date.now();
  while (Date.now() <= stamp);
  store.appendEntry(app.session, { kind: 'user', t: Date.now(), text: plan.instructions });
  store.appendEntry(app.session, { kind: 'assistant', t: Date.now(), backend: 'auto', text: summary, tools: [], usage: null, durationMs: null });
  store.rewriteHeader(app.session);
  try {
    app.sync();
  } catch (err) {
    log.error('auto could not sync AGENTS.md', err);
  }
}

module.exports = {
  createPlan,
  runPlan,
  createControl,
  heuristicSplit,
  classify,
  rateDifficulty,
  normalizeTasks,
  extractJson,
  assign,
  eligibleBackends,
  onPath,
  label,
  TYPES,
  MODEL_TIERS,
};
