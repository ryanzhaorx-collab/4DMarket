import { mat4, type Mat4 } from './math';
import type { LayerTransform, SplatPayload } from './types';

/**
 * 模型级对齐：平移 + 绕 X/Y/Z 三轴旋转 + 等比缩放。
 * 旋转顺序固定为 R = Rz · Ry · Rx（先绕 X，再 Y，最后 Z），与常见 DCC 的 XYZ 欧拉一致。
 */

export function isIdentity(t?: LayerTransform | null): boolean {
  if (!t) return true;
  const [x = 0, y = 0, z = 0] = t.translate ?? [];
  return (
    x === 0 && y === 0 && z === 0 &&
    (t.rotateX ?? 0) === 0 && (t.rotateY ?? 0) === 0 && (t.rotateZ ?? 0) === 0 &&
    (t.scale ?? 1) === 1
  );
}

type Quat = [number, number, number, number];

function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

interface Rot {
  /** R 的行主序元素 */
  r11: number; r12: number; r13: number;
  r21: number; r22: number; r23: number;
  r31: number; r32: number; r33: number;
  q: Quat;
}

const D2R = Math.PI / 180;

function composeRotation(t: LayerTransform): Rot {
  const a = (t.rotateX ?? 0) * D2R;
  const b = (t.rotateY ?? 0) * D2R;
  const g = (t.rotateZ ?? 0) * D2R;
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cg = Math.cos(g), sg = Math.sin(g);

  // R = Rz · Ry · Rx
  const r11 = cg * cb;
  const r12 = cg * sb * sa - sg * ca;
  const r13 = cg * sb * ca + sg * sa;
  const r21 = sg * cb;
  const r22 = sg * sb * sa + cg * ca;
  const r23 = sg * sb * ca - cg * sa;
  const r31 = -sb;
  const r32 = cb * sa;
  const r33 = cb * ca;

  // q = qz ⊗ qy ⊗ qx
  const qx: Quat = [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
  const qy: Quat = [0, Math.sin(b / 2), 0, Math.cos(b / 2)];
  const qz: Quat = [0, 0, Math.sin(g / 2), Math.cos(g / 2)];
  const q = quatMul(qz, quatMul(qy, qx));

  return { r11, r12, r13, r21, r22, r23, r31, r32, r33, q };
}

/** 直接就地变换 splat 点云（位置 / 尺度 / 四元数），并重算包围盒 */
export function applySplatTransform(p: SplatPayload, t?: LayerTransform | null): void {
  if (isIdentity(t) || !t) return;
  const s = t.scale ?? 1;
  const tx = t.translate?.[0] ?? 0;
  const ty = t.translate?.[1] ?? 0;
  const tz = t.translate?.[2] ?? 0;
  const { r11, r12, r13, r21, r22, r23, r31, r32, r33, q } = composeRotation(t);
  const [qx1, qy1, qz1, qw1] = q;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < p.count; i++) {
    const x = p.pos[i * 3] * s;
    const y = p.pos[i * 3 + 1] * s;
    const z = p.pos[i * 3 + 2] * s;
    const nx = r11 * x + r12 * y + r13 * z + tx;
    const ny = r21 * x + r22 * y + r23 * z + ty;
    const nz = r31 * x + r32 * y + r33 * z + tz;
    p.pos[i * 3] = nx;
    p.pos[i * 3 + 1] = ny;
    p.pos[i * 3 + 2] = nz;
    if (nx < minX) minX = nx;
    if (nx > maxX) maxX = nx;
    if (ny < minY) minY = ny;
    if (ny > maxY) maxY = ny;
    if (nz < minZ) minZ = nz;
    if (nz > maxZ) maxZ = nz;

    p.scale[i * 3] *= s;
    p.scale[i * 3 + 1] *= s;
    p.scale[i * 3 + 2] *= s;

    // 左乘组合四元数：q' = qAlign ⊗ q
    const bx = p.rot[i * 4], by = p.rot[i * 4 + 1], bz = p.rot[i * 4 + 2], bw = p.rot[i * 4 + 3];
    p.rot[i * 4] = qw1 * bx + qx1 * bw + qy1 * bz - qz1 * by;
    p.rot[i * 4 + 1] = qw1 * by - qx1 * bz + qy1 * bw + qz1 * bx;
    p.rot[i * 4 + 2] = qw1 * bz + qx1 * by - qy1 * bx + qz1 * bw;
    p.rot[i * 4 + 3] = qw1 * bw - qx1 * bx - qy1 * by - qz1 * bz;
  }

  p.min = [minX, minY, minZ];
  p.max = [maxX, maxY, maxZ];
}

/** 同一套变换的矩阵形式（给 3D Tiles 用，列主序） */
export function transformMatrix(t?: LayerTransform | null): Mat4 {
  const m = mat4();
  if (!t || isIdentity(t)) return m;
  const s = t.scale ?? 1;
  const { r11, r12, r13, r21, r22, r23, r31, r32, r33 } = composeRotation(t);
  m[0] = s * r11; m[1] = s * r21; m[2] = s * r31;
  m[4] = s * r12; m[5] = s * r22; m[6] = s * r32;
  m[8] = s * r13; m[9] = s * r23; m[10] = s * r33;
  m[12] = t.translate?.[0] ?? 0;
  m[13] = t.translate?.[1] ?? 0;
  m[14] = t.translate?.[2] ?? 0;
  return m;
}
