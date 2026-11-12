#!/usr/bin/env node
/**
 * 把 lodN 目录下所有 .splat 分块合并成一个 INRIA 3DGS .ply。
 * 用途：给 PlayCanvas / 其它引擎一个整块可加载的资产（它们不认我们的分块 .splat）。
 *
 * 用法：node tools/merge-lod-ply.mjs models/HS_Bolimuqiang/manifest.json lod0 out.ply
 */
import fs from 'node:fs';
import path from 'node:path';

const SH_C0 = 0.28209479177387814;
const [, , manifestPath, lod = 'lod0', outPath] = process.argv;
if (!manifestPath || !outPath) {
  console.error('用法: node tools/merge-lod-ply.mjs <manifest.json> <lod0|lod1> <out.ply>');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const baseDir = path.dirname(manifestPath);
const all = manifest.splat?.tiles ?? manifest.tiles ?? [];
const wanted = Number(lod.replace('lod', ''));
const tiles = all.filter((t) => (t.lod ?? 0) === wanted);
if (!tiles.length) {
  console.error(`manifest 里没有 ${lod} 分块`);
  process.exit(1);
}

const files = tiles
  .map((t) => path.join(baseDir, t.url))
  .filter((f) => fs.existsSync(f));

let count = 0;
for (const f of files) {
  const n = fs.statSync(f).size / 32;
  if (!Number.isInteger(n)) throw new Error(`坏文件: ${f}`);
  count += n;
}

const header = `ply
format binary_little_endian 1.0
comment merged from ${files.length} chunks (${lod})
element vertex ${count}
property float x
property float y
property float z
property float nx
property float ny
property float nz
property float f_dc_0
property float f_dc_1
property float f_dc_2
property float opacity
property float scale_0
property float scale_1
property float scale_2
property float rot_0
property float rot_1
property float rot_2
property float rot_3
end_header
`;

const STRIDE = 17 * 4;
const body = Buffer.alloc(count * STRIDE);
let o = 0;
for (const f of files) {
  const buf = fs.readFileSync(f);
  const n = buf.length / 32;
  for (let i = 0; i < n; i++) {
    const p = i * 32;
    const sx = Math.abs(buf.readFloatLE(p + 12));
    const sy = Math.abs(buf.readFloatLE(p + 16));
    const sz = Math.abs(buf.readFloatLE(p + 20));
    const r = buf[p + 24] / 255, g = buf[p + 25] / 255, b = buf[p + 26] / 255, a = buf[p + 27] / 255;
    const qx = buf[p + 28] / 128 - 1, qy = buf[p + 29] / 128 - 1;
    const qz = buf[p + 30] / 128 - 1, qw = buf[p + 31] / 128 - 1;

    body.writeFloatLE(buf.readFloatLE(p), o); o += 4;
    body.writeFloatLE(buf.readFloatLE(p + 4), o); o += 4;
    body.writeFloatLE(buf.readFloatLE(p + 8), o); o += 4;
    body.writeFloatLE(0, o); o += 4;
    body.writeFloatLE(0, o); o += 4;
    body.writeFloatLE(0, o); o += 4;
    body.writeFloatLE((r - 0.5) / SH_C0, o); o += 4;
    body.writeFloatLE((g - 0.5) / SH_C0, o); o += 4;
    body.writeFloatLE((b - 0.5) / SH_C0, o); o += 4;
    const op = Math.min(0.9999, Math.max(1e-4, a));
    body.writeFloatLE(Math.log(op / (1 - op)), o); o += 4;
    body.writeFloatLE(Math.log(Math.max(sx, 1e-6)), o); o += 4;
    body.writeFloatLE(Math.log(Math.max(sy, 1e-6)), o); o += 4;
    body.writeFloatLE(Math.log(Math.max(sz, 1e-6)), o); o += 4;
    body.writeFloatLE(qw, o); o += 4;
    body.writeFloatLE(qx, o); o += 4;
    body.writeFloatLE(qy, o); o += 4;
    body.writeFloatLE(qz, o); o += 4;
  }
}
fs.writeFileSync(outPath, Buffer.concat([Buffer.from(header, 'ascii'), body]));
console.log(`[merge-lod] ${files.length} 块 / ${count} 点 → ${outPath} (${(fs.statSync(outPath).size / 1048576).toFixed(1)}MB)`);
