const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { loadConfig } = require('./config');
const { Registry } = require('./registry');
const store = require('./store');
const { App } = require('./app');
const { scanInstalledCLIs, autoConnectAll } = require('./scanner');
const log = require('./log');
const { runInput } = require('./webinput');
const chats = require('./chats');
const skills = require('./skills');
const { MODEL_TIERS } = require('./auto');

const DEFAULT_PORT = 4242;

const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

function isLocalRequest(req) {
  const host = req.headers.host || '';
  if (!LOOPBACK.test(host)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}`;
}

function createServerInstance({ cwd = process.cwd(), home = null } = {}) {
  const config = loadConfig();
  if (home) config.home = home;
  const registry = new Registry(config.home, config);
  const ui = {
    onTurnStart: (info) => log.info('turn start', info),
    onFailover: (info) => log.warn('failover', info),
  };
  const appFor = (session, dir) => new App({ config, registry, session, cwd: dir, ui: { ...ui } });
  const latestOrNew = (dir) => {
    const latest = store.latestSession(config.home, dir);
    return latest ? store.openSession(latest.file) : store.createSession(config.home, dir);
  };

  let activeApp = appFor(latestOrNew(cwd), cwd);
  let busy = false; // one turn at a time; the open chat can't change underneath it

  const modelsFor = (name) => {
    const def = registry.backend(name) || {};
    const tiers = Object.values(def.models || MODEL_TIERS[name] || {}).map((v) => (typeof v === 'string' ? v : v?.model));
    return [...new Set([def.model, ...tiers].filter(Boolean))];
  };

  // open a stored chat, working in the folder it belongs to
  const openChat = (file) => {
    const session = store.openSession(file);
    const dir = session.header.cwd;
    if (!dir || !fs.existsSync(dir)) throw new Error(`this chat's folder no longer exists: ${dir}`);
    activeApp = appFor(session, dir);
  };

  // reuse the current chat while it's still empty, so "New chat" doesn't pile up blanks
  const newChat = (dir) => {
    if (activeApp.cwd === dir && !activeApp.session.entries.length) return;
    activeApp = appFor(store.createSession(config.home, dir), dir);
  };

  const chatPayload = () => ({
    sid: activeApp.session.header.sid,
    title: chats.titleOf(activeApp.session.header, activeApp.session.entries),
    pinned: Boolean(activeApp.session.header.pinned),
    cwd: activeApp.cwd,
    entries: activeApp.session.entries,
  });

  const publicDir = path.join(__dirname, '..', 'desktop', 'public');

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;

    const sendJson = (statusCode, data) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };

    const parseBody = () =>
      new Promise((resolve) => {
        let body = '';
        req.on('data', (c) => {
          body += c;
          if (body.length > 12 * 1024 * 1024) req.destroy();
        });
        req.on('end', () => {
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch {
            resolve({});
          }
        });
      });

    // This API runs coding agents, so only the app itself may call it: a loopback
    // Host (blocks DNS rebinding) and, from browsers, a matching Origin (blocks other sites).
    if (!isLocalRequest(req)) return sendJson(403, { ok: false, error: 'only the local relay app may use this server' });

    try {
      // API Routes
      if (pathname === '/api/status') {
        const st = activeApp.status();
        return sendJson(200, {
          ok: true,
          status: st,
          strategy: registry.getStrategy(),
          backends: registry.creditStatus(),
          order: registry.all,
          available: registry.available,
          session: activeApp.session.header.sid,
          title: chats.titleOf(activeApp.session.header, activeApp.session.entries),
          cwd: activeApp.cwd,
          busy,
          models: Object.fromEntries(registry.all.map((n) => [n, modelsFor(n)])),
        });
      }

      if (pathname === '/api/backends') {
        return sendJson(200, {
          ok: true,
          backends: registry.creditStatus(),
          order: registry.all,
          strategy: registry.getStrategy(),
        });
      }

      if (pathname === '/api/strategy' && req.method === 'POST') {
        const body = await parseBody();
        const strat = body.strategy;
        if (!strat) return sendJson(400, { ok: false, error: 'strategy is required' });
        try {
          registry.setStrategy(strat);
          return sendJson(200, { ok: true, strategy: registry.getStrategy() });
        } catch (err) {
          return sendJson(400, { ok: false, error: err.message });
        }
      }

      if (pathname === '/api/priority' && req.method === 'POST') {
        const body = await parseBody();
        if (!Array.isArray(body.order)) return sendJson(400, { ok: false, error: 'order array required' });
        registry.setOrder(body.order);
        return sendJson(200, { ok: true, order: registry.all });
      }

      if (pathname === '/api/use' && req.method === 'POST') {
        const body = await parseBody();
        if (!body.backend || !registry.all.includes(body.backend)) {
          return sendJson(400, { ok: false, error: 'invalid backend' });
        }
        activeApp.session.header.lastBackend = body.backend;
        store.rewriteHeader(activeApp.session);
        return sendJson(200, { ok: true, backend: body.backend });
      }

      if (pathname === '/api/forget' && req.method === 'POST') {
        const body = await parseBody();
        const target = body.backend === 'all' || !body.backend ? null : body.backend;
        registry.reset(target);
        return sendJson(200, { ok: true, message: target ? `Reset ${target}` : 'Reset all credit marks' });
      }

      if (pathname === '/api/scan') {
        const scanned = scanInstalledCLIs(cwd);
        if (req.method === 'POST') {
          const body = await parseBody();
          if (body.autoConnect) {
            const result = autoConnectAll(config, registry);
            return sendJson(200, { ok: true, scanned, autoConnect: result });
          }
        }
        return sendJson(200, { ok: true, scanned });
      }

      if (pathname === '/api/sessions') {
        const all = store.allSessions(config.home);
        return sendJson(200, { ok: true, sessions: all });
      }

      if (pathname === '/api/session') {
        const sid = parsed.searchParams.get('id');
        const found = store.findSession(config.home, sid);
        if (!found || found.ambiguous) return sendJson(404, { ok: false, error: 'session not found' });
        const sess = store.openSession(found.file);
        return sendJson(200, { ok: true, session: sess });
      }

      if (pathname === '/api/chats') {
        const found = chats.list(config.home, { query: parsed.searchParams.get('q') || '', keep: activeApp.session.header.sid });
        return sendJson(200, { ok: true, chats: found });
      }

      if (pathname === '/api/chat') return sendJson(200, { ok: true, chat: chatPayload() });

      if (pathname.startsWith('/api/chat/') && req.method === 'POST') {
        const body = await parseBody();
        const action = pathname.slice('/api/chat/'.length);
        const isOpen = body.sid === activeApp.session.header.sid;
        if (busy && action !== 'update') return sendJson(409, { ok: false, error: 'wait for the reply to finish, or stop it' });
        try {
          if (action === 'new') {
            const dir = body.cwd ? path.resolve(String(body.cwd).replace(/^~(?=\/|$)/, os.homedir())) : activeApp.cwd;
            if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`not a folder: ${dir}`);
            newChat(dir);
          } else if (action === 'open') {
            openChat(chats.locate(config.home, body.sid).file);
          } else if (action === 'update') {
            // edit the live object for the open chat, so its next write keeps the change
            const target = isOpen ? activeApp.session : store.openSession(chats.locate(config.home, body.sid).file);
            if (busy && !isOpen) return sendJson(409, { ok: false, error: 'wait for the reply to finish' });
            chats.update(target, body);
          } else if (action === 'delete') {
            chats.remove(config.home, body.sid);
            if (isOpen) {
              const dir = activeApp.cwd;
              activeApp = appFor(latestOrNew(dir), dir);
            }
          } else if (action === 'restore') {
            chats.restore(config.home, body.sid);
          } else if (action === 'branch') {
            const made = chats.branch(config.home, activeApp.session, Number(body.index));
            activeApp = appFor(made.session, activeApp.cwd);
            return sendJson(200, { ok: true, chat: chatPayload(), text: made.entry.text, attachments: made.entry.attachments || [] });
          } else {
            return sendJson(404, { ok: false, error: 'not found' });
          }
        } catch (err) {
          return sendJson(400, { ok: false, error: err.message });
        }
        return sendJson(200, { ok: true, chat: chatPayload() });
      }

      if (pathname === '/api/folders') {
        return sendJson(200, { ok: true, folders: chats.folders(config.home, activeApp.cwd) });
      }

      if (pathname === '/api/attach' && req.method === 'POST') {
        const body = await parseBody();
        try {
          return sendJson(200, { ok: true, file: chats.saveAttachment(config.home, body) });
        } catch (err) {
          return sendJson(400, { ok: false, error: err.message });
        }
      }

      // custom instructions are relay's notes: sent with every prompt, here and in the terminal
      if (pathname === '/api/notes') {
        const file = path.join(config.home, 'NOTES.md');
        if (req.method === 'POST') {
          const body = await parseBody();
          if (typeof body.text !== 'string') return sendJson(400, { ok: false, error: 'text is required' });
          fs.mkdirSync(config.home, { recursive: true });
          if (body.text.trim()) fs.writeFileSync(file, `${body.text.trimEnd()}\n`);
          else fs.rmSync(file, { force: true });
        }
        return sendJson(200, { ok: true, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' });
      }

      if (pathname === '/api/skills') {
        return sendJson(200, { ok: true, skills: skills.list(config.home).map((s) => ({ name: s.name, description: s.description })) });
      }

      if (pathname === '/api/sync' && req.method === 'POST') {
        const { file, block } = activeApp.sync();
        return sendJson(200, { ok: true, file, block });
      }

      if (pathname === '/api/agents') {
        const file = store.agentsPath(activeApp.cwd);
        const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        const block = text.match(/<!-- relay:progress -->\n?([\s\S]*?)<!-- \/relay:progress -->/);
        return sendJson(200, { ok: true, file, block: block ? block[1].trim() : '' });
      }

      if (pathname === '/api/logs') {
        const lines = log.tail(80);
        return sendJson(200, { ok: true, logs: lines });
      }

      if (pathname === '/api/abort' && req.method === 'POST') {
        if (activeApp.abort) {
          activeApp.abort();
          return sendJson(200, { ok: true, message: 'aborted' });
        }
        return sendJson(200, { ok: true, message: 'nothing running' });
      }

      // Live streaming turn execution over SSE
      if (pathname === '/api/prompt' && req.method === 'POST') {
        const body = await parseBody();
        const prompt = String(body.prompt || '').trim();
        if (!prompt) return sendJson(400, { ok: false, error: 'prompt cannot be empty' });
        if (busy) return sendJson(409, { ok: false, error: 'a reply is already in progress' });
        let attachments;
        try {
          attachments = chats.resolveAttachments(config.home, body.attachments || []);
        } catch (err) {
          return sendJson(400, { ok: false, error: err.message });
        }
        busy = true;
        const running = activeApp;

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const sendSse = (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        const hooks = {
          onEvent: (evt, backend) => {
            sendSse('cli_event', { backend, event: evt });
          },
          onPipelineStart: (data) => {
            sendSse('pipeline_start', data);
          },
          onStepStart: (data) => {
            sendSse('step_start', data);
          },
          onStepEnd: (data) => {
            sendSse('step_end', data);
          },
          onPipelineComplete: (data) => {
            sendSse('pipeline_complete', data);
          },
        };

        running.ui.onTurnStart = (info) => {
          sendSse('turn_start', info);
          ui.onTurnStart(info);
        };

        running.ui.onFailover = (info) => {
          sendSse('failover', info);
          ui.onFailover(info);
        };

        try {
          const forceBackend = body.backend || null;
          const turnResult = await runInput(running, prompt, hooks, { force: forceBackend, model: body.model || null, attachments });
          sendSse('turn_end', {
            ok: turnResult.ok,
            backend: turnResult.backend,
            isMultiStep: Boolean(turnResult.isMultiStep),
            totalSteps: turnResult.totalSteps || 1,
            text: turnResult.text || turnResult.res?.text || '',
            isError: !turnResult.ok,
            usage: turnResult.res?.result?.usage,
            durationMs: turnResult.res?.result?.durationMs,
          });
        } catch (err) {
          sendSse('turn_error', { error: err.message });
        } finally {
          Object.assign(running.ui, ui);
          busy = false;
          res.end();
        }
        return;
      }

      // Static file serving for Desktop App
      let filePath = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(publicDir, 'index.html');
      }

      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        const types = {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
        };
        res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
        return fs.createReadStream(filePath).pipe(res);
      }

      sendJson(404, { ok: false, error: 'not found' });
    } catch (err) {
      log.error('server error', { error: err.message, stack: err.stack });
      sendJson(500, { ok: false, error: err.message });
    }
  });

  return {
    server,
    get app() {
      return activeApp;
    },
    registry,
    config,
    listen(port = DEFAULT_PORT, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.listen(port, host, () => {
          const address = server.address();
          const actualPort = typeof address === 'object' ? address.port : port;
          const url = `http://${host}:${actualPort}`;
          resolve({ server, port: actualPort, url, host });
        });
        server.on('error', reject);
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = {
  createServerInstance,
  DEFAULT_PORT,
};
