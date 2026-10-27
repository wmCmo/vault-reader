// Scans the vault, resolves links the way Obsidian does, and renders every
// note to a JSON payload the phone can store offline.
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import sanitizeHtml from 'sanitize-html';
import { createMarkdown, slugify, escapeHtml, outsideFences, parseWikilink } from './markdown.js';
import { renderDataview } from './dataview.js';

const NOTE_EXT = new Set(['.md', '.canvas']);
const FILE_KIND = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image',
  '.svg': 'image', '.avif': 'image', '.bmp': 'image',
  '.pdf': 'pdf',
  '.mp3': 'audio', '.m4a': 'audio', '.wav': 'audio', '.ogg': 'audio',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video',
};
const HIDDEN_PROPS = new Set(['tags', 'tag', 'aliases', 'alias', 'cssclasses', 'cssclass', 'position', 'publish']);
const MAX_EMBED_DEPTH = 2;

// All tags are allowed except the dangerous ones, which exclusiveFilter drops
// (that is what makes allowVulnerableTags safe here).
const SANITIZE = {
  allowedTags: false,
  allowVulnerableTags: true,
  allowedAttributes: {
    '*': ['class', 'id', 'title', 'style', 'data-*', 'aria-hidden', 'lang', 'dir'],
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    audio: ['src', 'controls', 'preload'],
    video: ['src', 'controls', 'preload', 'playsinline'],
    input: ['type', 'checked', 'disabled'],
    details: ['open'],
    ol: ['start'],
    td: ['colspan', 'rowspan', 'align'],
    th: ['colspan', 'rowspan', 'align'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  exclusiveFilter: (frame) =>
    ['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base', 'textarea', 'button', 'select'].includes(frame.tag) ||
    (frame.tag === 'input' && frame.attribs.type !== 'checkbox'),
};

const toPosix = (p) => p.split(path.sep).join('/');
const noteHref = (id, sub) => {
  let h = '#/note/' + encodeURIComponent(id);
  if (sub) {
    const last = sub.split('#').filter(Boolean).pop() || '';
    h += '?h=' + encodeURIComponent(last.startsWith('^') ? last : slugify(last));
  }
  return h;
};
export const fileHref = (rel) => 'files/' + rel.split('/').map(encodeURIComponent).join('/');

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function asList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(asList);
  return String(v).split(/[,\s]+/).filter(Boolean);
}

function readObsidianSettings(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, '.obsidian', 'app.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Body of the section `sub` points at: a heading (with everything under it)
// or a ^block id (its paragraph).
function extractSection(body, sub) {
  const lines = body.split('\n');
  const last = sub.split('#').filter(Boolean).pop() || '';
  if (last.startsWith('^')) {
    const re = new RegExp(`(?:^|\\s)\\${last}\\s*$`);
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) return null;
    if (/^\s*([-*+]|\d+\.)\s/.test(lines[i])) return lines[i];
    let a = i;
    let b = i;
    while (a > 0 && lines[a - 1].trim()) a--;
    while (b < lines.length - 1 && lines[b + 1].trim()) b++;
    return lines.slice(a, b + 1).join('\n');
  }
  const want = slugify(last);
  let inFence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    if (start >= 0 && m[1].length <= level) return lines.slice(start, i).join('\n');
    if (start < 0 && slugify(m[2]) === want) {
      start = i;
      level = m[1].length;
    }
  }
  return start >= 0 ? lines.slice(start).join('\n') : null;
}

