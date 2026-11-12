#!/usr/bin/env node
/**
 * PLY → 分块 + 两级 LOD + manifest.json
 *
 * 大模型在移动端卡，根因通常不是渲染器，而是「一股脑塞进显存」。
 * 这个工具把一份原始 PLY 切成空间块，每块再抽一份低模，输出引擎可直接加载的目录树：
 *
 *   <out>/manifest.json
 *   <out>/splat/lod0/c0_0_0.splat   ← 约 20%，先出图
 *   <out>/splat/lod1/c0_0_0.splat   ← 全量，流式精修
 *
 * 用法：
 *   node tools/ply-to-lod.mjs 你的模型.ply --out public/assets/local/hotel
 *   可选：--chunk 150000（每块目标点数）--lod 0.2（低模比例）--name hotel
 *
 * 然后浏览器打开：
 *   http://localhost:5178/?manifest=assets/local/hotel/manifest.json&fit=1&debug=1
 *
 * 与浏览器端 splatFormat.ts 保持同一套解析规则（二进制小端 / ASCII，四元数自动判序）。
 */
import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2);
if (!argv[0] || argv[0] === '-h' || argv[0] === '--help') {
  console.log(`用法: node tools/ply-to-lod.mjs <input.ply> [--out 目录] [--chunk 150000] [--lod 0.2] [--keep 1] [--name 场景名]`);
  process.exit(argv[0] ? 0 : 1);
}
const input = path.resolve(argv[0]);
const opt = {
  out: 'public/assets/local/scene',
  chunk: 150000,
  lod: 0.2,
  keep: 1,
  name: path.basename(input).replace(/\.ply$/i, ''),
};
for (let i = 1; i < argv.length; i++) {
  const k = argv[i];
  const v = argv[i + 1];
  if (k === '--out') { opt.out = v; i++; }
  else if (k === '--chunk') { opt.chunk = Math.max(1000, Number(v)); i++; }
  else if (k === '--lod') { opt.lod = Math.min(0.9, Math.max(0.02, Number(v))); i++; }
  else if (k === '--keep') { opt.keep = Math.min(1, Math.max(0.05, Number(v))); i++; }
  else if (k === '--name') { opt.name = v; i++; }
}

