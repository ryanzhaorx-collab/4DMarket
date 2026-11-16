#!/usr/bin/env node
/**
 * 按轴对齐盒把 3DGS .ply 拆成「盒内 / 盒外」两份。
 * 用法：node tools/ply-box-split.mjs <in.ply> <x0,x1,y0,y1,z0,z1> <outIn.ply> <outOut.ply>
 * 坐标是 ply 原始坐标系（本项目模型是 Z-up，高度在 z）。
 */
import fs from 'node:fs';

const [, , inPath, boxArg, inOut, outOut] = process.argv;
const [x0, x1, y0, y1, z0, z1] = boxArg.split(',').map(Number);

const fd = fs.openSync(inPath, 'r');
const head = Buffer.alloc(65536);
const hn = fs.readSync(fd, head, 0, 65536, 0);
const txt = head.subarray(0, hn).toString('ascii');
const headEnd = txt.indexOf('end_header\n') + 11;
const header = txt.slice(0, headEnd);
const count = Number(/element vertex (\d+)/.exec(header)?.[1] ?? 0);
const props = [...header.matchAll(/property float (\w+)/g)].map((m) => m[1]);
const stride = props.length * 4;
const ix = props.indexOf('x') * 4;
const iy = props.indexOf('y') * 4;
const iz = props.indexOf('z') * 4;

const inner = [];
const outer = [];
const buf = Buffer.alloc(stride);
for (let i = 0; i < count; i++) {
  fs.readSync(fd, buf, 0, stride, headEnd + i * stride);
  const x = buf.readFloatLE(ix);
  const y = buf.readFloatLE(iy);
  const z = buf.readFloatLE(iz);
  (x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1 ? inner : outer).push(i);
}
fs.closeSync(fd);

const write = (idx, path) => {
  const body = Buffer.alloc(idx.length * stride);
  const chunk = Buffer.alloc(stride);
  const rfd = fs.openSync(inPath, 'r');   // 只开一次，避免 EMFILE
  idx.forEach((pi, k) => {
    fs.readSync(rfd, chunk, 0, stride, headEnd + pi * stride);
    chunk.copy(body, k * stride);
  });
  fs.closeSync(rfd);
  const h = header.replace(/element vertex \d+/, `element vertex ${idx.length}`);
  fs.writeFileSync(path, Buffer.concat([Buffer.from(h, 'ascii'), body]));
  console.log(`${path}: ${idx.length} 点 ${(idx.length * stride / 1048576).toFixed(1)}MB`);
};

write(inner, inOut);
write(outer, outOut);
