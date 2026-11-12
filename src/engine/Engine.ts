import { OrbitCamera } from './Camera';
import { CameraTimeline, type CameraKey, type CameraState } from './CameraTimeline';
import { OrbitControls } from './OrbitControls';
import { PerfGovernor } from './PerfGovernor';
import { SplatLoader } from './SplatLoader';
import { SplatRenderer } from './SplatRenderer';
import { Tiles3D } from './Tiles3D';
import { VirtualRoom } from './VirtualRoom';
import { createProgram, type ProgramInfo } from './glutil';
import { clamp, easeOutCubic, type Vec3 } from './math';
import { applySplatTransform, transformMatrix } from './transform';
import { SKY_FS, SKY_VS } from './shaders';
import type { PerfStats, SceneManifest, SplatPayload } from './types';

export interface CameraPose {
  target: Vec3;
  distance: number;
  yaw: number;
  pitch: number;
}

export interface EngineHooks {
  onStats?: (s: PerfStats) => void;
  onContextLost?: () => void;
  onContextRestored?: () => void;
  onError?: (err: Error) => void;
  onFrame?: () => void;
}

const SKY_TOP: [number, number, number] = [0.60, 0.71, 0.80];
const SKY_BOTTOM: [number, number, number] = [0.87, 0.88, 0.86];
const SKY_GLOW: [number, number, number] = [1.0, 0.82, 0.52];

export class Engine {
  readonly camera = new OrbitCamera();
  readonly canvas: HTMLCanvasElement;
  controls!: OrbitControls;
  governor: PerfGovernor;
  hooks: EngineHooks = {};

  private gl!: WebGL2RenderingContext;
  private skyProg!: ProgramInfo;
  private emptyVao!: WebGLVertexArrayObject;
  private splats!: SplatRenderer;
  private tiles!: Tiles3D;
  private room!: VirtualRoom;
  private interior: VirtualRoom | null = null;
  private interiorAlpha = 0;
  private loader: SplatLoader;
  private raf = 0;
  private running = false;
  private lost = false;
  private lastTime = 0;
  private cssW = 1;
  private cssH = 1;

  private timeline = new CameraTimeline();
  private timelineBase: CameraState | null = null;

  private fpsEma = 60;
  private statsTimer = 0;
  private frameMs = 16.7;
  private loadedSplats: { payload: SplatPayload; lod: number; key: string }[] = [];
  private budgetOverride: number | null = null;
  private sliceCfg: {
    y0: number; y1: number; lift: number;
    dir: [number, number, number]; dim: number;
    box?: [number, number, number, number];
  } | null = null;
  private sliceAnim: { t0: number; dur: number; from: number; to: number } | null = null;
  private sliceEase: 'outCubic' | 'outBack' = 'outCubic';
  private splitAnim: { t0: number; dur: number; from: number; to: number } | null = null;
  private splitT = 0;
  private splitUp = 0;
  private splitDown = 0;
  private sliceT = 0;
  private sliceDone: (() => void) | null = null;
  private resolveStart = -1;
  private resolveDur = 2000;
  private resolveScatter = 0;
  private tilesetUrl: string | null = null;
  private tilesetBase = '';
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.loader = new SplatLoader();
    const ua = navigator.userAgent;
    const mobile = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(ua);
    const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 0;
    this.governor = new PerfGovernor(mobile, mem);
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('当前设备/浏览器不支持 WebGL2');
    this.gl = gl;
    gl.getExtension('EXT_color_buffer_float');
    this.camera.fov = 45;
    this.initGLObjects();

    this.controls = new OrbitControls(this.canvas, this.camera);
    this.controls.enabled = false;

