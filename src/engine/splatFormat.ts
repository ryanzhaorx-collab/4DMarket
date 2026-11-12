/**
 * 3DGS 资产解析：.splat（32 字节/点，antimatter15 格式）与 .ply（INRIA 3DGS 原生导出）。
 * 全部解析在 Worker 中执行，主线程不阻塞；解析完成后按空间切块，便于剔除 / 排序 / 流式加载。
 */
import type { SplatPayload } from './types';

const SH_C0 = 0.28209479177387814;

export class SplatParseError extends Error {}

/* ------------------------------------------------------------------ .splat */

export function parseSplat(buffer: ArrayBuffer): SplatPayload {
  const dv = new DataView(buffer);
  if (buffer.byteLength < 32 || buffer.byteLength % 32 !== 0) {
    throw new SplatParseError(`.splat 文件长度非法: ${buffer.byteLength}`);
  }
  const count = buffer.byteLength / 32;
  const pos = new Float32Array(count * 3);
  const scale = new Float32Array(count * 3);
  const rot = new Float32Array(count * 4);
  const color = new Uint8Array(count * 3);
  const alpha = new Float32Array(count);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < count; i++) {
    const o = i * 32;
    const x = dv.getFloat32(o, true);
    const y = dv.getFloat32(o + 4, true);
    const z = dv.getFloat32(o + 8, true);
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    scale[i * 3] = Math.abs(dv.getFloat32(o + 12, true));
    scale[i * 3 + 1] = Math.abs(dv.getFloat32(o + 16, true));
    scale[i * 3 + 2] = Math.abs(dv.getFloat32(o + 20, true));
    color[i * 3] = dv.getUint8(o + 24);
    color[i * 3 + 1] = dv.getUint8(o + 25);
    color[i * 3 + 2] = dv.getUint8(o + 26);
    alpha[i] = dv.getUint8(o + 27) / 255;
    rot[i * 4] = dv.getUint8(o + 28) / 128 - 1;
    rot[i * 4 + 1] = dv.getUint8(o + 29) / 128 - 1;
    rot[i * 4 + 2] = dv.getUint8(o + 30) / 128 - 1;
    rot[i * 4 + 3] = dv.getUint8(o + 31) / 128 - 1;
    // 四元数归一化
    const qx = rot[i * 4], qy = rot[i * 4 + 1], qz = rot[i * 4 + 2], qw = rot[i * 4 + 3];
    const l = Math.hypot(qx, qy, qz, qw) || 1;
    rot[i * 4] = qx / l; rot[i * 4 + 1] = qy / l; rot[i * 4 + 2] = qz / l; rot[i * 4 + 3] = qw / l;

    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], count, pos, scale, rot, color, alpha };
}

/* -------------------------------------------------------------------- .ply */

interface PlyProp {
  name: string;
  type: string;
  offset: number;
  index: number;
}

const TYPE_SIZE: Record<string, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
};

function findHeaderEnd(bytes: Uint8Array): number {
  const limit = Math.min(bytes.length, 65536);
  for (let i = 0; i < limit; i++) {
    if (
      bytes[i] === 101 && bytes[i + 1] === 110 && bytes[i + 2] === 100 &&
      bytes[i + 3] === 95 && bytes[i + 4] === 104
    ) {
      let j = i + 10;
      while (j < bytes.length && bytes[j] !== 10) j++;
      return j + 1;
    }
  }
  throw new SplatParseError('PLY 头未找到 end_header');
}

