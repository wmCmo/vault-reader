// HTTP server: the phone app (public/), the sync API and vault attachments.
// Binds to 127.0.0.1 only; `tailscale serve` exposes it to the tailnet.
import express from 'express';
import compression from 'compression';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault } from './vault.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configArg = process.argv.indexOf('--config');
const configPath = path.resolve(ROOT, configArg > 0 ? process.argv[configArg + 1] : process.env.VAULT_READER_CONFIG || 'config.json');
if (!fs.existsSync(configPath)) {
  console.error(`No config at ${configPath}. Copy config.example.json to config.json and set "vault".`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const lang = config.lang || 'en';
const appName = config.appName || 'Vault';

fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
const logFile = fs.createWriteStream(path.join(ROOT, 'logs', 'server.log'), { flags: 'a' });
for (const level of ['log', 'error']) {
  const original = console[level];
  console[level] = (...args) => {
    original(...args);
    logFile.write(`${new Date().toISOString()} ${level === 'error' ? 'ERROR ' : ''}${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')}\n`);
  };
}

const vault = new Vault({ root: path.resolve(ROOT, config.vault), exclude: config.exclude || [], lang });
const app = express();
app.disable('x-powered-by');
app.use(compression());

// The page and manifest carry the configured language and app name.
const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8').replace('<html lang="en">', `<html lang="${lang}">`);
app.get(['/', '/index.html'], (_req, res) => res.set('Cache-Control', 'no-cache').type('html').send(indexHtml));
app.get('/manifest.webmanifest', (_req, res) => {
  res.set('Cache-Control', 'no-cache').type('application/manifest+json').send(JSON.stringify({
    name: `${appName} — ${vault.name}`,
    short_name: appName,
    description: `Read-only offline copy of the ${vault.name} Obsidian vault.`,
    id: './',
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'portrait',
    lang,
    background_color: '#fbfaf7',
    theme_color: '#fbfaf7',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2));
});

app.get('/api/health', (_req, res) => res.json({ ok: true, vault: vault.name }));

app.get('/api/manifest', async (_req, res, next) => {
  try {
    const index = await vault.refresh();
    res.set('Cache-Control', 'no-store').json({
      vault: vault.name,
      builtAt: index.builtAt,
      notes: index.manifest,
      files: [...index.files.values()],
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/notes', express.json({ limit: '256kb' }), async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 200) : [];
    const index = await vault.refresh();
    const parts = ids.map((id) => index.payloads.get(id)).filter(Boolean);
    res.set('Cache-Control', 'no-store').type('json').send(`{"notes":[${parts.join(',')}]}`);
  } catch (err) {
    next(err);
  }
});

// Only files the index knows about are served, so excluded folders, dotfiles
// and anything outside the vault are unreachable.
app.get('/files/*', async (req, res, next) => {
  try {
    const rel = req.params[0];
    const index = await vault.refresh();
    if (!index.files.has(rel)) return res.status(404).send('Not found');
    res.sendFile(path.join(vault.root, rel), { headers: { 'Cache-Control': 'no-cache' } });
  } catch (err) {
    next(err);
  }
});

app.use(
  express.static(path.join(ROOT, 'public'), {
    setHeaders(res, file) {
      if (/sw\.js$/.test(file)) res.set('Cache-Control', 'no-cache');
    },
  }),
);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
});

const port = config.port || 4610;
app.listen(port, '127.0.0.1', async () => {
  console.log(`vault reader for ${vault.root} on http://127.0.0.1:${port}`);
  await vault.refresh();
});
