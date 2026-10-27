// App shell: stale-while-revalidate. Vault files: cache first, so images and
// any PDF opened once keep working offline. /api/ always goes to the network.
const SHELL = 'shell-v1';
const FILES = 'vault-files';
const SHELL_URLS = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const offline = (text) => new Response(text, { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

async function fromShell(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || offline('Offline');
}

async function fromFiles(request) {
  const cache = await caches.open(FILES);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.status === 200) cache.put(request, res.clone());
    return res;
  } catch {
    return offline('This file has not been saved on the phone yet. Open it once while connected to your PC.');
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (path.startsWith('api/')) return;
  if (path.startsWith('files/')) {
    if (!request.headers.has('range')) event.respondWith(fromFiles(request));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(fromShell(new Request(new URL('index.html', self.registration.scope))));
    return;
  }
  event.respondWith(fromShell(request));
});
