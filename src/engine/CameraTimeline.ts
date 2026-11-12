import type { Vec3 } from './math';

/** 缓动函数：抽屉这类动效的关键是「末段收得住」，所以默认给 outCubic 而不是线性。 */
export type EaseName = 'linear' | 'inOutCubic' | 'outCubic' | 'inCubic' | 'outExpo' | 'outBack';

/**
 * 一个镜头关键帧。所有字段相对「上一个关键帧」缺省继承，
 * 所以只需要写变化的量，比如只给它 yaw 就是纯环绕。
 */
export interface CameraKey {
  /** 相对时间轴起点的秒数，必须递增 */
  t: number;
  target?: Vec3;
  distance?: number;
  yaw?: number;
  pitch?: number;
  fov?: number;
  /** 从上一帧过渡到这一帧用的缓动 */
  ease?: EaseName;
}

const EASE: Record<EaseName, (x: number) => number> = {
  linear: (x) => x,
  inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  outCubic: (x) => 1 - Math.pow(1 - x, 3),
  inCubic: (x) => x * x * x,
  outExpo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  outBack: (x) => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2),
};

export interface CameraState {
  target: Vec3;
  distance: number;
  yaw: number;
  pitch: number;
  fov: number;
}

/** 把角度差折算到 [-π, π]，避免环绕时走远路 */
function shortestDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * 多段镜头时间轴：给一串关键帧，按时间插值机位。
 * 抽屉那种「拉近 → 停一拍 → 穿墙」的分段节奏靠它表达。
 */
export class CameraTimeline {
  private keys: CameraKey[] = [];
  private t0 = 0;
  private duration = 0;
  private onDone: (() => void) | null = null;
  private active = false;

  get playing() {
    return this.active;
  }

  get total() {
    return this.duration;
  }

  get elapsed() {
    return this.active ? (performance.now() - this.t0) / 1000 : -1;
  }

  /** @returns 时间轴总时长（秒） */
  play(keys: CameraKey[], onDone?: () => void): number {
    if (!keys.length) return 0;
    this.keys = [...keys].sort((a, b) => a.t - b.t);
    this.t0 = performance.now();
    this.duration = this.keys[this.keys.length - 1].t;
    this.onDone = onDone ?? null;
    this.active = true;
    return this.duration;
  }

  cancel() {
    this.active = false;
    this.keys = [];
    this.onDone = null;
  }

  /**
   * 求 t 秒时的机位。时间轴结束时返回最后一帧。
   */
  sample(t: number, base: CameraState): CameraState {
    const keys = this.keys;
    if (!keys.length) return base;
    if (t <= keys[0].t) {
      const k = keys[0];
      return {
        target: k.target ?? base.target,
        distance: k.distance ?? base.distance,
        yaw: k.yaw ?? base.yaw,
        pitch: k.pitch ?? base.pitch,
        fov: k.fov ?? base.fov,
      };
    }
    // 找所在区间
    let i = 0;
    while (i < keys.length - 1 && t > keys[i + 1].t) i++;
    if (i >= keys.length - 1) {
      const k = keys[keys.length - 1];
      return {
        target: k.target ?? base.target,
        distance: k.distance ?? base.distance,
        yaw: k.yaw ?? base.yaw,
        pitch: k.pitch ?? base.pitch,
        fov: k.fov ?? base.fov,
      };
    }
    const a = keys[i];
    const b = keys[i + 1];
    const span = Math.max(1e-4, b.t - a.t);
    const raw = Math.min(1, Math.max(0, (t - a.t) / span));
    const e = (EASE[b.ease ?? 'inOutCubic'])(raw);

    const aTarget = a.target ?? base.target;
    const bTarget = b.target ?? aTarget;
    const aYaw = a.yaw ?? base.yaw;
    const bYaw = b.yaw ?? aYaw;
    return {
      target: [
        aTarget[0] + (bTarget[0] - aTarget[0]) * e,
        aTarget[1] + (bTarget[1] - aTarget[1]) * e,
        aTarget[2] + (bTarget[2] - aTarget[2]) * e,
      ],
      distance: (a.distance ?? base.distance) + ((b.distance ?? a.distance ?? base.distance) - (a.distance ?? base.distance)) * e,
      yaw: aYaw + shortestDelta(aYaw, bYaw) * e,
      pitch: (a.pitch ?? base.pitch) + ((b.pitch ?? a.pitch ?? base.pitch) - (a.pitch ?? base.pitch)) * e,
      fov: (a.fov ?? base.fov) + ((b.fov ?? a.fov ?? base.fov) - (a.fov ?? base.fov)) * e,
    };
  }

  /** 推进时间轴，返回是否仍在播放 */
  update(now: number, base: CameraState): { state: CameraState; done: boolean } {
    if (!this.active) return { state: base, done: true };
    const t = (now - this.t0) / 1000;
    const state = this.sample(t, base);
    const done = t >= this.duration;
    if (done) {
      this.active = false;
      const cb = this.onDone;
      this.onDone = null;
      cb?.();
    }
    return { state, done };
  }
}
