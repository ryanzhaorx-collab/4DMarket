#!/usr/bin/env node
/**
 * 演示场景生成器：用程序化几何产出「东山岛悦华酒店」的 3DGS 点云 + 周边倾斜摄影 3D Tiles。
 *
 * 真实项目里这两份资产分别由 3DGS 重建管线（.ply/.splat）与倾斜摄影空三建模（OSGB → 3D Tiles）产出，
 * 这里生成同格式的等价数据，用于验证引擎的渲染、排序、LOD、流式加载与容错，不依赖任何外部素材。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.join(root, 'public', 'assets', 'yuehua');

/* ------------------------------------------------------------------ 基础工具 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261110);
const jitter = (amt) => (rnd() * 2 - 1) * amt;
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function quatFromBasis(uIn, vIn, nIn) {
  // 强制正交右手基：直接用 U × V 作为第三轴，避免出现镜像矩阵（四元数无解）
  const U = norm(uIn);
  const V0 = norm(vIn);
  const N = norm(cross(U, V0));
  const V = cross(N, U);
  const m00 = U[0], m01 = V[0], m02 = N[0];
  const m10 = U[1], m11 = V[1], m12 = N[1];
  const m20 = U[2], m21 = V[2], m22 = N[2];
  void nIn;
  const trace = m00 + m11 + m22;
  let x, y, z, w;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  return [x / l, y / l, z / l, w / l];
}

/* -------------------------------------------------------------- splat 容器 */

class Cloud {
  constructor(cap = 400000) {
    this.cap = cap;
    this.n = 0;
    this.pos = new Float32Array(cap * 3);
    this.scale = new Float32Array(cap * 3);
    this.rot = new Float32Array(cap * 4);
    this.col = new Uint8Array(cap * 3);
    this.alpha = new Float32Array(cap);
  }

  add(x, y, z, sx, sy, sz, q, c, a) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.scale[i * 3] = sx; this.scale[i * 3 + 1] = sy; this.scale[i * 3 + 2] = sz;
    this.rot[i * 4] = q[0]; this.rot[i * 4 + 1] = q[1]; this.rot[i * 4 + 2] = q[2]; this.rot[i * 4 + 3] = q[3];
    const ao = 0.68 + 0.32 * smoothstep(0.3, 8.5, y);
    this.col[i * 3] = clamp(c[0] * ao, 0, 255);
    this.col[i * 3 + 1] = clamp(c[1] * ao, 0, 255);
    this.col[i * 3 + 2] = clamp(c[2] * ao, 0, 255);
    this.alpha[i] = a;
  }
}

const tint = (c, amt = 8) => [
  clamp(Math.round(c[0] + jitter(amt)), 0, 255),
  clamp(Math.round(c[1] + jitter(amt)), 0, 255),
  clamp(Math.round(c[2] + jitter(amt)), 0, 255),
];

/* ---------------------------------------------------------------- 表面采样 */

/** 以 u/v 张成的平面片：每个采样点是一个贴合表面的扁高斯 */
function patch(cloud, origin, u, v, n, su, sv, spacing, thickness, colorFn, alpha = 0.88) {
  const nu = Math.max(1, Math.round(su / spacing));
  const nv = Math.max(1, Math.round(sv / spacing));
  const q = quatFromBasis(u, v, n);
  const du = su / nu;
  const dv = sv / nv;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = (i + 0.5) / nu - 0.5;
      const b = (j + 0.5) / nv - 0.5;
      const c = colorFn(a, b, i, j);
      if (!c) continue;
      const jx = jitter(du * 0.35), jy = jitter(dv * 0.35);
      const x = origin[0] + u[0] * (a * su + jx) + v[0] * (b * sv + jy);
      const y = origin[1] + u[1] * (a * su + jx) + v[1] * (b * sv + jy);
      const z = origin[2] + u[2] * (a * su + jx) + v[2] * (b * sv + jy);
      cloud.add(x, y, z, du * 0.62, dv * 0.62, Math.max(thickness, spacing * 0.72), q, tint(c), alpha);
    }
  }
}

