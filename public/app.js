// Vault reader: renders from the copy stored on the phone, and syncs it from
// the PC whenever the PC is reachable. Every network step has a timeout, and
// each batch is saved as it arrives, so a bad connection never blocks reading
// and an interrupted sync resumes where it stopped.

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const LANG = document.documentElement.lang || 'en';
const collator = new Intl.Collator(LANG, { numeric: true, sensitivity: 'base' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase();
const noteHref = (id) => '#/note/' + encodeURIComponent(id);
const folderHref = (path) => (path ? '#/f/' + encodeURIComponent(path) : '#/');
const fileUrl = (p) => 'files/' + p.split('/').map(encodeURIComponent).join('/');

const ICON = {
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  canvas: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M10 6.5h4a2 2 0 0 1 2 2V14"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 4h4v4M4 20L20 4M20 16v4h-4M14 14l6 6M4 4l5 5"/></svg>',
};

// ---------- settings (per-device conveniences only) ----------

const settings = (() => {
  try { return JSON.parse(localStorage.getItem('vr-settings') || '{}'); } catch { return {}; }
})();
function saveSettings() {
  try { localStorage.setItem('vr-settings', JSON.stringify(settings)); } catch {}
  const root = document.documentElement;
  if (settings.theme && settings.theme !== 'system') root.dataset.theme = settings.theme;
  else delete root.dataset.theme;
  root.style.setProperty('--text-scale', settings.textScale || 1);
}

// ---------- IndexedDB ----------

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('vault-reader', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('notes', { keyPath: 'id' });
      req.result.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const idb = {
  allNotes: () => tx('notes', 'readonly', (s) => s.getAll()),
  putNotes: (notes) => tx('notes', 'readwrite', (s) => { notes.forEach((n) => s.put(n)); }),
  deleteNotes: (ids) => tx('notes', 'readwrite', (s) => { ids.forEach((id) => s.delete(id)); }),
  clearNotes: () => tx('notes', 'readwrite', (s) => s.clear()),
  get: (key) => tx('meta', 'readonly', (s) => s.get(key)),
  set: (key, value) => tx('meta', 'readwrite', (s) => s.put(value, key)),
};

// ---------- state ----------

const state = {
  notes: new Map(),
  tree: null,
  vaultName: 'Vault',
  lastSync: null,
  lastAttempt: 0,
  syncing: false,
  progress: null,
  reachable: null,
  error: null,
};

function buildTree() {
  const root = { name: '', path: '', folders: new Map(), notes: [], count: 0 };
  for (const n of state.notes.values()) {
    let node = root;
    node.count++;
    if (n.folder) {
      let acc = '';
      for (const part of n.folder.split('/')) {
        acc = acc ? `${acc}/${part}` : part;
        if (!node.folders.has(part)) node.folders.set(part, { name: part, path: acc, folders: new Map(), notes: [], count: 0 });
        node = node.folders.get(part);
        node.count++;
      }
    }
    node.notes.push(n);
  }
  state.tree = root;
}

function findFolder(path) {
  let node = state.tree;
  if (!path) return node;
  for (const part of path.split('/')) {
    node = node?.folders.get(part);
    if (!node) return null;
  }
  return node;
}

// ---------- sync ----------

async function fetchWithin(url, opts, ms, read) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await read(res);
  } finally {
    clearTimeout(timer);
  }
}

async function sync({ full = false } = {}) {
  if (state.syncing) return;
  state.syncing = true;
  state.lastAttempt = Date.now();
  state.error = null;
  renderStatus();
  const changed = new Set();
  try {
    if (full) {
      await idb.clearNotes();
      state.notes.clear();
    }
    const manifest = await fetchWithin('api/manifest', {}, 8000, (r) => r.json());
    state.reachable = true;
    state.vaultName = manifest.vault || state.vaultName;
    idb.set('vaultName', state.vaultName);

    const remote = new Map(manifest.notes.map((n) => [n.id, n]));
    const removed = [...state.notes.keys()].filter((id) => !remote.has(id));
    if (removed.length) {
      await idb.deleteNotes(removed);
      removed.forEach((id) => { state.notes.delete(id); changed.add(id); });
    }

    const todo = manifest.notes.filter((n) => state.notes.get(n.id)?.hash !== n.hash);
    const batches = [];
    let batch = [];
    let bytes = 0;
    for (const n of todo) {
      if (batch.length && (bytes + n.size > 64_000 || batch.length >= 25)) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(n.id);
      bytes += n.size;
    }
    if (batch.length) batches.push(batch);

    state.progress = { done: 0, total: todo.length };
    renderStatus();
    for (const ids of batches) {
      const { notes } = await fetchWithin(
        'api/notes',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) },
        20000,
        (r) => r.json(),
      );
      for (const n of notes) n.hash = remote.get(n.id)?.hash;
      await idb.putNotes(notes);
      notes.forEach((n) => { state.notes.set(n.id, n); changed.add(n.id); });
      state.progress.done += ids.length;
      renderStatus();
    }

    await syncFiles(manifest.files);
    state.lastSync = Date.now();
    await idb.set('lastSync', state.lastSync);
    if (!(await idb.get('persistAsked'))) {
      await idb.set('persistAsked', true);
      navigator.storage?.persist?.();
    }
  } catch (err) {
    state.reachable = false;
    state.error = err.name === 'AbortError' ? 'Timed out reaching your PC' : navigator.onLine ? `Couldn't reach your PC (${err.message})` : 'No internet connection';
  } finally {
    state.syncing = false;
    state.progress = null;
    if (changed.size) {
      buildTree();
      rerenderIfAffected(changed);
    }
    renderStatus();
  }
}

