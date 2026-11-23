const fs = require('fs');
const path = require('path');
const os = require('os');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const rich = /256|color|truecolor|24bit/i.test(`${process.env.TERM || ''} ${process.env.COLORTERM || ''}`);

// 256-colour codes per theme, with the plain-ANSI fallback in the second slot.
const THEMES = {
  dark: { text: [255, 97], gray: [250, 37], red: [203, 31], green: [114, 32], yellow: [222, 33], blue: [111, 34], magenta: [176, 35], cyan: [80, 36], white: [255, 97] },
  light: { text: [16, 30], gray: [238, 90], red: [160, 31], green: [28, 32], yellow: [130, 33], blue: [25, 34], magenta: [90, 35], cyan: [31, 36], white: [16, 30] },
  mono: {},
};

function themeFile() {
  return path.join(process.env.RELAY_HOME || path.join(os.homedir(), '.relay'), 'theme');
}

function readTheme() {
  const env = process.env.RELAY_THEME;
  if (env && THEMES[env]) return env;
  try {
    const saved = fs.readFileSync(themeFile(), 'utf8').trim();
    if (THEMES[saved]) return saved;
  } catch {
    /* no saved theme */
  }
  return 'dark';
}

let theme = readTheme();

function setTheme(name, persist = true) {
  if (!THEMES[name]) throw new Error(`unknown theme "${name}" — ${Object.keys(THEMES).join(', ')}`);
  theme = name;
  if (persist) {
    try {
      fs.mkdirSync(path.dirname(themeFile()), { recursive: true });
      fs.writeFileSync(themeFile(), name + '\n');
    } catch {
      /* theme still applies for this run */
    }
  }
}

const style = (open, close) => (s) => (useColor ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));
const hue = (name) => (s) => {
  const pair = THEMES[theme][name];
  if (!useColor || !pair) return String(s);
  return `\u001b[${rich ? `38;5;${pair[0]}` : pair[1]}m${s}\u001b[39m`;
};

const c = {
  bold: style('1', '22'),
  dim: style('2', '22'),
  italic: style('3', '23'),
  underline: style('4', '24'),
  red: hue('red'),
  green: hue('green'),
  yellow: hue('yellow'),
  blue: hue('blue'),
  magenta: hue('magenta'),
  cyan: hue('cyan'),
  gray: hue('gray'),
  white: hue('white'),
  text: hue('text'), // basic body text: explicit, so a dim terminal default cannot wash it out
};

const WIDTH = () => Math.max(48, Math.min(100, (process.stdout.columns || 80) - 4));

function strip(s) {
  return String(s ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}

function rule(char = '─') {
  return c.gray(char.repeat(WIDTH()));
}

function badge(text, color = 'gray') {
  return c.bold(c[color](` ${text} `));
}

function bullets(items, color = 'gray') {
  return items.map((i) => `  ${c[color]('•')} ${i}`).join('\n');
}

function table(rows, headers) {
  if (!rows.length) return headers ? table([headers.map(() => '')], null) : '';
  const all = headers ? [headers, ...rows] : rows;
  const widths = all[0].map((_, i) => Math.max(...all.map((r) => strip(r[i] ?? '').length)));
  const render = (cells, style) =>
    '  ' +
    cells
      .map((cell, i) => {
        const padded = String(cell ?? '') + ' '.repeat(Math.max(0, widths[i] - strip(cell).length));
        return typeof style === 'function' ? style(padded, i) : padded;
      })
      .join(c.gray('  '));
  const out = [];
  if (headers) {
    out.push(
      '  ' +
        headers
          .map((h, i) => c.bold(c.gray(strip(h).toUpperCase().padEnd(widths[i]))))
          .join(c.gray('  ')),
    );
    out.push(c.gray('  ' + widths.map((w) => '─'.repeat(w)).join('  ')));
    for (const r of rows) out.push(render(r, (s) => c.text(s)));
    return out.join('\n');
  }
  return rows.map((r) => render(r, (s) => c.text(s))).join('\n');
}

function truncate(value, max) {
  const s = strip(value);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function indent(text, prefix = '  ') {
  return String(text)
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

function spinnerFrame(text, frame = 0) {
  const glyphs = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  return `${c.cyan(glyphs[frame % glyphs.length])} ${c.dim(text)}`;
}

// Undo what a misbehaving child may have left on the terminal: mouse tracking, bracketed
// paste, focus reports, kitty keyboard mode, alternate screen, hidden cursor.
function resetTerminal(out = process.stdout) {
  if (!out.isTTY) return;
  out.write('\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?2004l\u001b[?1004l\u001b[?2027l\u001b[?2031l\u001b[<u\u001b[>4;0m\u001b[?1049l\u001b[?25h');
}

// ---- startup look ------------------------------------------------------------------
const LOGO = [
  '██████╗ ███████╗██╗      █████╗ ██╗   ██╗',
  '██╔══██╗██╔════╝██║     ██╔══██╗╚██╗ ██╔╝',
  '██████╔╝█████╗  ██║     ███████║ ╚████╔╝ ',
  '██╔══██╗██╔══╝  ██║     ██╔══██║  ╚██╔╝  ',
  '██║  ██║███████╗███████╗██║  ██║   ██║   ',
  '╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   ',
];

// colour ramps (256-colour codes) swept left to right across the logo
const RAMPS = {
  dark: [51, 45, 39, 33, 63, 99, 135, 171, 207],
  light: [25, 26, 62, 98, 91, 127, 161],
};

function gradient(text, row = 0) {
  const ramp = RAMPS[theme];
  if (!useColor || !ramp || !rich) return c.bold(c.cyan(text));
  const chars = [...text];
  const span = Math.max(1, chars.length - 1);
  return chars
    .map((ch, i) => {
      if (ch === ' ') return ch;
      const pos = Math.min(ramp.length - 1, Math.round(((i + row * 2) / (span + 12)) * (ramp.length - 1)));
      return `\u001b[1;38;5;${ramp[pos]}m${ch}`;
    })
    .join('') + '\u001b[0m';
}

function logoLines() {
  return LOGO.map((l, r) => '  ' + gradient(l, r));
}

function dot(state) {
  return state === 'ready' ? c.green('●') : state === 'cooldown' ? c.yellow('●') : c.red('●');
}

const TIPS = [
  'Tab completes commands and CLI names',
  '/native lists history other CLIs kept; /import brings one in',
  '/verbose compact gives a shorter view of tool output',
  '/theme light is easier to read on a white terminal',
  '/priority move junie 1 changes who gets asked first',
  '/export saves this session as markdown',
  '/note pins an instruction into every prompt',
  'Ctrl-C interrupts a reply; twice quits',
];

module.exports = { LOGO, gradient, logoLines, dot, TIPS, resetTerminal, THEMES, setTheme, getTheme: () => theme, c, rule, badge, bullets, table, truncate, indent, spinnerFrame, strip, WIDTH, useColor };
