// Serves the landing page (docs/) locally, the way GitHub Pages will.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const port = Number(process.env.PORT) || 4630;
express()
  .use('/vault-reader', express.static(docs))
  .get('/', (_req, res) => res.redirect('/vault-reader/'))
  .listen(port, '127.0.0.1', () => console.log(`landing page on http://127.0.0.1:${port}/vault-reader/`));
