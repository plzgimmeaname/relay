const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open, close) => (s) => (useColor ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));

const c = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  italic: wrap('3', '23'),
  underline: wrap('4', '24'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  blue: wrap('34', '39'),
  magenta: wrap('35', '39'),
  cyan: wrap('36', '39'),
  gray: wrap('90', '39'),
  white: wrap('97', '39'),
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
    for (const r of rows) out.push(render(r, (s) => s));
    return out.join('\n');
  }
  return rows.map((r) => render(r, (s) => s)).join('\n');
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

module.exports = { c, rule, badge, bullets, table, truncate, indent, spinnerFrame, strip, WIDTH, useColor };
