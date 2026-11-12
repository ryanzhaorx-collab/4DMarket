import {
    BLEND_ADDITIVEALPHA,
    CULLFACE_NONE,
    Mesh,
    MeshInstance,
    PRIMITIVE_POINTS,
    SEMANTIC_POSITION,
    ShaderMaterial,
    Vec3
} from 'playcanvas';

/**
 * 「点云 → 实体」加载特效
 * ---------------------------------------------------------------------------
 * 效果全部建立在真实 splat 数据上，分两层同时推进：
 *
 * 1) 点云层：把 splat 的中心点（resource.centers）画成 GL_POINTS。
 *    每个点按自身哈希错峰启动，从散开的位置飞回自己的真实位置，落位后淡出。
 *
 * 2) 实体层：给 splat 的绘制材质注入引擎自带的 gsplatModifyVS 钩子，
 *    逐个 splat 做「位置散开 → 归位」「尺寸缩小 → 复原」「透明度 0 → 1」，
 *    与点云层反相推进，于是看到的是点凝聚成实体，而不是点消失、实体另起。
 *
 * 之所以把散开量放进着色器、而不在外面挪实体：splat 数量可达百万级，
 * 逐帧在 CPU 改顶点数据不现实；着色器里做，成本是每 splat 几个 ALU。
 */

const MAX_POINTS = 300000;

// ---------------------------------------------------------------- 实体层钩子

/**
 * 引擎提供三个钩子函数（见 PlayCanvas gsplatModifyVS 默认 chunk）：
 *   modifySplatCenter / modifySplatRotationScale / modifySplatColor
 * 三个都要重写，少写一个会导致另一处调用点编译失败。
 * 三个函数拿到的 center / originalCenter 是同一个值，用它哈希即可保证
 * 同一个 splat 在三个函数里的相位一致。
 */
const SPLAT_MODIFY_VS = /* glsl */ `
uniform float uReveal;   // 0 = 点云态，1 = 实体
uniform float uSpread;   // 散开幅度（模型局部单位）
uniform float uSizeMin;  // 点云态下 splat 尺寸的缩放系数
uniform float uDelay;    // 每个 splat 的启动延迟占比

float revealHash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float revealPhase(vec3 c) {
    float seed = revealHash(c);
    float delay = seed * uDelay;
    return clamp((uReveal - delay) / max(1.0 - uDelay, 1e-4), 0.0, 1.0);
}

vec3 revealDirection(vec3 c) {
    float s = revealHash(c + 13.7);
    vec3 r = vec3(
        revealHash(c + 1.31),
        revealHash(c + 2.73),
        revealHash(c + 4.19)
    ) * 2.0 - 1.0;
    return normalize(r + vec3(1e-4 + s * 0.2));
}

void modifySplatCenter(inout vec3 center) {
    float t = revealPhase(center);
    if (t >= 1.0) return;
    vec3 dir = revealDirection(center);
    center += dir * uSpread * pow(1.0 - t, 2.2);
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    float t = revealPhase(originalCenter);
    scale *= mix(uSizeMin, 1.0, t);
}

void modifySplatColor(vec3 center, inout vec4 color) {
    float t = revealPhase(center);
    color.a *= smoothstep(0.0, 1.0, t);
}
`;

// ---------------------------------------------------------------- 点云层着色器