const SH_C0 = 0.28209479177387814;
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${(n / 1e3).toFixed(1)}k`);
const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;

/* ------------------------------------------------------------- PLY 解析 */

const TYPE_SIZE = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
};

function findHeaderEnd(buf) {
  const limit = Math.min(buf.length, 65536);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 101 && buf[i + 1] === 110 && buf[i + 2] === 100 && buf[i + 3] === 95 && buf[i + 4] === 104) {
      let j = i + 10;
      while (j < buf.length && buf[j] !== 10) j++;
      return j + 1;
    }
  }
  throw new Error('PLY 头没有 end_header');
}

function parsePly(buf) {
  const headerEnd = findHeaderEnd(buf);
  const header = buf.subarray(0, headerEnd).toString('utf8');
  const lines = header.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let format = '';
  let count = 0;
  let stride = 0;
  const props = [];
  let inVertex = false;
  for (const line of lines) {
    const p = line.split(/\s+/);
    if (p[0] === 'format') format = p[1];
    else if (p[0] === 'element') {
      inVertex = p[1] === 'vertex';
      if (inVertex) count = parseInt(p[2], 10);
    } else if (p[0] === 'property' && inVertex) {
      if (p[1] === 'list') continue;
      const size = TYPE_SIZE[p[1]];
      if (!size) throw new Error(`不支持的属性类型 ${p[1]}`);
      props.push({ name: p[2], type: p[1], offset: stride, index: props.length });
      stride += size;
    }
  }
  const isAscii = /^ascii$/.test(format);
  if (!isAscii && !/binary_little_endian/.test(format)) {
    throw new Error(`仅支持 binary_little_endian 或 ascii，当前 ${format}`);
  }

  const byName = new Map(props.map((p) => [p.name, p]));
  const has = (n) => byName.has(n);
  if (!has('x') || !has('y') || !has('z')) throw new Error('PLY 缺少 x/y/z');

  const pos = new Float32Array(count * 3);
  const scale = new Float32Array(count * 3);
  const rot = new Float32Array(count * 4);
  const color = new Uint8Array(count * 3);
  const alpha = new Float32Array(count);

  const asciiRows = isAscii ? buf.subarray(headerEnd).toString('utf8').split('\n').filter((l) => l.trim()) : null;
  const n = Math.min(count, asciiRows ? asciiRows.length : Math.floor((buf.length - headerEnd) / stride));
  const dv = isAscii ? null : new DataView(buf.buffer, buf.byteOffset + headerEnd, buf.length - headerEnd);

  const readBin = (o, prop, def) => {
    if (!prop) return def;
    const at = o + prop.offset;
    switch (prop.type) {
      case 'float': case 'float32': return dv.getFloat32(at, true);
      case 'double': case 'float64': return dv.getFloat64(at, true);
      case 'uchar': case 'uint8': return dv.getUint8(at);
      case 'char': case 'int8': return dv.getInt8(at);
      case 'ushort': case 'uint16': return dv.getUint16(at, true);
      case 'short': case 'int16': return dv.getInt16(at, true);
      case 'uint': case 'uint32': return dv.getUint32(at, true);
      case 'int': case 'int32': return dv.getInt32(at, true);
      default: return def;
    }
  };

  let vals = null;
  const loadAscii = (i) => {
    const t = asciiRows[i].trim().split(/\s+/);
    if (!vals) vals = new Float64Array(props.length);
    for (let k = 0; k < props.length && k < t.length; k++) vals[k] = Number(t[k]) || 0;
  };
  const get = (i, prop, def) => {
    if (!prop) return def;
    if (asciiRows) return vals[prop.index];
    return readBin(i * stride, prop, def);
  };

  const isSH = has('f_dc_0');
  const fdc = [byName.get('f_dc_0'), byName.get('f_dc_1'), byName.get('f_dc_2')];
  const rgb = [byName.get('red'), byName.get('green'), byName.get('blue')];
  const scl = [byName.get('scale_0'), byName.get('scale_1'), byName.get('scale_2')];
  const op = byName.get('opacity') ?? byName.get('alpha');
  const rq = [byName.get('rot_0'), byName.get('rot_1'), byName.get('rot_2'), byName.get('rot_3')];

  // 四元数判序：|w| 通常显著大于其它分量
  let rotOrder = 'wxyz';
  if (rq[3] && n > 0) {
    const step = Math.max(1, Math.floor(n / 2000));
    let s0 = 0, s3 = 0, c = 0;
    for (let i = 0; i < n; i += step) {
      if (asciiRows) loadAscii(i);
      s0 += Math.abs(get(i, rq[0], 0));
      s3 += Math.abs(get(i, rq[3], 1));
      c++;
    }
    if (s3 > s0 * 1.15) rotOrder = 'xyzw';
  }

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    if (asciiRows) loadAscii(i);
    const x = get(i, byName.get('x'), 0), y = get(i, byName.get('y'), 0), z = get(i, byName.get('z'), 0);
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;

    for (let k = 0; k < 3; k++) {
      let c;
      if (isSH) c = 0.5 + SH_C0 * get(i, fdc[k], 0);
      else if (rgb[k]) c = get(i, rgb[k], 200) / 255;
      else c = 0.75;
      color[i * 3 + k] = Math.max(0, Math.min(255, Math.round(c * 255)));
      scale[i * 3 + k] = has('scale_0') ? Math.exp(get(i, scl[k], -4)) : 0.02;
    }
    const o = get(i, op, 3);
    alpha[i] = 1 / (1 + Math.exp(-o));
    if (!Number.isFinite(alpha[i])) alpha[i] = 0;

    const a0 = get(i, rq[0], 1), b0 = get(i, rq[1], 0), c0 = get(i, rq[2], 0), d0 = get(i, rq[3], 0);
    let qx, qy, qz, qw;
    if (rotOrder === 'wxyz') { qw = a0; qx = b0; qy = c0; qz = d0; }
    else { qx = a0; qy = b0; qz = c0; qw = d0; }
    const l = Math.hypot(qx, qy, qz, qw) || 1;
    rot[i * 4] = qx / l; rot[i * 4 + 1] = qy / l; rot[i * 4 + 2] = qz / l; rot[i * 4 + 3] = qw / l;
  }

  return { count: n, pos, scale, rot, color, alpha, min, max, rotOrder, hasScale: has('scale_0'), hasOpacity: !!op };
}

/* --------------------------------------------------------------- 写 .splat */

function writeSplat(file, data, index, n) {
  const buf = Buffer.alloc(n * 32);
  let o = 0;
  for (let k = 0; k < n; k++) {
    const i = index[k];
    buf.writeFloatLE(data.pos[i * 3], o);
    buf.writeFloatLE(data.pos[i * 3 + 1], o + 4);
    buf.writeFloatLE(data.pos[i * 3 + 2], o + 8);
    buf.writeFloatLE(data.scale[i * 3], o + 12);
    buf.writeFloatLE(data.scale[i * 3 + 1], o + 16);
    buf.writeFloatLE(data.scale[i * 3 + 2], o + 20);
    buf[o + 24] = data.color[i * 3];
    buf[o + 25] = data.color[i * 3 + 1];
    buf[o + 26] = data.color[i * 3 + 2];
    buf[o + 27] = Math.round(Math.max(0, Math.min(1, data.alpha[i])) * 255);
    buf[o + 28] = Math.round(Math.max(-1, Math.min(1, data.rot[i * 4])) * 127.5 + 127.5);
    buf[o + 29] = Math.round(Math.max(-1, Math.min(1, data.rot[i * 4 + 1])) * 127.5 + 127.5);
    buf[o + 30] = Math.round(Math.max(-1, Math.min(1, data.rot[i * 4 + 2])) * 127.5 + 127.5);
    buf[o + 31] = Math.round(Math.max(-1, Math.min(1, data.rot[i * 4 + 3])) * 127.5 + 127.5);
    o += 32;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf.length;
}

/* ------------------------------------------------------------------ 主流程 */

const t0 = Date.now();
const fileSize = fs.statSync(input).size;
console.log(`[lod] 读取 ${path.basename(input)}  ${mb(fileSize)}`);
const buf = fs.readFileSync(input);
const data = parsePly(buf);
console.log(`[lod] 解析 ${fmt(data.count)} 点（四元数 ${data.rotOrder}${data.hasOpacity ? '' : '，无 opacity'}） ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const size = [data.max[0] - data.min[0], data.max[1] - data.min[1], data.max[2] - data.min[2]];
console.log(`[lod] 包围盒 ${size.map((v) => v.toFixed(1)).join(' × ')} m`);

