#!/usr/bin/env node
/**
 * Gera os ícones PNG do AdShield sem dependências externas.
 * Escudo com barra diagonal = bloqueio.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function png(width, height, rgba) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filtro none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    header,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

/** Cobre do escudo em coordenadas normalizadas. */
function inShield(x, y) {
  const dx = Math.abs(x - 0.5);
  if (y < 0.16 || y > 0.86) return false;
  if (y <= 0.56) return dx <= 0.34 - 0.02 * (y - 0.16);
  const t = (y - 0.56) / (0.86 - 0.56);
  return dx <= 0.3 * (1 - t) ** 1.15;
}

function inSlash(x, y) {
  // barra de (0.24,0.24) a (0.76,0.76), espessura ~0.11
  const d = Math.abs((y - 0.5) - (x - 0.5)) / Math.SQRT2;
  return d < 0.055 && x > 0.22 && x < 0.78;
}

function render(size) {
  const buffer = Buffer.alloc(size * size * 4);
  const superSample = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let shieldHits = 0;
      let slashHits = 0;
      for (let sy = 0; sy < superSample; sy++) {
        for (let sx = 0; sx < superSample; sx++) {
          const x = (px + (sx + 0.5) / superSample) / size;
          const y = (py + (sy + 0.5) / superSample) / size;
          if (inShield(x, y)) shieldHits += 1;
          if (inShield(x, y) && inSlash(x, y)) slashHits += 1;
        }
      }
      const total = superSample * superSample;
      const shieldAlpha = shieldHits / total;
      const slashAlpha = slashHits / total;
      const gradient = mix(0.0, 1.0, py / size);
      let r = mix(47, 24, gradient);
      let g = mix(111, 92, gradient);
      let b = mix(237, 190, gradient);
      if (slashAlpha > 0) {
        r = mix(r, 255, slashAlpha);
        g = mix(g, 255, slashAlpha);
        b = mix(b, 255, slashAlpha);
      }
      const index = (py * size + px) * 4;
      buffer[index] = Math.round(r);
      buffer[index + 1] = Math.round(g);
      buffer[index + 2] = Math.round(b);
      buffer[index + 3] = Math.round(255 * Math.max(shieldAlpha, 0));
    }
  }
  return png(size, size, buffer);
}

await mkdir(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(join(OUT, `icon${size}.png`), render(size));
  console.log(`icons/icon${size}.png`);
}
