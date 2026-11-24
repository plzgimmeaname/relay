#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createServerInstance, DEFAULT_PORT } = require('../lib/server');
const { c } = require('../lib/ui');

async function launchDesktop({ port = DEFAULT_PORT, cwd = process.cwd(), headless = false } = {}) {
  const instance = createServerInstance({ cwd });
  let serverInfo;

  try {
    serverInfo = await instance.listen(port);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      // Already running on that port, try next or reuse
      console.log(c.yellow(`Port ${port} in use, connecting to existing Relay Desktop server...`));
      serverInfo = { url: `http://127.0.0.1:${port}`, port };
    } else {
      throw err;
    }
  }

  const url = serverInfo.url;
  console.log(c.bold(c.cyan('◆ Relay Desktop')) + ' running at ' + c.underline(url));

  if (headless) {
    return { ...serverInfo, close: () => instance.close() };
  }

  // Open native application window
  const chromeApp = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'darwin' && fs.existsSync(chromeApp)) {
    const child = spawn(chromeApp, [
      `--app=${url}`,
      '--window-size=1200,820',
      '--window-position=100,80',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
  } else {
    // Fallback standard open
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
    child.unref();
  }

  return { ...serverInfo, close: () => instance.close() };
}

if (require.main === module) {
  launchDesktop().catch((err) => {
    console.error('Failed to launch Relay Desktop:', err);
    process.exit(1);
  });
}

module.exports = { launchDesktop };
