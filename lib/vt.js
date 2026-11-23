// A small VT100/xterm screen emulator: enough to run a full-screen TUI headlessly,
// answer its terminal queries, and read back what it drew. Zero dependencies.
const { StringDecoder } = require('string_decoder');

class VT {
  constructor({ cols = 120, rows = 40, reply = () => {} } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.reply = reply;
    this.decoder = new StringDecoder('utf8');
    this.history = [];
    this.bracketed = false;
    this.alt = false;
    this.revision = 0; // bumps whenever visible text changes
    this.reset();
  }

  reset() {
    this.grid = Array.from({ length: this.rows }, () => this.blankRow());
    this.cx = 0;
    this.cy = 0;
    this.top = 0;
    this.bottom = this.rows - 1;
    this.saved = { cx: 0, cy: 0 };
    this.state = 'ground';
    this.buf = '';
  }

  blankRow() {
    return new Array(this.cols).fill(' ');
  }

  // ---- input -------------------------------------------------------------
  write(chunk) {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const before = this.revision;
    for (const ch of text) this.step(ch);
    return this.revision !== before;
  }

  step(ch) {
    const code = ch.codePointAt(0);
    switch (this.state) {
      case 'ground':
        if (code === 0x1b) this.state = 'esc';
        else if (code < 0x20 || code === 0x7f) this.control(code);
        else this.print(ch);
        return;
      case 'esc':
        if (ch === '[') {
          this.state = 'csi';
          this.buf = '';
        } else if (ch === ']') {
          this.state = 'osc';
          this.buf = '';
        } else if (ch === 'P' || ch === '_' || ch === '^' || ch === 'X') {
          this.state = 'str';
          this.buf = '';
        } else if (ch === '(' || ch === ')' || ch === '*' || ch === '+' || ch === '#' || ch === ' ') {
          this.state = 'skip1';
        } else {
          this.escape(ch);
          this.state = 'ground';
        }
        return;
      case 'skip1':
        this.state = 'ground';
        return;
      case 'csi':
        if (code >= 0x40 && code <= 0x7e) {
          this.csi(this.buf, ch);
          this.state = 'ground';
        } else if (code === 0x1b) {
          this.state = 'esc';
        } else if (code >= 0x20) {
          this.buf += ch;
          if (this.buf.length > 64) this.state = 'ground';
        }
        return;
      case 'osc':
      case 'str':
        if (code === 0x07) {
          if (this.state === 'osc') this.osc(this.buf);
          this.state = 'ground';
        } else if (code === 0x1b) {
          this.state = this.state === 'osc' ? 'oscEsc' : 'strEsc';
        } else {
          this.buf += ch;
          if (this.buf.length > 4096) this.state = 'ground';
        }
        return;
      case 'oscEsc':
        if (ch === '\\') this.osc(this.buf);
        this.state = ch === '\\' ? 'ground' : 'esc';
        return;
      case 'strEsc':
        this.state = ch === '\\' ? 'ground' : 'esc';
        return;
      default:
        this.state = 'ground';
    }
  }

  control(code) {
    if (code === 0x0a || code === 0x0b || code === 0x0c) this.lineFeed();
    else if (code === 0x0d) this.cx = 0;
    else if (code === 0x08) this.cx = Math.max(0, this.cx - 1);
    else if (code === 0x09) this.cx = Math.min(this.cols - 1, (Math.floor(this.cx / 8) + 1) * 8);
  }

  print(ch) {
    if (this.cx >= this.cols) {
      this.cx = 0;
      this.lineFeed();
    }
    if (this.grid[this.cy][this.cx] !== ch) {
      this.grid[this.cy][this.cx] = ch;
      this.revision += 1;
    }
    this.cx += 1;
  }

  lineFeed() {
    if (this.cy === this.bottom) this.scrollUp(1);
    else if (this.cy < this.rows - 1) this.cy += 1;
  }