export function parsePly(
  buffer: ArrayBuffer,
  opts?: { rotOrder?: 'wxyz' | 'xyzw' | 'auto' },
): SplatPayload {
  const bytes = new Uint8Array(buffer);
  const headerEnd = findHeaderEnd(bytes);
  const header = new TextDecoder().decode(bytes.subarray(0, headerEnd));
  const lines = header.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let format = '';
  let vertexCount = 0;
  let inVertex = false;
  let stride = 0;
  const props: PlyProp[] = [];
  let otherElementsBytes = 0;
  let currentElement = '';

  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts[0] === 'format') format = parts[1] ?? '';
    else if (parts[0] === 'element') {
      currentElement = parts[1];
      if (currentElement === 'vertex') {
        vertexCount = parseInt(parts[2], 10);
        inVertex = true;
      } else {
        inVertex = false;
        const n = parseInt(parts[2], 10);
        if (n > 0) otherElementsBytes += n; // 粗略：非 vertex 元素通常没有
      }
    } else if (parts[0] === 'property' && inVertex) {
      const type = parts[1];
      const name = parts[2];
      if (type === 'list') continue; // 不支持 list 顶点属性
      const size = TYPE_SIZE[type];
      if (!size) throw new SplatParseError(`未知 PLY 属性类型: ${type}`);
      props.push({ name, type, offset: stride, index: props.length });
      stride += size;
    }
  }
  const isAscii = /^ascii$/.test(format);
  if (!isAscii && !/binary_little_endian/.test(format)) {
    throw new SplatParseError(`仅支持二进制小端或 ASCII PLY，当前: ${format || 'unknown'}`);
  }
  if (!vertexCount || !stride) throw new SplatParseError('PLY 缺少 vertex 数据');

  const byName = new Map<string, PlyProp>();
  for (const p of props) byName.set(p.name, p);
  const need = (n: string) => byName.get(n);
  const has = (n: string) => byName.has(n);

  const pX = need('x'), pY = need('y'), pZ = need('z');
  if (!pX || !pY || !pZ) throw new SplatParseError('PLY 缺少 x/y/z');

  const dv = new DataView(buffer, headerEnd);
  const asciiText = isAscii ? new TextDecoder().decode(bytes.subarray(headerEnd)) : null;
  const asciiRows = asciiText ? asciiText.split('\n').filter((l) => l.trim()) : null;
  // 只取有效数据范围，避免越界（部分导出文件尾部有 padding）
  const available = isAscii ? (asciiRows?.length ?? 0) : Math.floor((buffer.byteLength - headerEnd) / stride);
  const count = Math.min(vertexCount, available);
  if (count <= 0) throw new SplatParseError('PLY 顶点数据为空');

  const read = (o: number, prop: PlyProp | undefined, def: number): number => {
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

  const pos = new Float32Array(count * 3);
  const scale = new Float32Array(count * 3);
  const rot = new Float32Array(count * 4);
  const color = new Uint8Array(count * 3);
  const alpha = new Float32Array(count);

  const fdc = [need('f_dc_0'), need('f_dc_1'), need('f_dc_2')];
  const rgb = [need('red'), need('green'), need('blue')];
  const scl = [need('scale_0'), need('scale_1'), need('scale_2')];
  const pOpacity = need('opacity') ?? need('alpha');
  const prot = [need('rot_0'), need('rot_1'), need('rot_2'), need('rot_3')];
  const isSH = fdc[0] !== undefined;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  const rotA = prot[0], rotB = prot[1], rotC = prot[2], rotD = prot[3];
  const asciiVals = asciiRows ? new Float64Array(props.length) : null;
  const loadAsciiRow = (i: number) => {
    const tokens = asciiRows![i].trim().split(/\s+/);
    for (let k = 0; k < props.length && k < tokens.length; k++) asciiVals![k] = Number(tokens[k]) || 0;
  };
  const getAt = (i: number, prop: PlyProp | undefined, def: number): number => {
    if (!prop) return def;
    if (asciiVals) return asciiVals[prop.index];
    return read(i * stride, prop, def);
  };

  // 四元数分量顺序：INRIA 官方导出是 (w, x, y, z)，部分工具写成 (x, y, z, w)。
  // 真实 3DGS 的旋转大多接近单位四元数，|w| 系统性大于其它分量，据此自动判定。
  let rotOrder: 'wxyz' | 'xyzw' = opts?.rotOrder === 'xyzw' ? 'xyzw' : 'wxyz';
  if (!opts?.rotOrder || opts.rotOrder === 'auto') {
    const step = Math.max(1, Math.floor(count / 2000));
    let sumFirst = 0;
    let sumLast = 0;
    let samples = 0;
    for (let i = 0; i < count; i += step) {
      if (asciiVals) loadAsciiRow(i);
      sumFirst += Math.abs(getAt(i, rotA, 0));
      sumLast += Math.abs(getAt(i, rotD, 1));
      samples++;
    }
    if (samples > 0 && sumLast > sumFirst * 1.15) rotOrder = 'xyzw';
  }

  const writePoint = (i: number) => {
    const x = getAt(i, pX, 0), y = getAt(i, pY, 0), z = getAt(i, pZ, 0);
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;

    for (let k = 0; k < 3; k++) {
      let c: number;
      if (isSH) c = 0.5 + SH_C0 * getAt(i, fdc[k], 0);
      else if (rgb[k]) c = getAt(i, rgb[k], 200) / 255;
      else c = 0.72;
      color[i * 3 + k] = Math.max(0, Math.min(255, Math.round(c * 255)));
      // 3DGS 原生导出为 log 尺度
      scale[i * 3 + k] = has('scale_0') ? Math.exp(getAt(i, scl[k], -4)) : 0.03;
    }

    const op = getAt(i, pOpacity, 3);
    alpha[i] = 1 / (1 + Math.exp(-op));
    if (!Number.isFinite(alpha[i])) alpha[i] = 0;

    const a = getAt(i, rotA, 1), b = getAt(i, rotB, 0), c = getAt(i, rotC, 0), d = getAt(i, rotD, 0);
    let qx: number, qy: number, qz: number, qw: number;
    if (rotOrder === 'wxyz') {
      qw = a; qx = b; qy = c; qz = d;
    } else {
      qx = a; qy = b; qz = c; qw = d;
    }
    const l = Math.hypot(qx, qy, qz, qw) || 1;
    rot[i * 4] = qx / l;
    rot[i * 4 + 1] = qy / l;
    rot[i * 4 + 2] = qz / l;
    rot[i * 4 + 3] = qw / l;

    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  };

  if (asciiRows) {
    for (let i = 0; i < count; i++) {
      loadAsciiRow(i);
      writePoint(i);
    }
  } else {
    for (let i = 0; i < count; i++) writePoint(i);
  }

  void otherElementsBytes;
  return {
    min: [minX, minY, minZ], max: [maxX, maxY, maxZ], count, pos, scale, rot, color, alpha,
  };
}

