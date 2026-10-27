// Obsidian-flavoured Markdown on top of markdown-it.
// Vault-specific work (resolving links, rendering embeds and Dataview) is
// delegated to callbacks on `env`, so this module knows nothing about files.
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import mark from 'markdown-it-mark';
import hljs from 'highlight.js';

export function slugify(text) {
  return String(text)
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .replace(/-+/g, '-');
}

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Apply `fn` to the parts of `src` that are outside fenced code blocks.
export function outsideFences(src, fn) {
  const parts = src.split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$)/m);
  return parts.map((p, i) => (i % 2 ? p : fn(p))).join('');
}

const CALLOUT_KIND = {
  note: 'note',
  abstract: 'abstract', summary: 'abstract', tldr: 'abstract',
  info: 'info',
  todo: 'todo',
  tip: 'tip', hint: 'tip', important: 'tip',
  success: 'success', check: 'success', done: 'success',
  question: 'question', help: 'question', faq: 'question',
  warning: 'warning', caution: 'warning', attention: 'warning',
  failure: 'failure', fail: 'failure', missing: 'failure',
  danger: 'danger', error: 'danger',
  bug: 'bug',
  example: 'example',
  quote: 'quote', cite: 'quote',
};

function wikilinkRule(state, silent) {
  const src = state.src;
  let pos = state.pos;
  let embed = false;
  if (src.charCodeAt(pos) === 0x21 /* ! */) {
    if (src.charCodeAt(pos + 1) !== 0x5b || src.charCodeAt(pos + 2) !== 0x5b) return false;
    embed = true;
    pos += 1;
  } else if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) {
    return false;
  }
  const end = src.indexOf(']]', pos + 2);
  if (end < 0) return false;
  // Inside tables the alias pipe has to be escaped as \|.
  const inner = src.slice(pos + 2, end).replace(/\\\|/g, '|');
  if (!inner.trim() || inner.includes('\n') || inner.includes('[[')) return false;
  if (!silent) {
    const token = state.push('wikilink', '', 0);
    token.meta = parseWikilink(inner, embed);
  }
  state.pos = end + 2;
  return true;
}

export function parseWikilink(inner, embed = false) {
  const bar = inner.indexOf('|');
  const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
  const alias = bar < 0 ? '' : inner.slice(bar + 1).trim();
  const hash = target.indexOf('#');
  const path = (hash < 0 ? target : target.slice(0, hash)).trim();
  const sub = hash < 0 ? '' : target.slice(hash + 1).trim();
  return { raw: inner, path, sub, alias, embed };
}

function tagRule(state, silent) {
  const pos = state.pos;
  if (state.src.charCodeAt(pos) !== 0x23 /* # */) return false;
  if (pos > 0 && !/\s/.test(state.src[pos - 1])) return false;
  const m = /^#([\p{L}\p{N}_\-/]+)/u.exec(state.src.slice(pos));
  if (!m || !/[^\d]/.test(m[1])) return false;
  if (!silent) {
    const token = state.push('tag', '', 0);
    token.content = m[1];
  }
  state.pos += m[0].length;
  return true;
}

function calloutRule(md) {
  return (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'blockquote_open') continue;
      const para = tokens[i + 1];
      const inline = tokens[i + 2];
      if (!para || para.type !== 'paragraph_open' || !inline || inline.type !== 'inline') continue;
      const firstLine = inline.content.split('\n')[0];
      const m = /^\[!([^\]\s]+)\]([+-]?)[ \t]*(.*)$/.exec(firstLine);
      if (!m) continue;

      const type = m[1].toLowerCase();
      const kind = CALLOUT_KIND[type] || 'note';
      const titleRaw = m[3].trim();
      const titleHtml = titleRaw
        // A copy without the note's footnotes, or the footnote list is appended to the title.
        ? md.renderInline(titleRaw, { ...state.env, footnotes: undefined })
        : escapeHtml(type.charAt(0).toUpperCase() + type.slice(1));

      const children = inline.children || [];
      const brk = children.findIndex((c) => c.type === 'softbreak' || c.type === 'hardbreak');
      inline.children = brk < 0 ? [] : children.slice(brk + 1);
      if (!inline.children.length) {
        para.hidden = true;
        tokens[i + 3].hidden = true;
      }

      let depth = 0;
      for (let j = i; j < tokens.length; j++) {
        if (tokens[j].type === 'blockquote_open') depth++;
        if (tokens[j].type === 'blockquote_close' && --depth === 0) {
          tokens[j].meta = { callout: { fold: m[2] } };
          break;
        }
      }
      tokens[i].meta = { callout: { type, kind, fold: m[2], titleHtml } };
    }
  };
}

