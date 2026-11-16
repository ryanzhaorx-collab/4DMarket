#!/usr/bin/env node
/**
 * 均匀抽稀 3DGS .ply（按 stride 取点，保留全部属性）。
 * 比 splat-transform 的 -d 快得多：1200 万点几秒完成，适合"先能看"。
 * 用法：node tools/ply-decimate.mjs <in.ply> <out.ply> <keepRatio 0~1>
 */
import fs from 'node:fs';

const [, , inPath, outPath, ratioArg] = process.argv;
const keep = Math.max(0.01, Math.min(1, Number(ratioArg) || 0.2));
const fd = fs.openSync(inPath, 'r');
const head = Buffer.alloc(65536);
const n = fs.readSync(fd, head, 0, 65536, 0);
const txt = head.subarray(0, n).toString('ascii');
const headEnd = txt.indexOf('end_header\n') + 11;
const header = txt.slice(0, headEnd);
const count = Number(/element vertex (\d+)/.exec(header)?.[1] ?? 0);
const props = [...header.matchAll(/property float (\w+)/g)].map((m) => m[1]);
const stride = props.length * 4;
const total = fs.statSync(inPath).size - headEnd;

const step = Math.max(1, Math.round(1 / keep));
const outCount = Math.floor((count + step - 1) / step);

const body = Buffer.alloc(outCount * stride);
const scratch = Buffer.alloc(stride * 512);
let w = 0;
for (let i = 0; i < count; i += step) {
  fs.readSync(fd, scratch, 0, stride, headEnd + i * stride);
  scratch.copy(body, w * stride, 0, stride);
  w++;
}
fs.closeSync(fd);

const newHeader = header.replace(/element vertex \d+/, `element vertex ${w}`);
fs.writeFileSync(outPath, Buffer.concat([Buffer.from(newHeader, 'ascii'), body.subarray(0, w * stride)]));
console.log(`[decimate] ${count} → ${w} 点（1/${step}）  ${(fs.statSync(outPath).size / 1048576).toFixed(1)}MB`);
console.log(`  输入总长 ${(total / 1048576).toFixed(0)}MB  属性 ${props.length} 个`);
