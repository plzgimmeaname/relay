const fs = require('fs');
const path = require('path');
const os = require('os');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const rich = /256|color|truecolor|24bit/i.test(`${process.env.TERM || ''} ${process.env.COLORTERM || ''}`);

// 256-colour codes per theme, with the plain-ANSI fallback in the second slot.
const THEMES = {
  dark: {
    text: [252, 97],
    gray: [245, 90],
    border: [240, 90],
    red: [203, 31],
    green: [114, 32],
    yellow: [221, 33],
    blue: [111, 34],
    magenta: [177, 35],
    cyan: [79, 36],
    accent: [80, 36],
    white: [255, 97],
  },
  light: {
    text: [235, 30],
    gray: [241, 90],
    border: [249, 90],
    red: [160, 31],
    green: [28, 32],
    yellow: [130, 33],
    blue: [25, 34],
    magenta: [90, 35],
    cyan: [30, 36],
    accent: [24, 36],
    white: [235, 30],
  },
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
  accent: hue('accent'),
  border: hue('border'),
  gray: hue('gray'),
  white: hue('white'),
  text: hue('text'), // basic body text: explicit, so a dim terminal default cannot wash it out
};

const WIDTH = () => Math.max(48, Math.min(100, (process.stdout.columns || 80) - 4));

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_ONE = /\u001b\[[0-9;?]*[ -/]*[@-~]/;

function strip(s) {
  return String(s ?? '').replace(ANSI_RE, '');
}

// Display columns for one character: CJK and emoji take two cells, combining marks none.
function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function visibleWidth(s) {
  let w = 0;
  for (const ch of strip(s)) w += charWidth(ch);
  return w;
}

// Cut styled text to a column budget without breaking escape sequences.
function clipAnsi(value, max) {
  const s = String(value ?? '');
  if (visibleWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  let i = 0;
  let styled = false;
  while (i < s.length) {
    if (s[i] === '\u001b') {
      const m = ANSI_ONE.exec(s.slice(i));
      if (m) {
        out += m[0];
        styled = true;
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(s.codePointAt(i));
    const cw = charWidth(ch);
    if (w + cw > Math.max(0, max - 1)) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  if (styled) out += '\u001b[0m';
  return out + '…';
}

function padVisible(value, width, align = 'left') {
  const gap = Math.max(0, width - visibleWidth(value));
  return align === 'right' ? ' '.repeat(gap) + value : value + ' '.repeat(gap);
}

function truncate(value, max) {
  const s = strip(value);
  if (visibleWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

function rule(char = '─', width = WIDTH()) {
  return c.border(char.repeat(Math.max(1, width)));
}

function badge(text, color = 'gray') {
  return c.bold(c[color](` ${text} `));
}

function bullets(items, color = 'gray') {
  return items.map((i) => `  ${c[color]('•')} ${i}`).join('\n');
}

// A quiet section label with a hairline running to the right margin.
function heading(text, opts = {}) {
  const label = c.bold(c.gray(String(text).toUpperCase()));
  const width = opts.width || WIDTH();
  const fill = Math.max(6, width - visibleWidth(label) - 4);
  return `  ${label}  ${c.border('─'.repeat(fill))}`;
}

// Aligned key/value rows; multi-line values indent under the value column.
function fields(pairs, opts = {}) {
  if (!pairs.length) return '';
  const w = Math.max(...pairs.map(([k]) => visibleWidth(k)));
  return pairs
    .map(([k, v]) => {
      const lines = String(v ?? '').split('\n');
      const body = lines.map((l, i) => (i === 0 ? l : ' '.repeat(w + 4) + l)).join('\n');
      return `  ${c.gray(padVisible(k, w, opts.align))}  ${body}`;
    })
    .join('\n');
}

const NUMERIC = /^[−-]?[\d][\d.,%kmhsm]*$/i;

function table(rows, headers, opts = {}) {
  if (!rows || !rows.length) return '';
  const cols = Math.max(headers ? headers.length : 0, ...rows.map((r) => r.length));
  const cell = (r, i) => String(r[i] ?? '');

  const widths = [];
  for (let i = 0; i < cols; i += 1) {
    widths[i] = headers ? visibleWidth(headers[i]) : 0;
    for (const r of rows) widths[i] = Math.max(widths[i], visibleWidth(cell(r, i)));
  }

  // Numbers read better right-aligned; anything else stays left.
  const align = [];
  for (let i = 0; i < cols; i += 1) {
    if (opts.align && opts.align[i]) {
      align[i] = opts.align[i];
      continue;
    }
    const vals = rows.map((r) => strip(cell(r, i)).trim()).filter(Boolean);
    align[i] = vals.length > 0 && vals.every((v) => NUMERIC.test(v)) ? 'right' : 'left';
  }

  // Keep the table inside the terminal: shave the widest column until it fits.
  const gap = 2;
  const maxW = opts.width || WIDTH();
  const minW = 6;
  const total = () => widths.reduce((a, b) => a + b, 0) + gap * (cols - 1) + 2;
  let guard = 400;
  while (total() > maxW && guard > 0) {
    guard -= 1;
    let idx = -1;
    for (let i = 0; i < cols; i += 1) {
      if (widths[i] > minW && (idx < 0 || widths[i] > widths[idx])) idx = i;
    }
    if (idx < 0) break;
    widths[idx] -= 1;
  }

  const render = (value, i) => {
    const text = visibleWidth(value) > widths[i] ? clipAnsi(value, widths[i]) : value;
    return padVisible(text, widths[i], align[i]);
  };

  const out = [];
  if (headers && opts.header !== false) {
    out.push(
      (
        '  ' +
        headers
          .map((h, i) => c.bold(c.gray(padVisible(strip(h).toUpperCase(), widths[i], align[i] || 'left'))))
          .join(' '.repeat(gap))
      ).replace(/[ \t]+$/, ''),
    );
    out.push(c.border('  ' + widths.map((w) => '─'.repeat(w)).join(' '.repeat(gap))));
  }
  for (const r of rows) {
    const cells = [];
    for (let i = 0; i < cols; i += 1) {
      const raw = cell(r, i);
      const painted = /\u001b/.test(raw) ? raw : c.text(raw);
      cells.push(render(painted, i));
    }
    out.push(('  ' + cells.join(' '.repeat(gap))).replace(/[ \t]+$/, ''));
  }
  return out.join('\n');
}

function indent(text, prefix = '  ') {
  return String(text)
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

function spinnerFrame(text, frame = 0) {
  const glyphs = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  return `${c.accent(glyphs[frame % glyphs.length])} ${c.dim(text)}`;
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
  return state === 'ready' ? c.green('●') : state === 'cooldown' ? c.yellow('◐') : c.red('○');
}

function swatches() {
  return ['cyan', 'green', 'yellow', 'red', 'magenta', 'blue', 'gray'].map((n) => c[n]('██')).join(' ');
}

const TIPS = [
  'Tab completes commands and CLI names',
  '@qwen <prompt> asks one CLI without switching',
  '/auto splits a list of tasks across your CLIs',
  '/skill import <path> shares a skill with every CLI',
  '/credits shows quota health across every connected CLI',
  '/verbose compact trims tool output to a short view',
  '/theme light is easier on a white terminal',
  '/priority move qwen 1 promotes a CLI to first',
  '/export writes this session as markdown',
  '/note pins an instruction into every prompt',
  'Ctrl-C interrupts a reply · twice quits',
];

module.exports = {
  LOGO,
  gradient,
  logoLines,
  dot,
  TIPS,
  resetTerminal,
  THEMES,
  setTheme,
  getTheme: () => theme,
  c,
  rule,
  badge,
  bullets,
  heading,
  fields,
  table,
  truncate,
  clipAnsi,
  indent,
  spinnerFrame,
  strip,
  visibleWidth,
  padVisible,
  swatches,
  WIDTH,
  useColor,
};
