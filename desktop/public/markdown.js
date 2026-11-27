// A small Markdown renderer for CLI replies. Replies are untrusted (they can quote any
// file or web page), so all text is escaped, links are limited to web and mail
// addresses, and images become links so nothing is fetched just by showing a reply.
(function (root) {
  const escapeHtml = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

  const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;
  const PREVIEWABLE = /^(?:html|svg)$/i;

  const link = (url, label) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;

  function emphasis(text) {
    return escapeHtml(text)
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([\s\S]*?\S)__(?!\w)/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/(^|\W)_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  }

  // code spans, links and bare addresses are cut out first so emphasis can't rewrite them
  const TOKEN = /(`+)([\s\S]*?[^`])\1(?!`)|!?\[([^\]\n]*)\]\(\s*<?([^()\s>]+(?:\([^()\s]*\))?)>?(?:\s+"[^"\n]*")?\s*\)|(https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}])/g;

  function inline(text) {
    let out = '';
    let last = 0;
    for (const m of String(text).matchAll(TOKEN)) {
      out += emphasis(text.slice(last, m.index));
      if (m[1]) out += `<code>${escapeHtml(m[2])}</code>`;
      else if (m[4] !== undefined) out += SAFE_URL.test(m[4]) ? link(m[4], emphasis(m[3] || m[4])) : emphasis(m[0]);
      else out += link(m[5], escapeHtml(m[5]));
      last = m.index + m[0].length;
    }
    return out + emphasis(String(text).slice(last));
  }

  function codeBlock(lang, code) {
    const preview = PREVIEWABLE.test(lang) ? '<button type="button" data-act="preview">Preview</button>' : '';
    return (
      `<div class="code" data-lang="${escapeHtml(lang.toLowerCase())}">` +
      `<div class="code-head"><span>${escapeHtml(lang || 'text')}</span>${preview}<button type="button" data-act="copy-code">Copy</button></div>` +
      `<pre><code>${escapeHtml(code)}</code></pre></div>`
    );
  }

  const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
  const ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
  const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const isDivider = (row) => /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*(?::?-+:?\s*)?$/.test(row || '');

  function startsBlock(lines, i) {
    const line = lines[i];
    return FENCE.test(line) || ITEM.test(line) || /^ {0,3}(?:#{1,6}\s|>|(?:[-*_]\s*){3,}$)/.test(line) || (line.includes('|') && isDivider(lines[i + 1]));
  }

  function list(lines, start) {
    const first = lines[start].match(ITEM);
    const indent = first[1].length;
    const ordered = first[3] !== undefined;
    const items = [];
    let i = start;
    while (i < lines.length) {
      const m = lines[i].match(ITEM);
      if (m && m[1].length === indent && (m[3] !== undefined) === ordered) {
        items.push([m[4]]);
        i += 1;
      } else if (items.length && /^\s+\S/.test(lines[i]) && lines[i].match(/^\s*/)[0].length > indent) {
        items[items.length - 1].push(lines[i].slice(Math.min(lines[i].match(/^\s*/)[0].length, indent + 2)));
        i += 1;
      } else if (!lines[i].trim() && lines[i + 1] !== undefined && (ITEM.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))) {
        i += 1;
      } else break;
    }
    const tag = ordered ? 'ol' : 'ul';
    const from = ordered && first[3] !== '1' ? ` start="${Number(first[3])}"` : '';
    const body = items
      .map(([head, ...rest]) => `<li>${inline(head)}${rest.length ? blocks(rest) : ''}</li>`)
      .join('');
    return { html: `<${tag}${from}>${body}</${tag}>`, next: i };
  }

  function blocks(lines, depth = 0) {
    let out = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (!line.trim()) i += 1;
      else if ((m = line.match(FENCE))) {
        const fence = m[1];
        const lead = line.match(/^ */)[0].length;
        const body = [];
        i += 1;
        // an unclosed fence runs to the end, which is what a reply looks like mid-stream
        while (i < lines.length && !(lines[i].trim().startsWith(fence) && !lines[i].trim().replace(new RegExp(`^\\${fence[0]}+`), ''))) {
          body.push(lines[i].slice(Math.min(lead, lines[i].match(/^ */)[0].length)));
          i += 1;
        }
        i += 1;
        out += codeBlock(m[2], body.join('\n'));
      } else if ((m = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*$/))) {
        const level = Math.min(m[1].length + 1, 6);
        out += `<h${level}>${inline(m[2])}</h${level}>`;
        i += 1;
      } else if (/^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
        out += '<hr>';
        i += 1;
      } else if (/^ {0,3}>/.test(line) && depth < 6) {
        const quoted = [];
        while (i < lines.length && /^ {0,3}>/.test(lines[i])) quoted.push(lines[i++].replace(/^ {0,3}> ?/, ''));
        out += `<blockquote>${blocks(quoted, depth + 1)}</blockquote>`;
      } else if (line.includes('|') && isDivider(lines[i + 1])) {
        const head = cells(line);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        out +=
          `<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${head.map((_, n) => `<td>${inline(r[n] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      } else if (ITEM.test(line)) {
        const made = list(lines, i);
        out += made.html;
        i = made.next;
      } else {
        const para = [line];
        i += 1;
        while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++]);
        out += `<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`;
      }
    }
    return out;
  }

  const renderMarkdown = (text) => blocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'));

  const api = { renderMarkdown, escapeHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(this);
