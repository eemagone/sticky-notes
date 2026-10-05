// Tiny PNG painter: the app icon, tray icon and colour swatches without image files or deps.
// `node icon.js` writes build/icon.png (used by electron-builder).
const zlib = require('zlib');

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = ~0; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (type, body) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type), body]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
};
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// paint(u, v) -> [r, g, b, a] | null for u, v in 0..1; 4x4 supersampled
function png(size, paint) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const p = paint((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size);
        if (p) { const a = p[3] ?? 255; acc[0] += p[0] * a; acc[1] += p[1] * a; acc[2] += p[2] * a; acc[3] += a; }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (acc[3]) for (let i = 0; i < 3; i++) raw[o + i] = Math.round(acc[i] / acc[3]);
      raw[o + 3] = Math.round(acc[3] / 16);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const inRounded = (u, v, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(u, x0 + r), x1 - r), cy = Math.min(Math.max(v, y0 + r), y1 - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r && u >= x0 && u <= x1 && v >= y0 && v <= y1;
};

// A pale yellow note with a folded corner and two handwritten-ish lines.
function noteIcon(size) {
  const [paper, fold, edge, ink] = ['#ffe680', '#f2c94c', '#b8922a', '#6b5526'].map(rgb);
  const e = Math.max(0.03, 1.2 / size);
  return png(size, (u, v) => {
    if (!inRounded(u, v, 0.1, 0.1, 0.9, 0.9, 0.08)) return null;
    if (u + v > 1.48) return null; // folded-away corner
    if (u + v > 1.48 - e * 1.4) return edge;
    if (!inRounded(u, v, 0.1 + e, 0.1 + e, 0.9 - e, 0.9 - e, 0.08 - e)) return edge;
    if (u + v > 1.3) return fold;
    const line = (y, x1) => Math.abs(v - y) < 0.045 && u > 0.26 && u < x1;
    if (line(0.38, 0.74) || line(0.58, 0.62)) return ink;
    return paper;
  });
}

function swatch(hex, size = 16) {
  const [c, b] = [rgb(hex), [0, 0, 0, 60]];
  return png(size, (u, v) => (inRounded(u, v, 0.08, 0.08, 0.92, 0.92, 0.25)
    ? (inRounded(u, v, 0.14, 0.14, 0.86, 0.86, 0.2) ? c : b) : null));
}

module.exports = { noteIcon, swatch };

if (require.main === module) {
  require('fs').mkdirSync('build', { recursive: true });
  require('fs').writeFileSync('build/icon.png', noteIcon(256));
  console.log('wrote build/icon.png');
}
