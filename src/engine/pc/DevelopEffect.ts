/**
 * 「冲洗显影」加载特效（移植自团队参考实现）。
 *
 * 效果：一条从屏幕上方往下扫的分界线——线以上显影成实体，线以下保持冷色暗点云，
 * 分界线上是发白发亮的雾带 + 轻微色散。比「点飞回来」更像暗房里洗照片。
 *
 * 实现要点：全部计算落在 splat 自身的绘制着色器里（PlayCanvas 的 gsplatModifyVS 钩子），
 * 逐 splat 决定 显影程度 / 尺寸 / 颜色，所以点云和实体天然是同一批数据。
 */
import { Entity, GSplatResourceBase, Material, Vec3, type Application } from 'playcanvas';

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

/** 能挂特效的最小实体接口（避免依赖 GSplatComponent 的完整类型） */
type SplatEntity = Entity;

/** 从 gsplat 组件里挖出材质（PC 的 instance 是私有字段，不同版本名字不一样） */
function findMaterial(entity: SplatEntity): Material | null {
  const g = (entity as unknown as { gsplat?: Record<string, unknown> }).gsplat;
  if (!g) return null;
  const inst = (g.instance ?? g._instance) as { material?: Material } | undefined;
  return inst?.material ?? (g._materialTmp as Material | undefined) ?? null;
}

export class DevelopEffect {
    duration = 1.8;
    time = 0;
    playing = false;
    progress = 0;
    private splatMaterial: Material | null = null;
    private _ok = false;
    private center = new Vec3();
    private half = new Vec3(1, 1, 1);
    private _scanAxis = new Vec3(0, 1, 0);
    private _scanMin = -1;
    private _scanMax = 1;
    /** 供外部读取当前扫描范围（调试用） */
    get scanRange(): [number, number] {
      return [this._scanMin, this._scanMax];
    }

    /**
     * @param {import('playcanvas').Application} app
     * @param {import('playcanvas').Entity} entity  承载 splat 的实体
     * @param {import('playcanvas').GSplatResourceBase} resource
     * @param {import('playcanvas').Entity} [camera] 扫描轴以它的「上方向」为准
     */
    constructor(
    readonly app: Application,
    private readonly entity: SplatEntity,
    readonly resource: GSplatResourceBase,
    private readonly camera: Entity | null = null,
  ) {
        this.duration = 1.8;
        this.time = 0;
        this.playing = false;
        this.progress = 0;

        this._ok = false;

        const aabb = resource?.aabb;
        this.center = aabb ? aabb.center.clone() : new Vec3();
        this.half = aabb ? aabb.halfExtents.clone() : new Vec3(1, 1, 1);

        this._scanAxis = new Vec3(0, 1, 0);
        this._scanMin = -1;
        this._scanMax = 1;

        this._attach();
    }

    private _attach(): void {
        const material = findMaterial(this.entity);
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
    private _updateScanAxis(): void {
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
            (this.splatMaterial as Material).setParameter('uScanOrigin', [this.center.x, this.center.y, this.center.z]);
            (this.splatMaterial as Material).setParameter('uScanAxis', [axis.x, axis.y, axis.z]);
            (this.splatMaterial as Material).setParameter('uScanMin', min);
            (this.splatMaterial as Material).setParameter('uScanMax', max);
        }
    }

    get ready(): boolean {
        return this._ok;
    }

    private _apply(p: number): void {
        if (!this.splatMaterial) return;
        (this.splatMaterial as Material).setParameter('uProgress', p);
        // setParameter 只改数据、不递增版本号；不补 update() 的话 GPU 拿不到新值
        this.splatMaterial.update();
    }

    /**
     * @param {{ duration?: number }} [options]  duration 单位毫秒
     */
    play(options: { duration?: number } = {}): void {
        this.duration = Math.max(0.3, (options.duration ?? 1800) / 1000);
        this.time = 0;
        this.progress = 0;
        this.playing = true;
        if (!this._ok) this._attach();
        this._updateScanAxis();
        this._apply(0);
    }

    update(dt: number): void {
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
    hold(p: number): void {
        const v = Math.min(1, Math.max(0, p));
        this.playing = false;
        this.time = v * this.duration;
        this.progress = v;
        this._updateScanAxis();
        this._apply(v);
    }

    cancel(): void {
        if (this.playing) {
            this.playing = false;
            this._apply(1);
        }
    }

    destroy(): void {
        this.cancel();
        this._apply(1);
    }
}