function headingsOf(body) {
  const out = [];
  const seen = new Map();
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slugify(m[2]) || 'section';
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out.push({ level: m[1].length, text: m[2].replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').replace(/[*_`=~]/g, ''), id: n ? `${base}-${n}` : base });
  }
  return out;
}

function plainText(body) {
  return body
    .replace(/!\[\[[^\]]+\.(?:png|jpe?g|gif|webp|svg|avif|bmp|pdf|mp3|m4a|wav|ogg|mp4|webm|mov)(?:\|[^\]]*)?\]\]/gi, '')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
    .replace(/^(\s*)([-*+]|\d+\.)\s+(\[.\]\s+)?/gm, '$1')
    .replace(/^-{3,}\s*$/gm, '')
    .replace(/!?\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_, a, b) => b || a)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^>\s*\[![^\]]*\][+-]?/gm, '')
    .replace(/[#>*_`~=|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Vault {
  constructor({ root, exclude = [], lang = 'en' }) {
    this.root = path.resolve(root);
    this.lang = lang;
    this.name = path.basename(this.root);
    this.exclude = new Set(exclude.map((e) => e.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()));
    const settings = readObsidianSettings(this.root);
    this.md = createMarkdown({ breaks: !settings.strictLineBreaks });
    this.index = null;
    this.signature = '';
    this.checkedAt = 0;
    this.building = null;
  }

  async walk(dir = this.root, out = []) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(this.root, abs));
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (this.exclude.has(rel.toLowerCase())) continue;
      if (entry.isDirectory()) {
        await this.walk(abs, out);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!entry.isFile() || (!NOTE_EXT.has(ext) && !FILE_KIND[ext])) continue;
      const st = await fs.stat(abs);
      out.push({ rel, abs, ext, size: st.size, mtime: Math.round(st.mtimeMs), ctime: Math.round(st.birthtimeMs || st.ctimeMs) });
    }
    return out;
  }

  // Rebuilds the index when any file changed; checks at most every 2 seconds.
  async refresh() {
    if (this.index && Date.now() - this.checkedAt < 2000) return this.index;
    if (this.building) return this.building;
    this.building = (async () => {
      try {
        const files = await this.walk();
        const signature = files.map((f) => `${f.rel}:${f.mtime}:${f.size}`).sort().join('|');
        if (!this.index || signature !== this.signature) {
          this.index = await this.build(files);
          this.signature = signature;
        }
        this.checkedAt = Date.now();
        return this.index;
      } finally {
        this.building = null;
      }
    })();
    return this.building;
  }

  async build(files) {
    const started = Date.now();
    const notes = new Map();
    const attachments = new Map();
    const byPath = new Map();
    const byName = new Map();
    const addName = (key, entry) => {
      const k = key.toLowerCase();
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(entry);
    };

    for (const f of files) {
      if (FILE_KIND[f.ext]) {
        attachments.set(f.rel, { path: f.rel, kind: FILE_KIND[f.ext], size: f.size, mtime: f.mtime });
        const entry = { kind: 'file', id: f.rel };
        byPath.set(f.rel.toLowerCase(), entry);
        addName(path.posix.basename(f.rel), entry);
        continue;
      }
      let raw = await fs.readFile(f.abs, 'utf8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const kind = f.ext === '.md' ? 'md' : 'canvas';
      let frontmatter = {};
      let body = raw;
      if (kind === 'md') {
        try {
          const parsed = matter(raw);
          frontmatter = parsed.data || {};
          body = parsed.content;
        } catch {}
      }
      const name = path.posix.basename(f.rel).slice(0, -f.ext.length);
      const folder = path.posix.dirname(f.rel) === '.' ? '' : path.posix.dirname(f.rel);
      const inlineTags = kind === 'md'
        ? [...outsideFences(body, (s) => s).matchAll(/(?:^|\s)#([\p{L}\p{N}_\-/]+)/gu)].map((m) => m[1]).filter((t) => /[^\d]/.test(t))
        : [];
      const note = {
        id: f.rel, kind, name, folder,
        size: f.size, mtime: f.mtime, ctime: f.ctime,
        body, frontmatter,
        aliases: asList(frontmatter.aliases ?? frontmatter.alias),
        tags: [...new Set([...asList(frontmatter.tags ?? frontmatter.tag).map((t) => t.replace(/^#/, '')), ...inlineTags])],
        outlinks: new Set(),
        backlinks: new Set(),
      };
      notes.set(f.rel, note);
      const entry = { kind: 'note', id: f.rel };
      byPath.set(f.rel.toLowerCase(), entry);
      addName(kind === 'md' ? name : path.posix.basename(f.rel), entry);
    }

    const index = { notes, files: attachments, byPath, byName, builtAt: Date.now() };
    this.index = index;

    for (const note of notes.values()) {
      for (const target of this.linkTargets(note)) {
        const r = this.resolve(target, note.id);
        if (r?.kind === 'note' && r.id !== note.id) {
          note.outlinks.add(r.id);
          notes.get(r.id).backlinks.add(note.id);
        }
      }
    }

    index.payloads = new Map();
    index.manifest = [];
    for (const note of notes.values()) {
      let json;
      try {
        json = JSON.stringify(this.payload(note));
      } catch (err) {
        console.error(`render failed: ${note.id}`, err);
        json = JSON.stringify({ ...this.basePayload(note), html: `<div class="unsupported">This note couldn't be rendered.</div><pre><code>${escapeHtml(note.body)}</code></pre>`, text: note.body, headings: [] });
      }
      const hash = crypto.createHash('sha1').update(json).digest('hex').slice(0, 16);
      index.payloads.set(note.id, json);
      index.manifest.push({ id: note.id, hash, size: Buffer.byteLength(json) });
    }
    console.log(`indexed ${notes.size} notes, ${attachments.size} files in ${Date.now() - started} ms`);
    return index;
  }

  linkTargets(note) {
    if (note.kind === 'canvas') {
      try {
        const canvas = JSON.parse(note.body);
        return (canvas.nodes || []).flatMap((n) =>
          n.type === 'file' ? [n.file] : n.type === 'text' ? [...(n.text || '').matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => parseWikilink(m[1]).path) : [],
        );
      } catch {
        return [];
      }
    }
    const src = outsideFences(note.body, (s) => s.replace(/`[^`\n]*`/g, ''));
    const wiki = [...src.matchAll(/!?\[\[([^\]\n]+?)\]\]/g)].map((m) => parseWikilink(m[1].replace(/\\\|/g, '|')).path).filter(Boolean);
    const mdLinks = [...src.matchAll(/\]\(([^)\s]+?\.md)(?:#[^)]*)?\)/g)].map((m) => {
      try { return decodeURIComponent(m[1]); } catch { return m[1]; }
    });
    return [...wiki, ...mdLinks];
  }

  // Obsidian-style resolution: exact path, path relative to the note, then
  // shortest path among notes/files with the same name.
  resolve(target, fromId) {
    const { byPath, byName } = this.index;
    let t = String(target).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    if (!t) return fromId ? { kind: 'note', id: fromId } : null;
    const lower = t.toLowerCase();
    for (const cand of [lower, lower + '.md']) if (byPath.has(cand)) return byPath.get(cand);
    if (fromId) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromId), t)).toLowerCase();
      for (const cand of [rel, rel + '.md']) if (byPath.has(cand)) return byPath.get(cand);
    }
    const base = lower.split('/').pop();
    let cands = byName.get(base) || byName.get(base.replace(/\.md$/, '')) || [];
    if (lower.includes('/')) {
      cands = cands.filter((c) => {
        const id = c.id.toLowerCase();
        return id.endsWith(lower) || id.endsWith(lower + '.md');
      });
    }
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];
    const fromDir = fromId ? path.posix.dirname(fromId) : '';
    return [...cands].sort((a, b) => {
      const sa = path.posix.dirname(a.id) === fromDir ? 0 : 1;
      const sb = path.posix.dirname(b.id) === fromDir ? 0 : 1;
      return sa - sb || a.id.length - b.id.length;
    })[0];
  }

  env(note, depth, stack) {
    return {
      note,
      depth,
      stack,
      wikilink: (meta, env) => this.renderWikilink(meta, env),
      resolveHref: (href, env) => this.resolveHref(href, env),
      dataview: (src, env) => renderDataview(src, { index: this, note: env.note, lang: this.lang, noteLink: (n) => this.noteLink(n) }),
    };
  }

  get notes() {
    return this.index.notes;
  }

  noteLink(n, text) {
    return `<a class="internal-link" href="${noteHref(n.id)}">${escapeHtml(text ?? n.name)}</a>`;
  }

  renderMarkdown(body, env) {
    return this.md.render(outsideFences(body, (s) => s.replace(/%%[\s\S]*?%%/g, '')), env);
  }

  renderWikilink(meta, env) {
    const r = meta.path ? this.resolve(meta.path, env.note.id) : { kind: 'note', id: env.note.id };
    if (meta.embed) return this.renderEmbed(meta, r, env);
    const label = meta.alias || (meta.path ? meta.path + (meta.sub ? ' › ' + meta.sub.replace(/#/g, ' › ') : '') : meta.sub.replace(/#/g, ' › '));
    if (!r) return `<span class="internal-link is-unresolved">${escapeHtml(label)}</span>`;
    if (r.kind === 'file') return `<a class="internal-link file-link" href="${fileHref(r.id)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
    return `<a class="internal-link" href="${noteHref(r.id, meta.sub)}">${escapeHtml(label)}</a>`;
  }

  renderEmbed(meta, r, env) {
    if (!r) return `<span class="embed is-unresolved">${escapeHtml(meta.raw)}</span>`;
    if (r.kind === 'file') {
      const f = this.index.files.get(r.id);
      const src = fileHref(r.id);
      const name = escapeHtml(path.posix.basename(r.id));
      if (f.kind === 'image') {
        const size = /^(\d+)(?:x(\d+))?$/.exec(meta.alias);
        const dims = size ? ` width="${size[1]}"${size[2] ? ` height="${size[2]}"` : ''}` : '';
        return `<img class="embed-image" src="${src}" alt="${size ? name : escapeHtml(meta.alias || path.posix.basename(r.id))}"${dims} loading="lazy">`;
      }
      if (f.kind === 'audio') return `<audio class="embed-media" src="${src}" controls preload="none"></audio>`;
      if (f.kind === 'video') return `<video class="embed-media" src="${src}" controls preload="metadata" playsinline></video>`;
      return `<a class="embed-file" data-kind="${f.kind}" href="${src}" target="_blank" rel="noopener"><span class="embed-file-icon" aria-hidden="true"></span><span class="embed-file-name">${name}</span><span class="embed-file-meta">${f.kind.toUpperCase()} · ${formatSize(f.size)}</span></a>`;
    }

    const target = this.index.notes.get(r.id);
    const title = escapeHtml(meta.alias || target.name + (meta.sub ? ' › ' + meta.sub.replace(/#/g, ' › ') : ''));
    const card = (extra = '') =>
      `<a class="embed-link" href="${noteHref(r.id, meta.sub)}"><span class="embed-link-title">${title}</span>${extra}</a>`;
    if (target.kind === 'canvas' || env.depth >= MAX_EMBED_DEPTH || env.stack.has(r.id)) return card();
    const body = meta.sub ? extractSection(target.body, meta.sub) : target.body;
    if (body == null) return card('<span class="embed-link-note">Section not found</span>');
    const inner = this.renderMarkdown(body, this.env(target, env.depth + 1, new Set([...env.stack, r.id])));
    return `<div class="embed-note"><a class="embed-note-title" href="${noteHref(r.id, meta.sub)}">${title}</a><div class="embed-note-body">${inner}</div></div>`;
  }

  resolveHref(href, env) {
    let target = href;
    try { target = decodeURIComponent(href); } catch {}
    const hash = target.indexOf('#');
    const p = hash < 0 ? target : target.slice(0, hash);
    const frag = hash < 0 ? '' : target.slice(hash + 1);
    const r = this.resolve(p, env.note.id);
    if (!r) return null;
    if (r.kind === 'file') return { href: fileHref(r.id), className: 'file-link' };
    return { href: noteHref(r.id, frag), className: 'internal-link' };
  }

  renderCanvas(note) {
    let canvas;
    try {
      canvas = JSON.parse(note.body);
    } catch {
      return '<div class="unsupported">This canvas file couldn\'t be read.</div>';
    }
    const env = this.env(note, 1, new Set([note.id]));
    const nodes = [...(canvas.nodes || [])].sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
    const cards = nodes.map((n) => {
      const color = n.color ? ` data-color="${escapeHtml(n.color)}"` : '';
      if (n.type === 'group') return `<div class="canvas-group"${color}>${escapeHtml(n.label || 'Group')}</div>`;
      if (n.type === 'text') return `<div class="canvas-card"${color}>${this.renderMarkdown(n.text || '', env)}</div>`;
      if (n.type === 'link') return `<div class="canvas-card"${color}><a class="external-link" href="${escapeHtml(n.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(n.url)}</a></div>`;
      if (n.type === 'file') return `<div class="canvas-card"${color}>${this.renderWikilink(parseWikilink(n.file, true), env)}</div>`;
      return '';
    });
    return `<div class="canvas-board">${cards.join('')}</div>`;
  }

  basePayload(note) {
    return {
      id: note.id,
      kind: note.kind,
      name: note.name,
      folder: note.folder,
      mtime: note.mtime,
      ctime: note.ctime,
      aliases: note.aliases,
      tags: note.tags,
      backlinks: [...note.backlinks]
        .map((id) => this.index.notes.get(id))
        .sort((a, b) => a.name.localeCompare(b.name, this.lang))
        .map((n) => ({ id: n.id, name: n.name, folder: n.folder })),
    };
  }

  payload(note) {
    const env = this.env(note, 0, new Set([note.id]));
    const html = note.kind === 'canvas' ? this.renderCanvas(note) : this.renderMarkdown(note.body, env);
    // Properties get their own env: the body's env carries its footnotes.
    const propEnv = this.env(note, 0, new Set([note.id]));
    const props = Object.entries(note.frontmatter)
      .filter(([k]) => !HIDDEN_PROPS.has(k.toLowerCase()))
      .map(([key, value]) => ({ key, html: sanitizeHtml(this.renderProp(value, propEnv), SANITIZE) }));
    const text = note.kind === 'canvas'
      ? (() => { try { return plainText((JSON.parse(note.body).nodes || []).map((n) => n.text || n.label || n.file || '').join('\n')); } catch { return ''; } })()
      : plainText(note.body);
    return {
      ...this.basePayload(note),
      props,
      headings: note.kind === 'md' ? headingsOf(note.body) : [],
      html: sanitizeHtml(html, SANITIZE),
      text,
    };
  }

  renderProp(value, env) {
    if (value == null || value === '') return '<span class="prop-empty">—</span>';
    if (value instanceof Date) {
      const iso = value.toISOString();
      return escapeHtml(iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' '));
    }
    if (Array.isArray(value)) {
      return `<span class="prop-list">${value.map((v) => `<span class="prop-pill">${this.renderProp(v, env)}</span>`).join('')}</span>`;
    }
    if (typeof value === 'object') return `<code>${escapeHtml(JSON.stringify(value))}</code>`;
    if (typeof value === 'boolean') return `<input type="checkbox" disabled${value ? ' checked' : ''}>`;
    if (typeof value === 'number') return escapeHtml(value.toLocaleString(this.lang));
    return this.md.renderInline(String(value), env);
  }
}
