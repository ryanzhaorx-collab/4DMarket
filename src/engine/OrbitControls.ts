import { OrbitCamera } from './Camera';
import { clamp } from './math';

const MIN_PITCH = 0.06;
const MAX_PITCH = 1.36;

/**
 * 触摸/鼠标轨道控制：
 * - 单指拖动 = 环视（惯性 + 时间常数平滑，接近 Luma 的阻尼手感）
 * - 双指捏合 = 推拉镜头
 * - 轻点 = 点选；双击 = 回到初始机位
 * - 空闲 3.8s 后极慢自转，任何触碰立即停止
 * 只监听 canvas，避免和 DOM 滚动冲突；全程 passive:false 以便阻止页面回弹。
 */
export class OrbitControls {
  onTap: ((x: number, y: number, source: 'canvas') => void) | null = null;
  onDoubleTap: (() => void) | null = null;
  autoRotate = true;

  private pointers = new Map<number, { x: number; y: number }>();
  private last = { x: 0, y: 0 };
  private pinchStart = 0;
  private pinchDist = 0;
  private velYaw = 0;
  private velPitch = 0;
  private moved = 0;
  private downAt = 0;
  private lastInput = 0;
  private lastTapAt = 0;
  private lastTapX = 0;
  private lastTapY = 0;
  private minDist = 10;
  private maxDist = 420;
  private targetYaw: number;
  private targetPitch: number;
  private _enabled = true;

  constructor(
    private readonly el: HTMLElement,
    private readonly camera: OrbitCamera,
  ) {
    this.targetYaw = camera.yaw;
    this.targetPitch = camera.pitch;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this.onDown, { passive: false });
    el.addEventListener('pointermove', this.onMove, { passive: false });
    el.addEventListener('pointerup', this.onUp, { passive: false });
    el.addEventListener('pointercancel', this.onCancel, { passive: false });
    el.addEventListener('wheel', this.onWheel, { passive: false });
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(v: boolean) {
    if (v && !this._enabled) {
      this.syncFromCamera();
      // 重新接管时给一段静止宽限期，避免入场结束立刻自转
      this.lastInput = performance.now();
    }
    this._enabled = v;
  }

  /** 距离上下限（由自动取景按模型尺度动态设置） */
  setLimits(min: number, max: number) {
    this.minDist = Math.max(0.5, min);
    this.maxDist = Math.max(this.minDist * 1.5, max);
    this.camera.distance = clamp(this.camera.distance, this.minDist, this.maxDist);
  }

  syncFromCamera() {
    this.targetYaw = this.camera.yaw;
    this.targetPitch = this.camera.pitch;
    this.velYaw = 0;
    this.velPitch = 0;
  }

  dispose() {
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('pointermove', this.onMove);
    this.el.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('pointercancel', this.onCancel);
    this.el.removeEventListener('wheel', this.onWheel);
  }

  private onDown = (e: PointerEvent) => {
    if (!this._enabled) return;
    e.preventDefault();
    this.lastInput = performance.now();
    try {
      this.el.setPointerCapture?.(e.pointerId);
    } catch {
      /* 合成事件/已释放指针时会抛 NotFoundError，忽略即可 */
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.last = { x: e.clientX, y: e.clientY };
      this.velYaw = 0;
      this.velPitch = 0;
      this.moved = 0;
      this.downAt = performance.now();
    } else if (this.pointers.size === 2) {
      this.pinchStart = this.camera.distance;
      this.pinchDist = this.currentPinchDistance();
    }
  };

  private onMove = (e: PointerEvent) => {
    if (!this._enabled) return;
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    this.lastInput = performance.now();
    p.x = e.clientX;
    p.y = e.clientY;

    if (this.pointers.size >= 2) {
      const d = this.currentPinchDistance();
      if (this.pinchDist > 1 && d > 1) {
        const ratio = this.pinchDist / d;
        this.camera.distance = clamp(this.pinchStart * ratio, this.minDist, this.maxDist);
      }
      return;
    }

    const dx = e.clientX - this.last.x;
    const dy = e.clientY - this.last.y;
    this.last = { x: e.clientX, y: e.clientY };
    this.moved += Math.abs(dx) + Math.abs(dy);

    const k = 0.0042;
    this.targetYaw -= dx * k;
    this.targetPitch = clamp(this.targetPitch + dy * k, MIN_PITCH, MAX_PITCH);
    this.velYaw = -dx * k * 0.5;
    this.velPitch = dy * k * 0.5;
  };

  private onUp = (e: PointerEvent) => {
    const had = this.pointers.delete(e.pointerId);
    if (!had) return;
    if (this.pointers.size === 0) {
      const dt = performance.now() - this.downAt;
      if (this.moved < 10 && dt < 420) {
        this.velYaw = 0;
        this.velPitch = 0;
        const now = performance.now();
        const isDouble =
          now - this.lastTapAt < 320 &&
          Math.hypot(e.clientX - this.lastTapX, e.clientY - this.lastTapY) < 30;
        if (isDouble) {
          this.lastTapAt = 0;
          this.onDoubleTap?.();
        } else {
          this.lastTapAt = now;
          this.lastTapX = e.clientX;
          this.lastTapY = e.clientY;
          this.onTap?.(e.clientX, e.clientY, 'canvas');
        }
      }
    } else if (this.pointers.size === 1) {
      const rest = this.pointers.values().next().value as { x: number; y: number } | undefined;
      if (rest) this.last = { x: rest.x, y: rest.y };
    }
  };

  private onCancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
  };

  private onWheel = (e: WheelEvent) => {
    if (!this._enabled) return;
    e.preventDefault();
    this.lastInput = performance.now();
    this.camera.distance = clamp(
      this.camera.distance * Math.exp(e.deltaY * 0.0012),
      this.minDist,
      this.maxDist,
    );
  };

  private currentPinchDistance(): number {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  update(dt: number) {
    if (!this._enabled) return;
    const idle = this.pointers.size === 0 && performance.now() - this.lastInput > 3800;

    if (this.pointers.size === 0) {
      if (Math.abs(this.velYaw) > 1e-5 || Math.abs(this.velPitch) > 1e-5) {
        this.targetYaw += this.velYaw;
        this.targetPitch = clamp(this.targetPitch + this.velPitch, MIN_PITCH, MAX_PITCH);
        const decay = Math.pow(0.9, dt * 60);
        this.velYaw *= decay;
        this.velPitch *= decay;
      }
      // 空闲自转：极慢，接近 Luma 的展示态
      if (this.autoRotate && idle) this.targetYaw += 0.06 * dt;
    }

    // 时间常数平滑（≈70ms）：触摸输入不再有像素级抖动
    const k = 1 - Math.exp(-dt * 14);
    this.camera.yaw += (this.targetYaw - this.camera.yaw) * k;
    this.camera.pitch += (this.targetPitch - this.camera.pitch) * k;

    // 长时间自转后把角度折回一圈，避免浮点精度损失
    if (Math.abs(this.targetYaw) > Math.PI * 4) {
      const wrap = Math.round(this.targetYaw / (Math.PI * 2)) * Math.PI * 2;
      this.targetYaw -= wrap;
      this.camera.yaw -= wrap;
    }
  }

  get isDragging() {
    return this.pointers.size > 0;
  }
}
