// Generates PWA icons as PNG files using only Node built-ins (zlib).
// Usage: node scripts/gen-icons.mjs

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "icons");
mkdirSync(OUT, { recursive: true });

/* ---------- PNG encoding ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- drawing ---------- */

// Checkmark in the 512x512 design space (round caps/joins via segment distance).
const CHECK_P1 = [148, 272];
const CHECK_P2 = [222, 346];
const CHECK_P3 = [372, 182];
const CHECK_WIDTH = 58;

const BG_TOP = [240, 112, 79];    // #f0704f
const BG_BOTTOM = [200, 70, 47];  // #c8462f

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return Math.hypot(qx, qy);
}

// Signed distance to a rounded rect; negative inside.
function roundedRectSDF(x, y, size, radius) {
  const half = size / 2;
  const qx = Math.abs(x - half) - (half - radius);
  const qy = Math.abs(y - half) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

function renderIcon(size, { rounded = true, contentScale = 1 } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const ss = 4; // supersampling factor
  const radius = size * (120 / 512);
  const scale = size / 512;
  const center = size / 2;
  const halfW = (CHECK_WIDTH * scale) / 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgSum = 0;
      let fgSum = 0;
      for (let sy = 0; sy < ss; sy += 1 / ss) {
        for (let sx = 0; sx < ss; sx += 1 / ss) {
          const x = px + sx + 0.5 / ss;
          const y = py + sy + 0.5 / ss;
          const bgA = rounded
            ? Math.min(1, Math.max(0, 0.5 - roundedRectSDF(x, y, size, radius)))
            : 1;
          if (bgA <= 0) continue;
          // Map sample into the (possibly shrunk) content box.
          const cx = (x - center) / contentScale + center;
          const cy = (y - center) / contentScale + center;
          const d = Math.min(
            distToSegment(cx, cy, CHECK_P1[0] * scale, CHECK_P1[1] * scale, CHECK_P2[0] * scale, CHECK_P2[1] * scale),
            distToSegment(cx, cy, CHECK_P2[0] * scale, CHECK_P2[1] * scale, CHECK_P3[0] * scale, CHECK_P3[1] * scale)
          );
          const fgA = Math.min(1, Math.max(0, 0.5 + halfW - d));
          bgSum += bgA;
          fgSum += fgA * bgA;
        }
      }
      const samples = ss * ss;
      const bgA = bgSum / samples;
      if (bgA <= 0) continue;
      const fg = Math.min(1, fgSum / bgSum);
      const t = (px + py) / (2 * size); // diagonal gradient factor
      const r = (BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t) * (1 - fg) + 255 * fg;
      const g = (BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t) * (1 - fg) + 255 * fg;
      const b = (BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t) * (1 - fg) + 255 * fg;
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(bgA * 255);
    }
  }
  return encodePng(size, size, rgba);
}

const targets = [
  { file: "icon-192.png", size: 192, opts: { rounded: true } },
  { file: "icon-512.png", size: 512, opts: { rounded: true } },
  { file: "maskable-512.png", size: 512, opts: { rounded: false, contentScale: 0.62 } },
  { file: "apple-touch-icon.png", size: 180, opts: { rounded: false, contentScale: 0.82 } },
];

for (const { file, size, opts } of targets) {
  const png = renderIcon(size, opts);
  writeFileSync(join(OUT, file), png);
  console.log(`icons/${file} (${size}x${size}, ${(png.length / 1024).toFixed(1)} KB)`);
}