/** 竖直圆柱侧壁（建筑外墙 / 柱 / 穹顶鼓座） */
function cylinderWall(cloud, cx, cz, r, y0, y1, spacing, colorFn, alpha = 0.88, thickness = 0.08) {
  const nTheta = Math.max(8, Math.ceil((TAU * r) / spacing));
  const nY = Math.max(1, Math.ceil((y1 - y0) / spacing));
  for (let i = 0; i < nTheta; i++) {
    const th = (i + 0.5) / nTheta * TAU;
    const u = [-Math.sin(th), 0, Math.cos(th)];
    const n = [Math.cos(th), 0, Math.sin(th)];
    const seg = (TAU * r) / nTheta;
    for (let j = 0; j < nY; j++) {
      const y = y0 + (j + 0.5) / nY * (y1 - y0);
      const c = colorFn(th, y, i, j);
      if (!c) continue;
      const q = quatFromBasis(u, [0, 1, 0], n);
      cloud.add(
        cx + n[0] * r + jitter(0.05), y, cz + n[2] * r + jitter(0.05),
        seg * 0.62, ((y1 - y0) / nY) * 0.62, Math.max(thickness, spacing * 0.72), q, tint(c), alpha,
      );
    }
  }
}

/** 半椭球穹顶 */
function domeShell(cloud, cx, cz, y0, radius, height, spacing, colorFn, alpha = 0.9) {
  const meridian = Math.ceil((Math.PI / 2) * radius / spacing);
  for (let m = 0; m < meridian; m++) {
    const phi = ((m + 0.5) / meridian) * (Math.PI / 2);
    const rr = radius * Math.sin(phi);
    const y = y0 + height * Math.cos(phi);
    const nTheta = Math.max(8, Math.ceil((TAU * rr) / spacing));
    for (let i = 0; i < nTheta; i++) {
      const th = (i + 0.5) / nTheta * TAU;
      const n = [Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th)];
      const u = [-Math.sin(th), 0, Math.cos(th)];
      const v = [
        n[1] * u[2] - n[2] * u[1],
        n[2] * u[0] - n[0] * u[2],
        n[0] * u[1] - n[1] * u[0],
      ];
      const c = colorFn(th, phi, y);
      if (!c) continue;
      const q = quatFromBasis(u, v, n);
      cloud.add(
        cx + n[0] * radius + jitter(0.04), y + jitter(0.04), cz + n[2] * radius + jitter(0.04),
        ((TAU * Math.max(rr, 1)) / nTheta) * 0.36, (Math.PI * radius / meridian) * 0.36, 0.08,
        q, tint(c), alpha,
      );
    }
  }
}

/** 水平圆盘 / 圆环 */
function disc(cloud, cx, cz, r0, r1, y, spacing, colorFn, alpha = 0.9) {
  const nR = Math.max(1, Math.ceil((r1 - r0) / spacing));
  const nA = Math.max(8, Math.ceil((TAU * Math.max(r1, 0.001)) / spacing));
  const q = quatFromBasis([1, 0, 0], [0, 0, 1], [0, 1, 0]);
  for (let j = 0; j < nR; j++) {
    const r = r0 + (j + 0.5) / nR * (r1 - r0);
    const nA2 = Math.max(6, Math.ceil((TAU * Math.max(r, 0.1)) / spacing));
    for (let i = 0; i < nA2; i++) {
      const th = (i + 0.5) / nA2 * TAU;
      const c = colorFn(th, r, i, j);
      if (!c) continue;
      cloud.add(cx + Math.cos(th) * r, y + jitter(0.02), cz + Math.sin(th) * r,
        (TAU * r) / nA2 * 0.62, (r1 - r0) / nR * 0.62, spacing * 0.72, q, tint(c), alpha);
    }
  }
  void nA;
}

function box(cloud, cx, cy, cz, sx, sy, sz, spacing, colorFn, alpha = 0.92) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  // 顶面
  patch(cloud, [cx, cy + hy, cz], [1, 0, 0], [0, 0, 1], [0, 1, 0], sx, sz, spacing, 0.08,
    () => colorFn('top'), alpha);
  // 四面
  patch(cloud, [cx, cy, cz + hz], [1, 0, 0], [0, 1, 0], [0, 0, 1], sx, sy, spacing, 0.08,
    () => colorFn('side'), alpha);
  patch(cloud, [cx, cy, cz - hz], [-1, 0, 0], [0, 1, 0], [0, 0, -1], sx, sy, spacing, 0.08,
    () => colorFn('side'), alpha);
  patch(cloud, [cx + hx, cy, cz], [0, 0, -1], [0, 1, 0], [1, 0, 0], sz, sy, spacing, 0.08,
    () => colorFn('side'), alpha);
  patch(cloud, [cx - hx, cy, cz], [0, 0, 1], [0, 1, 0], [-1, 0, 0], sz, sy, spacing, 0.08,
    () => colorFn('side'), alpha);
}