// Images are saved ahead of time. PDFs and media are saved by the service
// worker the first time they're opened; stale copies are dropped here.
async function syncFiles(files) {
  if (!('caches' in window)) return;
  const cache = await caches.open('vault-files');
  const versions = (await idb.get('fileVersions')) || {};
  const live = new Set();
  for (const f of files) {
    const url = new URL(fileUrl(f.path), location.href).href;
    live.add(url);
    if (f.kind !== 'image') {
      if (versions[f.path] !== f.mtime) {
        await cache.delete(url);
        versions[f.path] = f.mtime;
      }
      continue;
    }
    if (versions[f.path] === f.mtime && (await cache.match(url))) continue;
    try {
      const blob = await fetchWithin(url, {}, 30000, (r) => r.blob());
      await cache.put(url, new Response(blob, { headers: { 'Content-Type': blob.type } }));
      versions[f.path] = f.mtime;
    } catch {
      // Retried on the next sync.
    }
  }
  for (const req of await cache.keys()) if (!live.has(req.url)) await cache.delete(req);
  for (const p of Object.keys(versions)) if (!files.some((f) => f.path === p)) delete versions[p];
  await idb.set('fileVersions', versions);
}

function maybeSync() {
  if (document.visibilityState === 'visible' && Date.now() - state.lastAttempt > 30_000) sync();
}

// ---------- status pill ----------

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(ts).toLocaleDateString(LANG);
}

