#!/usr/bin/env node
/**
 * 按 Y 高度把 3DGS .ply 切成三段（下 / 中 / 上），给 PlayCanvas 做「上下拆分 + 抽屉」。
 * 用法：node tools/split-ply-y.mjs <in.ply> <outPrefix> <y0> <y1>
 * 产物：<outPrefix>-lower.ply / -mid.ply / -upper.ply
 */
import fs from 'node:fs';

const [, , inPath, outPrefix, a0, a1] = process.argv;
const y0 = Number(a0);
const y1 = Number(a1);
const buf = fs.readFileSync(inPath);
const headEnd = buf.indexOf('end_header\n') + 'end_header\n'.length;
const head = buf.subarray(0, headEnd).toString('ascii');
const count = Number(/element vertex (\d+)/.exec(head)?.[1] ?? 0);
const props = [...head.matchAll(/property float (\w+)/g)].map((m) => m[1]);
const stride = props.length * 4;
const yi = props.indexOf('z'); // 原始数据 Z-up：z 才是高度

const buckets = { lower: [], mid: [], upper: [] };
for (let i = 0; i < count; i++) {
  const o = headEnd + i * stride;
  const y = buf.readFloatLE(o + yi * 4);
  (y < y0 ? buckets.lower : y > y1 ? buckets.upper : buckets.mid).push(i);
}

for (const [name, idx] of Object.entries(buckets)) {
  const body = Buffer.alloc(idx.length * stride);
  idx.forEach((pi, k) => buf.copy(body, k * stride, headEnd + pi * stride, headEnd + (pi + 1) * stride));
  const h = head.replace(/element vertex \d+/, `element vertex ${idx.length}`);
  fs.writeFileSync(`${outPrefix}-${name}.ply`, Buffer.concat([Buffer.from(h, 'ascii'), body]));
  console.log(`${name}: ${idx.length} 点 → ${outPrefix}-${name}.ply (${(idx.length * stride / 1048576).toFixed(1)}MB)`);
}