/* ---------------------------------------------------------------- 场景资产 */

const C = {
  plaster: [235, 228, 212],
  plasterShade: [214, 205, 188],
  stone: [206, 198, 180],
  stoneDark: [176, 168, 152],
  paving: [196, 188, 172],
  lawn: [86, 112, 58],
  lawnDark: [64, 88, 44],
  domeBlue: [46, 68, 100],
  domeBlueLite: [72, 102, 142],
  gold: [198, 158, 84],
  glass: [38, 46, 56],
  glassLite: [64, 84, 104],
  roofTile: [92, 100, 112],
  trunk: [82, 66, 52],
  leaf: [52, 76, 42],
  leafLite: [74, 102, 56],
  water: [96, 126, 132],
  umbrella: [146, 48, 40],
  carBody: [168, 172, 176],
};

function buildHotel(cloud) {
  /* 台基 */
  cylinderWall(cloud, 0, 0, 16.4, 0.05, 0.55, 0.3, () => C.stoneDark);
  disc(cloud, 0, 0, 0, 16.4, 0.55, 0.55, () => C.stone);
  cylinderWall(cloud, 0, 0, 14.6, 0.55, 1.5, 0.28, () => C.stone);
  disc(cloud, 0, 0, 0, 14.6, 1.5, 0.5, () => C.plasterShade);

  /* 主圆厅外墙（底层，带拱窗） */
  cylinderWall(cloud, 0, 0, 12.4, 1.5, 9.9, 0.16, (th, y) => {
    if (y > 9.2) return C.plaster;
    const seg = ((th / DEG) % 22.5);
    if (seg > 5 && seg < 17) return y > 3 && y < 8.4 ? C.glass : C.plaster;
    return C.plaster;
  });

  /* 柱廊 */
  const cols = 16;
  for (let i = 0; i < cols; i++) {
    const th = (i / cols) * TAU;
    const r = 13.3;
    cylinderWall(cloud, Math.cos(th) * r, Math.sin(th) * r, 0.62, 1.5, 10.1, 0.2,
      (_, y) => (y < 1.9 || y > 9.7 ? C.stoneDark : C.stone));
    disc(cloud, Math.cos(th) * r, Math.sin(th) * r, 0, 0.62, 10.12, 0.22, () => C.stone);
  }

  /* 檐口 + 二层鼓座 */
  cylinderWall(cloud, 0, 0, 14.2, 10.1, 11.1, 0.16, () => C.stone);
  disc(cloud, 0, 0, 12.4, 14.2, 11.1, 0.4, () => C.stone);
  cylinderWall(cloud, 0, 0, 10.3, 11.1, 14.6, 0.16, (th, y) => {
    const seg = ((th / DEG) % 30);
    if (seg > 8 && seg < 22 && y > 11.6 && y < 14.2) return (y > 12.9 ? C.glassLite : C.glass);
    return y > 14.2 ? C.gold : C.plaster;
  });
  disc(cloud, 0, 0, 0, 10.3, 14.6, 0.5, () => C.stone);

  /* 穹顶 */
  domeShell(cloud, 0, 0, 14.6, 11.7, 10.6, 0.155, (th, phi, y) => {
    const rib = ((th / DEG) % 15);
    if (y < 15.4) return C.gold;
    if (phi < 0.1) return C.domeBlueLite;
    if (rib < 1.6) return C.domeBlueLite;
    return C.domeBlue;
  });

  /* 采光亭 + 铜像 */
  cylinderWall(cloud, 0, 0, 1.9, 25.2, 27.4, 0.16, () => C.plaster);
  domeShell(cloud, 0, 0, 27.4, 2.1, 1.5, 0.14, () => C.gold);
  // 雕像：锥体 + 球头
  for (let i = 0; i < 220; i++) {
    const t = i / 220;
    const y = 28.9 + t * 2.4;
    const r = (1 - t) * 0.55 + 0.06;
    const th = t * 18;
    const q = quatFromBasis([1, 0, 0], [0, 0, 1], [0, 1, 0]);
    cloud.add(Math.cos(th) * r, y, Math.sin(th) * r, 0.16, 0.16, 0.12, q, tint(C.stone));
  }
  for (let i = 0; i < 90; i++) {
    const th = (i / 90) * TAU;
    const ph = (i / 90) * Math.PI;
    const q = quatFromBasis([1, 0, 0], [0, 0, 1], [0, 1, 0]);
    cloud.add(Math.cos(th) * Math.sin(ph) * 0.28, 31.5 + Math.cos(ph) * 0.3, Math.sin(th) * Math.sin(ph) * 0.28,
      0.12, 0.12, 0.1, q, tint(C.stoneDark));
  }

  /* 弧形客房翼：θ ∈ [118°, 242°] */
  const wingA0 = 118 * DEG;
  const wingA1 = 242 * DEG;
  const rIn = 25.2;
  const rOut = 31.8;
  const wingH = 15.6;
  const span = wingA1 - wingA0;

  cylinderWall(cloud, 0, 0, rIn, 0, wingH, 0.16, (th, y) => {
    if (th < wingA0 || th > wingA1) return null;
    if (y > wingH - 0.7) return C.stone;
    const floorH = 3.6;
    const fy = y % floorH;
    // 每层一排窗
    if (fy > 0.9 && fy < 2.6 && y > 2.2 && y < wingH - 1) {
      const local = ((th - wingA0) / DEG) % 6.5;
      if (local > 1.0 && local < 5.4) {
        return fy > 1.7 ? C.glassLite : C.glass;
      }
    }
    if (y < 0.9) return C.plasterShade;
    return C.plaster;
  });

  cylinderWall(cloud, 0, 0, rOut, 0, wingH, 0.18, (th) => (th < wingA0 || th > wingA1 ? null : C.plasterShade));
  disc(cloud, 0, 0, rIn, rOut, wingH, 0.2, (th) => (th < wingA0 || th > wingA1 ? null : C.roofTile));

  // 端头山墙
  for (const a of [wingA0, wingA1]) {
    const u = [-Math.sin(a), 0, Math.cos(a)];
    const n = [Math.cos(a), 0, Math.sin(a)];
    const mid = [(rIn + rOut) / 2 * n[0], wingH / 2, (rIn + rOut) / 2 * n[2]];
    patch(cloud, mid, u, [0, 1, 0], n, rOut - rIn, wingH, 0.26, 0.1, () => C.plaster);
  }

  /* 庭院：铺装 / 草坪 / 环形步道 / 喷泉 */
  disc(cloud, 0, 4, 0, 30, 0.06, 0.42, (th, r) => {
    if (r < 17.0) return null;
    return r > 19.4 && r < 22.6 ? C.stoneDark : C.paving;
  });
  disc(cloud, 0, 4, 0, 16.5, 0.12, 0.26, (th, r) => (r < 3.6 ? null : (r > 15.6 ? C.stone : C.lawn)));
  disc(cloud, 0, 4, 15.4, 17.0, 0.14, 0.3, () => C.stone);

  // 喷泉
  cylinderWall(cloud, 0, 8, 3.4, 0.12, 0.95, 0.24, () => C.stone);
  disc(cloud, 0, 8, 0, 3.4, 0.95, 0.3, (th, r) => (r > 3.0 ? C.stone : C.water));
  cylinderWall(cloud, 0, 8, 0.55, 0.95, 2.1, 0.18, () => C.stone);
  disc(cloud, 0, 8, 0, 1.15, 2.15, 0.22, () => C.stone);

  /* 树木 */
  const tree = (x, z, h, spread) => {
    const trunkQ = quatFromBasis([1, 0, 0], [0, 0, 1], [0, 1, 0]);
    for (let i = 0; i < 26; i++) {
      const t = i / 26;
      cloud.add(x + jitter(0.06), 0.2 + t * h * 0.55, z + jitter(0.06), 0.22, 0.22, 0.22, trunkQ, tint(C.trunk));
    }
    const blobs = 3 + Math.floor(rnd() * 3);
    for (let b = 0; b < blobs; b++) {
      const bx = x + jitter(spread * 0.5);
      const bz = z + jitter(spread * 0.5);
      const by = h * 0.62 + rnd() * h * 0.42;
      const br = spread * (0.55 + rnd() * 0.4);
      const n = Math.round(br * br * 26);
      for (let i = 0; i < n; i++) {
        const th = rnd() * TAU;
        const ph = Math.acos(1 - 2 * rnd());
        const rr = br * (0.72 + rnd() * 0.3);
        const nx = Math.sin(ph) * Math.cos(th);
        const ny = Math.cos(ph);
        const nz = Math.sin(ph) * Math.sin(th);
        const nn = norm([nx, ny, nz]);
        let tu = norm(cross([0, 1, 0], nn));
        if (!Number.isFinite(tu[0]) || Math.hypot(tu[0], tu[1], tu[2]) < 0.1) tu = [1, 0, 0];
        const tv = cross(nn, tu);
        const q = quatFromBasis(tu, tv, nn);
        cloud.add(bx + nx * rr, by + ny * rr, bz + nz * rr,
          br * 0.22, br * 0.22, br * 0.18, q,
          tint(rnd() > 0.5 ? C.leaf : C.leafLite, 14), 0.86);
      }
    }
  };

  const treePositions = [
    [-19, 17, 7, 2.5], [-15, 24, 8, 3], [-6, 27, 7.5, 2.6], [7, 27, 8, 2.8],
    [16, 23, 7, 2.4], [20, 14, 8.5, 3], [-22, 8, 7, 2.6], [22, -2, 6.5, 2.4],
    [-20, -6, 7.5, 2.8], [13, -18, 8, 2.8], [-11, -20, 7, 2.6], [25, 25, 8, 3],
    [-26, 26, 7.5, 2.8], [2, 33, 6.5, 2.4],
  ];
  for (const [x, z, h, s] of treePositions) tree(x, z, h, s);

  /* 遮阳伞 + 躺椅 */
  for (const [x, z] of [[-16, 12], [-13, 14.5], [15, 11], [12.5, 14], [0, 20]]) {
    disc(cloud, x, z, 0, 1.55, 2.35, 0.22, () => C.umbrella, 0.95);
    for (let i = 0; i < 10; i++) {
      cloud.add(x, 0.15 + i * 0.22, z, 0.06, 0.11, 0.06,
        quatFromBasis([1, 0, 0], [0, 0, 1], [0, 1, 0]), tint(C.stoneDark));
    }
  }

  /* 停车区与车辆 */
  box(cloud, 34, 0.35, 26, 16, 0.7, 9, 1.1, (f) => (f === 'top' ? C.paving : C.stoneDark));
  const cars = [[30, 24], [33, 24], [36, 24], [30, 28], [33, 28]];
  for (const [x, z] of cars) {
    const col = [Math.round(150 + rnd() * 60), Math.round(152 + rnd() * 50), Math.round(150 + rnd() * 55)];
    box(cloud, x, 0.75, z, 4.2, 1.1, 1.9, 0.42, (f) => (f === 'top' ? col : C.carBody));
    box(cloud, x - 0.2, 1.45, z, 2.2, 0.9, 1.6, 0.4, (f) => (f === 'top' ? col : C.glass));
  }

  /* 入口台阶 */
  for (let i = 0; i < 5; i++) {
    box(cloud, 0, 0.09 + i * 0.16, 20.5, 12 - i * 0.4, 0.18, 1.6, 0.5, () => C.stone);
  }
}