const POINT_VS = /* glsl */ `
attribute vec3 vertex_position;

uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
uniform float uProgress;  // 0 ~ 1 总进度
uniform float uSpread;    // 散开幅度（模型局部单位）
uniform float uSize;      // 点的基础像素尺寸
uniform float uDelay;     // 每点延迟占比
uniform float uTime;      // 秒，用于未归位点的轻微漂浮

varying float vT;
varying float vAlpha;

float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

vec3 hash31(float p) {
    vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
}

void main() {
    vec3 center = vertex_position;

    // 用中心坐标哈希：同一份模型每次播放的散开方向与次序完全一致（可复现）
    float seed = hash11(dot(center, vec3(12.9898, 78.233, 45.164)));
    float delay = seed * uDelay;
    float t = clamp((uProgress - delay) / max(1.0 - uDelay, 1e-4), 0.0, 1.0);

    vec3 dir = normalize(hash31(seed + 1.0) * 2.0 - 1.0 + vec3(1e-4));
    float scatter = uSpread * pow(1.0 - t, 2.2);
    vec3 pos = center + dir * scatter;
    pos.y += sin(uTime * 1.8 + seed * 6.2832) * scatter * 0.12;

    gl_Position = matrix_viewProjection * (matrix_model * vec4(pos, 1.0));

    gl_PointSize = uSize * (0.7 + 0.6 * seed) * (1.0 - 0.35 * t);

    vT = t;
    // 起手立刻可见（不能留黑场）；归位过程中整团点云让位给实体
    float fadeIn = smoothstep(0.0, 0.03, uProgress);
    float fadeOut = 1.0 - smoothstep(0.35, 0.95, uProgress);
    vAlpha = fadeIn * fadeOut;
}
`;

const POINT_PS = /* glsl */ `
varying float vT;
varying float vAlpha;

uniform vec3 uColorA;  // 点云初期颜色（偏冷，扫描感）
uniform vec3 uColorB;  // 归位前颜色（偏暖白，接近实体）

void main() {
    vec2 d = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(d, d);
    if (r2 > 1.0) discard;

    float core = 1.0 - r2;
    core *= core;

    vec3 col = mix(uColorA, uColorB, vT);
    gl_FragColor = vec4(col, core * vAlpha);
}
`;

export class RevealEffect {
    /**
     * @param {import('playcanvas').Application} app
     * @param {import('playcanvas').Entity} entity  承载 splat 的实体（点云层跟随它的变换）
     * @param {import('playcanvas').GSplatResourceBase} resource
     */
    constructor(app, entity, resource) {
        this.app = app;
        this.entity = entity;
        this.resource = resource;

        this.duration = 1.9;
        this.time = 0;
        this.playing = false;
        this.progress = 0;
        this.spreadFactor = 0.30;

        this.meshInstance = null;
        this.material = null;
        this.mesh = null;
        this.splatMaterial = null;

        const aabb = resource?.aabb;
        this.radius = aabb ? Math.max(aabb.halfExtents.length(), 1e-3) : 1;
        this.center = aabb ? aabb.center.clone() : new Vec3();

        this._attachSplatShader();
        this._buildPointLayer();
    }

    // ------------------------------------------------------------ 实体层

    /** 把凝聚用的钩子挂到 splat 的绘制材质上 */
    _attachSplatShader() {
        const comp = this.entity?.gsplat;
        const material = comp?.instance?.material;
        if (!material) {
            this._splatOk = false;
            return;
        }

        material.shaderChunks.glsl.set('gsplatModifyVS', SPLAT_MODIFY_VS);
        material.setParameter('uReveal', 0);
        material.setParameter('uSpread', this.radius * this.spreadFactor);
        material.setParameter('uSizeMin', 0.34);
        material.setParameter('uDelay', 0.35);
        material.update();

        this.splatMaterial = material;
        this._splatOk = true;
    }

    _applySplat(v) {
        if (!this.splatMaterial) return;
        this.splatMaterial.setParameter('uReveal', v);
        // setParameter 只改数据、不递增版本号；渲染器按版本号决定是否同步参数，
        // 所以这里的 update() 是必需的，否则 uniform 不会真正进到 GPU。
        this.splatMaterial.update();
    }

    // ------------------------------------------------------------ 点云层

