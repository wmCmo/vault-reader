// Read-aloud: a note's text -> MP3, generated on the PC with Microsoft's neural
// voices (scripts/tts.py, via edge-tts) and streamed to the phone as it's made,
// so playback starts in a second or two. Finished files are cached by note
// content + voice, so a replay (or the phone's offline download) is instant.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

// Markdown -> what a person would read out. Structure lines (hub links),
// code and tables are skipped; links keep their visible text.
export function speechText(title, body) {
  const lines = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/%%[\s\S]*?%%/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/);
  const out = [];
  for (let line of lines) {
    if (/^\s*(>\s*)?(\*\*)?(Part of|Parent project|Related:)/.test(line)) continue;
    if (/^\s*\|/.test(line)) continue;
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue;
    line = line
      .replace(/^\s*(>\s*)+/, '')
      .replace(/^\[![^\]]*\][+-]?\s*/, '')
      .replace(/^#{1,6}\s+(.*)$/, '$1.')
      .replace(/^\s*([-*+]|\d+\.)\s+(\[.\]\s+)?/, '')
      .replace(/!\[\[[^\]]*\]\]/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[\[([^\]|#]*)(#[^\]|]*)?\|?([^\]]*)\]\]/g, (_, target, _h, alias) => alias || target.split('/').pop())
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/[→⇒]/g, ', ')
      .replace(/[*_`~=]+/g, '')
      .replace(EMOJI, '')
      .trim();
    if (line) out.push(line);
  }
  return [title.replace(EMOJI, '').trim() + '.', ...out].join('\n');
}

const isJapanese = (text) => {
  const ja = (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return ja > latin * 0.5;
};

export function createTts({ root, config = {} }) {
  const voiceEn = config.voiceEn || 'en-US-AvaMultilingualNeural';
  const voiceJa = config.voiceJa || 'ja-JP-NanamiNeural';
  const rate = config.rate || '-5%';
  const python = config.python || 'python';
  const script = path.join(root, 'scripts', 'tts.py');
  const dir = path.join(root, 'cache', 'tts');
  fs.mkdirSync(dir, { recursive: true });
  // Leftovers from a generation that was killed (e.g. a server restart).
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.part')) fs.rmSync(path.join(dir, f), { force: true });
  const jobs = new Map();

  function plan(note) {
    const text = speechText(note.name || path.basename(note.id, '.md'), note.body || '');
    const voice = isJapanese(text) ? voiceJa : voiceEn;
    const key = crypto.createHash('sha1').update(`${voice}\n${rate}\n${text}`).digest('hex').slice(0, 20);
    return { text, voice, file: path.join(dir, `${key}.mp3`) };
  }

  // One generation per note, independent of any request: the audio is kept in
  // memory as it arrives, every listener (the first play, a resume after pause)
  // reads from it, and a dropped connection doesn't stop it. When it finishes,
  // the file is cached and later requests are plain file serves.
  function startJob(id, text, voice, file) {
    const job = { chunks: [], size: 0, ended: false, failed: false, listeners: new Set() };
    const notify = () => job.listeners.forEach((fn) => fn());
    const started = Date.now();
    const secs = () => ((Date.now() - started) / 1000).toFixed(1);
    let firstAudio = null;
    let stderr = '';
    console.log(`tts start: ${id} (${voice}, ${text.length} chars)`);
    const child = spawn(python, [script, voice, rate], { windowsHide: true });
    // Timings and every stall/retry go to the log.
    child.stderr.on('data', (d) => {
      stderr += d;
      for (const line of String(d).split(/\r?\n/).filter(Boolean)) console.log(`tts ${secs()}s: ${id}: ${line}`);
    });
    child.stdout.on('data', (chunk) => {
      if (firstAudio == null) firstAudio = secs();
      job.chunks.push(chunk);
      job.size += chunk.length;
      notify();
    });
    const finish = (err) => {
      if (job.ended) return;
      if (!err) {
        try {
          const tmp = `${file}.part`;
          fs.writeFileSync(tmp, Buffer.concat(job.chunks));
          fs.renameSync(tmp, file);
          console.log(`tts done: ${id} (first audio ${firstAudio}s, total ${secs()}s)`);
        } catch (e) {
          err = e;
        }
      }
      if (err) {
        job.failed = true;
        console.error(`tts failed after ${secs()}s: ${id}`, err);
      }
      job.ended = true;
      jobs.delete(file);
      notify();
    };
    child.on('error', finish);
    child.on('close', (code) => finish(code === 0 ? null : new Error(`tts.py exited ${code}: ${stderr.trim().slice(-400)}`)));
    child.stdin.end(text, 'utf8');
    jobs.set(file, job);
    return job;
  }

  // Wait until the job has more than `offset` bytes, or has ended.
  const waitFor = (job, offset, ms) =>
    new Promise((resolve) => {
      if (job.size > offset || job.ended) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        job.listeners.delete(check);
        resolve();
      }
      function check() {
        if (job.size > offset || job.ended) done();
      }
      job.listeners.add(check);
    });

  const slice = (job, from) => {
    const out = [];
    let pos = 0;
    for (const c of job.chunks) {
      if (pos + c.length > from) out.push(from > pos ? c.subarray(from - pos) : c);
      pos += c.length;
    }
    return Buffer.concat(out);
  };

  // GET /audio?id=<note id>. Cached -> sendFile (ranges work, so the phone can
  // seek). Being generated -> a request from the start streams everything so
  // far and then follows the generation live; a request from a later byte
  // (the phone resuming after a pause) gets the bytes that exist past it now,
  // as a 206 with an unknown total, and asks again for the rest.
  return async function handler(req, res, vault) {
    const id = String(req.query.id || '');
    const index = await vault.refresh();
    const note = index.notes.get(id);
    if (!note || note.kind !== 'md') return res.status(404).send('Not found');
    const { text, voice, file } = plan(note);
    if (fs.existsSync(file)) return res.sendFile(file, { headers: { 'Cache-Control': 'no-cache' } });
    const job = jobs.get(file) || startJob(id, text, voice, file);

    const range = /^bytes=(\d+)-/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' });

    if (start > 0) {
      await waitFor(job, start, 60_000);
      if (fs.existsSync(file)) return res.sendFile(file, { headers: { 'Cache-Control': 'no-cache' } });
      if (job.size <= start) return res.status(job.failed ? 502 : 416).end();
      const body = slice(job, start);
      res.status(206).set({ 'Content-Range': `bytes ${start}-${start + body.length - 1}/*`, 'Content-Length': body.length });
      return res.end(body);
    }

    // From the start: everything so far, then live until the job ends.
    let sent = 0;
    const pump = () => {
      if (res.writableEnded) return;
      if (job.size > sent) {
        res.write(slice(job, sent));
        sent = job.size;
      }
      if (job.ended) {
        job.listeners.delete(pump);
        if (job.failed && !res.headersSent) res.status(502);
        res.end();
      }
    };
    job.listeners.add(pump);
    res.on('close', () => job.listeners.delete(pump));
    pump();
  };
}