// 3D 网格
const wantedCells = Math.max(1, Math.ceil(data.count / opt.chunk));
const g = Math.max(1, Math.min(12, Math.ceil(Math.cbrt(wantedCells))));
const cell = [
  Math.max(size[0] / g, 1e-6),
  Math.max(size[1] / g, 1e-6),
  Math.max(size[2] / g, 1e-6),
];
console.log(`[lod] 切块 ${g}×${g}×${g}，单块目标 ${fmt(opt.chunk)} 点`);

const cellOf = (i) => {
  const ix = Math.min(g - 1, Math.floor((data.pos[i * 3] - data.min[0]) / cell[0]));
  const iy = Math.min(g - 1, Math.floor((data.pos[i * 3 + 1] - data.min[1]) / cell[1]));
  const iz = Math.min(g - 1, Math.floor((data.pos[i * 3 + 2] - data.min[2]) / cell[2]));
  return (ix * g + iy) * g + iz;
};

const buckets = new Map();
for (let i = 0; i < data.count; i++) {
  const c = cellOf(i);
  let b = buckets.get(c);
  if (!b) { b = []; buckets.set(c, b); }
  b.push(i);
}

const outDir = path.resolve(opt.out);
fs.mkdirSync(outDir, { recursive: true });

let lod1Total = 0, lod0Total = 0, bytes1 = 0, bytes0 = 0, files = 0;
const tiles = [];
const report = [];