/* ------------------------------------------------------------ 点云 -> 文件 */

function writeSplats(cloud, tiles) {
  const dir = path.join(OUT, 'splat');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(OUT, 'splat', 'lod0'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'splat', 'lod1'), { recursive: true });

  const entries = [];
  let total = 0;
  for (const t of tiles) {
    for (const lod of [0, 1]) {
      const idx = [];
      for (let i = 0; i < cloud.n; i++) {
        if (t.contains(cloud.pos[i * 3], cloud.pos[i * 3 + 2])) {
          // LOD0 用确定性稀疏采样，保持空间均匀
          if (lod === 0 && hash01(i) > 0.17) continue;
          idx.push(i);
        }
      }
      if (!idx.length) continue;
      const buf = Buffer.alloc(idx.length * 32);
      let minx = 1e9, miny = 1e9, minz = 1e9, maxx = -1e9, maxy = -1e9, maxz = -1e9;
      let o = 0;
      for (const i of idx) {
        const x = cloud.pos[i * 3], y = cloud.pos[i * 3 + 1], z = cloud.pos[i * 3 + 2];
        buf.writeFloatLE(x, o); buf.writeFloatLE(y, o + 4); buf.writeFloatLE(z, o + 8);
        buf.writeFloatLE(cloud.scale[i * 3], o + 12);
        buf.writeFloatLE(cloud.scale[i * 3 + 1], o + 16);
        buf.writeFloatLE(cloud.scale[i * 3 + 2], o + 20);
        buf[o + 24] = cloud.col[i * 3];
        buf[o + 25] = cloud.col[i * 3 + 1];
        buf[o + 26] = cloud.col[i * 3 + 2];
        buf[o + 27] = Math.round(clamp(cloud.alpha[i], 0, 1) * 255);
        buf[o + 28] = Math.round(clamp(cloud.rot[i * 4], -1, 1) * 127.5 + 127.5);
        buf[o + 29] = Math.round(clamp(cloud.rot[i * 4 + 1], -1, 1) * 127.5 + 127.5);
        buf[o + 30] = Math.round(clamp(cloud.rot[i * 4 + 2], -1, 1) * 127.5 + 127.5);
        buf[o + 31] = Math.round(clamp(cloud.rot[i * 4 + 3], -1, 1) * 127.5 + 127.5);
        o += 32;
        minx = Math.min(minx, x); miny = Math.min(miny, y); minz = Math.min(minz, z);
        maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); maxz = Math.max(maxz, z);
      }
      const name = `${t.key}_l${lod}.splat`;
      fs.writeFileSync(path.join(dir, `lod${lod}`, name), buf);
      entries.push({
        url: `splat/lod${lod}/${name}`,
        lod,
        key: t.key,
        min: [round2(minx), round2(miny), round2(minz)],
        max: [round2(maxx), round2(maxy), round2(maxz)],
        bytes: buf.length,
        count: idx.length,
      });
      total += idx.length;
    }
  }
  return { entries, total };
}

