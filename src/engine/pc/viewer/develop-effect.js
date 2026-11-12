import { Vec3 } from 'playcanvas';

/**
 * 「冲洗显影」加载特效（对齐参考视频里那种效果）
 * ---------------------------------------------------------------------------
 * 参考视频的开场是这样的（0 ~ 1.7 秒）：
 *   0.0s  近乎全黑，只有零星亮点（还没显影的 splat），隐约能看出场景轮廓
 *   0.5s  结构浮现，仍然偏暗
 *   0.9s  一条分界线从画面上方往下推，线以上已经有颜色
 *   1.2s  分界线降到中段，沿线一圈发白的雾状带，线下方还是暗点云
 *   1.5s  大部分已成形，底部仍在流动
 *   1.7s  完整实体
 *
 * 所以它比「点飞回来」更像**暗房里洗照片**：一条有机起伏的分界线从上往下扫过，
 * 线以上显影成实体、线以下保持暗场点云，分界线上是发白发亮的雾带 + 轻微色散。
 *
 * 扫描轴不按模型局部 Y 算，而是取**相机在该模型坐标系里的上方向**：
 * 这样不管模型怎么摆、清单里带什么基准旋转、用户从哪个角度看，分界线都是
 * 屏幕上「自上而下」地推进，和视频观感一致。轴在每次 play 时重算一次
 * （动画只有一两秒，中途转动相机不需要跟随）。
 *
 * 全部计算落在 splat 自身的绘制着色器里（gsplatModifyVS 钩子），逐 splat：
 *   - t       显影阈值：沿扫描轴的归一化坐标 × 系数，叠低频波纹 + 哈希抖动
 *   - reveal  smoothstep(t, t + 0.07, progress)：0→1 的显影程度
 *   - band    以阈值右侧半个带宽为中心的高斯钟形，只在分界线附近非零
 *   - 暗场    只有约 16% 的 splat 作为亮点可见，颜色去色偏冷
 *   - 分界线  splat 放大、各向异性拉长（拖影）、颜色提亮 + 三通道错相（色散）
 *
 * 没有额外的点云层：暗场里那些亮点就是 splat 自己缩到很小、压暗之后的样子，
 * 这样点云和实体天然是同一批数据，显影时不会出现「点消失、实体另起」的割裂。
 */

const SPLAT_MODIFY_VS = /* glsl */ `
uniform float uProgress;     // 0 = 全暗点云，1 = 完整实体
uniform vec3  uScanOrigin;   // 扫描轴原点（模型局部坐标，取包围盒中心）
uniform vec3  uScanAxis;     // 扫描方向（模型局部坐标，已归一化）
uniform float uScanMin;      // 原点附近，沿扫描轴的最小投影值
uniform float uScanMax;      // 原点附近，沿扫描轴的最大投影值
uniform float uBand;         // 分界线过渡宽度（progress 单位）
uniform float uStreak;       // 分界线拖影强度
uniform float uGlow;         // 分界线发光强度
uniform float uSizeMin;      // 暗场点的小尺寸系数
uniform float uSparkRate;    // 暗场里可见亮点的比例阈值

float devHash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

// 沿扫描轴的归一化坐标：0 = 屏幕上方（先显影），1 = 屏幕下方（后显影）
float devCoord(vec3 c) {
    float d = dot(c - uScanOrigin, uScanAxis);
    return clamp((d - uScanMin) / max(uScanMax - uScanMin, 1e-4), 0.0, 1.0);
}

// 显影阈值：上方先显影（devCoord 在屏幕上方为 1，所以取反），
// 叠两路低频正弦让分界线起伏，叠哈希让边缘有颗粒感
float devThreshold(vec3 c) {
    float wave = sin(c.x * 6.5 + 1.7) * 0.05 + sin(c.z * 5.1 - 0.9) * 0.05;
    float grain = (devHash(c) - 0.5) * 0.07;
    return clamp((1.0 - devCoord(c)) * 0.60 + wave + grain, 0.0, 1.0);
}

float devReveal(vec3 c) {
    float t = devThreshold(c);
    return smoothstep(t, t + 0.07, uProgress);
}

// 只在分界线附近非零：钟形以阈值右侧半个带宽为中心
float devBand(vec3 c) {
    float t = devThreshold(c);
    float d = (uProgress - t - 0.035) / uBand;
    return exp(-d * d);
}

void modifySplatCenter(inout vec3 center) {
    float band = devBand(center);
    float r = devReveal(center);
    // 未显影的一侧沿扫描方向轻微后坠，配合下面的拉长形成拖影
    center -= uScanAxis * (band * (uScanMax - uScanMin) * 0.008 * (1.0 - r));
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    float r = devReveal(originalCenter);
    float band = devBand(originalCenter);

    // 暗场缩成小点，显影后恢复原始尺寸
    scale *= mix(uSizeMin, 1.0, smoothstep(0.0, 1.0, r));

    // 分界线处各向异性拉长：两条轴拉伸比例不同，看起来像运动模糊/拖影
    scale.x *= 1.0 + band * uStreak * 0.9;
    scale.y *= 1.0 + band * uStreak * 0.45;
}

void modifySplatColor(vec3 center, inout vec4 color) {
    float r = devReveal(center);
    float band = devBand(center);

    // 暗场：约 16% 的 splat 保留为亮点，其余几乎不可见
    float spark = step(uSparkRate, devHash(center + 3.7));
    float dim = mix(spark, 1.0, r);

    // 暗场颜色去色、偏冷；显影后回到原始颜色
    vec3 cold = vec3(color.r * 0.40 + 0.02, color.g * 0.44 + 0.03, color.b * 0.56 + 0.05);
    color.rgb = mix(cold, color.rgb, r);

    color.a *= mix(dim * 0.95, 1.0, r);
    color.a *= 1.0 + band * 0.32;

    // 分界线：整体提亮，三通道错相叠一点彩色（近似镜头色散，别做成彩虹带）
    float ph = devHash(center + 9.1) * 6.2832 + center.y * 9.0;
    vec3 fringe = vec3(
        0.5 + 0.5 * sin(ph),
        0.5 + 0.5 * sin(ph + 2.1),
        0.5 + 0.5 * sin(ph + 4.2)
    );
    color.rgb += (vec3(0.72) + fringe * 0.6) * band * uGlow;

    color.rgb = clamp(color.rgb, vec3(0.0), vec3(1.35));
    color.a = clamp(color.a, 0.0, 1.0);
}
`;

