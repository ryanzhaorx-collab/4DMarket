/**
 * PlayCanvas 版加载引擎（P1/P2）。
 * - 复用自研的 OrbitCamera / OrbitControls / CameraTimeline（纯数学，与渲染无关）
 * - 3DGS 用 PlayCanvas 的 gsplat 组件
 * - 上下拆分 = 三块预切资产（lower / mid / upper）分别位移
 * - 抽屉 = 程序化楼板 mesh（MeshBuilder）沿方向升起
 */
import * as pc from 'playcanvas';
import { OrbitCamera } from '../Camera';
import { OrbitControls } from '../OrbitControls';
import { CameraTimeline, type CameraKey } from '../CameraTimeline';
import { MeshBuilder } from '../VirtualRoom';
import type { Vec3 } from '../math';

export type PcEngineOptions = {
  canvas: HTMLCanvasElement;
  /** 由下到上的楼层资产（.sog），用于「千层糕」分层展开 */
  layers: string[];
  /** 真实室内扫描（.sog），放在被抽出的楼层里 */
  roomUrl?: string;
};

const toVec = (v: Vec3) => new pc.Vec3(v[0], v[1], v[2]);

export class PcEngine {
  readonly camera = new OrbitCamera();
  readonly controls: OrbitControls;
  readonly app: pc.Application;

  private camEntity: pc.Entity;
  private root: pc.Entity;
  private layerEntities: pc.Entity[] = [];
  private interiorEntity: pc.Entity | null = null;
  /** 室内扫描的朝向/缩放，先用参数试，定了再写死 */
  interiorRot: [number, number, number] = [-90, 0, 0];
  interiorScale = 1;   // 缩放已烘进资产，这里保持 1
  /** 扫描模型的中心偏移（标定用，单位与扫描一致） */
  interiorOffset: [number, number, number] = [0, 0, 0];
  /** 第二页室内机位距离（可 URL 覆盖，便于标定） */
  roomDistance = 95;
  private roomEntity: pc.Entity | null = null;
  private roomAnim: { t0: number; dur: number; from: Vec3; to: Vec3; ease: string } | null = null;
  private roomOpacity = 0;
  private roomPos: Vec3 = [0, 0, 0];

  private timeline = new CameraTimeline();
  private timelineBase: { target: Vec3; distance: number; yaw: number; pitch: number; fov: number } | null = null;
  private timelinePlayingFlag = false;

  /** 分层展开进度 0..1 */
  private unfoldT = 0;
  private unfoldTarget = 0;
  private unfoldSpeed = 1.6;
  /** 每层纵向拉开距离（米）——爆炸图的主方向 */
  unfoldSpreadY = 62;
  /** 每层横向错位（米），让层次更清晰 */
  unfoldSpreadX = 0;
  /** 展开时被抽走的那层（索引） */
  targetLayer = 3;

  private bounds: { min: Vec3; max: Vec3 } | null = null;
  private fps = 60;
  private last = performance.now();
  private loaded = 0;
  /** 首块（远景）就绪 */
  onFirstPaint: (() => void) | null = null;
  /** 全部就绪 */
  onFullLoad: (() => void) | null = null;

  constructor(opts: PcEngineOptions) {
    this.opts = opts;
    this.app = new pc.Application(opts.canvas, {
      graphicsDeviceOptions: { antialias: false, alpha: false, powerPreference: 'high-performance' },
    });
    this.app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    this.app.setCanvasResolution(pc.RESOLUTION_AUTO);
    // 手机 GPU 顶不住 3x 屏：按设备能力封顶像素比
    const dpr = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dpr')) || 2;
    this.app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio || 1, dpr);
    this.app.start();

    this.app.scene.ambientLight = new pc.Color(0.55, 0.6, 0.68);
    this.root = new pc.Entity('splat-root', this.app);
    this.camEntity = new pc.Entity('camera', this.app);
    this.camEntity.addComponent('camera', {
      fov: 52, nearClip: 0.4, farClip: 6000,
      clearColor: new pc.Color(0.76, 0.82, 0.86),
    });
    this.app.root.addChild(this.camEntity);

    this.app.root.addChild(this.root);

    const sun = new pc.Entity('sun', this.app);
    sun.addComponent('light', {
      type: 'directional',
      color: new pc.Color(1, 0.96, 0.9),
      intensity: 1.1,
      castShadows: false,
    });
    sun.setEulerAngles(38, 40, 0);
    this.app.root.addChild(sun);

