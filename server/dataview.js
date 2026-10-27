// A small subset of Dataview (DQL), enough for the LIST/TABLE queries the
// vault uses. Anything outside the subset falls back to showing the query.
import { escapeHtml } from './markdown.js';

function parseQuery(src) {
  const lines = src.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const q = { type: null, fields: [], from: null, where: [], sort: [], limit: Infinity };
  const head = /^(LIST|TABLE)\b\s*(.*)$/i.exec(lines[0]);
  if (!head) return null;
  q.type = head[1].toUpperCase();
  if (q.type === 'TABLE' && head[2]) {
    q.fields = head[2].replace(/^WITHOUT ID\s*/i, '').split(',').map((f) => {
      const m = /^(.+?)\s+AS\s+"?([^"]+)"?$/i.exec(f.trim());
      return m ? { expr: m[1].trim(), label: m[2] } : { expr: f.trim(), label: f.trim() };
    });
  }
  for (const line of lines.slice(1)) {
    let m;
    if ((m = /^FROM\s+(.+)$/i.exec(line))) q.from = m[1];
    else if ((m = /^WHERE\s+(.+)$/i.exec(line))) q.where.push(...m[1].split(/\s+AND\s+/i));
    else if ((m = /^SORT\s+(.+)$/i.exec(line))) {
      for (const part of m[1].split(',')) {
        const s = /^(\S+)(?:\s+(ASC|DESC|ASCENDING|DESCENDING))?$/i.exec(part.trim());
        if (!s) return null;
        q.sort.push({ field: s[1], desc: /^desc/i.test(s[2] || '') });
      }
    } else if ((m = /^LIMIT\s+(\d+)$/i.exec(line))) q.limit = Number(m[1]);
    else return null;
  }
  return q;
}

// FROM: "folder" | #tag | [[link]], combined with OR / AND, optional leading "-".
function parseSources(from) {
  if (!from) return () => true;
  const parts = from.split(/\s+(OR|AND)\s+/i);
  const preds = [];
  const ops = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2) { ops.push(parts[i].toUpperCase()); continue; }
    let s = parts[i].trim();
    const neg = s.startsWith('-');
    if (neg) s = s.slice(1).trim();
    let pred;
    let m;
    if ((m = /^"([^"]*)"$/.exec(s))) {
      const folder = m[1].replace(/\/+$/, '');
      pred = (n, ctx) => n.id === folder || n.id === folder + '.md' || n.id.startsWith(folder + '/');
    } else if ((m = /^#(.+)$/.exec(s))) {
      const tag = m[1].toLowerCase();
      pred = (n) => n.tags.some((t) => t.toLowerCase() === tag || t.toLowerCase().startsWith(tag + '/'));
    } else if ((m = /^\[\[(.+)\]\]$/.exec(s))) {
      const target = m[1];
      pred = (n, ctx) => {
        const r = ctx.index.resolve(target, ctx.note.id);
        return r?.kind === 'note' && n.outlinks.has(r.id);
      };
    } else {
      return null;
    }
    preds.push(neg ? (n, ctx) => !pred(n, ctx) : pred);
  }
  return (n, ctx) => {
    let result = preds[0](n, ctx);
    for (let i = 1; i < preds.length; i++) result = ops[i - 1] === 'AND' ? result && preds[i](n, ctx) : result || preds[i](n, ctx);
    return result;
  };
}

function fieldValue(n, field) {
  switch (field) {
    case 'file.name': return n.name;
    case 'file.path': return n.id;
    case 'file.folder': return n.folder;
    case 'file.mtime': return n.mtime;
    case 'file.ctime': return n.ctime;
    case 'file.size': return n.size;
    case 'file.tags': return n.tags.map((t) => '#' + t);
    default: return n.frontmatter?.[field.replace(/^this\./, '')];
  }
}

function parseWhere(cond) {
  let m;
  if ((m = /^contains\(\s*file\.(outlinks|inlinks)\s*,\s*this\.file\.link\s*\)$/i.exec(cond))) {
    const dir = m[1].toLowerCase();
    return (n, ctx) => (dir === 'outlinks' ? n.outlinks.has(ctx.note.id) : ctx.note.outlinks.has(n.id));
  }
  if ((m = /^contains\(\s*file\.tags\s*,\s*"#?([^"]+)"\s*\)$/i.exec(cond))) {
    const tag = m[1].toLowerCase();
    return (n) => n.tags.some((t) => t.toLowerCase() === tag);
  }
  if ((m = /^([\w.]+)\s*(=|!=)\s*"([^"]*)"$/.exec(cond))) {
    const [, field, op, value] = m;
    return (n) => (String(fieldValue(n, field) ?? '') === value) === (op === '=');
  }
  if ((m = /^!?([\w.]+)$/.exec(cond))) {
    const neg = cond.startsWith('!');
    return (n) => Boolean(fieldValue(n, m[1])) !== neg;
  }
  return null;
}

function formatValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 1e11) return new Date(v).toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.map(formatValue).join(', ');
  return String(v);
}

export function renderDataview(src, ctx) {
  const q = parseQuery(src);
  const from = q && parseSources(q.from);
  const where = q && q.where.map(parseWhere);
  if (!q || !from || where.some((w) => !w)) {
    return `<div class="dataview unsupported"><div class="dataview-note">This Dataview query isn't supported in the reader.</div><pre><code>${escapeHtml(src)}</code></pre></div>`;
  }

  let rows = [...ctx.index.notes.values()].filter(
    (n) => n.id !== ctx.note.id && from(n, ctx) && where.every((w) => w(n, ctx)),
  );
  const sorts = q.sort.length ? q.sort : [{ field: 'file.name', desc: false }];
  rows.sort((a, b) => {
    for (const { field, desc } of sorts) {
      const x = fieldValue(a, field);
      const y = fieldValue(b, field);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), ctx.lang);
      if (c) return desc ? -c : c;
    }
    return 0;
  });
  rows = rows.slice(0, q.limit);

  if (!rows.length) return '<div class="dataview"><div class="dataview-empty">No results</div></div>';

  if (q.type === 'LIST') {
    const items = rows.map((n) => `<li>${ctx.noteLink(n)}</li>`).join('');
    return `<div class="dataview"><ul class="dataview-list">${items}</ul></div>`;
  }
  const headCells = ['<th>File</th>', ...q.fields.map((f) => `<th>${escapeHtml(f.label)}</th>`)].join('');
  const body = rows
    .map((n) => `<tr><td>${ctx.noteLink(n)}</td>${q.fields.map((f) => `<td>${escapeHtml(formatValue(fieldValue(n, f.expr)))}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="dataview"><div class="table-wrap"><table><thead><tr>${headCells}</tr></thead><tbody>${body}</tbody></table></div></div>`;
}