const hash01 = (i) => {
  let x = i + 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
};
const round2 = (v) => Math.round(v * 100) / 100;

/* --------------------------------------------------------- 倾斜摄影 3D Tiles */

function terrainHeight(x, z) {
  const d = Math.hypot(x * 0.9, z);
  let h = -0.9;
  h += Math.sin(x * 0.012) * Math.cos(z * 0.014) * 4.2;
  h += Math.sin(x * 0.031 + 1.7) * Math.cos(z * 0.024 + 0.4) * 1.6;
  h += Math.sin(x * 0.071 + 0.3) * Math.cos(z * 0.062 + 2.1) * 0.5;
  const flat = smoothstep(46, 150, d);
  h = -0.9 + (h + 0.9) * flat;
  // 西侧丘陵
  h += smoothstep(-150, -280, x) * (26 + Math.sin(z * 0.02) * 8);
  // 东侧海岸与海面
  const coast = smoothstep(120, 168, x);
  h = mix(h, -3.2, coast);
  return h;
}

function terrainColor(x, z, h) {
  const sea = clamp((x - 120) / 48, 0, 1);
  if (sea > 0.55) return [38 + Math.round(10 * Math.sin(x * 0.05)), 74, 96];
  if (sea > 0.1) return [196, 186, 158]; // 沙滩
  if (x < -150) return [58, 74, 48]; // 山林
  const road = Math.min(Math.abs(z - 12), Math.abs(x + 96), Math.abs(z + 78));
  if (road < 4.5) return [92, 94, 96];
  if (road < 6) return [176, 172, 160];
  if (h > 8) return [78, 92, 58];
  return [88, 104, 62];
}

