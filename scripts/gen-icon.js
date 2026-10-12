/**
 * Генерация assets/icon.png (512×512) без внешних зависимостей:
 * тёмный скруглённый квадрат с градиентом и эквалайзер-столбиками Sonic Studio.
 * Запуск: node scripts/gen-icon.js
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 512;

// ─── Минимальный PNG-энкодер ───

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ─── Рисование ───

const img = Buffer.alloc(SIZE * SIZE * 4);

function lerp(a, b, k) { return a + (b - a) * k; }
function mix(c1, c2, k) {
  return [lerp(c1[0], c2[0], k), lerp(c1[1], c2[1], k), lerp(c1[2], c2[2], k)];
}

function setPx(x, y, r, g, b, a = 255) {
  const i = (y * SIZE + x) * 4;
  img[i] = Math.round(r); img[i + 1] = Math.round(g); img[i + 2] = Math.round(b); img[i + 3] = Math.round(a);
}

// Скруглённый прямоугольник: signed distance
function roundedRectDist(px, py, cx, cy, hw, hh, radius) {
  const dx = Math.abs(px - cx) - (hw - radius);
  const dy = Math.abs(py - cy) - (hh - radius);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - radius;
}

// Капсула (столбик со скруглёнными концами)
function capsuleDist(px, py, x1, y1, x2, y2, r) {
  const pax = px - x1, pay = py - y1;
  const bax = x2 - x1, bay = y2 - y1;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  const dx = pax - bax * h, dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

const bg1 = [23, 26, 34];    // верх
const bg2 = [13, 15, 20];    // низ
const acc1 = [148, 133, 255]; // #9485ff
const acc2 = [34, 211, 238];  // #22d3ee

const bars = [-0.32, -0.16, 0, 0.16, 0.32]; // относительный центр по X
const barH = [0.34, 0.55, 0.86, 0.55, 0.34]; // относительная высота
const barW = 26;
const halfH = SIZE / 2;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // Фон: скруглённый квадрат с вертикальным градиентом
    const d = roundedRectDist(x + 0.5, y + 0.5, SIZE / 2, SIZE / 2, SIZE / 2 - 8, SIZE / 2 - 8, 96);
    if (d > 1) continue;
    const alpha = d < -1 ? 255 : Math.round(255 * (1 - Math.max(0, d) / 2));
    const k = y / SIZE;
    let [r, g, b] = mix(bg1, bg2, k);

    // Лёгкое радиальное свечение за столбиками
    const glow = capsuleDist(x, y, SIZE / 2, halfH, SIZE / 2, halfH, 190);
    if (glow < 0) {
      const gk = Math.min(1, -glow / 190);
      [r, g, b] = mix([r, g, b], [40, 44, 66], gk * 0.9);
    }

    // Столбики эквалайзера
    for (let i = 0; i < bars.length; i++) {
      const bx = SIZE / 2 + bars[i] * 300;
      const h = barH[i] * 340;
      const top = halfH - h / 2;
      const cd = capsuleDist(x + 0.5, y + 0.5, bx, top + barW, bx, top + h - barW, barW);
      if (cd < 0.5) {
        const t = Math.min(1, Math.max(0, (y - top) / h));
        const [cr, cg, cb] = mix(acc1, acc2, (i / (bars.length - 1)) * 0.75 + t * 0.25);
        const edge = Math.min(1, Math.max(0, (0.5 - cd) / 1.5));
        [r, g, b] = mix([r, g, b], [cr, cg, cb], edge);
      }
    }

    // Верхняя светлая кромка
    const edgeTop = roundedRectDist(x + 0.5, y + 0.5, SIZE / 2, SIZE / 2 + 1.5, SIZE / 2 - 8, SIZE / 2 - 8, 96);
    if (edgeTop > -3 && edgeTop < 0) {
      [r, g, b] = mix([r, g, b], [255, 255, 255], 0.06);
    }

    setPx(x, y, r, g, b, alpha);
  }
}

const png = encodePNG(SIZE, SIZE, img);
const out = path.join(__dirname, '..', 'assets', 'icon.png');
fs.writeFileSync(out, png);
console.log(`Иконка создана: ${out} (${png.length} байт)`);