    const fill = new pc.Entity('fill', this.app);
    fill.addComponent('light', { type: 'omni', color: new pc.Color(0.7, 0.8, 1), intensity: 0.6, range: 4000 });
    fill.setPosition(0, 200, 0);
    this.app.root.addChild(fill);

    this.controls = new OrbitControls(opts.canvas, this.camera);
    this.app.on('update', () => this.onUpdate());
  }

  private opts: PcEngineOptions;

  /** 加载真实室内扫描，挂到楼层实体下面，跟着盘子一起动 */
  private loadInterior(url: string) {
    const asset = new pc.Asset('interior', 'gsplat', { url });
    this.app.assets.add(asset);
    asset.on('load', () => {
      const e = new pc.Entity('interior', this.app);
      e.addComponent('gsplat', { asset });
      e.setLocalEulerAngles(...this.interiorRot);
      e.setLocalScale(this.interiorScale, this.interiorScale, this.interiorScale);
      e.enabled = false;
      this.app.root.addChild(e);
      this.interiorEntity = e;
      if (this.roomMode) e.enabled = true;
    });
    asset.on('error', (err: unknown) => console.warn('[pc] 室内资产加载失败', err));
    this.app.assets.load(asset);
  }

  /** 让室内扫描跟随楼层位置/可见性 */
  setInterior(on: boolean) {
    if (this.interiorEntity) this.interiorEntity.enabled = on;
  }

  /** 第二页：进入室内模式——隐藏整栋楼，只看房间，可自由环绕 */
  enterRoomScene() {
    for (const e of this.layerEntities) if (e) e.enabled = false;
    if (this.roomEntity) this.roomEntity.enabled = false;
    if (!this.interiorEntity) return;
    this.interiorEntity.enabled = true;
    // 扫描内容的中心不等于包围盒中心，用 offset 把它挪到世界原点
    const sc = this.interiorScale;
    this.interiorEntity.setPosition(
      -this.interiorOffset[0] * sc,
      -this.interiorOffset[1] * sc,
      -this.interiorOffset[2] * sc,
    );
    this.interiorEntity.setLocalEulerAngles(...this.interiorRot);
    this.interiorEntity.setLocalScale(this.interiorScale, this.interiorScale, this.interiorScale);

    // 相机对准房间中心
    this.camera.target = [0, 6, 0];
    this.camera.distance = this.roomDistance;
    this.camera.yaw = 0.3;
    this.camera.pitch = 0.06;
    this.camera.fov = 58;
    this.controls.enabled = true;
    this.controls.autoRotate = false;
    // OrbitControls 有自己的 yaw/pitch 状态，改完相机必须同步回去，否则会被覆盖
    (this.controls as unknown as { syncFromCamera?: () => void }).syncFromCamera?.();
    this.roomMode = true;
  }

  /** 退出室内，恢复整栋楼 */
  exitRoomScene() {
    this.roomMode = false;
    for (const e of this.layerEntities) if (e) e.enabled = true;
    if (this.interiorEntity) this.interiorEntity.enabled = false;
  }

  private roomMode = false;

  private loadLayer(index: number, url: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const key = `layer-${index}`;
      const asset = new pc.Asset(key, 'gsplat', { url });
      this.app.assets.add(asset);
      asset.on('load', () => {
        const e = new pc.Entity(key, this.app);
        e.addComponent('gsplat', { asset });
        // 每层自己把 Z-up 数据扶正；父节点不再旋转，位移直接用世界轴
        e.setEulerAngles(-90, 0, 0);
        this.root.addChild(e);
        this.layerEntities[index] = e;
        this.loaded++;
        resolve();
      });
      asset.on('error', () => resolve());
      this.app.assets.load(asset);
    });
  }

  /**
   * 分级加载：先只加载下半部分（远景轮廓立刻可看），
   * 之后在后台补中间层和上半部分——这是手机上「点开就能看」的关键。
   */
  async start(): Promise<void> {
    const urls = this.opts.layers;
    // 先加载「点数最多」的那层（通常是主体），再并行补其余
    await this.loadLayer(0, urls[0]);
    this.onFirstPaint?.();
    if (this.opts.roomUrl) this.loadInterior(this.opts.roomUrl);
    const rest = urls.slice(1).map((u, i) => this.loadLayer(i + 1, u));
    void Promise.all(rest).then(() => this.onFullLoad?.());

    this.bounds = {
      min: [-104, -70, -113],
      max: [119, 116, 110],
    };
    const b = this.bounds;
    this.camera.target = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    this.camera.distance = 460;
    this.camera.yaw = 0.62;
    this.camera.pitch = 0.38;
    this.camera.fov = 52;
  }

  /** resolve 近似：整体从 0.88 放大到 1，配合镜头推进做「凝聚成形」 */
  startResolve(duration = 1400) {
    this.resolve = { t0: performance.now(), dur: duration };
  }

  private resolve: { t0: number; dur: number } | null = null;

  /** 当前是否支持 WebGL2（PlayCanvas 必需） */
  static supported(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!c.getContext('webgl2');
    } catch {
      return false;
    }
  }

  contentBounds() {
    return this.bounds;
  }

  applyCameraPose(p: { target: Vec3; distance: number; yaw: number; pitch: number; fov: number }) {
    this.camera.target = [...p.target] as Vec3;
    this.camera.distance = p.distance;
    this.camera.yaw = p.yaw;
    this.camera.pitch = p.pitch;
    this.camera.fov = p.fov;
  }

  playTimeline(keys: CameraKey[], onDone?: () => void) {
    this.timelineBase = {
      target: [...this.camera.target] as Vec3,
      distance: this.camera.distance,
      yaw: this.camera.yaw,
      pitch: this.camera.pitch,
      fov: this.camera.fov,
    };
    this.timeline.play(keys, () => {
      this.timelinePlayingFlag = false;
      this.controls.enabled = true;
      onDone?.();
    });
    this.timelinePlayingFlag = true;
    this.controls.enabled = false;
  }

  get timelinePlaying() {
    return this.timelinePlayingFlag;
  }

  /** 千层糕：各层沿水平方向错开，目标层再额外抽出来 */
  openUnfold(spread = 26, duration = 1400, targetLayer = 3) {
    this.unfoldSpreadY = spread;
    this.targetLayer = targetLayer;
    this.unfoldTarget = 1;
    this.unfoldSpeed = 1000 / Math.max(duration, 1);
  }

  closeUnfold(duration = 800) {
    this.unfoldTarget = 0;
    this.unfoldSpeed = 1000 / Math.max(duration, 1);
  }

  /** 兼容旧接口 */
  openSplit(up: number, down: number, duration = 900) {
    void up;
    void down;
    this.openUnfold(this.unfoldSpreadY, duration, this.targetLayer);
  }

  closeSplit(duration = 700) {
    this.closeUnfold(duration);
  }

  openSlice(_cfg: unknown, _duration = 900) {}
  closeSlice(_duration = 600) {}
  setBudgetOverride(_n: number) {}

  private roomReady = false;

  /** 首帧之后才创建 mesh / 材质：PlayCanvas 需要「当前 application」上下文 */
  private initRoomLater() {
    if (this.roomReady) return;
    this.roomReady = true;
    this.buildRoomMesh();
  }

  private ensureRoom() {
    this.initRoomLater();
    if (!this.roomEntity) return null;
    return this.roomEntity;
  }

  private buildRoomMesh() {
    const b = new MeshBuilder();
    const W = 3.5, D = 3, H = 3.2;   // 玻璃房间盒：7 × 6 × 3.2m
    b.box([-W - 1, -0.9, -D - 1], [W + 1, 0, D + 1], [40, 38, 34]);
    b.box([-W, 0, -D], [W, 0.08, D], [26, 24, 21]);
    const trim: [number, number, number][] = [
      [-W - 0.5, W + 0.5, -D - 0.5, -D],
      [-W - 0.5, W + 0.5, D, D + 0.5],
      [-W - 0.5, -W, -D, D],
      [W, W + 0.5, -D, D],
    ].map((v) => [v[0], v[1], v[2]] as [number, number, number]);
    void trim;
    b.box([-W - 0.5, H - 0.24, -D - 0.5], [W + 0.5, H, -D], [214, 178, 106]);
    b.box([-W - 0.5, H - 0.24, D], [W + 0.5, H, D + 0.5], [214, 178, 106]);
    b.box([-W - 0.5, H - 0.24, -D], [-W, H, D], [214, 178, 106]);
    b.box([W, H - 0.24, -D], [W + 0.5, H, D], [214, 178, 106]);
    // 四角立柱
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      b.box([sx * W - 0.08, 0, sz * D - 0.08], [sx * W + 0.08, H, sz * D + 0.08], [214, 178, 106]);
    }

    const mesh = new pc.Mesh(this.app.graphicsDevice);
    mesh.setPositions(new Float32Array(b.pos));
    mesh.setNormals(new Float32Array(b.nrm));
    const cols = new Float32Array((b.pos.length / 3) * 4);
    for (let i = 0; i < b.pos.length / 3; i++) {
      cols[i * 4] = b.col[i * 4] / 255;
      cols[i * 4 + 1] = b.col[i * 4 + 1] / 255;
      cols[i * 4 + 2] = b.col[i * 4 + 2] / 255;
      cols[i * 4 + 3] = 1;
    }
    mesh.setColors(cols as unknown as number[]);
    mesh.setIndices(new Uint32Array(b.idx));
    mesh.update(pc.PRIMITIVE_TRIANGLES);

    const material = this.app.scene.defaultMaterial.clone();
    material.diffuse = new pc.Color(1, 1, 1);
    material.diffuseVertexColor = true;
    material.blendType = pc.BLEND_NORMAL;
    material.depthWrite = false;
    material.opacity = 0.62;   // 玻璃感：能透出一点内部
    material.update();

    // 边缘发光：金色轮廓线（爆炸图里那一圈高亮）
    const edgeMat = this.app.scene.defaultMaterial.clone();
    edgeMat.diffuse = new pc.Color(1, 1, 1);
    edgeMat.diffuseVertexColor = true;
    edgeMat.emissive = new pc.Color(0.35, 0.75, 1);
    edgeMat.emissiveIntensity = 0.9;
    edgeMat.opacity = 0.16;
    edgeMat.blendType = pc.BLEND_ADDITIVEALPHA;
    edgeMat.depthWrite = false;
    edgeMat.update();

    const e = new pc.Entity('room', this.app);
    e.addComponent('render', { type: 'asset' });
    // 暖光内景：一张床 + 两盏灯（让玻璃盒里「有东西」）
    const inner = new MeshBuilder();
    inner.box([-8, 0.1, -6], [8, 1.1, 2], [222, 214, 198]);        // 床
    inner.box([-8.2, 1.1, 1.4], [8.2, 2.0, 2.2], [150, 120, 92]);  // 床头板
    inner.box([-2, 2.2, -9], [2, 2.6, -8], [255, 224, 160]);       // 顶灯
    inner.box([13, 1.0, -8], [14, 2.2, -7], [255, 210, 140]);      // 落地灯
    const innerMesh = new pc.Mesh(this.app.graphicsDevice);
    innerMesh.setPositions(new Float32Array(inner.pos));
    innerMesh.setNormals(new Float32Array(inner.nrm));
    const innerCols = new Float32Array((inner.pos.length / 3) * 4);
    for (let i = 0; i < inner.pos.length / 3; i++) {
      innerCols[i * 4] = inner.col[i * 4] / 255;
      innerCols[i * 4 + 1] = inner.col[i * 4 + 1] / 255;
      innerCols[i * 4 + 2] = inner.col[i * 4 + 2] / 255;
      innerCols[i * 4 + 3] = 1;
    }
    innerMesh.setColors(innerCols as unknown as number[]);
    innerMesh.setIndices(new Uint32Array(inner.idx));
    innerMesh.update(pc.PRIMITIVE_TRIANGLES);
    const innerMat = this.app.scene.defaultMaterial.clone();
    innerMat.diffuse = new pc.Color(1, 1, 1);
    innerMat.diffuseVertexColor = true;
    innerMat.emissive = new pc.Color(0.5, 0.38, 0.2);
    innerMat.emissiveIntensity = 0.8;
    innerMat.update();

    const mi = new pc.MeshInstance(mesh, material);
    mi.castShadow = false;
    const miEdge = new pc.MeshInstance(mesh, edgeMat);
    miEdge.castShadow = false;
    const miInner = new pc.MeshInstance(innerMesh, innerMat);
    miInner.castShadow = false;
    e.render!.meshInstances = [miEdge];
    // 注意：MeshBuilder 的几何本身就是 Y-up（薄的方向是 Y），
    // 这里绝对不能再绕 X 转 -90°，否则楼板会立起来。
    e.enabled = false;
    this.app.root.addChild(e);
    this.roomEntity = e;
  }

  showRoom(anchor: Vec3, dir: Vec3, dist: number, duration = 1400, ease = 'outBack') {
    const e = this.ensureRoom();
    if (!e) return;
    e.enabled = true;
    const to: Vec3 = [anchor[0] + dir[0] * dist, anchor[1] + dir[1] * dist, anchor[2] + dir[2] * dist];
    this.roomPos = [...anchor] as Vec3;
    this.roomAnim = { t0: performance.now(), dur: duration, from: [...anchor] as Vec3, to, ease };
  }

  /** 原地渐显（不位移）：楼体拆分完之后先让玻璃层显出来 */
  revealRoom(duration = 700) {
    this.showRoom([this.roomPos[0], this.roomPos[1], this.roomPos[2]], [0, 0, 0], 0, duration, 'linear');
  }

  hideRoom(_duration = 450) {
    this.roomOpacity = 0;
    this.roomAnim = null;
    if (this.roomEntity) this.roomEntity.enabled = false;
  }

  private onUpdate() {
    if (!this.roomReady) this.initRoomLater();
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.fps = this.fps * 0.92 + (1 / Math.max(dt, 0.001)) * 0.08;

    if (this.timelinePlayingFlag && this.timelineBase) {
      const { state } = this.timeline.update(now, this.timelineBase);
      this.camera.target = [...state.target] as Vec3;
      this.camera.distance = state.distance;
      this.camera.yaw = state.yaw;
      this.camera.pitch = state.pitch;
      this.camera.fov = state.fov;
    } else {
      this.controls.update(dt);
    }

    this.camera.update();
    this.camEntity.setPosition(this.camera.eye[0], this.camera.eye[1], this.camera.eye[2]);
    this.camEntity.lookAt(toVec(this.camera.target));
    this.camEntity.camera!.fov = this.camera.fov;

    // resolve：整体缩放凝聚
    if (this.resolve) {
      const raw = Math.min(1, (now - this.resolve.t0) / this.resolve.dur);
      const e = 1 - Math.pow(1 - raw, 3);
      const k = 0.88 + 0.12 * e;
      this.root.setLocalScale(k, k, k);
      if (raw >= 1) { this.resolve = null; this.root.setLocalScale(1, 1, 1); }
    }

    // 千层糕展开：第 i 层横向偏移 (i - 中心) * spread * k
    if (this.unfoldT !== this.unfoldTarget || this.unfoldT > 0) {
      this.unfoldT += (this.unfoldTarget - this.unfoldT) * Math.min(1, dt * this.unfoldSpeed);
      if (Math.abs(this.unfoldTarget - this.unfoldT) < 0.001) this.unfoldT = this.unfoldTarget;
      const k = this.unfoldT;
      const n = this.layerEntities.length;
      const mid = (n - 1) / 2;
      for (let i = 0; i < n; i++) {
        const e = this.layerEntities[i];
        if (!e) continue;
        // 本地 Z = 世界 Y（高度），本地 X = 世界 X
        // 只沿世界高度分开：父节点没有旋转，所以这里就是世界 Y
        const dy = (i - mid) * this.unfoldSpreadY * k;
        e.setPosition(0, dy, 0);
      }
    }

    if (this.roomAnim) {
      const raw = Math.min(1, (now - this.roomAnim.t0) / this.roomAnim.dur);
      const ease = this.roomAnim.ease;
      const e = ease === 'outBack'
        ? 1 + 2.70158 * Math.pow(raw - 1, 3) + 1.70158 * Math.pow(raw - 1, 2)
        : ease === 'inOutCubic'
          ? (raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2)
          : ease === 'linear'
            ? raw
            : 1 - Math.pow(1 - raw, 3);
      const { from, to } = this.roomAnim;
      this.roomPos = [
        from[0] + (to[0] - from[0]) * e,
        from[1] + (to[1] - from[1]) * e,
        from[2] + (to[2] - from[2]) * e,
      ];
      // 渐显：前 30% 时间从 0 到满，之后保持不变（多次调用不会闪回）
      const k2 = Math.min(1, raw / 0.3);
      if (k2 > this.roomOpacity) {
        this.roomOpacity = k2;
        const list = this.roomEntity?.render?.meshInstances ?? [];
        for (const mi of list) {
          const mat = mi.material as pc.StandardMaterial;
          if (mat && 'opacity' in mat) mat.opacity = 0.62 * this.roomOpacity;
        }
      }
      if (raw >= 1) this.roomAnim = null;
    }
    if (this.roomEntity && this.roomEntity.enabled) {
      this.roomEntity.setPosition(this.roomPos[0], this.roomPos[1], this.roomPos[2]);
    }
    // 只有首页抽屉里才让室内跟随楼层；第二页室内模式由 enterRoomScene 固定在世界原点
    if (this.interiorEntity?.enabled && !this.roomMode) {
      this.interiorEntity.setPosition(this.roomPos[0], this.roomPos[1], this.roomPos[2]);
    }
  }

  get roomPose() {
    return { pos: [...this.roomPos] as Vec3, yaw: 0 };
  }

  get stats() {
    return { fps: Math.round(this.fps), tiles: this.loaded };
  }

  dispose() {
    this.app.destroy();
  }
}
