import { Vec3, math } from 'playcanvas';

/**
 * 轻量轨道相机控制器
 *
 * 之所以自己实现而不用引擎自带的 camera-controls 脚本：
 * 1. 手势需求明确（单指旋转、双指缩放+平移、滚轮缩放），自实现没有多余逻辑；
 * 2. 不引入额外 ESM 依赖，App 与小程序的 WebView 环境里不会因为模块解析失败；
 * 3. 目标点 / 距离可以直接被模型包围盒驱动，加载后自动取景。
 *
 * 约定：相机绕 target 做球面运动，yaw 绕 Y 轴，pitch 为俯仰角。
 */
export class OrbitCamera {
    /**
     * @param {import('playcanvas').Entity} camera - 带 camera 组件的实体
     * @param {HTMLElement} element - 接收手势的元素（通常是 canvas）
     */
    constructor(camera, element) {
        this.camera = camera;
        this.element = element;

        // 当前值（用于阻尼插值）
        this.target = new Vec3(0, 0, 0);
        this.yaw = 0;
        this.pitch = 0.12;
        this.distance = 3;

        // 目标值（手势直接改这个）
        this.goalTarget = new Vec3(0, 0, 0);
        this.goalYaw = 0;
        this.goalPitch = 0.12;
        this.goalDistance = 3;

        this.minDistance = 0.05;
        this.maxDistance = 1000;

        /** 旋转灵敏度（弧度/像素） */
        this.sensitivity = 0.0055;
        /** 缩放灵敏度 */
        this.zoomSpeed = 0.0015;
        /** 阻尼收敛速度，越大越跟手 */
        this.damping = 12;

        this._pointers = new Map();
        this._gesture = null;
        this._animate = { from: null, start: 0, duration: 0 };

        this._bind();
    }

    // ---------------------------------------------------------------- 手势

    _bind() {
        const el = this.element;
        const down = (e) => this._onDown(e);
        const move = (e) => this._onMove(e);
        const up = (e) => this._onUp(e);
        const wheel = (e) => {
            e.preventDefault();
            this.zoomBy(Math.exp(e.deltaY * this.zoomSpeed));
        };

        el.addEventListener('pointerdown', down);
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('pointerleave', up);
        el.addEventListener('wheel', wheel, { passive: false });
        // 右键拖拽平移时不弹出菜单
        el.addEventListener('contextmenu', (e) => e.preventDefault());

        this._unbind = () => {
            el.removeEventListener('pointerdown', down);
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
            el.removeEventListener('pointercancel', up);
            el.removeEventListener('pointerleave', up);
            el.removeEventListener('wheel', wheel);
        };
    }

    _onDown(e) {
        try {
            this.element.setPointerCapture(e.pointerId);
        } catch {
            // 某些 WebView 不支持 pointer capture，忽略即可
        }
        this._pointers.set(e.pointerId, {
            x: e.clientX,
            y: e.clientY,
            pan: e.button === 2 || e.ctrlKey || e.shiftKey
        });
        this._gesture = this._readGesture();
    }

    _onMove(e) {
        const p = this._pointers.get(e.pointerId);
        if (!p) return;

        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;
        p.x = e.clientX;
        p.y = e.clientY;

        if (this._pointers.size === 1) {
            if (p.pan) {
                this.panBy(dx, dy);
            } else {
                this.goalYaw -= dx * this.sensitivity;
                this.goalPitch = clamp(
                    this.goalPitch + dy * this.sensitivity,
                    -Math.PI / 2 + 0.02,
                    Math.PI / 2 - 0.02
                );
            }
            this._gesture = null;
            return;
        }

        // 双指：缩放 + 平移
        const g = this._readGesture();
        const prev = this._gesture;
        if (g && prev && prev.span > 0 && g.span > 0) {
            this.zoomBy(prev.span / g.span);
            this.panBy(g.midX - prev.midX, g.midY - prev.midY);
        }
        this._gesture = g;
    }

