const http = require('http');
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
  let session = store.latestSession(config.home, cwd);
  if (!session) {
    session = store.createSession(config.home, cwd);
  } else {
    session = store.openSession(session.file);
  }

  let activeApp = new App({
    config,
    registry,
    session,
    cwd,
    ui: {
      onTurnStart: (info) => log.info('turn start', info),
      onFailover: (info) => log.warn('failover', info),
    },
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
        req.on('data', (c) => (body += c));
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
          session: session.header.sid,
          cwd: activeApp.cwd,
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

      if (pathname === '/api/session/new' && req.method === 'POST') {
        session = store.createSession(config.home, cwd);
        activeApp = new App({
          config,
          registry,
          session,
          cwd,
          ui: {
            onTurnStart: (info) => log.info('turn start', info),
            onFailover: (info) => log.warn('failover', info),
          },
        });
        return sendJson(200, { ok: true, session: session.header.sid });
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

        const origTurnStart = activeApp.ui.onTurnStart;
        const origFailover = activeApp.ui.onFailover;

        activeApp.ui.onTurnStart = (info) => {
          sendSse('turn_start', info);
          origTurnStart?.(info);
        };

        activeApp.ui.onFailover = (info) => {
          sendSse('failover', info);
          origFailover?.(info);
        };

        try {
          const forceBackend = body.backend || null;
          const turnResult = await runInput(activeApp, prompt, hooks, { force: forceBackend });
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
          activeApp.ui.onTurnStart = origTurnStart;
          activeApp.ui.onFailover = origFailover;
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
    app: activeApp,
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
