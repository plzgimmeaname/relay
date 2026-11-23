// A stand-in for a full-screen coding TUI: alt screen, mouse + paste modes, terminal queries,
// a spinner while "thinking", the reply, a timing line, a box, and a footer that echoes the prompt.
const out = (s) => process.stdout.write(s);
let typed = '';
let chat = [];
let last = '';

function draw(busy) {
  out('\x1b[H\x1b[2J');
  out('\x1b[1;1H FAKE-TUI v1\r\n\r\n');
  for (const l of chat) out(` ${l}\r\n`);
  if (busy) out(` ${busy}\r\n`);
  const row = 14;
  out(`\x1b[${row};1H╭${'─'.repeat(60)}╮\r\n│ ${(typed || 'Enter a task').padEnd(58)} │\r\n╰${'─'.repeat(60)}╯\r\n`);
  out(` model fake · Chat: ${last}\r\n`);
}

out('\x1b[?1049h\x1b[?1000h\x1b[?1003h\x1b[?2004h\x1b[c\x1b[>0q\x1b[?2027$p\x1b[6n');
draw();
process.stdin.setRawMode && process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (/^\x1b\[[0-9;?>]*[a-zA-Z$]/.test(d) && !d.includes('\x1b[200~')) return; // terminal replies
  const paste = d.match(/\x1b\[200~([\s\S]*?)\x1b\[201~/);
  if (paste) typed += paste[1].replace(/\n/g, ' ');
  for (const ch of d.replace(/\x1b\[200~[\s\S]*?\x1b\[201~/, '')) {
    if (ch === '\r') return submit();
    if (ch >= ' ' && ch !== '\x7f' && ch !== '\x1b') typed += ch;
  }
  draw();
});

function submit() {
  const text = typed;
  typed = '';
  last = text;
  chat.push(`you: ${text}`);
  let i = 0;
  const spin = setInterval(() => draw(`${'⠋⠙⠹⠸'[i++ % 4]} thinking`), 120);
  setTimeout(() => {
    clearInterval(spin);
    const reply = process.env.FAKE_REPLY || (/RELAY_OK/.test(text) ? 'RELAY_OK' : `ECHO: ${text.slice(-30)}`);
    chat.push(`${reply}`, '  ⎘ • 1s');
    draw();
  }, 1200);
}