function makeTerrainMesh(x0, z0, size, seg, withCity, withRoadDetail) {
  const n = seg + 1;
  const pos = [];
  const nrm = [];
  const col = [];
  const idx = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + (i / seg) * size;
      const z = z0 + (j / seg) * size;
      const h = terrainHeight(x, z);
      pos.push(x, h, z);
      const hx = terrainHeight(x + 2, z) - terrainHeight(x - 2, z);
      const hz = terrainHeight(x, z + 2) - terrainHeight(x, z - 2);
      const nn = norm([-hx, 8, -hz]);
      nrm.push(nn[0], nn[1], nn[2]);
      const c = terrainColor(x, z, h);
      col.push(c[0], c[1], c[2]);
    }
  }
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  if (withCity || withRoadDetail) {
    // 简易城市体块：红瓦屋顶，按网格随机布置
    const r = mulberry32(7077);
    for (let bx = -520; bx < -80; bx += 30) {
      for (let bz = -420; bz < 380; bz += 30) {
        if (r() > 0.62) continue;
        const cx = bx + r() * 10;
        const cz = bz + r() * 10;
        if (cx < x0 || cx > x0 + size || cz < z0 || cz > z0 + size) continue;
        const w = 9 + r() * 8;
        const d = 9 + r() * 8;
        const h = 5 + r() * 13;
        const baseY = terrainHeight(cx, cz);
        addBuilding(pos, nrm, col, idx, cx, baseY, cz, w, h, d, r);
      }
    }
  }
  return {
    pos: new Float32Array(pos),
    nrm: new Float32Array(nrm),
    col: new Uint8Array(col),
    idx: new Uint32Array(idx),
  };
}