    _onUp(e) {
        this._pointers.delete(e.pointerId);
        this._gesture = this._readGesture();
        try {
            this.element.releasePointerCapture(e.pointerId);
        } catch {
            // ignore
        }
    }

    _readGesture() {
        if (this._pointers.size !== 2) return null;
        const [a, b] = [...this._pointers.values()];
        return {
            midX: (a.x + b.x) / 2,
            midY: (a.y + b.y) / 2,
            span: Math.hypot(a.x - b.x, a.y - b.y)
        };
    }

    // ---------------------------------------------------------------- 操作

    zoomBy(factor) {
        this.goalDistance = clamp(
            this.goalDistance * factor,
            this.minDistance,
            this.maxDistance
        );
    }

    panBy(dx, dy) {
        const height = this.element.clientHeight || 1;
        const fov = (this.camera.camera.fov * math.DEG_TO_RAD) || 0.8;
        // 把像素位移换算到目标点所在平面的世界单位
        const unit = (2 * Math.tan(fov / 2) * this.goalDistance) / height;
        const basis = this._cameraBasis();

        this.goalTarget.add(basis.right.mulScalar(-dx * unit));
        this.goalTarget.add(basis.up.mulScalar(dy * unit));
    }

    _cameraBasis() {
        const wt = this.camera.getWorldTransform();
        const d = wt.data;
        return {
            right: new Vec3(d[0], d[1], d[2]),
            up: new Vec3(d[4], d[5], d[6])
        };
    }

    /**
     * 根据包围球设定视角（立即生效，加载模型后调用）
     * @param {Vec3} center - 包围球中心（世界坐标）
     * @param {number} radius - 包围球半径
     */
    setView(center, radius) {
        const safeRadius = Math.max(radius, 1e-3);
        const fov = (this.camera.camera.fov * math.DEG_TO_RAD) || 0.8;
        const dist = (safeRadius / Math.sin(fov / 2)) * 1.15;

        this.minDistance = safeRadius * 0.04;
        this.maxDistance = safeRadius * 30;

        this.target.copy(center);
        this.goalTarget.copy(center);
        this.distance = dist;
        this.goalDistance = dist;
        this.yaw = this.goalYaw = 0;
        this.pitch = this.goalPitch = 0.14;

        this._fitClip(safeRadius);
        this.update(1);
    }

    /** 平滑飞回上次设定的视角 */
    reset() {
        this.goalTarget.copy(this._homeTarget ?? this.goalTarget);
        this.goalDistance = this._homeDistance ?? this.goalDistance;
        this.goalYaw = 0;
        this.goalPitch = 0.14;
    }

    /** 记下当前视角作为复位点 */
    markHome() {
        this._homeTarget = this.goalTarget.clone();
        this._homeDistance = this.goalDistance;
    }

    _fitClip(radius) {
        const cam = this.camera.camera;
        cam.nearClip = Math.max(0.01, radius / 500);
        cam.farClip = Math.max(1, radius * 60);
    }

    // ---------------------------------------------------------------- 每帧

    update(dt) {
        const t = Math.min(Math.max(dt, 0.001), 0.1);
        const k = 1 - Math.exp(-this.damping * t);

        this.yaw += (this.goalYaw - this.yaw) * k;
        this.pitch += (this.goalPitch - this.pitch) * k;
        this.distance += (this.goalDistance - this.distance) * k;
        this.target.lerp(this.target, this.goalTarget, k);

        const cp = Math.cos(this.pitch);
        const sp = Math.sin(this.pitch);
        const sy = Math.sin(this.yaw);
        const cy = Math.cos(this.yaw);

        this.camera.setPosition(
            this.target.x + this.distance * cp * sy,
            this.target.y + this.distance * sp,
            this.target.z + this.distance * cp * cy
        );
        this.camera.lookAt(this.target);
    }

    destroy() {
        this._unbind?.();
        this._pointers.clear();
    }
}

function clamp(v, a, b) {
    return Math.min(b, Math.max(a, v));
}