export class DevelopEffect {
    /**
     * @param {import('playcanvas').Application} app
     * @param {import('playcanvas').Entity} entity  承载 splat 的实体
     * @param {import('playcanvas').GSplatResourceBase} resource
     * @param {import('playcanvas').Entity} [camera] 扫描轴以它的「上方向」为准
     */
    constructor(app, entity, resource, camera) {
        this.app = app;
        this.entity = entity;
        this.resource = resource;
        this.camera = camera ?? null;

        this.duration = 1.8;
        this.time = 0;
        this.playing = false;
        this.progress = 0;

        this.splatMaterial = null;
        this._ok = false;

        const aabb = resource?.aabb;
        this.center = aabb ? aabb.center.clone() : new Vec3();
        this.half = aabb ? aabb.halfExtents.clone() : new Vec3(1, 1, 1);

        this._scanAxis = new Vec3(0, 1, 0);
        this._scanMin = -1;
        this._scanMax = 1;

        this._attach();
    }

    _attach() {
        const material = this.entity?.gsplat?.instance?.material;
        if (!material) {
            this._ok = false;
            return;
        }

        material.shaderChunks.glsl.set('gsplatModifyVS', SPLAT_MODIFY_VS);
        material.setParameter('uProgress', 1);
        material.setParameter('uBand', 0.035);
        material.setParameter('uStreak', 1.45);
        material.setParameter('uGlow', 0.24);
        material.setParameter('uSizeMin', 0.22);
        material.setParameter('uSparkRate', 0.84);
        material.update();

        this.splatMaterial = material;
        this._ok = true;
        this._updateScanAxis();
    }

    /**
     * 取相机上方向、转到模型局部坐标系，再在包围盒上求投影范围。
     * 这样「自上而下」永远成立，不受模型自身朝向影响。
     */
    _updateScanAxis() {
        if (!this.entity) return;

        const axis = new Vec3(0, 1, 0);
        const up = new Vec3();
        if (this.camera) {
            this.camera.getWorldTransform().getY(up);
            const inv = this.entity.getWorldTransform().clone().invert();
            inv.transformVector(up, axis);
            if (axis.lengthSq() < 1e-8) axis.set(0, 1, 0);
            axis.normalize();
        }

        // 包围盒 8 个角在这条轴上的投影范围
        let min = Infinity;
        let max = -Infinity;
        const corner = new Vec3();
        for (let i = 0; i < 8; i++) {
            corner.set(
                this.center.x + (i & 1 ? this.half.x : -this.half.x),
                this.center.y + (i & 2 ? this.half.y : -this.half.y),
                this.center.z + (i & 4 ? this.half.z : -this.half.z)
            );
            const d = corner.sub(this.center).dot(axis);
            if (d < min) min = d;
            if (d > max) max = d;
        }

        this._scanAxis.copy(axis);
        this._scanMin = min;
        this._scanMax = max;

        if (this.splatMaterial) {
            this.splatMaterial.setParameter('uScanOrigin', [this.center.x, this.center.y, this.center.z]);
            this.splatMaterial.setParameter('uScanAxis', [axis.x, axis.y, axis.z]);
            this.splatMaterial.setParameter('uScanMin', min);
            this.splatMaterial.setParameter('uScanMax', max);
        }
    }

    get ready() {
        return this._ok;
    }

    _apply(p) {
        if (!this.splatMaterial) return;
        this.splatMaterial.setParameter('uProgress', p);
        // setParameter 只改数据、不递增版本号；不补 update() 的话 GPU 拿不到新值
        this.splatMaterial.update();
    }

    /**
     * @param {{ duration?: number }} [options]  duration 单位毫秒
     */
    play(options = {}) {
        this.duration = Math.max(0.3, (options.duration ?? 1800) / 1000);
        this.time = 0;
        this.progress = 0;
        this.playing = true;
        if (!this._ok) this._attach();
        this._updateScanAxis();
        this._apply(0);
    }

    update(dt) {
        if (!this.playing) return;

        this.time += dt;
        const raw = Math.min(1, this.time / this.duration);
        this.progress = raw;
        this._apply(raw);

        if (raw >= 1) {
            this.playing = false;
            this._apply(1);
        }
    }

    /** 定格在指定进度（调参/评审用：?revealHold=0.5） */
    hold(p) {
        const v = Math.min(1, Math.max(0, p));
        this.playing = false;
        this.time = v * this.duration;
        this.progress = v;
        this._updateScanAxis();
        this._apply(v);
    }

    cancel() {
        if (this.playing) {
            this.playing = false;
            this._apply(1);
        }
    }

    destroy() {
        this.cancel();
        this._apply(1);
    }
}