function addBuilding(pos, nrm, col, idx, cx, baseY, cz, w, h, d, r) {
  const corners = [
    [cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2],
    [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2],
  ];
  const wallCol = [188 + Math.round(r() * 26), 182 + Math.round(r() * 24), 170 + Math.round(r() * 22)];
  const roofCol = [148 + Math.round(r() * 30), 84 + Math.round(r() * 24), 66 + Math.round(r() * 20)];

  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const nn = norm([dz, 0, -dx]);
    const base = pos.length / 3;
    pos.push(a[0], baseY, a[1], b[0], baseY, b[1], a[0], baseY + h, a[1], b[0], baseY + h, b[1]);
    for (let k = 0; k < 4; k++) nrm.push(nn[0], nn[1], nn[2]);
    for (let k = 0; k < 4; k++) col.push(wallCol[0], wallCol[1], wallCol[2]);
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }

  const rb = pos.length / 3;
  const top = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  for (const [sx, sz] of top) {
    pos.push(cx + sx * w, baseY + h, cz + sz * d);
    nrm.push(0, 1, 0);
    col.push(roofCol[0], roofCol[1], roofCol[2]);
  }
  idx.push(rb, rb + 2, rb + 1, rb, rb + 3, rb + 2);
}

function glbFromMesh(mesh) {
  const { pos, nrm, col, idx } = mesh;
  const parts = [];
  let offset = 0;
  const push = (buf) => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { parts.push(Buffer.alloc(pad)); offset += pad; }
    parts.push(buf);
    offset += buf.length;
    return offset - buf.length;
  };
  const oPos = push(Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength));
  const oNrm = push(Buffer.from(nrm.buffer, nrm.byteOffset, nrm.byteLength));
  const oCol = push(Buffer.from(col.buffer, col.byteOffset, col.byteLength));
  const oIdx = push(Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength));
  const bin = Buffer.concat(parts);

  let minx = 1e9, miny = 1e9, minz = 1e9, maxx = -1e9, maxy = -1e9, maxz = -1e9;
  for (let i = 0; i < pos.length; i += 3) {
    minx = Math.min(minx, pos[i]); maxx = Math.max(maxx, pos[i]);
    miny = Math.min(miny, pos[i + 1]); maxy = Math.max(maxy, pos[i + 1]);
    minz = Math.min(minz, pos[i + 2]); maxz = Math.max(maxz, pos[i + 2]);
  }

  const json = {
    asset: { version: '2.0', generator: 'four-dimension-space/gen-scene' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0, mode: 4 }] }],
    materials: [{
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
      doubleSided: true,
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: [minx, miny, minz], max: [maxx, maxy, maxz] },
      { bufferView: 1, componentType: 5126, count: nrm.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5121, normalized: true, count: col.length / 3, type: 'VEC3' },
      { bufferView: 3, componentType: 5125, count: idx.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: oPos, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: oNrm, byteLength: nrm.byteLength, target: 34962 },
      { buffer: 0, byteOffset: oCol, byteLength: col.byteLength, target: 34962 },
      { buffer: 0, byteOffset: oIdx, byteLength: idx.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  };

  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}

