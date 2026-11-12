import { Application, Asset, AssetListLoader, Color, Entity, FILLMODE_NONE, Quat, Vec3 } from 'playcanvas';
import { OrbitCamera } from './orbit-camera.js';
import { RevealEffect } from './reveal-effect.js';
import { DevelopEffect } from './develop-effect.js';

/**
 * 可用的加载特效：
 *  - develop：冲洗显影（对齐参考视频）—— 分界线从上往下扫过，线以上成形、线以下暗场点云
 *  - gather ：点云聚拢 —— 点从散开位置飞回归位，同时实体长出来
 */
const EFFECT_MODES = ['develop', 'gather'];

/** 引擎支持的 3DGS 格式（.sog / .ply / .spz / .lod-meta.json 流式 LOD） */
// 与引擎 @playcanvas/engine 2.24 的 gsplat handler 注册的解析器一一对应：
//   .ply                 → PlyParser（普通 3DGS ply 与 compressed ply 都吃）
//   .sog                 → SogBundleParser（单文件 sog 包）
//   .json                → SogParser（meta.json + 同目录 webp，按目录结构取）
//   .lcc2 / lod-meta.json → GSplatLcc2 / GSplatOctree（分级 LOD 格式）
// 注意不要写 .spz：2.24 没有注册 spz 解析器，写进来只会让用户选中后必然报错（已实测）
const SUPPORTED_EXT = ['sog', 'ply', 'json', 'lcc2'];
// 本地单选文件只能拿单文件格式：meta.json 需要同目录的附属 webp，选不进来
const LOCAL_SUPPORTED_EXT = ['sog', 'ply'];

/**
 * 常见坐标系修正：3DGS 训练输出（COLMAP）多为 Z-up，直接按 Y-up 加载会「躺倒」，
 * 通常绕 X 轴 -90° 就能立起来。提供这组预设，用户不用改代码就能校正。
 */
const ORIENT_PRESETS = [
    { label: '默认', euler: [0, 0, 0] },
    { label: 'X-90°', euler: [-90, 0, 0] },
    { label: 'X+90°', euler: [90, 0, 0] },
    { label: 'Z180°', euler: [0, 0, 180] }
];

/**
 * 运行环境能力探测。3DGS 渲染强依赖 WebGL2 的浮点纹理与实例化，
 * WebGL1 环境下无法降级，必须提前拦截并给出可读的提示。
 */
export function detectCapabilities() {
    const info = {
        ok: false,
        webgl2: false,
        colorBufferFloat: false,
        maxTextureSize: 0,
        renderer: '',
        reason: ''
    };

    if (typeof document === 'undefined' || !window.WebGL2RenderingContext) {
        info.reason = '当前环境不支持 WebGL2（3DGS 无法降级到 WebGL1 渲染）';
        return info;
    }

    let canvas = null;
    let gl = null;
    try {
        canvas = document.createElement('canvas');
        gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
        if (!gl) {
            info.reason = '当前环境无法创建 WebGL2 上下文';
            return info;
        }

        info.webgl2 = true;
        info.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
        info.colorBufferFloat = !!gl.getExtension('EXT_color_buffer_float');

        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
            info.renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '';
        }

        info.ok = true;
        if (!info.colorBufferFloat) {
            info.reason = '缺少 EXT_color_buffer_float 扩展，排序缓冲可能异常，画质会受影响';
        }
        return info;
    } catch (e) {
        info.reason = `WebGL2 初始化异常：${e && e.message ? e.message : e}`;
        return info;
    } finally {
        try {
            gl?.getExtension('WEBGL_lose_context')?.loseContext();
        } catch {
            // ignore
        }
    }
}