    _buildPointLayer() {
        const device = this.app.graphicsDevice;
        const centers = this.resource?.centers;
        if (!centers || centers.length < 3) {
            this._pointLayerOk = false;
            return;
        }

        const total = Math.floor(centers.length / 3);
        const stride = Math.max(1, Math.ceil(total / MAX_POINTS));
        const count = Math.ceil(total / stride);

        const positions = new Float32Array(count * 3);
        for (let i = 0, src = 0; i < count; i++, src += stride * 3) {
            positions[i * 3] = centers[src];
            positions[i * 3 + 1] = centers[src + 1];
            positions[i * 3 + 2] = centers[src + 2];
        }

        const mesh = new Mesh(device);
        mesh.setPositions(positions);
        mesh.update(PRIMITIVE_POINTS, true);

        const material = new ShaderMaterial({
            uniqueName: `reveal-points-${Date.now()}`,
            attributes: { vertex_position: SEMANTIC_POSITION },
            vertexGLSL: POINT_VS,
            fragmentGLSL: POINT_PS
        });
        material.blendType = BLEND_ADDITIVEALPHA;
        material.depthWrite = false;
        material.cull = CULLFACE_NONE;

        material.setParameter('uColorA', [0.30, 0.72, 1.0]);
        material.setParameter('uColorB', [0.95, 0.98, 1.0]);
        material.setParameter('uSpread', this.radius * this.spreadFactor);
        material.setParameter('uSize', 2.2 * device.maxPixelRatio);
        material.setParameter('uDelay', 0.45);
        material.setParameter('uTime', 0);
        material.setParameter('uProgress', 0);
        material.update();

        const meshInstance = new MeshInstance(mesh, material, this.entity);
        meshInstance.cull = false;

        const layer = this.app.scene.layers.getLayerByName('World');
        layer.addMeshInstances([meshInstance]);

        this.mesh = mesh;
        this.material = material;
        this.meshInstance = meshInstance;
        this.pointCount = count;
        this._pointLayerOk = true;
    }

    get ready() {
        return this._splatOk || this._pointLayerOk;
    }

    // ------------------------------------------------------------ 播放控制

    /**
     * @param {{ duration?: number, spread?: number }} [options]
     */
    play(options = {}) {
        const device = this.app.graphicsDevice;
        this.duration = Math.max(0.3, (options.duration ?? 1900) / 1000);
        this.time = 0;
        this.progress = 0;
        this.playing = true;
        this.spreadFactor = options.spread ?? 0.30;

        const spread = this.radius * this.spreadFactor;

        // 实例可能晚于组件创建，播放前再挂一次，避免特效静默失效
        if (!this._splatOk) this._attachSplatShader();

        if (this.material) {
            this.material.setParameter('uSpread', spread);
            this.material.setParameter('uSize', 2.2 * device.maxPixelRatio);
            this.material.setParameter('uProgress', 0);
            this.material.setParameter('uTime', 0);
            this.material.update();
        }
        if (this.splatMaterial) {
            this.splatMaterial.setParameter('uSpread', spread);
            this.splatMaterial.update();
        }
        if (this.meshInstance) this.meshInstance.visible = true;

        this._applySplat(0);
    }

    update(dt) {
        if (!this.playing) return;

        this.time += dt;
        const raw = Math.min(1, this.time / this.duration);
        this.progress = raw;
        this._applyProgress(raw);

        if (raw >= 1) {
            this.playing = false;
            this._finish();
        }
    }

    /** 把某一帧的状态铺到渲染上（动画推进与定格检查共用） */
    _applyProgress(p) {
        if (this.material) {
            this.material.setParameter('uProgress', p);
            this.material.setParameter('uTime', this.time);
            this.material.update();
        }
        this._applySplat(p);
    }

    /** 定格在指定进度（设计评审用：?revealHold=0.5） */
    hold(p) {
        const v = Math.min(1, Math.max(0, p));
        this.playing = false;
        this.time = v * this.duration;
        this.progress = v;
        if (this.meshInstance) this.meshInstance.visible = true;
        this._applyProgress(v);
    }

    _finish() {
        this._applySplat(1);
        if (this.meshInstance) this.meshInstance.visible = false;
    }

    cancel() {
        if (this.playing) {
            this.playing = false;
            this._finish();
        }
    }

    destroy() {
        this.cancel();
        // 即使不是在播放中被销毁，也要把钩子恢复到实体态，避免留下半透明的模型
        this._applySplat(1);

        if (this.meshInstance) {
            const layer = this.app.scene.layers.getLayerByName('World');
            layer?.removeMeshInstances([this.meshInstance]);
            this.meshInstance.destroy();
            this.meshInstance = null;
        }
        this.material?.destroy();
        this.material = null;
        this.mesh?.destroy();
        this.mesh = null;
    }
}