function buildTileset() {
  const dir = path.join(OUT, 'tiles');
  fs.mkdirSync(dir, { recursive: true });
  const SIZE = 1200;
  const half = SIZE / 2;
  const quads = [];
  const qs = [
    [-half, -half], [0, -half], [-half, 0], [0, 0],
  ];
  let n = 0;
  for (const [qx, qz] of qs) {
    const qsize = SIZE / 2;
    // 粗层
    const coarse = makeTerrainMesh(qx, qz, qsize, 22, false, false);
    fs.writeFileSync(path.join(dir, `q${n}_coarse.glb`), glbFromMesh(coarse));
    // 4 个精细子瓦片
    const children = [];
    const sub = qsize / 2;
    for (let sz = 0; sz < 2; sz++) {
      for (let sx = 0; sx < 2; sx++) {
        const x = qx + sx * sub;
        const z = qz + sz * sub;
        const fine = makeTerrainMesh(x, z, sub, 30, true, true);
        const name = `q${n}_${sx}${sz}.glb`;
        fs.writeFileSync(path.join(dir, name), glbFromMesh(fine));
        children.push({
          boundingVolume: {
            box: [x + sub / 2, 6, z + sub / 2, sub / 2, 0, 0, 0, 24, 0, 0, 0, sub / 2],
          },
          geometricError: 18,
          content: { uri: name },
        });
      }
    }
    quads.push({
      boundingVolume: {
        box: [qx + qsize / 2, 6, qz + qsize / 2, qsize / 2, 0, 0, 0, 30, 0, 0, 0, qsize / 2],
      },
      geometricError: 70,
      content: { uri: `q${n}_coarse.glb` },
      children,
    });
    n++;
  }

  const tileset = {
    asset: { version: '1.0', generator: 'four-dimension-space/gen-scene' },
    geometricError: 240,
    root: {
      boundingVolume: { box: [0, 8, 0, SIZE / 2, 0, 0, 0, 60, 0, 0, 0, SIZE / 2] },
      geometricError: 240,
      refine: 'REPLACE',
      children: quads,
    },
  };
  fs.writeFileSync(path.join(dir, 'tileset.json'), JSON.stringify(tileset, null, 2));
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('[gen] 构建 3DGS 场景…');
  const cloud = new Cloud(900000);
  buildHotel(cloud);
  console.log(`[gen] splat 原始点数: ${cloud.n}`);

  // 9 块 XZ 网格
  const B = 44;
  const step = (B * 2) / 3;
  const tiles = [];
  for (let iz = 0; iz < 3; iz++) {
    for (let ix = 0; ix < 3; ix++) {
      const x0 = -B + ix * step;
      const z0 = -B + iz * step;
      tiles.push({
        key: `t${ix}${iz}`,
        contains: (x, z) => x >= x0 && x < x0 + step && z >= z0 && z < z0 + step,
        min: [x0, -2, z0],
        max: [x0 + step, 34, z0 + step],
      });
    }
  }
  const { entries, total } = writeSplats(cloud, tiles);
  console.log(`[gen] splat 分块写入: ${entries.length} 个文件 / ${total} 点`);

  console.log('[gen] 构建倾斜摄影瓦片…');
  buildTileset();

  const manifest = {
    version: 1,
    scene: {
      id: 'yuehua-hotel',
      name: '四维空间',
      subtitle: 'FOUR-DIMENSION SPACE',
      location: '福建 · 东山岛',
      anchor: { label: '悦华酒店 · 270° 海景', detail: 'OBJ-001 · RECONSTRUCTED' },
      tags: ['看海窗景', '1987 老宅改造', '深夜渔火'],
    },
    camera: {
      target: [0, 4, 10],
      distance: 93,
      yaw: 0.12,
      pitch: 0.7,
      fov: 55,
      introFrom: { distance: 220, pitch: 1.02, yawOffset: 0.5 },
    },
    splat: { tiles: entries },
    tileset: 'tiles/tileset.json',
    hotspots: [
      { id: 'hotel', label: '悦华酒店 · 270° 海景', position: [0, 26.5, 0], kind: 'space' },
      { id: 'court', label: '中央庭院 · 喷泉', position: [0, 2.2, 8], kind: 'poi' },
      { id: 'wing', label: '1987 老宅客房翼', position: [-20, 9, -14], kind: 'poi' },
    ],
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const bytes = entries.reduce((a, e) => a + e.bytes, 0);
  console.log(`[gen] 完成：manifest.json / splat ${(bytes / 1048576).toFixed(2)}MB / tiles`);
}

main();