export class SplatViewer {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{ onStats?: (stats: object) => void }} [options]
     */
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.onStats = options.onStats ?? (() => {});

        this.entity = null;
        this.asset = null;
        this.model = null;
        this.baseEuler = [0, 0, 0];
        this.orientIndex = 0;
        this.pixelRatio = options.pixelRatio ?? 1;

        // 加载特效（默认「冲洗显影」，可切到「点云聚拢」）
        this.reveal = null;
        this.revealEnabled = options.reveal !== false;
        this.revealDuration = options.revealDuration ?? null;
        this.revealHold = options.revealHold ?? null;
        this.effectMode = EFFECT_MODES.includes(options.effect) ? options.effect : 'develop';

        this._fps = 0;
        this._accTime = 0;
        this._accFrames = 0;
        this._resizeObserver = null;
        this._rafPaused = false;
        this._timerDriver = null;
        this._probeTimer = null;

        this.app = new Application(canvas, {
            graphicsDeviceOptions: {
                // 3DGS 是填充率瓶颈，关掉 MSAA 能显著提升帧率
                antialias: false,
                alpha: false,
                preserveDrawingBuffer: false,
                powerPreference: 'high-performance'
            }
        });

        this.app.graphicsDevice.maxPixelRatio = this.pixelRatio;
        this.app.setCanvasFillMode(FILLMODE_NONE);

        this.camera = new Entity('Camera');
        this.camera.addComponent('camera', {
            clearColor: new Color(0.043, 0.051, 0.062),
            fov: 50,
            nearClip: 0.05,
            farClip: 500
        });
        this.app.root.addChild(this.camera);

        this.orbit = new OrbitCamera(this.camera, canvas);

        this.app.on('update', (dt) => this._tick(dt));
        this.app.start();

        this.resize();
        this._observeResize();
        this._watchFrameClock();
    }

    /**
     * 帧时钟兜底：浏览器窗口被遮挡、后台化，或小程序 webview 节流时，
     * requestAnimationFrame 会完全停摆（画面冻在上一帧、FPS 一直是 --）。
     * 这里用一个 700ms 的探针判断 rAF 是否还在跑，停了就改用定时器驱动 app.update。
     * rAF 恢复后自动交还给它，两者不会长期同时驱动。
     */
    _watchFrameClock() {
        const probe = () => {
            let fired = false;
            const id = requestAnimationFrame(() => {
                fired = true;
            });
            setTimeout(() => {
                cancelAnimationFrame(id);
                this._setRafPaused(!fired);
                this._probeTimer = setTimeout(probe, 1500);
            }, 700);
        };
        probe();
    }

    _setRafPaused(paused) {
        if (paused === this._rafPaused) return;
        this._rafPaused = paused;

        if (paused) {
            let last = performance.now();
            this._timerDriver = setInterval(() => {
                const now = performance.now();
                const dt = Math.min(Math.max((now - last) / 1000, 0), 0.1);
                last = now;
                // app.update 只跑逻辑，渲染要另外调 app.render（引擎的 rAF 循环里是两步分开的）
                this.app.update(dt);
                this.app.render();
            }, 16);
        } else if (this._timerDriver) {
            clearInterval(this._timerDriver);
            this._timerDriver = null;
        }
    }

    // ------------------------------------------------------------ 生命周期

    _tick(dt) {
        this.orbit.update(dt);
        this.reveal?.update(dt);

        this._accTime += dt;
        this._accFrames += 1;
        if (this._accTime >= 0.5) {
            this._fps = this._accFrames / this._accTime;
            this._accTime = 0;
            this._accFrames = 0;
            this.onStats(this.stats);
        }
    }

    get stats() {
        const device = this.app.graphicsDevice;
        return {
            fps: this._fps,
            numSplats: this.asset?.resource?.numSplats ?? 0,
            width: device.width,
            height: device.height,
            pixelRatio: device.maxPixelRatio
        };
    }

    resize() {
        const rect = this.canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width || this.canvas.clientWidth || 1));
        const h = Math.max(1, Math.round(rect.height || this.canvas.clientHeight || 1));
        this.app.graphicsDevice.resizeCanvas(w, h);
    }

    _observeResize() {
        const onChange = () => this.resize();
        window.addEventListener('resize', onChange);
        window.addEventListener('orientationchange', onChange);
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(onChange);
            this._resizeObserver.observe(this.canvas);
        }
        this._removeResize = () => {
            window.removeEventListener('resize', onChange);
            window.removeEventListener('orientationchange', onChange);
            this._resizeObserver?.disconnect();
        };
    }

    /** 画质档位：本质是限制渲染分辨率，3DGS 通常 1 ~ 2 之间最划算 */
    setPixelRatio(ratio) {
        this.pixelRatio = ratio;
        this.app.graphicsDevice.maxPixelRatio = ratio;
        this.resize();
    }

    // ------------------------------------------------------------ 模型加载

    /**
     * 加载一个 3DGS 模型
     * @param {{ id: string, name?: string, url?: string, file?: File, transform?: object }} source
     * @param {{ onProgress?: (p: {ratio: number, loaded: number, total: number, stage: string}) => void }} [options]
     */
    async load(source, options = {}) {
        const onProgress = options.onProgress ?? (() => {});

        await this.unload();

        const name = source.name || source.file?.name || source.url || 'model';
        // 扩展名必须以真实文件路径为准：name 只是展示名（如「玩具猫」）
        const fileRef = source.file?.name || source.url || '';
        const ext = fileRef.split('?')[0].split('.').pop().toLowerCase();
        if (!SUPPORTED_EXT.includes(ext)) {
            throw new Error(
                `不支持的模型格式「.${ext}」。当前支持 ${SUPPORTED_EXT.map((e) => '.' + e).join(' / ')}。`
            );
        }
        if (source.file && !LOCAL_SUPPORTED_EXT.includes(ext)) {
            throw new Error(
                `「.${ext}」不能单个文件导入：它需要同目录的附属文件。` +
                '请把整个目录放到 assets/models/ 并在 models.json 里登记地址，或用 .sog / .ply。'
            );
        }

        onProgress({ ratio: 0.02, loaded: 0, total: 0, stage: '准备加载' });

        let asset = null;

        if (source.file) {
            // 本地文件：走 asset.file.contents 直传，避免二次下载。
            // 必须包成 Response：引擎 2.24 的 PlyParser 只认 Response（直接取 response.body.getReader()），
            // 传 ArrayBuffer 会在「读取文件」阶段报 Error loading resource —— .ply 本地导入就卡在这里。
            // Response 是引擎远端下载时的标准形态，本地与远端因此走同一条解析路径。
            onProgress({ ratio: 0.3, loaded: 0, total: 0, stage: '读取文件' });
            const buffer = await source.file.arrayBuffer();
            const contents = new Response(buffer, {
                headers: { 'content-length': String(buffer.byteLength) }
            });
            asset = new Asset(`splat-${Date.now()}`, 'gsplat', {
                url: source.file.name,
                contents
            });
            onProgress({ ratio: 0.9, loaded: buffer.byteLength, total: buffer.byteLength, stage: '解析中' });
        } else {
            asset = new Asset(`splat-${Date.now()}`, 'gsplat', { url: source.url });
            // 引擎在 http 层会把进度 fire 到 asset 上
            asset.on('progress', (loaded, total) => {
                const ratio = total ? 0.02 + 0.88 * (loaded / total) : 0.5;
                onProgress({ ratio: Math.min(ratio, 0.9), loaded, total, stage: '下载中' });
            });
        }

        // 引擎把真正的解析/网络错误 fire 在 asset 上，loader 回调里只有一句
        // “Failed to load some assets”，不接住就没法给用户可读原因
        let assetError = null;
        asset.on('error', (e) => { assetError = e; });

        this.app.assets.add(asset);
        this.asset = asset;

        const loader = new AssetListLoader([asset], this.app.assets);
        const err = await new Promise((resolve) => loader.load(resolve));

        if (err || !asset.resource) {
            console.error('[gsplat] 加载失败原因：', assetError, err);
            await this.unload();
            throw new Error(normalizeAssetError(assetError || err));
        }

        onProgress({ ratio: 1, loaded: 0, total: 0, stage: '完成' });

        // 创建渲染实体：清单里的基准变换 + 轴向预设，合成一个四元数直接作用在 splat 实体上
        // （不做父实体嵌套：splat 组件对父级变换的取用行为不直观，嵌套容易把朝向算错）
        const entity = new Entity(name);
        const transform = source.transform ?? {};
        if (transform.position) entity.setLocalPosition(...toVec3(transform.position));
        if (transform.scale !== undefined) {
            const s = transform.scale;
            entity.setLocalScale(...(Array.isArray(s) ? toVec3(s) : toVec3([s, s, s])));
        }

        // unified=false：走单实例渲染路径，才能拿到 splat 的绘制材质，
        // 用于「点云 → 实体」特效注入 gsplatModifyVS 钩子。
        // 代价是排序从全局排序退化为每实例排序；本项目同一时刻只渲染一个模型，无影响。
        entity.addComponent('gsplat', { asset, unified: false });
        this.app.root.addChild(entity);

        this.entity = entity;
        this.assetModel = source;
        this.baseEuler = toVec3(transform.rotation ?? [0, 0, 0]);
        this.orientIndex = 0;
        this._applyOrientation();

        this.frame();
        this.orbit.markHome();
        this.onStats(this.stats);

        this._startReveal();

        return {
            numSplats: asset.resource?.numSplats ?? 0,
            aabb: asset.resource?.aabb ?? null
        };
    }

    // ------------------------------------------------------------ 加载特效

    /** 模型就绪后播放加载特效；关掉开关时直接以实体呈现 */
    _startReveal() {
        this.reveal?.destroy();
        this.reveal = null;

        if (!this.revealEnabled || !this.entity) return;

        const EffectClass = this.effectMode === 'gather' ? RevealEffect : DevelopEffect;
        const defaultMs = this.effectMode === 'gather' ? 1900 : 1600;

        try {
            this.reveal = new EffectClass(this.app, this.entity, this.asset?.resource, this.camera);
            if (this.reveal.ready === false) {
                this.reveal.destroy();
                this.reveal = null;
                return;
            }
            this.reveal.play({ duration: this.revealDuration ?? defaultMs });
            if (this.revealHold != null) this.reveal.hold(this.revealHold);
        } catch (e) {
            // 特效属于锦上添花，任何异常都不应影响模型本身的显示
            console.warn('加载特效初始化失败，已跳过', e);
            this.reveal = null;
        }
    }

    /** 重播特效（UI 上的「重播」按钮） */
    replayReveal() {
        if (!this.revealEnabled) return false;
        if (!this.reveal) {
            this._startReveal();
            return !!this.reveal;
        }
        this.reveal.play({ duration: this.revealDuration ?? (this.effectMode === 'gather' ? 1900 : 1600) });
        return true;
    }

    /** 切换特效类型并立即重播 */
    setEffectMode(mode) {
        if (!EFFECT_MODES.includes(mode) || mode === this.effectMode) return this.effectMode;
        this.effectMode = mode;
        this.revealEnabled = true;
        this._startReveal();
        return this.effectMode;
    }

    /** 按模型包围盒自动取景 */
    frame() {
        const resource = this.asset?.resource;
        if (!resource || !this.entity) return;

        const aabb = resource.aabb;
        if (!aabb) return;

        const wt = this.entity.getWorldTransform();
        const center = new Vec3();
        wt.transformPoint(aabb.center, center);

        const scale = new Vec3();
        wt.getScale(scale);
        const maxScale = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z), 1e-4);

        const radius = Math.max(aabb.halfExtents.length() * maxScale, 0.05);
        this.orbit.setView(center, radius);
    }

    resetView() {
        this.orbit.reset();
    }

    /**
     * 切换坐标系修正预设（循环调用即可）
     * @param {number} index
     */
    setOrientation(index) {
        this.orientIndex = ((index % ORIENT_PRESETS.length) + ORIENT_PRESETS.length) % ORIENT_PRESETS.length;
        this._applyOrientation();
        if (this.entity) {
            this.frame();
            this.orbit.markHome();
        }
        return this.orientation;
    }

    /** 把「清单基准旋转 + 轴向预设」合成为一个四元数，避免两次旋转互相覆盖 */
    _applyOrientation() {
        if (!this.entity) return;
        const base = new Quat().setFromEulerAngles(this.baseEuler[0], this.baseEuler[1], this.baseEuler[2]);
        const fix = new Quat().setFromEulerAngles(...ORIENT_PRESETS[this.orientIndex].euler);
        // 先应用基准旋转，再叠加轴向修正
        const combined = new Quat().mul2(fix, base);
        this.entity.setRotation(combined);
    }

    get orientation() {
        return ORIENT_PRESETS[this.orientIndex] ?? ORIENT_PRESETS[0];
    }

    async unload() {
        this.reveal?.destroy();
        this.reveal = null;
        if (this.entity) {
            this.entity.destroy();
            this.entity = null;
        }
        if (this.asset) {
            this.asset.off('progress');
            this.asset.unload();
            this.app.assets.remove(this.asset);
            this.asset = null;
        }
        this.model = null;
    }

    destroy() {
        clearTimeout(this._probeTimer);
        if (this._timerDriver) clearInterval(this._timerDriver);
        this._removeResize?.();
        this.orbit.destroy();
        this.unload();
        this.app.destroy();
    }
}

function toVec3(arr) {
    return [Number(arr[0] ?? 0), Number(arr[1] ?? 0), Number(arr[2] ?? 0)];
}

function normalizeAssetError(err) {
    const raw = String(err?.message ?? err ?? '未知错误');
    if (/No parser found/i.test(raw)) {
        return `引擎无法识别该文件：${raw}。请确认文件是有效的 3DGS 数据（.ply / .compressed.ply / .sog）。`;
    }
    if (/Error loading resource/i.test(raw)) {
        return `读取文件内容失败：${raw}。若为本地文件，请确认文件未损坏、且格式在支持列表内。`;
    }
    if (/404|not found/i.test(raw)) {
        return `模型文件未找到（404）：${raw}`;
    }
    if (/memory/i.test(raw)) {
        return `显存/内存不足，splat 数量超出设备上限：${raw}。建议使用 .sog 并降低 splat 数量。`;
    }
    return raw;
}