/* --------------------------------------------------------------- 空间切块 */

export function detectFormat(url: string): 'ply' | 'splat' {
  return /\.ply(\?|$)/i.test(url) ? 'ply' : 'splat';
}

/**
 * 把单文件资产切成 XZ 平面网格块。单块目标 ~55k splat，
 * 既能保证视锥剔除效果，又能让每块排序耗时落在 1~3ms。
 */
export function splitIntoTiles(src: SplatPayload, targetPerTile = 60000): SplatPayload[] {
  const { count } = src;
  if (count === 0) return [];
  const grid = Math.max(1, Math.min(8, Math.round(Math.sqrt(count / targetPerTile))));
  if (grid === 1) return [src];

  const sizeX = src.max[0] - src.min[0] || 1;
  const sizeZ = src.max[2] - src.min[2] || 1;
  const cellW = sizeX / grid;
  const cellD = sizeZ / grid;
  const cells = grid * grid;
  const cellOf = new Int32Array(count);
  const counts = new Uint32Array(cells + 1);

  for (let i = 0; i < count; i++) {
    let cx = Math.floor((src.pos[i * 3] - src.min[0]) / cellW);
    let cz = Math.floor((src.pos[i * 3 + 2] - src.min[2]) / cellD);
    cx = cx < 0 ? 0 : cx >= grid ? grid - 1 : cx;
    cz = cz < 0 ? 0 : cz >= grid ? grid - 1 : cz;
    const c = cz * grid + cx;
    cellOf[i] = c;
    counts[c + 1]++;
  }
  for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];

  const cursor = counts.slice();
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[cursor[cellOf[i]]++] = i;

  const out: SplatPayload[] = [];
  for (let c = 0; c < cells; c++) {
    const start = counts[c];
    const n = counts[c + 1] - start;
    if (!n) continue;
    const pos = new Float32Array(n * 3);
    const scale = new Float32Array(n * 3);
    const rot = new Float32Array(n * 4);
    const color = new Uint8Array(n * 3);
    const alpha = new Float32Array(n);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < n; k++) {
      const s = order[start + k];
      for (let a = 0; a < 3; a++) {
        const v = src.pos[s * 3 + a];
        pos[k * 3 + a] = v;
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
        scale[k * 3 + a] = src.scale[s * 3 + a];
        color[k * 3 + a] = src.color[s * 3 + a];
      }
      for (let a = 0; a < 4; a++) rot[k * 4 + a] = src.rot[s * 4 + a];
      alpha[k] = src.alpha[s];
    }
    out.push({ min, max, count: n, pos, scale, rot, color, alpha });
  }
  return out;
}
