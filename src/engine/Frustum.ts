import type { Mat4 } from './math';

/** 从 viewProj 提取 6 个视锥平面，用于包围球剔除（每块每帧一次，成本可忽略）。 */
export class Frustum {
  private planes = new Float32Array(24);

  update(m: Mat4) {
    const f = this.planes;
    const rows: [number, number, number, number][] = [
      [m[0] + m[3], m[4] + m[7], m[8] + m[11], m[12] + m[15]],
      [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],
      [m[1] + m[3], m[5] + m[7], m[9] + m[11], m[13] + m[15]],
      [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],
      [m[2] + m[3], m[6] + m[7], m[10] + m[11], m[14] + m[15]],
      [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],
    ];
    for (let i = 0; i < 6; i++) {
      const r = rows[i];
      const l = Math.hypot(r[0], r[1], r[2]) || 1;
      f[i * 4] = r[0] / l;
      f[i * 4 + 1] = r[1] / l;
      f[i * 4 + 2] = r[2] / l;
      f[i * 4 + 3] = r[3] / l;
    }
  }

  sphereVisible(x: number, y: number, z: number, r: number): boolean {
    const f = this.planes;
    for (let i = 0; i < 6; i++) {
      if (f[i * 4] * x + f[i * 4 + 1] * y + f[i * 4 + 2] * z + f[i * 4 + 3] < -r) return false;
    }
    return true;
  }
}
