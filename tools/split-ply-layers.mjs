#!/usr/bin/env node
/**
 * 把 3DGS .ply 按高度均分成 N 层（千层糕 / 抽屉分层展开用）。
 * 用法：node tools/split-ply-layers.mjs <in.ply> <outPrefix> <n>
 * 产物：<outPrefix>-0..N-1.ply，另写 <outPrefix>-layers.json（记录每层高度范围）
 */
import fs from 'node:fs';

const [, , inPath, outPrefix, nArg] = process.argv;
const N = Math.max(2, Number(nArg) || 6);
const buf = fs.readFileSync(inPath);
const headEnd = buf.indexOf('end_header\n') + 'end_header\n'.length;
const head = buf.subarray(0, headEnd).toString('ascii');
const count = Number(/element vertex (\d+)/.exec(head)?.[1] ?? 0);
const props = [...head.matchAll(/property float (\w+)/g)].map((m) => m[1]);
const stride = props.length * 4;
const yi = props.indexOf('z'); // 原始数据 Z-up：z 才是高度

let yMin = Infinity;
let yMax = -Infinity;
for (let i = 0; i < count; i++) {
  const y = buf.readFloatLE(headEnd + i * stride + yi * 4);
  if (y < yMin) yMin = y;
  if (y > yMax) yMax = y;
}

const step = (yMax - yMin) / N;
const buckets = Array.from({ length: N }, () => []);
for (let i = 0; i < count; i++) {
  const y = buf.readFloatLE(headEnd + i * stride + yi * 4);
  const idx = Math.min(N - 1, Math.max(0, Math.floor((y - yMin) / step)));
  buckets[idx].push(i);
}

const meta = { n: N, yMin, yMax, layers: [] };
for (let k = 0; k < N; k++) {
  const idx = buckets[k];
  const body = Buffer.alloc(idx.length * stride);
  idx.forEach((pi, j) => buf.copy(body, j * stride, headEnd + pi * stride, headEnd + (pi + 1) * stride));
  const h = head.replace(/element vertex \d+/, `element vertex ${idx.length}`);
  fs.writeFileSync(`${outPrefix}-${k}.ply`, Buffer.concat([Buffer.from(h, 'ascii'), body]));
  meta.layers.push({ index: k, count: idx.length, y0: yMin + k * step, y1: yMin + (k + 1) * step });
  console.log(`layer ${k}: ${idx.length} 点  y[${(yMin + k * step).toFixed(1)}, ${(yMin + (k + 1) * step).toFixed(1)}]  ${((idx.length * stride) / 1048576).toFixed(1)}MB`);
}
fs.writeFileSync(`${outPrefix}-layers.json`, JSON.stringify(meta, null, 2));