for (const [c, idx] of buckets) {
  const iz = c % g;
  const iy = Math.floor(c / g) % g;
  const ix = Math.floor(c / (g * g));
  const key = `c${ix}_${iy}_${iz}`;

  // 重要性：透明度 × 体积^(1/3)，加一点抖动避免规则采样
  const scored = idx.map((i) => {
    const s = data.scale;
    const vol = Math.cbrt(Math.max(1e-9, s[i * 3] * s[i * 3 + 1] * s[i * 3 + 2]));
    return { i, w: data.alpha[i] * vol * (0.9 + Math.random() * 0.2) };
  });
  scored.sort((a, b) => b.w - a.w);
  const keep1 = Math.max(1, Math.round(idx.length * opt.keep));
  const keep0 = Math.max(1, Math.round(idx.length * opt.lod));
  const lod1Idx = scored.slice(0, keep1).map((s) => s.i);
  const lod0Idx = scored.slice(0, Math.min(keep0, keep1)).map((s) => s.i);

  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const i of idx) {
    for (let k = 0; k < 3; k++) {
      const v = data.pos[i * 3 + k];
      if (v < mn[k]) mn[k] = v;
      if (v > mx[k]) mx[k] = v;
    }
  }
  const b1 = writeSplat(path.join(outDir, 'splat/lod1', `${key}.splat`), data, lod1Idx, lod1Idx.length);
  const b0 = writeSplat(path.join(outDir, 'splat/lod0', `${key}.splat`), data, lod0Idx, lod0Idx.length);
  lod1Total += lod1Idx.length;
  lod0Total += lod0Idx.length;
  bytes1 += b1;
  bytes0 += b0;
  files += 2;

  tiles.push({
    url: `splat/lod1/${key}.splat`, lod: 1, key,
    min: mn.map((v) => Math.round(v * 100) / 100),
    max: mx.map((v) => Math.round(v * 100) / 100),
  });
  tiles.push({
    url: `splat/lod0/${key}.splat`, lod: 0, key,
    min: mn.map((v) => Math.round(v * 100) / 100),
    max: mx.map((v) => Math.round(v * 100) / 100),
  });
  report.push(`  ${key}: ${fmt(lod1Idx.length)} → LOD0 ${fmt(lod0Idx.length)}`);
}

const cx = (data.min[0] + data.max[0]) / 2;
const cy = (data.min[1] + data.max[1]) / 2;
const cz = (data.min[2] + data.max[2]) / 2;
const diag = Math.hypot(...size);
const distance = Math.max(2, (diag / Math.sin((55 * Math.PI) / 360)) * 0.72);

const manifest = {
  version: 1,
  scene: {
    id: opt.name,
    name: opt.name,
    subtitle: 'FOUR-DIMENSION SPACE',
    location: '',
    anchor: { label: opt.name, detail: 'LOCAL SCAN' },
    tags: [],
  },
  camera: {
    target: [Math.round(cx * 10) / 10, Math.round(cy * 10) / 10, Math.round(cz * 10) / 10],
    distance: Math.round(distance),
    yaw: 0.2,
    pitch: 0.55,
    fov: 55,
    introFrom: { distance: Math.round(distance * 2.2), pitch: 0.95, yawOffset: 0.45 },
  },
  splat: { tiles },
  hotspots: [],
};

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

/* ------------------------------------------------------------------ 报告 */

console.log(report.slice(0, 12).join('\n') + (report.length > 12 ? `\n  … 其余 ${report.length - 12} 块` : ''));
console.log('');
console.log(`[lod] 完成 ${files} 个文件，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`[lod] LOD1 ${fmt(lod1Total)} 点 ${mb(bytes1)}   LOD0 ${fmt(lod0Total)} 点 ${mb(bytes0)}（${(opt.lod * 100).toFixed(0)}%）`);
console.log(`[lod] 首屏只需 LOD0：${mb(bytes0)}；显存 LOD1 全量约 ${(lod1Total * 56 / 1048576).toFixed(0)}MB`);
console.log(`[lod] manifest: ${path.relative(process.cwd(), path.join(outDir, 'manifest.json'))}`);
console.log('');
console.log('  打开调试验证：');
console.log(`  http://localhost:5178/?manifest=${path.relative(path.resolve('public'), path.join(outDir, 'manifest.json')).split(path.sep).join('/')}&fit=1&debug=1`);