  scrollUp(n) {
    for (let i = 0; i < n; i += 1) {
      const gone = this.grid.splice(this.top, 1)[0];
      this.history.push(gone.join('').replace(/\s+$/, ''));
      if (this.history.length > 5000) this.history.shift();
      this.grid.splice(this.bottom, 0, this.blankRow());
    }
    this.revision += 1;
  }

  scrollDown(n) {
    for (let i = 0; i < n; i += 1) {
      this.grid.splice(this.bottom, 1);
      this.grid.splice(this.top, 0, this.blankRow());
    }
    this.revision += 1;
  }

  escape(ch) {
    if (ch === 'M') {
      if (this.cy === this.top) this.scrollDown(1);
      else this.cy = Math.max(0, this.cy - 1);
    } else if (ch === 'D') this.lineFeed();
    else if (ch === 'E') {
      this.cx = 0;
      this.lineFeed();
    } else if (ch === '7') this.saved = { cx: this.cx, cy: this.cy };
    else if (ch === '8') {
      this.cx = this.saved.cx;
      this.cy = this.saved.cy;
    } else if (ch === 'c') this.reset();
  }

  osc(body) {
    if (/^10;\?/.test(body)) this.reply('\x1b]10;rgb:e5e5/e5e5/e5e5\x1b\\');
    else if (/^11;\?/.test(body)) this.reply('\x1b]11;rgb:0000/0000/0000\x1b\\');
  }

