// Draws the app icon (a page on a violet tile) into PNGs without any image
// library: shapes are rasterised with 4x4 supersampling and PNG-encoded by hand.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inPoly = (x, y, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Returns [r, g, b, a] (0-255) for a point in unit coordinates.
function sample(u, v, { fullBleed, scale }) {
  const tileTop = [134, 108, 255];
  const tileBottom = [86, 58, 214];
  const inTile = fullBleed || inRoundRect(u, v, 0.02, 0.02, 0.98, 0.98, 0.22);
  if (!inTile) return [0, 0, 0, 0];
  let color = mix(tileTop, tileBottom, (u + v) / 2);
  const x = 0.5 + (u - 0.5) / scale;
  const y = 0.5 + (v - 0.5) / scale;
  const page = [[0.29, 0.2], [0.59, 0.2], [0.71, 0.32], [0.71, 0.8], [0.29, 0.8]];
  const fold = [[0.59, 0.2], [0.59, 0.32], [0.71, 0.32]];
  if (inPoly(x, y, page)) color = [255, 255, 255];
  if (inPoly(x, y, fold)) color = [214, 204, 255];
  for (const [ly, lx1] of [[0.45, 0.63], [0.555, 0.63], [0.66, 0.53]]) {
    if (inRoundRect(x, y, 0.37, ly - 0.021, lx1, ly + 0.021, 0.021)) color = [118, 92, 236];
  }
  return [...color, 255];
}

function draw(size, opts) {
  const S = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const [cr, cg, cb, ca] = sample((px + (sx + 0.5) / S) / size, (py + (sy + 0.5) / S) / size, opts);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const i = (py * size + px) * 4;
      out[i] = a ? r / a : 0;
      out[i + 1] = a ? g / a : 0;
      out[i + 2] = a ? b / a : 0;
      out[i + 3] = a / (S * S);
    }
  }
  return encodePng(size, out);
}

fs.mkdirSync(OUT, { recursive: true });
const icons = {
  'icon-192.png': [192, { fullBleed: false, scale: 1 }],
  'icon-512.png': [512, { fullBleed: false, scale: 1 }],
  'maskable-512.png': [512, { fullBleed: true, scale: 0.8 }],
  'apple-touch-icon.png': [180, { fullBleed: true, scale: 0.9 }],
};
for (const [name, [size, opts]] of Object.entries(icons)) {
  fs.writeFileSync(path.join(OUT, name), draw(size, opts));
  console.log('wrote', name);
}