    this.canvas.addEventListener('webglcontextlost', this.onLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.onRestored, false);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);

    this.resize();
    this.governor.freezeFor(900);
    return this;
  }

  private initGLObjects() {
    const gl = this.gl;
    this.skyProg = createProgram(gl, SKY_VS, SKY_FS, 'sky');
    this.emptyVao = gl.createVertexArray()!;
    this.splats = new SplatRenderer(gl);
    this.tiles = new Tiles3D(gl);
    this.room = new VirtualRoom(gl);
    this.applyQuality();
  }

  applyQuality() {
    if (!this.splats) return;
    this.splats.setBudget(this.budgetOverride ?? this.governor.splatBudget);
  }

  setHooks(h: EngineHooks) {
    this.hooks = h;
  }

  /** 入场动画：点云从粉尘态凝聚成实体（配合相机推进） */
  startResolve(duration = 2000) {
    const b = this.contentBounds();
    const radius = b
      ? 0.5 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])
      : 25;
    this.resolveScatter = Math.max(1.2, radius * 0.3);
    this.resolveStart = performance.now();
    this.resolveDur = duration;
    this.splats.setResolve(0, this.resolveScatter);
  }

  get splitState() {
    return { up: this.splitUp, down: this.splitDown, t: this.splitT, anim: !!this.splitAnim };
  }

  /** 楼体上下拆分：上半上移 up 米、下半下沉 down 米 */
  openSplit(up: number, down: number, duration = 900) {
    this.splitUp = up;
    this.splitDown = down;
    this.splitAnim = { t0: performance.now(), dur: duration, from: this.splitT, to: 1 };
  }

  closeSplit(duration = 600) {
    this.splitAnim = { t0: performance.now(), dur: duration, from: this.splitT, to: 0 };
  }

  private updateSplit(now: number) {
    if (!this.splitAnim) return;
    const raw = Math.min(1, (now - this.splitAnim.t0) / this.splitAnim.dur);
    this.splitT = this.splitAnim.from + (this.splitAnim.to - this.splitAnim.from) * easeOutCubic(raw);
    this.splats.setSplit(this.splitUp, this.splitDown, this.splitT);
    if (raw >= 1) this.splitAnim = null;
  }

  /** 伪分层抽屉：把 [y0,y1] 这一层沿 dir 平移 lift，其余部分压暗 */
  openSlice(
    cfg: { y0: number; y1: number; lift: number; dir: [number, number, number]; dim: number; box?: [number, number, number, number] },
    duration = 900,
    onDone?: () => void,
    ease: 'outCubic' | 'outBack' = 'outCubic',
  ) {
    this.sliceCfg = cfg;
    this.sliceDone = onDone ?? null;
    this.sliceEase = ease;
    this.sliceAnim = { t0: performance.now(), dur: duration, from: 0, to: 1 };
  }

  closeSlice(duration = 600) {
    if (!this.sliceCfg) return;
    this.sliceAnim = { t0: performance.now(), dur: duration, from: this.sliceT, to: 0 };
    this.sliceDone = null;
  }

  private updateSlice(now: number) {
    if (!this.sliceCfg) return;
    if (this.sliceAnim) {
      const t = Math.min(1, (now - this.sliceAnim.t0) / this.sliceAnim.dur);
      const e = this.sliceEase === 'outBack'
        ? 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2)
        : easeOutCubic(t);
      this.sliceT = this.sliceAnim.from + (this.sliceAnim.to - this.sliceAnim.from) * e;
      if (t >= 1) {
        this.sliceAnim = null;
        const cb = this.sliceDone;
        this.sliceDone = null;
        cb?.();
      }
    }
    this.splats.setSlice(
      this.sliceCfg.y0,
      this.sliceCfg.y1,
      this.sliceCfg.lift,
      this.sliceCfg.dir,
      this.sliceCfg.dim,
      this.sliceT,
    );
  }

  /** 抽屉式弹出虚拟楼层：从 anchor 沿 dir 滑出 dist，同时放大 + 淡入 */
  showRoom(
    anchor: [number, number, number],
    dir: [number, number, number],
    dist: number,
    duration = 1700,
    ease: 'outCubic' | 'outBack' = 'outBack',
  ) {
    this.roomAnim = { t0: performance.now(), dur: duration, anchor, dir, dist, ease };
  }

  /** 抽屉当前位姿（穿越动画要用） */
  get roomPose() {
    return { pos: [...this.roomPos] as [number, number, number], yaw: this.roomYaw };
  }

  /** 穿越中：把裙楼楼层瞬间收掉，换成同位置的小套间 */
  swapToInterior(x: number, y: number, z: number, yaw: number) {
    if (!this.interior) this.interior = new VirtualRoom(this.gl, 'suite');
    this.roomAnim = null;
    this.roomAlpha = 0;
    this.interiorAlpha = 1;
    this.interior.setPose(x, y, z, yaw, 1, 1, 1);
  }

  hideInterior() {
    this.interiorAlpha = 0;
  }

  hideRoom(duration = 500) {
    this.roomAnim = null;
    this.roomFade = { t0: performance.now(), dur: duration, from: this.roomAlpha, to: 0 };
  }

  private roomAnim: {
    t0: number; dur: number;
    anchor: [number, number, number]; dir: [number, number, number];
    dist: number; ease: 'outCubic' | 'outBack';
  } | null = null;
  private roomFade: { t0: number; dur: number; from: number; to: number } | null = null;
  private roomAlpha = 0;

  private updateRoom(now: number) {
    if (this.roomAnim) {
      const raw = Math.min(1, (now - this.roomAnim.t0) / this.roomAnim.dur);
      // outBack：末端轻微过冲再回弹，抽屉「滑到底」的手感
      const t = this.roomAnim.ease === 'outBack'
        ? 1 + 2.70158 * Math.pow(raw - 1, 3) + 1.70158 * Math.pow(raw - 1, 2)
        : easeOutCubic(raw);
      const { anchor, dir, dist } = this.roomAnim;
      const yaw = Math.atan2(this.camera.eye[0] - anchor[0], this.camera.eye[2] - anchor[2]);
      const px = anchor[0] + dir[0] * dist * t;
      const py = anchor[1] + dir[1] * dist * t;
      const pz = anchor[2] + dir[2] * dist * t;
      this.roomPos = [px, py, pz];
      this.roomYaw = yaw;
      // 先隐着往上走，进到缝里再逐渐显形；显形本身是自下而上的渐变
      this.roomAlpha = Math.min(1, Math.max(0, (raw - 0.18) / 0.5));
      const reveal = Math.min(1, Math.max(0, (raw - 0.1) / 0.62));
      this.room.setPose(px, py, pz, yaw, 1, this.roomAlpha, reveal);
      if (raw >= 1) this.roomAnim = null;
      return;
    }
    if (this.roomFade) {
      const raw = Math.min(1, (now - this.roomFade.t0) / this.roomFade.dur);
      this.roomAlpha = this.roomFade.from + (this.roomFade.to - this.roomFade.from) * raw;
      this.room.setPose(this.roomPos[0], this.roomPos[1], this.roomPos[2], this.roomYaw, 1, this.roomAlpha);
      if (raw >= 1) this.roomFade = null;
      return;
    }
    if (this.roomAlpha > 0.002) this.room.setPose(this.roomPos[0], this.roomPos[1], this.roomPos[2], this.roomYaw, 1, this.roomAlpha);
  }

  private roomPos: [number, number, number] = [0, 0, 0];
  private roomYaw = 0;

  /** 跳过入场，直接呈现实体 */
  setResolveInstant() {
    this.resolveStart = -1;
    this.splats.setResolve(1, 0);
  }

  /** 固定 splat 绘制预算（调试大模型时用），传 null 恢复自适应 */
  setBudgetOverride(n: number | null) {
    this.budgetOverride = n && n > 0 ? Math.round(n) : null;
    this.applyQuality();
  }

  get shed(): SplatRenderer {
    return this.splats;
  }

  get tileRenderer(): Tiles3D {
    return this.tiles;
  }

  get isLost() {
    return this.lost;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(1, rect.width);
    this.cssH = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.max(0.4, dpr * this.governor.renderScale);
    const w = Math.max(1, Math.round(this.cssW * scale));
    const h = Math.max(1, Math.round(this.cssH * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.camera.setViewport(w, h);
  }

  private onResize = () => {
    this.resize();
  };

  private onVisibility = () => {
    if (document.hidden) this.stop();
    else if (!this.lost) this.start();
  };

  private onLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
    this.stop();
    this.hooks.onContextLost?.();
  };

  private onRestored = () => {
    try {
      this.initGLObjects();
      for (const item of this.loadedSplats) this.splats.addTile(item.payload, item.lod, item.key);
      this.lost = false;
      if (this.tilesetUrl) {
        this.tiles.load(this.tilesetUrl, this.tilesetBase).catch((err) => this.hooks.onError?.(err));
      }
      this.hooks.onContextRestored?.();
      this.start();
    } catch (err) {
      this.hooks.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  /** 加载场景：3DGS 分块按「近景优先 + LOD0 优先」排队，倾斜摄影并行流式加载 */
  async loadScene(manifest: SceneManifest, baseUrl: string, onProgress?: (p: number, detail?: string) => void) {
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    const splatTransform = manifest.splat.transform ?? null;
    const rotOrder = manifest.splat.rotOrder ?? 'auto';
    if ((!manifest.splat.tiles || manifest.splat.tiles.length === 0) && manifest.splat.source) {
      // 单文件资产（.ply/.splat）：按空间自动切块，一次性加载
      const url = new URL(manifest.splat.source, base).href;
      try {
        const tiles = await this.loader.load(url, false, (loaded, total) => {
          const mb = (n: number) => (n / 1048576).toFixed(1);
          onProgress?.(total > 0 ? Math.min(0.98, loaded / total) : 0.3, `${mb(loaded)}MB / ${total ? mb(total) + 'MB' : '?'}`);
        }, rotOrder);
        for (let k = 0; k < tiles.length; k++) {
          applySplatTransform(tiles[k], splatTransform);
          const key = `src#${k}`;
          this.splats.addTile(tiles[k], 0, key);
          this.loadedSplats.push({ payload: tiles[k], lod: 0, key });
        }
        onProgress?.(1, `${tiles.reduce((a, t) => a + t.count, 0).toLocaleString()} splats`);
      } catch (err) {
        this.hooks.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
    const entries = manifest.splat.tiles.slice().sort((a, b) => {
      if (a.lod !== b.lod) return a.lod - b.lod;
      const da = Math.hypot(a.min[0] - manifest.camera.target[0], a.min[2] - manifest.camera.target[2]);
      const db = Math.hypot(b.min[0] - manifest.camera.target[0], b.min[2] - manifest.camera.target[2]);
      return da - db;
    });

    const total = entries.length || 1;
    let done = 0;
    const concurrency = 2;
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= entries.length) return;
        const e = entries[i];
        const url = new URL(e.url, base).href;
        const key = e.key ?? `${e.url}@${e.lod}`;
        try {
          const tiles = await this.loader.load(url, !!e.key, undefined, rotOrder);
          for (let k = 0; k < tiles.length; k++) {
            const payload = tiles[k];
            applySplatTransform(payload, splatTransform);
            const tileKey = tiles.length > 1 ? `${key}#${k}` : key;
            this.splats.addTile(payload, e.lod, tileKey);
            this.loadedSplats.push({ payload, lod: e.lod, key: tileKey });
          }
          if (e.lod === 0 && done === 0) this.hooks.onStats?.(this.buildStats());
        } catch (err) {
          this.hooks.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
        done++;
        onProgress?.(Math.min(1, done / total));
      }
    };
    const workers = Array.from({ length: Math.min(concurrency, entries.length) }, worker);
    this.tiles.setRootTransform(transformMatrix(manifest.tilesetTransform));
    const tilesetPromise = manifest.tileset
      ? (() => {
          this.tilesetUrl = new URL(manifest.tileset!, base).href;
          this.tilesetBase = this.tilesetUrl.slice(0, this.tilesetUrl.lastIndexOf('/') + 1);
          return this.tiles.load(this.tilesetUrl, this.tilesetBase).catch((err) => {
            this.hooks.onError?.(err instanceof Error ? err : new Error(String(err)));
          });
        })()
      : Promise.resolve();

    await Promise.all([...workers, tilesetPromise]);
  }

  /** 已加载内容的整体包围盒（点云优先；两个模型量级差太多时只取点云） */
  contentBounds(): { min: [number, number, number]; max: [number, number, number] } | null {
    const a = this.splats.bounds;
    const b = this.tiles.bounds;
    const diagonal = (x: { min: number[]; max: number[] }) =>
      Math.hypot(x.max[0] - x.min[0], x.max[1] - x.min[1], x.max[2] - x.min[2]);
    if (a && b) return diagonal(a) * 20 < diagonal(b) ? a : {
      min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
      max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
    };
    return a ?? b;
  }

  /** 自动取景：把已加载模型完整框进画面（调试陌生资产时的第一步） */
  autoFrame(margin = 1.05): boolean {
    const b = this.contentBounds();
    if (!b) return false;
    const cx = (b.min[0] + b.max[0]) / 2;
    const cy = (b.min[1] + b.max[1]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    // 用最大边长而不是对角线：地面类模型（倾斜摄影）用对角线取景会退得太远
    const radius = Math.max(
      0.5 * Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 1.08,
      0.5,
    );
    const vf = (this.camera.fov * Math.PI) / 180;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * this.camera.aspectRatio);
    const fit = Math.min(vf, hf);
    const dist = (radius / Math.max(Math.sin(fit / 2), 0.04)) * margin;
    this.camera.target = [cx, cy, cz];
    this.camera.distance = clamp(dist, 2, 40000);
    this.camera.far = Math.max(4000, this.camera.distance * 12);
    this.camera.pitch = 0.55;
    this.camera.update();
    // 缩放范围跟着模型尺度走，否则大模型会被默认的 420m 上限卡住
    this.controls?.setLimits(this.camera.distance * 0.08, this.camera.distance * 5);
    return true;
  }

  applyCameraPose(pose: CameraPose) {
    this.camera.target = [...pose.target] as Vec3;
    this.camera.distance = pose.distance;
    this.camera.yaw = pose.yaw;
    this.camera.pitch = pose.pitch;
    this.camera.update();
    this.controls?.setLimits(pose.distance * 0.1, pose.distance * 5);
  }

  playIntro(from: CameraPose, to: CameraPose, duration = 2600) {
    this.applyCameraPose(from);
    this.playTimeline([
      { t: 0, target: from.target, distance: from.distance, yaw: from.yaw, pitch: from.pitch, fov: this.camera.fov },
      { t: duration / 1000, target: to.target, distance: to.distance, yaw: to.yaw, pitch: to.pitch, ease: 'inOutCubic' },
    ]);
  }

  /** 多段镜头时间轴：抽屉动效这类分段节奏用它表达 */
  playTimeline(keys: CameraKey[], onDone?: () => void) {
    this.timelineBase = this.currentState();
    this.controls.enabled = false;
    this.timeline.play(keys, () => {
      this.controls.enabled = true;
      onDone?.();
    });
  }

  cancelTimeline() {
    this.timeline.cancel();
    this.controls.enabled = true;
  }

  get currentFps() {
    return this.fpsEma;
  }

  get timelinePlaying() {
    return this.timeline.playing;
  }

  get timelineInfo() {
    return { playing: this.timeline.playing, total: this.timeline.total, elapsed: this.timeline.elapsed };
  }

  private currentState(): CameraState {
    return {
      target: [this.camera.target[0], this.camera.target[1], this.camera.target[2]],
      distance: this.camera.distance,
      yaw: this.camera.yaw,
      pitch: this.camera.pitch,
      fov: this.camera.fov,
    };
  }

  flyTo(to: CameraPose, duration = 900) {
    const from = this.currentState();
    this.playTimeline([
      { t: 0, target: from.target, distance: from.distance, yaw: from.yaw, pitch: from.pitch, fov: from.fov },
      { t: duration / 1000, target: to.target, distance: to.distance, yaw: to.yaw, pitch: to.pitch, ease: 'inOutCubic' },
    ]);
  }

  private updateAnim(now: number) {
    if (!this.timeline.playing) return;
    const base = this.timelineBase ?? this.currentState();
    const { state } = this.timeline.update(now, base);
    this.camera.target = [state.target[0], state.target[1], state.target[2]];
    this.camera.distance = state.distance;
    this.camera.yaw = state.yaw;
    this.camera.pitch = state.pitch;
    this.camera.fov = state.fov;
  }

  start() {
    if (this.running || this.lost || this.disposed) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.tick(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private tick(now: number) {
    const dt = Math.min(now - this.lastTime, 200);
    this.lastTime = now;
    try {
      this.governor.sample(dt);
      this.splats.setBudget(this.budgetOverride ?? this.governor.splatBudget);
      this.splats.maxSorts = this.governor.sortsPerFrame;

      this.controls.update(dt / 1000);
      this.updateAnim(now);
      this.camera.update();

      this.updateSplit(now);
      this.updateSlice(now);
      if (this.resolveStart > 0) {
        const t = Math.min(1, (now - this.resolveStart) / this.resolveDur);
        this.splats.setResolve(easeOutCubic(t), Math.max(0.001, this.resolveScatter * (1 - t)));
        if (t >= 1) {
          this.resolveStart = -1;
          this.splats.setResolve(1, 0);
        }
      }

      const gl = this.gl;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(SKY_BOTTOM[0], SKY_BOTTOM[1], SKY_BOTTOM[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      this.drawSky();

      this.tiles.update(this.camera, this.canvas.height, this.governor.maxSSE);
      this.tiles.render(this.camera);

      this.splats.update(this.camera, dt / 1000);
      this.splats.render(this.camera, this.canvas.width, this.canvas.height);
      this.updateRoom(now);
      this.room.render(this.camera);
      if (this.interior && this.interiorAlpha > 0.002) this.interior.render(this.camera);

      this.frameMs = this.frameMs * 0.9 + dt * 0.1;
      this.fpsEma = this.fpsEma * 0.9 + (1000 / Math.max(dt, 1)) * 0.1;
      this.statsTimer += dt;
      if (this.statsTimer > 240) {
        this.statsTimer = 0;
        this.hooks.onStats?.(this.buildStats());
      }
    } catch (err) {
      this.stop();
      this.hooks.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private drawSky() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.useProgram(this.skyProg.program);
    gl.uniform3fv(this.skyProg.uniforms.get('uTop') ?? null, SKY_TOP);
    gl.uniform3fv(this.skyProg.uniforms.get('uBottom') ?? null, SKY_BOTTOM);
    gl.uniform3fv(this.skyProg.uniforms.get('uGlow') ?? null, SKY_GLOW);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  private buildStats(): PerfStats {
    const s = this.splats.stats;
    const t = this.tiles.tileStats;
    return {
      fps: Math.round(this.fpsEma),
      frameMs: Number(this.frameMs.toFixed(2)),
      drawCalls: s.drawCalls + t.drawCalls,
      splats: s.splats,
      sse: t.selected,
      renderScale: this.governor.renderScale,
      budget: this.budgetOverride ?? this.governor.splatBudget,
      total: s.total,
      gpuMemoryMB: Math.round((s.gpuMemoryBytes + t.gpuBytes) / 1048576),
      quality: this.governor.tier.name,
    };
  }

  project(p: Vec3) {
    return this.camera.project(p, this.cssW, this.cssH);
  }

  get viewport() {
    return { width: this.cssW, height: this.cssH };
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.controls?.dispose();
    this.loader.dispose();
    this.splats?.dispose();
    this.tiles?.dispose();
    this.room?.dispose();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
  }
}
