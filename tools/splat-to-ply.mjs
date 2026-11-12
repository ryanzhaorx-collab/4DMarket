#!/usr/bin/env node
/**
 * .splat → INRIA 3DGS .ply 转换器。
 *
 * 用途：
 *   1. 把现成的 .splat 转成引擎同样支持的 .ply，验证 PLY 解析链路；
 *   2. 拿它对照你自己的 PLY 属性名是否齐全（f_dc_* / opacity / scale_* / rot_*）。
 *
 * 用法：node tools/splat-to-ply.mjs <input.splat> <output.ply>
 */
import fs from 'node:fs';

const SH_C0 = 0.28209479177387814;

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('用法: node tools/splat-to-ply.mjs <input.splat> <output.ply>');
  process.exit(1);
}

const buf = fs.readFileSync(inPath);
if (buf.length % 32 !== 0) {
  console.error(`[splat2ply] 文件长度不是 32 的整数倍：${buf.length}`);
  process.exit(1);
}
const count = buf.length / 32;

const header = `ply
format binary_little_endian 1.0
comment converted from ${inPath.split('/').pop()}
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

for (let i = 0; i < count; i++) {
  const p = i * 32;
  const x = buf.readFloatLE(p);
  const y = buf.readFloatLE(p + 4);
  const z = buf.readFloatLE(p + 8);
  const sx = Math.abs(buf.readFloatLE(p + 12));
  const sy = Math.abs(buf.readFloatLE(p + 16));
  const sz = Math.abs(buf.readFloatLE(p + 20));
  const r = buf[p + 24] / 255;
  const g = buf[p + 25] / 255;
  const b = buf[p + 26] / 255;
  const a = buf[p + 27] / 255;
  const qx = buf[p + 28] / 128 - 1;
  const qy = buf[p + 29] / 128 - 1;
  const qz = buf[p + 30] / 128 - 1;
  const qw = buf[p + 31] / 128 - 1;

  // 位置
  body.writeFloatLE(x, o); o += 4;
  body.writeFloatLE(y, o); o += 4;
  body.writeFloatLE(z, o); o += 4;
  // 法线（3DGS 不使用，填 0）
  body.writeFloatLE(0, o); o += 4;
  body.writeFloatLE(0, o); o += 4;
  body.writeFloatLE(0, o); o += 4;
  // 颜色 DC：c = 0.5 + SH_C0 * dc  →  dc = (c - 0.5) / SH_C0
  body.writeFloatLE((r - 0.5) / SH_C0, o); o += 4;
  body.writeFloatLE((g - 0.5) / SH_C0, o); o += 4;
  body.writeFloatLE((b - 0.5) / SH_C0, o); o += 4;
  // 不透明度：alpha = sigmoid(opacity)
  const op = Math.min(0.9999, Math.max(1e-4, a));
  body.writeFloatLE(Math.log(op / (1 - op)), o); o += 4;
  // 尺度：scale = exp(scale_i)
  body.writeFloatLE(Math.log(Math.max(sx, 1e-6)), o); o += 4;
  body.writeFloatLE(Math.log(Math.max(sy, 1e-6)), o); o += 4;
  body.writeFloatLE(Math.log(Math.max(sz, 1e-6)), o); o += 4;
  // 旋转：按 INRIA 官方约定写成 (w, x, y, z)
  body.writeFloatLE(qw, o); o += 4;
  body.writeFloatLE(qx, o); o += 4;
  body.writeFloatLE(qy, o); o += 4;
  body.writeFloatLE(qz, o); o += 4;
}

fs.writeFileSync(outPath, Buffer.concat([Buffer.from(header, 'ascii'), body]));
console.log(`[splat2ply] ${count} 点 → ${outPath} (${(fs.statSync(outPath).size / 1048576).toFixed(2)}MB)`);