  csi(body, final) {
    const marker = /^[?<>=]/.test(body) ? body[0] : '';
    const rest = marker ? body.slice(1) : body;
    const inter = (rest.match(/[ -/]+$/) || [''])[0];
    const nums = rest
      .slice(0, rest.length - inter.length)
      .split(';')
      .map((p) => (p === '' ? null : parseInt(p, 10)));
    const p = (i, d) => (nums[i] == null || Number.isNaN(nums[i]) ? d : nums[i]);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    if (marker === '?' && (final === 'h' || final === 'l')) {
      for (const mode of nums) {
        if (mode === 1049 || mode === 1047 || mode === 47) {
          this.alt = final === 'h';
          if (final === 'h') {
            this.clearAll();
            this.cx = 0;
            this.cy = 0;
          }
        } else if (mode === 2004) this.bracketed = final === 'h';
      }
      return;
    }
    if (marker === '?' && final === 'p' && inter === '$') {
      for (const mode of nums) this.reply(`\x1b[?${mode};0$y`);
      return;
    }
    if (marker === '?' && final === 'u') return this.reply('\x1b[?0u');
    if (marker === '>' && final === 'q') return this.reply('\x1bP>|relay 0.1\x1b\\');
    if (marker === '>' && final === 'c') return this.reply('\x1b[>0;0;0c');
    if (marker) return;

    switch (final) {
      case 'A':
        this.cy = clamp(this.cy - p(0, 1), 0, this.rows - 1);
        break;
      case 'B':
      case 'e':
        this.cy = clamp(this.cy + p(0, 1), 0, this.rows - 1);
        break;
      case 'C':
      case 'a':
        this.cx = clamp(this.cx + p(0, 1), 0, this.cols - 1);
        break;
      case 'D':
        this.cx = clamp(this.cx - p(0, 1), 0, this.cols - 1);
        break;
      case 'E':
        this.cx = 0;
        this.cy = clamp(this.cy + p(0, 1), 0, this.rows - 1);
        break;
      case 'F':
        this.cx = 0;
        this.cy = clamp(this.cy - p(0, 1), 0, this.rows - 1);
        break;
      case 'G':
      case '`':
        this.cx = clamp(p(0, 1) - 1, 0, this.cols - 1);
        break;
      case 'd':
        this.cy = clamp(p(0, 1) - 1, 0, this.rows - 1);
        break;
      case 'H':
      case 'f':
        this.cy = clamp(p(0, 1) - 1, 0, this.rows - 1);
        this.cx = clamp(p(1, 1) - 1, 0, this.cols - 1);
        break;
      case 'J': {
        const m = p(0, 0);
        if (m === 2 || m === 3) this.clearAll();
        else if (m === 0) {
          this.eraseRow(this.cy, this.cx, this.cols);
          for (let y = this.cy + 1; y < this.rows; y += 1) this.eraseRow(y, 0, this.cols);
        } else {
          for (let y = 0; y < this.cy; y += 1) this.eraseRow(y, 0, this.cols);
          this.eraseRow(this.cy, 0, this.cx + 1);
        }
        break;
      }
      case 'K': {
        const m = p(0, 0);
        if (m === 0) this.eraseRow(this.cy, this.cx, this.cols);
        else if (m === 1) this.eraseRow(this.cy, 0, this.cx + 1);
        else this.eraseRow(this.cy, 0, this.cols);
        break;
      }
      case 'X':
        this.eraseRow(this.cy, this.cx, this.cx + p(0, 1));
        break;
      case 'L':
        if (this.cy >= this.top && this.cy <= this.bottom) {
          for (let i = 0; i < p(0, 1); i += 1) {
            this.grid.splice(this.bottom, 1);
            this.grid.splice(this.cy, 0, this.blankRow());
          }
          this.revision += 1;
        }
        break;
      case 'M':
        if (this.cy >= this.top && this.cy <= this.bottom) {
          for (let i = 0; i < p(0, 1); i += 1) {
            this.grid.splice(this.cy, 1);
            this.grid.splice(this.bottom, 0, this.blankRow());
          }
          this.revision += 1;
        }
        break;
      case 'P': {
        const row = this.grid[this.cy];
        row.splice(this.cx, Math.min(p(0, 1), this.cols - this.cx));
        while (row.length < this.cols) row.push(' ');
        this.revision += 1;
        break;
      }
      case '@': {
        const row = this.grid[this.cy];
        for (let i = 0; i < p(0, 1); i += 1) row.splice(this.cx, 0, ' ');
        row.length = this.cols;
        this.revision += 1;
        break;
      }
      case 'S':
        this.scrollUp(p(0, 1));
        break;
      case 'T':
        this.scrollDown(p(0, 1));
        break;
      case 'r': {
        const t = clamp(p(0, 1) - 1, 0, this.rows - 1);
        const b = clamp(p(1, this.rows) - 1, 0, this.rows - 1);
        if (t < b) {
          this.top = t;
          this.bottom = b;
        }
        this.cx = 0;
        this.cy = 0;
        break;
      }
      case 's':
        this.saved = { cx: this.cx, cy: this.cy };
        break;
      case 'u':
        this.cx = this.saved.cx;
        this.cy = this.saved.cy;
        break;
      case 'n':
        if (p(0, 0) === 6) this.reply(`\x1b[${this.cy + 1};${this.cx + 1}R`);
        else if (p(0, 0) === 5) this.reply('\x1b[0n');
        break;
      case 'c':
        this.reply('\x1b[?62;22c');
        break;
      case 't':
        if (p(0, 0) === 14) this.reply(`\x1b[4;${this.rows * 16};${this.cols * 8}t`);
        else if (p(0, 0) === 16) this.reply('\x1b[6;16;8t');
        else if (p(0, 0) === 18) this.reply(`\x1b[8;${this.rows};${this.cols}t`);
        break;
      default:
        break; // SGR (m) and everything else do not affect the text
    }
  }

  eraseRow(y, from, to) {
    const row = this.grid[y];
    for (let x = Math.max(0, from); x < Math.min(this.cols, to); x += 1) {
      if (row[x] !== ' ') {
        row[x] = ' ';
        this.revision += 1;
      }
    }
  }

  clearAll() {
    for (let y = 0; y < this.rows; y += 1) this.eraseRow(y, 0, this.cols);
  }

  // ---- output ------------------------------------------------------------
  screen() {
    return this.grid.map((r) => r.join('').replace(/\s+$/, ''));
  }

  // everything drawn so far, scrolled-off lines first
  lines() {
    return [...this.history, ...this.screen()];
  }
}

module.exports = { VT };