function taskRule(state) {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
    const m = /^\[(.)\][ \t]/.exec(inline.content);
    if (!m) continue;
    const first = inline.children[0];
    if (!first || first.type !== 'text' || !first.content.startsWith(m[0])) continue;
    first.content = first.content.slice(m[0].length);
    const done = m[1] !== ' ';
    const box = new state.Token('html_inline', '', 0);
    box.content = `<input type="checkbox" class="task-checkbox" disabled${done ? ' checked' : ''}>`;
    inline.children.unshift(box);
    const item = tokens[i - 2];
    item.attrJoin('class', 'task-list-item' + (done ? ' is-checked' : ''));
    item.attrSet('data-task', m[1]);
  }
}

function blockIdRule(state) {
  const tokens = state.tokens;
  for (let i = 1; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline' || !inline.children?.length) continue;
    const last = inline.children[inline.children.length - 1];
    if (last.type !== 'text') continue;
    const m = /(?:^|\s)\^([A-Za-z0-9-]+)$/.exec(last.content);
    if (!m) continue;
    last.content = last.content.slice(0, m.index);
    const open = tokens[i - 1];
    if (open.nesting === 1) open.attrSet('id', '^' + m[1]);
  }
}

function headingIdRule(state) {
  const seen = new Map();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const base = slugify(tokens[i + 1].content) || 'section';
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    tokens[i].attrSet('id', n ? `${base}-${n}` : base);
  }
}

export function createMarkdown({ breaks = true } = {}) {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    breaks,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return `<pre class="hljs"><code class="language-${escapeHtml(lang)}">${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
        } catch {}
      }
      return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
    },
  });
  md.use(footnote).use(mark);

  md.inline.ruler.before('link', 'wikilink', wikilinkRule);
  md.inline.ruler.after('wikilink', 'tag', tagRule);
  md.core.ruler.after('text_join', 'callouts', calloutRule(md));
  md.core.ruler.after('callouts', 'tasks', taskRule);
  md.core.ruler.after('tasks', 'block_ids', blockIdRule);
  md.core.ruler.after('block_ids', 'heading_ids', headingIdRule);

  const r = md.renderer.rules;

  r.wikilink = (tokens, idx, _o, env) => env.wikilink(tokens[idx].meta, env);
  r.tag = (tokens, idx) => {
    const tag = tokens[idx].content;
    return `<a class="tag" href="#/search?q=${encodeURIComponent('#' + tag)}">#${escapeHtml(tag)}</a>`;
  };

  r.blockquote_open = (tokens, idx, o, env, self) => {
    const c = tokens[idx].meta?.callout;
    if (!c) return self.renderToken(tokens, idx, o);
    const attrs = `class="callout" data-callout="${escapeHtml(c.type)}" data-kind="${c.kind}"`;
    const title = `<span class="callout-icon" aria-hidden="true"></span><span class="callout-title-inner">${c.titleHtml}</span>`;
    if (c.fold) {
      return `<details ${attrs}${c.fold === '+' ? ' open' : ''}><summary class="callout-title">${title}<span class="callout-fold" aria-hidden="true"></span></summary><div class="callout-content">`;
    }
    return `<div ${attrs}><div class="callout-title">${title}</div><div class="callout-content">`;
  };
  r.blockquote_close = (tokens, idx, o, env, self) => {
    const c = tokens[idx].meta?.callout;
    if (!c) return self.renderToken(tokens, idx, o);
    return c.fold ? '</div></details>\n' : '</div></div>\n';
  };

  const fence = r.fence;
  r.fence = (tokens, idx, o, env, self) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0].toLowerCase();
    if (lang === 'dataview' && env.dataview) return env.dataview(token.content, env);
    if (lang === 'dataviewjs') {
      return `<div class="unsupported">DataviewJS isn't supported in the reader.</div>` + fence(tokens, idx, o, env, self);
    }
    return fence(tokens, idx, o, env, self);
  };

  r.table_open = () => '<div class="table-wrap"><table>\n';
  r.table_close = () => '</table></div>\n';

  r.link_open = (tokens, idx, o, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet('href') || '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
      token.attrJoin('class', 'external-link');
    } else if (href && !href.startsWith('#') && env.resolveHref) {
      const resolved = env.resolveHref(href, env);
      if (resolved) {
        token.attrSet('href', resolved.href);
        token.attrJoin('class', resolved.className);
      }
    }
    return self.renderToken(tokens, idx, o);
  };

  const image = r.image;
  r.image = (tokens, idx, o, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet('src') || '';
    if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && env.resolveHref) {
      const resolved = env.resolveHref(src, env);
      if (resolved) token.attrSet('src', resolved.href);
    }
    token.attrSet('loading', 'lazy');
    return image(tokens, idx, o, env, self);
  };

  return md;
}