function dateLabel(ts) {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

function renderStatus() {
  const pill = $('#sync-pill');
  let tone;
  let label;
  if (state.syncing) {
    tone = 'busy';
    label = state.progress?.total ? `Syncing ${state.progress.done}/${state.progress.total}` : 'Syncing';
  } else if (state.reachable) {
    tone = 'ok';
    label = 'Synced';
  } else if (state.notes.size) {
    tone = 'offline';
    label = `Offline · ${ago(state.lastSync)}`;
  } else {
    tone = 'error';
    label = state.reachable === false ? 'Not connected' : '…';
  }
  pill.dataset.tone = tone;
  $('.label', pill).textContent = label;
  if (currentRoute().name === 'settings' && !state.syncing) renderSettings();
}

// ---------- routing ----------

function currentRoute() {
  const raw = location.hash.slice(1) || '/';
  const [p, qs = ''] = raw.split('?');
  const parts = p.split('/').filter(Boolean);
  let arg = '';
  try { arg = decodeURIComponent(parts.slice(1).join('/')); } catch {}
  return { name: parts[0] || 'home', arg, params: new URLSearchParams(qs) };
}

let lastRendered = '';
let lastNoteId = null;
let depth = 0;
function render() {
  let route = currentRoute();
  // #/random becomes the picked note's own URL, so Back skips the dice roll.
  if (route.name === 'random') {
    const [pick] = rediscover.pick(1, new Set([lastNoteId]));
    history.replaceState(history.state, '', pick ? noteHref(pick.id) + '?r=1' : '#/');
    route = currentRoute();
  }
  if (history.state?.depth == null) history.replaceState({ ...history.state, depth: lastRendered ? depth + 1 : 0 }, '');
  depth = history.state.depth;
  closeToc();
  $('#toc-fab').hidden = true;
  $('#back').hidden = route.name === 'home';
  $('#brand').hidden = route.name !== 'home';
  setTopbarTitle('');
  titleObserver?.disconnect();

  if (!state.notes.size && route.name !== 'settings') renderEmpty();
  else if (route.name === 'note') renderNote(route.arg, route.params.get('h'), route.params.has('r'));
  else if (route.name === 'f') renderFolder(route.arg);
  else if (route.name === 'search') renderSearch(route.params.get('q') || '');
  else if (route.name === 'settings') renderSettings();
  else renderHome();
  lastRendered = location.hash;

  const saved = history.state?.scroll;
  if (route.name === 'note' && route.params.get('h')) scrollToAnchor(route.params.get('h'));
  else window.scrollTo(0, saved ?? 0);
}

function rerenderIfAffected(changed) {
  const route = currentRoute();
  if (route.name === 'search') return;
  if (route.name === 'note' && !changed.has(route.arg)) return;
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

function scrollToAnchor(id) {
  const el = document.getElementById(id) || document.getElementById(decodeURIComponent(id));
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - $('#topbar').offsetHeight - 12;
  window.scrollTo({ top, behavior: 'instant' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

// Remember scroll position per history entry, so Back returns to the same place.
let scrollTimer;
window.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    if (location.hash === lastRendered) history.replaceState({ ...history.state, scroll: window.scrollY }, '');
  }, 250);
  $('#topbar').classList.toggle('scrolled', window.scrollY > 4);
}, { passive: true });

let titleObserver;
function setTopbarTitle(text) {
  const el = $('#topbar-title');
  el.textContent = text;
  el.classList.remove('visible');
}

// ---------- views ----------

function noteRow(n, { showFolder = true, meta = '', href = noteHref(n.id) } = {}) {
  return `<li><a class="row" href="${href}">
    <span class="row-icon">${n.kind === 'canvas' ? ICON.canvas : ICON.note}</span>
    <span class="row-main"><span class="row-title">${esc(n.name)}</span>${showFolder && n.folder ? `<span class="row-sub">${esc(n.folder)}</span>` : ''}</span>
    ${meta ? `<span class="row-meta">${meta}</span>` : ''}
  </a></li>`;
}

function folderRow(f) {
  return `<li><a class="row" href="${folderHref(f.path)}">
    <span class="row-icon folder">${ICON.folder}</span>
    <span class="row-main"><span class="row-title">${esc(f.name)}</span></span>
    <span class="row-meta">${f.count}</span>
    <span class="row-chevron">${ICON.chevron}</span>
  </a></li>`;
}

const sortedFolders = (node) => [...node.folders.values()].sort((a, b) => collator.compare(a.name, b.name));
const sortedNotes = (node) => [...node.notes].sort((a, b) => collator.compare(a.name, b.name));

function renderEmpty() {
  view.innerHTML = `<section class="empty">
    <img src="icons/icon-192.png" alt="" width="72" height="72">
    <h1>No offline copy yet</h1>
    <p>${state.syncing ? 'Downloading your vault…' : 'Connect to your PC once (Tailscale on) and the whole vault is saved on this phone for reading anywhere.'}</p>
    ${state.syncing ? '' : '<button class="btn primary" id="empty-sync">Try again</button>'}
    ${state.error ? `<p class="muted small">${esc(state.error)}</p>` : ''}
  </section>`;
  $('#empty-sync')?.addEventListener('click', () => sync());
}

function renderHome() {
  $('#brand-name').textContent = state.vaultName;
  const recent = [...state.notes.values()].sort((a, b) => b.mtime - a.mtime).slice(0, 8);
  const picks = rediscover.homePicks();
  const root = state.tree;
  view.innerHTML = `<section class="page home">
    <a class="search-launch" href="#/search">${ICON.search}<span>Search ${state.notes.size} notes</span></a>
    <h2 class="section-label">Recently edited</h2>
    <ul class="list card">${recent.map((n) => noteRow(n, { meta: ago(n.mtime) })).join('')}</ul>
    ${picks.length ? `<h2 class="section-label label-with-action">Rediscover <button class="link-btn" id="reroll">${ICON.shuffle}<span>Shuffle</span></button></h2>
    <ul class="list card">${picks.map((n) => noteRow(n, { meta: rediscover.seenLabel(n), href: noteHref(n.id) + '?r=1' })).join('')}</ul>` : ''}
    <h2 class="section-label">Folders</h2>
    <ul class="list card">${sortedFolders(root).map(folderRow).join('')}</ul>
    ${root.notes.length ? `<h2 class="section-label">Notes</h2><ul class="list card">${sortedNotes(root).map((n) => noteRow(n, { showFolder: false })).join('')}</ul>` : ''}
  </section>`;
  $('#reroll')?.addEventListener('click', () => {
    rediscover.reroll();
    renderHome();
  });
}

function crumbs(path, { includeLast = true } = {}) {
  if (!path) return '';
  const parts = path.split('/');
  const items = parts.map((part, i) => {
    const p = parts.slice(0, i + 1).join('/');
    return i === parts.length - 1 && !includeLast ? `<span>${esc(part)}</span>` : `<a href="${folderHref(p)}">${esc(part)}</a>`;
  });
  return `<nav class="crumbs"><a href="#/">${esc(state.vaultName)}</a>${items.map((i) => `<span class="sep">/</span>${i}`).join('')}</nav>`;
}

function renderFolder(path) {
  const node = findFolder(path);
  if (!node) {
    view.innerHTML = `<section class="page"><h1 class="page-title">Folder not found</h1><p class="muted">${esc(path)}</p></section>`;
    return;
  }
  setTopbarTitle(node.name);
  $('#topbar-title').classList.add('visible');
  const folders = sortedFolders(node);
  const notes = sortedNotes(node);
  view.innerHTML = `<section class="page">
    ${crumbs(path.split('/').slice(0, -1).join('/'))}
    <h1 class="page-title">${esc(node.name)}</h1>
    ${folders.length ? `<ul class="list card">${folders.map(folderRow).join('')}</ul>` : ''}
    ${notes.length ? `<ul class="list card">${notes.map((n) => noteRow(n, { showFolder: false, meta: ago(n.mtime) })).join('')}</ul>` : ''}
  </section>`;
}

function renderNote(id, anchor, fromRandom) {
  const n = state.notes.get(id);
  lastNoteId = id;
  if (!n) {
    view.innerHTML = `<section class="page"><h1 class="page-title">Note not found</h1><p class="muted">${esc(id)}</p><p class="muted small">It may have been renamed or deleted on your PC.</p></section>`;
    return;
  }
  setTopbarTitle(n.name);
  rediscover.markOpened(id);
  const props = n.props || [];
  const tags = n.tags || [];
  view.innerHTML = `<article class="page note" data-kind="${n.kind}">
    ${crumbs(n.folder)}
    <h1 class="note-title" id="note-title">${esc(n.name)}</h1>
    <div class="note-meta">Edited ${esc(dateLabel(n.mtime))}${Date.now() - n.mtime < 30 * 864e5 ? ` · ${esc(ago(n.mtime))}` : ''}${n.backlinks?.length ? ` · <a href="#backlinks">${n.backlinks.length} linked</a>` : ''}</div>
    ${tags.length ? `<div class="tag-row">${tags.map((t) => `<a class="tag" href="#/search?q=${encodeURIComponent('#' + t)}">#${esc(t)}</a>`).join('')}</div>` : ''}
    ${props.length ? `<details class="props"${props.length <= 6 ? ' open' : ''}>
      <summary>Properties <span class="muted">${props.length}</span></summary>
      <dl>${props.map((p) => `<div class="prop"><dt>${esc(p.key)}</dt><dd>${p.html}</dd></div>`).join('')}</dl>
    </details>` : ''}
    ${n.kind === 'md' ? '<div class="listen-row" id="listen-row"></div>' : ''}
    <div class="markdown">${n.html}</div>
    ${n.backlinks?.length ? `<section class="backlinks" id="backlinks">
      <h2 class="section-label">Linked mentions <span class="muted">${n.backlinks.length}</span></h2>
      <ul class="list card">${n.backlinks.map((b) => noteRow(state.notes.get(b.id) || { ...b, kind: 'md' })).join('')}</ul>
    </section>` : ''}
    ${fromRandom ? `<a class="btn another" href="#/random">${ICON.shuffle}<span>Another random note</span></a>
      ${n.folder ? `<button class="link-btn skip-folder" id="skip-folder">Don’t pick from “${esc(n.folder.split('/').pop())}” again</button>` : ''}` : ''}
  </article>`;
  $('#skip-folder')?.addEventListener('click', (e) => {
    rediscover.skipFolder(n.folder);
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Skipped. Undo in Settings.';
  });

  if (n.kind === 'md') renderListenRow(n);

  const title = $('#note-title');
  titleObserver = new IntersectionObserver(([e]) => $('#topbar-title').classList.toggle('visible', !e.isIntersecting), {
    rootMargin: `-${$('#topbar').offsetHeight}px 0px 0px 0px`,
  });
  titleObserver.observe(title);

  if ((n.headings || []).length >= 3) {
    $('#toc-fab').hidden = false;
    $('#toc-sheet').innerHTML = `<div class="sheet-handle"></div><h2 class="section-label">Contents</h2><ul>${n.headings
      .map((h) => `<li style="--level:${h.level}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`)
      .join('')}</ul>`;
  }
}

function searchNotes(q) {
  const terms = norm(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const results = [];
  for (const n of state.notes.values()) {
    n._title ??= norm([n.name, ...(n.aliases || [])].join(' '));
    n._text ??= norm(n.text);
    n._tags ??= (n.tags || []).map((t) => '#' + norm(t));
    let score = 0;
    let ok = true;
    for (const t of terms) {
      if (t.startsWith('#') && t.length > 1) {
        if (n._tags.some((tag) => tag === t || tag.startsWith(t + '/'))) score += 20;
        else { ok = false; break; }
        continue;
      }
      const inTitle = n._title.includes(t);
      const inText = n._text.includes(t);
      const inFolder = norm(n.folder).includes(t);
      if (!inTitle && !inText && !inFolder) { ok = false; break; }
      score += (inTitle ? 30 : 0) + (n._title.startsWith(t) ? 10 : 0) + (inFolder ? 3 : 0) + (inText ? 5 : 0);
    }
    if (ok) results.push({ n, score });
  }
  return results.sort((a, b) => b.score - a.score || b.n.mtime - a.n.mtime).slice(0, 60);
}

function highlight(text, terms) {
  let out = esc(text);
  for (const t of terms) {
    if (!t || t.startsWith('#')) continue;
    out = out.replace(new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
  }
  return out;
}

function snippet(n, terms) {
  const t = terms.find((x) => !x.startsWith('#') && n._text.includes(x));
  if (!t) return '';
  const i = n._text.indexOf(t);
  const start = Math.max(0, i - 40);
  const text = (start ? '…' : '') + (n.text || '').slice(start, i + t.length + 80) + '…';
  return highlight(text, terms);
}

function renderSearch(q) {
  setTopbarTitle('Search');
  $('#topbar-title').classList.add('visible');
  view.innerHTML = `<section class="page search">
    <label class="search-box">${ICON.search}<input id="q" type="search" placeholder="Search notes, #tags" value="${esc(q)}" autocomplete="off" enterkeyhint="search"></label>
    <div id="results"></div>
  </section>`;
  const input = $('#q');
  const run = () => {
    const value = input.value.trim();
    history.replaceState({ ...history.state }, '', '#/search' + (value ? '?q=' + encodeURIComponent(value) : ''));
    lastRendered = location.hash;
    const terms = norm(value).split(/\s+/).filter(Boolean);
    const results = searchNotes(value);
    $('#results').innerHTML = !value
      ? '<p class="muted center">Search titles, text and #tags.</p>'
      : results.length
        ? `<p class="muted small">${results.length === 60 ? '60+' : results.length} results</p><ul class="list card results">${results
            .map(({ n }) => `<li><a class="row result" href="${noteHref(n.id)}">
              <span class="row-main"><span class="row-title">${highlight(n.name, terms)}</span>
              ${n.folder ? `<span class="row-sub">${esc(n.folder)}</span>` : ''}
              <span class="row-snippet">${snippet(n, terms)}</span></span></a></li>`)
            .join('')}</ul>`
        : '<p class="muted center">No matches.</p>';
  };
  let timer;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
  run();
  if (!q) setTimeout(() => input.focus(), 50);
}

async function renderSettings() {
  setTopbarTitle('Sync & settings');
  $('#topbar-title').classList.add('visible');
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => null);
  if (currentRoute().name !== 'settings') return;
  const seg = (name, value, options) =>
    `<div class="segmented" data-setting="${name}">${options
      .map(([v, label]) => `<button data-value="${v}" aria-pressed="${String(value) === String(v)}">${label}</button>`)
      .join('')}</div>`;
  const statusText = state.syncing
    ? state.progress?.total ? `Downloading ${state.progress.done} of ${state.progress.total} changed notes…` : 'Checking for changes…'
    : state.reachable ? 'Connected to your PC.' : state.reachable === false ? state.error || 'Not connected.' : 'Not checked yet.';
  view.innerHTML = `<section class="page settings">
    <h1 class="page-title">Sync</h1>
    <div class="card pad">
      <div class="status-line" data-tone="${$('#sync-pill').dataset.tone}"><span class="dot"></span>${esc(statusText)}</div>
      <dl class="kv">
        <div><dt>Last synced</dt><dd>${state.lastSync ? `${esc(ago(state.lastSync))} <span class="muted">(${new Date(state.lastSync).toLocaleString(LANG)})</span>` : 'Never'}</dd></div>
        <div><dt>Notes on this phone</dt><dd>${state.notes.size}</dd></div>
        ${est ? `<div><dt>Storage used</dt><dd>${(est.usage / 1024 / 1024).toFixed(1)} MB</dd></div>` : ''}
        ${persisted != null ? `<div><dt>Protected from cleanup</dt><dd>${persisted ? 'Yes' : 'No (Android may clear it if space runs low)'}</dd></div>` : ''}
      </dl>
      <div class="btn-row">
        <button class="btn primary" id="sync-now"${state.syncing ? ' disabled' : ''}>Sync now</button>
        <button class="btn" id="sync-full"${state.syncing ? ' disabled' : ''}>Download everything again</button>
      </div>
    </div>
    <h2 class="section-label">Reading</h2>
    <div class="card pad settings-grid">
      <span>Theme</span>${seg('theme', settings.theme || 'system', [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])}
      <span>Text size</span>${seg('textScale', settings.textScale || 1, [['0.9', 'S'], ['1', 'M'], ['1.12', 'L'], ['1.25', 'XL']])}
    </div>
    <h2 class="section-label">Random notes: folders to skip</h2>
    <div class="card pad" id="random-skip"></div>
    <h2 class="section-label">Read aloud: saved on this phone</h2>
    <div class="card pad" id="saved-audio"><p class="muted small">Checking…</p></div>
    <p class="muted small center">Read-only copy of <strong>${esc(state.vaultName)}</strong>. Edits happen in Obsidian on your PC.</p>
  </section>`;
  renderSavedAudio();
  renderRandomSkip();
  $('#sync-now').addEventListener('click', () => sync());
  $('#sync-full').addEventListener('click', () => sync({ full: true }));
  view.querySelectorAll('.segmented').forEach((el) =>
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const name = el.dataset.setting;
      settings[name] = name === 'textScale' ? Number(b.dataset.value) : b.dataset.value;
      saveSettings();
      renderSettings();
    }),
  );
}

// ---------- contents sheet ----------

function openToc() {
  $('#toc-sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
  requestAnimationFrame(() => document.body.classList.add('sheet-open'));
}
function closeToc() {
  document.body.classList.remove('sheet-open');
  $('#toc-sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
}
$('#toc-fab').addEventListener('click', openToc);
$('#sheet-backdrop').addEventListener('click', closeToc);

// ---------- global events ----------

// In-page anchors (#heading, footnotes) scroll instead of changing the route.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (href.startsWith('#/')) return;
  e.preventDefault();
  closeToc();
  let id = href.slice(1);
  try { id = decodeURIComponent(id); } catch {}
  scrollToAnchor(id);
});

// Back goes back within the app, or home when the app was opened on this page.
$('#back').addEventListener('click', () => {
  if (history.state?.depth > 0) history.back();
  else location.hash = '#/';
});
window.addEventListener('hashchange', render);
document.addEventListener('visibilitychange', maybeSync);
window.addEventListener('online', () => sync());
setInterval(maybeSync, 5 * 60_000);

// ---------- read aloud ----------
// The PC turns a note into speech (server/tts.js) and streams it; playback goes
// through a real <audio> element, so it keeps going with the screen off and
// shows lock-screen controls. "Save for offline" keeps a full copy in Cache
// Storage, which the service worker serves first; Settings lists and deletes them.

const AUDIO_CACHE = 'vault-audio';
const audioUrl = (n) => new URL(`audio?id=${encodeURIComponent(n.id)}&v=${encodeURIComponent(n.hash || '')}`, location.href).href;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const clock = (sec) => (Number.isFinite(sec) ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : '');
const player = { bar: null, audio: null, note: null, waitingSince: null, tick: null };

function ensurePlayer() {
  if (player.bar) return player;
  const bar = document.createElement('div');
  bar.className = 'player';
  bar.hidden = true;
  bar.innerHTML = `<button class="icon-btn" id="pl-toggle" aria-label="Play or pause">${ICON.pause}</button>
    <a class="pl-title" id="pl-title"></a>
    <span class="pl-time" id="pl-time"></span>
    <button class="icon-btn" id="pl-close" aria-label="Stop">${ICON.close}</button>
    <audio id="pl-audio" preload="none"></audio>`;
  document.body.append(bar);
  const audio = $('#pl-audio', bar);
  const paint = () => {
    const loading = player.waitingSince != null;
    bar.classList.toggle('loading', loading);
    $('#pl-toggle', bar).innerHTML = audio.paused ? ICON.play : ICON.pause;
    if (audio.error) return;
    if (loading) {
      // A counter, so a slow start reads as progress rather than a freeze.
      // First audio usually takes 2-8 s; mid-note waits are the PC catching up.
      const secs = Math.floor((Date.now() - player.waitingSince) / 1000);
      const what = audio.currentTime > 0 ? 'Buffering' : 'Preparing';
      $('#pl-time', bar).textContent = `${what}… ${secs}s`;
      return;
    }
    const dur = Number.isFinite(audio.duration) ? ` / ${clock(audio.duration)}` : '';
    $('#pl-time', bar).textContent = `${clock(audio.currentTime)}${dur}`;
  };
  const startWaiting = () => {
    if (player.waitingSince == null) player.waitingSince = Date.now();
    clearInterval(player.tick);
    player.tick = setInterval(paint, 1000);
    paint();
  };
  const stopWaiting = () => {
    player.waitingSince = null;
    clearInterval(player.tick);
    paint();
  };
  player.startWaiting = startWaiting;
  player.stopWaiting = stopWaiting;
  for (const ev of ['play', 'pause', 'ended', 'timeupdate', 'durationchange']) audio.addEventListener(ev, paint);
  audio.addEventListener('waiting', () => !audio.paused && startWaiting());
  audio.addEventListener('playing', stopWaiting);
  audio.addEventListener('pause', () => audio.paused && stopWaiting());
  audio.addEventListener('error', () => {
    stopWaiting();
    $('#pl-time', bar).textContent = "Couldn't load: connect to your PC, or save it for offline first";
  });
  $('#pl-toggle', bar).addEventListener('click', () => (audio.paused ? audio.play().catch(() => {}) : audio.pause()));
  $('#pl-close', bar).addEventListener('click', stopListening);
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => audio.play().catch(() => {}));
    ms.setActionHandler('pause', () => audio.pause());
    ms.setActionHandler('stop', stopListening);
    ms.setActionHandler('seekbackward', () => (audio.currentTime = Math.max(0, audio.currentTime - 15)));
    ms.setActionHandler('seekforward', () => (audio.currentTime += 15));
  }
  Object.assign(player, { bar, audio });
  return player;
}

function listen(n) {
  const { bar, audio } = ensurePlayer();
  player.note = n;
  const title = $('#pl-title', bar);
  title.textContent = n.name;
  title.href = noteHref(n.id);
  bar.hidden = false;
  document.body.classList.add('has-player');
  player.stopWaiting();
  audio.src = audioUrl(n);
  player.startWaiting();
  audio.play().catch(() => player.stopWaiting());
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: n.name,
      artist: state.vaultName,
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
}

function stopListening() {
  if (!player.audio) return;
  player.audio.pause();
  player.stopWaiting();
  player.audio.removeAttribute('src');
  player.audio.load();
  player.bar.hidden = true;
  player.note = null;
  document.body.classList.remove('has-player');
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
}

async function savedAudioSize(n) {
  try {
    const res = await (await caches.open(AUDIO_CACHE)).match(audioUrl(n));
    return res ? Number(res.headers.get('Content-Length')) || 0 : null;
  } catch {
    return null;
  }
}

async function renderListenRow(n) {
  const row = $('#listen-row');
  if (!row) return;
  const size = await savedAudioSize(n);
  if ($('#listen-row') !== row) return;
  row.innerHTML = `<button class="btn primary" id="listen">${ICON.play}<span>Listen</span></button>
    ${size != null
      ? `<span class="muted small">Saved for offline · ${mb(size)}</span>`
      : '<button class="btn" id="save-audio">Save for offline</button>'}`;
  $('#listen', row).addEventListener('click', () => listen(n));
  $('#save-audio', row)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Saving… (about a minute for a long note)';
    try {
      const res = await fetch(audioUrl(n));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      await (await caches.open(AUDIO_CACHE)).put(audioUrl(n), new Response(blob, {
        headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(blob.size) },
      }));
      renderListenRow(n);
    } catch {
      btn.disabled = false;
      btn.textContent = "Couldn't save: connect to your PC and try again";
    }
  });
}

async function renderSavedAudio() {
  const box = $('#saved-audio');
  if (!box) return;
  const entries = [];
  try {
    const cache = await caches.open(AUDIO_CACHE);
    for (const req of await cache.keys()) {
      const url = new URL(req.url);
      const id = url.searchParams.get('id');
      const res = await cache.match(req);
      const note = state.notes.get(id);
      entries.push({
        url: req.url,
        id,
        name: note?.name || id,
        size: Number(res?.headers.get('Content-Length')) || 0,
        stale: !note || note.hash !== url.searchParams.get('v'),
      });
    }
  } catch {}
  if ($('#saved-audio') !== box) return;
  if (!entries.length) {
    box.innerHTML = '<p class="muted small">Nothing saved. Open a note and tap “Save for offline” to keep its audio on this phone.</p>';
    return;
  }
  entries.sort((a, b) => collator.compare(a.name, b.name));
  const total = entries.reduce((sum, e) => sum + e.size, 0);
  box.innerHTML = `<ul class="audio-list">${entries.map((e, i) => `<li>
      <a href="${noteHref(e.id)}">${esc(e.name)}</a>
      <span class="muted small">${mb(e.size)}${e.stale ? ' · older version of the note' : ''}</span>
      <button class="btn" data-del="${i}">Delete</button>
    </li>`).join('')}</ul>
    <div class="btn-row"><span class="muted small">${entries.length} saved · ${mb(total)}</span><button class="btn" id="del-all-audio">Delete all</button></div>`;
  const remove = async (urls) => {
    const cache = await caches.open(AUDIO_CACHE);
    await Promise.all(urls.map((u) => cache.delete(u)));
    renderSavedAudio();
  };
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => remove([entries[Number(b.dataset.del)].url])));
  $('#del-all-audio', box).addEventListener('click', () => remove(entries.map((e) => e.url)));
}

// ---------- rediscover ----------
// A random note, weighted towards ones not seen for a long time: "seen" is the
// later of the last time it was opened on this phone and its last edit, so a
// note you just wrote or just read rarely comes up. Open times live in the meta
// store; they cover this phone only, not reading in Obsidian on the PC.

const DAY = 864e5;
const rediscover = {
  opened: new Map(),
  picks: [],
  RECENT: 14 * DAY,
  // Folders left out of random picks, per phone (Settings, or the button under a random note).
  skipped(n) {
    return (settings.randomSkip || []).some((f) => n.folder === f || n.folder?.startsWith(f + '/'));
  },
  skipFolder(folder) {
    settings.randomSkip = [...new Set([...(settings.randomSkip || []), folder])];
    saveSettings();
  },
  lastSeen(n) {
    return Math.max(this.opened.get(n.id) || 0, n.mtime || 0);
  },
  seenLabel(n) {
    const o = this.opened.get(n.id);
    const ts = o && o >= n.mtime ? o : n.mtime;
    const days = (Date.now() - ts) / DAY;
    return `${ts === o ? 'read ' : ''}${days < 30 ? ago(ts) : days < 365 ? `${Math.round(days / 30)} mo ago` : `${Math.round(days / 365)} y ago`}`;
  },
  markOpened(id) {
    this.opened.set(id, Date.now());
    idb.set('opened', Object.fromEntries([...this.opened].filter(([k]) => state.notes.has(k)))).catch(() => {});
  },
  async load() {
    this.opened = new Map(Object.entries((await idb.get('opened')) || {}));
  },
  // Weighted draw without replacement. Falls back to every note when the
  // filters leave nothing, so a tiny vault still gets a pick.
  pick(count, exclude = new Set()) {
    const now = Date.now();
    const all = [...state.notes.values()].filter((n) => n.kind === 'md' && !exclude.has(n.id) && !this.skipped(n));
    // Under ~300 characters of text is a hub or stub note, not something to reread.
    let pool = all.filter((n) => (n.text || '').length >= 300 && now - (this.opened.get(n.id) || 0) > this.RECENT);
    if (!pool.length) pool = all;
    const weighted = pool.map((n) => ({ n, w: 14 + Math.min(365, (now - this.lastSeen(n)) / DAY) }));
    const out = [];
    while (out.length < count && weighted.length) {
      let r = Math.random() * weighted.reduce((sum, x) => sum + x.w, 0);
      const i = weighted.findIndex((x) => (r -= x.w) <= 0);
      out.push(weighted.splice(i < 0 ? weighted.length - 1 : i, 1)[0].n);
    }
    return out;
  },
  // Home keeps its three picks across re-renders; one you've opened is swapped out.
  homePicks() {
    const now = Date.now();
    this.picks = this.picks.filter((id) => state.notes.has(id) && !this.skipped(state.notes.get(id)) && now - (this.opened.get(id) || 0) > this.RECENT);
    if (this.picks.length < 3) this.picks.push(...this.pick(3 - this.picks.length, new Set(this.picks)).map((n) => n.id));
    return this.picks.map((id) => state.notes.get(id));
  },
  reroll() {
    this.picks = this.pick(3, new Set(this.picks)).map((n) => n.id);
  },
};

function renderRandomSkip() {
  const box = $('#random-skip');
  if (!box) return;
  const skip = settings.randomSkip || [];
  const folders = new Set();
  for (const n of state.notes.values()) {
    const parts = (n.folder || '').split('/').filter(Boolean);
    parts.forEach((_, i) => folders.add(parts.slice(0, i + 1).join('/')));
  }
  const options = [...folders].filter((f) => !skip.includes(f)).sort(collator.compare);
  box.innerHTML = `${skip.length
    ? `<ul class="audio-list">${skip.map((f, i) => `<li><span class="skip-name">${esc(f)}</span><button class="btn" data-unskip="${i}">Remove</button></li>`).join('')}</ul>`
    : '<p class="muted small">Every folder can come up in random notes and Rediscover.</p>'}
    <select class="skip-select" id="skip-add" aria-label="Skip a folder">
      <option value="">Skip a folder…</option>
      ${options.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}
    </select>`;
  box.querySelectorAll('[data-unskip]').forEach((b) => b.addEventListener('click', () => {
    settings.randomSkip = skip.filter((_, i) => i !== Number(b.dataset.unskip));
    saveSettings();
    renderRandomSkip();
  }));
  $('#skip-add', box).addEventListener('change', (e) => {
    if (!e.target.value) return;
    rediscover.skipFolder(e.target.value);
    renderRandomSkip();
  });
}

// ---------- boot ----------

(async function boot() {
  saveSettings();
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  try {
    for (const n of await idb.allNotes()) state.notes.set(n.id, n);
    state.lastSync = (await idb.get('lastSync')) || null;
    state.vaultName = (await idb.get('vaultName')) || state.vaultName;
    await rediscover.load();
  } catch (err) {
    state.error = `Couldn't open storage on this phone (${err.message})`;
  }
  buildTree();
  render();
  renderStatus();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  sync();
})();
