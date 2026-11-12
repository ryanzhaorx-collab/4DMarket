import { clamp, mat4, mat4LookAt, mat4Multiply, mat4Perspective, type Mat4, type Vec3 } from './math';

/** 轨道相机：yaw/pitch 环绕目标点，距离可缩放。所有姿态都由这三个量唯一确定，便于做过渡动画。 */
export class OrbitCamera {
  target: Vec3 = [0, 6, 0];
  distance = 90;
  /** 水平角（弧度），0 = 相机位于 +Z 侧 */
  yaw = 0;
  /** 仰角（弧度），正值表示相机在目标上方 */
  pitch = 0.55;
  fov = 45;
  near = 0.4;
  far = 4000;

  readonly view: Mat4 = mat4();
  readonly proj: Mat4 = mat4();
  readonly viewProj: Mat4 = mat4();
  readonly eye: Vec3 = [0, 0, 0];
  readonly forward: Vec3 = [0, 0, -1];

  private aspect = 1;

  setViewport(width: number, height: number) {
    this.aspect = width / Math.max(height, 1);
  }

  get aspectRatio() {
    return this.aspect;
  }

  update() {
    const cp = Math.cos(this.pitch);
    this.eye[0] = this.target[0] + this.distance * cp * Math.sin(this.yaw);
    this.eye[1] = this.target[1] + this.distance * Math.sin(this.pitch);
    this.eye[2] = this.target[2] + this.distance * cp * Math.cos(this.yaw);

    mat4LookAt(this.view, this.eye, this.target, [0, 1, 0]);
    mat4Perspective(this.proj, (this.fov * Math.PI) / 180, this.aspect, this.near, this.far);
    mat4Multiply(this.viewProj, this.proj, this.view);

    const dx = this.target[0] - this.eye[0];
    const dy = this.target[1] - this.eye[1];
    const dz = this.target[2] - this.eye[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    this.forward[0] = dx / l;
    this.forward[1] = dy / l;
    this.forward[2] = dz / l;
  }

  /** 焦距（像素），与投影矩阵的 fov 保持一致 */
  focalPixels(viewportHeight: number) {
    return viewportHeight * 0.5 / Math.tan((this.fov * Math.PI) / 360);
  }

  /** 世界坐标 -> CSS 像素坐标 */
  project(p: Vec3, cssWidth: number, cssHeight: number): { x: number; y: number; visible: boolean } {
    const m = this.viewProj;
    const x = p[0], y = p[1], z = p[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (w <= 0.0001) return { x: 0, y: 0, visible: false };
    const nx = cx / w;
    const ny = cy / w;
    const nz = cz / w;
    return {
      x: (nx * 0.5 + 0.5) * cssWidth,
      y: (-ny * 0.5 + 0.5) * cssHeight,
      visible: nz > -1 && nz < 1,
    };
  }

  /** 屏幕点 -> 世界射线方向（用于点选） */
  rayDirection(sx: number, sy: number, cssWidth: number, cssHeight: number): Vec3 {
    const nx = (sx / cssWidth) * 2 - 1;
    const ny = 1 - (sy / cssHeight) * 2;
    const t = Math.tan((this.fov * Math.PI) / 360);
    const dir: Vec3 = [nx * t * this.aspect, ny * t, -1];
    // 用 view 的逆旋转（view 是正交旋转 + 平移，取左上 3x3 转置）
    const v = this.view;
    const rx = v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2];
    const ry = v[4] * dir[0] + v[5] * dir[1] + v[6] * dir[2];
    const rz = v[8] * dir[0] + v[9] * dir[1] + v[10] * dir[2];
    const l = Math.hypot(rx, ry, rz) || 1;
    return [rx / l, ry / l, rz / l];
  }
}

export const clamp02 = (v: number) => clamp(v, 0, 1);
