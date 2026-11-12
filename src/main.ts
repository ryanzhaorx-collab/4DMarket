import './app.css';
import { Engine, type CameraPose } from './engine/Engine';
import type { CameraKey } from './engine/CameraTimeline';
import { Sfx, haptic } from './ui/sfx';
import { mountRoom, unmountRoom } from './ui/room';
import type { PerfStats, SceneManifest } from './engine/types';
import type { Vec3 } from './engine/math';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const params = new URLSearchParams(location.search);
const sfx = new Sfx();
const isWeapp = (window as unknown as { __wxjs_environment?: string }).__wxjs_environment === 'miniprogram';
if (isWeapp) document.body.classList.add('in-weapp');
sfx.enabled = params.get('sound') !== '0';

/** HUD 以 885×1920 设计稿等比缩放贴合屏幕 */
let hudScale = 0.44;
function fitStage() {
  hudScale = Math.min(window.innerWidth / 885, window.innerHeight / 1000);
  document.documentElement.style.setProperty('--s', String(hudScale));
}
fitStage();
window.addEventListener('resize', fitStage);
window.addEventListener('orientationchange', fitStage);

/* ------------------------------------------------------------------ 启动 */

const canvas = $('#scene') as unknown as HTMLCanvasElement;
const loader = $('#loader');
const loadPct = $('#loadPct');
const loadSub = $('#loadSub');
const ringFg = document.getElementById('ringFg') as unknown as SVGCircleElement;
const perf = $('#perf');
const toastEl = $('#toast');

let engine: Engine | null = null;
let manifest: SceneManifest | null = null;
let ready = false;
let homePose: CameraPose | null = null;
let usingLocalModel = false;
/** 伪分层抽屉的「8F」Y 区间（加载后按包围盒算出来） */
let sliceBand: { y0: number; y1: number } | null = null;
let drawerOpen = false;
let toastTimer = 0;

function toast(msg: string, ms = 1800) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), ms);
}

function setProgress(p: number) {
  const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
  loadPct.innerHTML = `${pct}<i>%</i>`;
  const circumference = 326.7;
  ringFg.style.strokeDashoffset = String(circumference * (1 - Math.max(0.02, p)));
}

function hideLoader() {
  loader.classList.add('done');
  setTimeout(() => loader.remove(), 800);
}

function showFallback(reason: string) {
  loader.classList.add('done');
  const stage = document.getElementById('stage')!;
  const div = document.createElement('div');
  div.className = 'fallback';
  div.innerHTML =
    `<div class="fb-card"><b>当前设备无法开启 3D 实景</b><p>${reason}</p>` +
    `<p class="fb-sub">已切换为静态实景图，房型与订购功能不受影响。</p></div>`;
  div.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'background:radial-gradient(circle at 50% 40%,#0d131a,#05070a 70%);z-index:5;padding:40px;text-align:center';
  document.body.appendChild(div);
  const poster = document.createElement('div');
  poster.style.cssText =
    'position:absolute;inset:0;background:url(assets/poster.jpg) center/cover;opacity:.65;z-index:4';
  stage.appendChild(poster);
}

/* --------------------------------------------------------------- 交互逻辑 */

const card = $('#card');
const sheet = $('#sheet');
const scrim = $('#scrim');
const hint = $('#hint');
const hotspot = $('#hotspot');
const objtag = $('#objtag');
const brackets = $('#brackets');

function openSheet() {
  sheet.classList.add('open');
  scrim.classList.add('show');
  card.classList.add('dim');
  hint.classList.add('hide');
}

function closeSheet() {
  sheet.classList.remove('open');
  scrim.classList.remove('show');
  card.classList.remove('dim');
  hint.classList.remove('hide');
}

/**
 * 「进入空间」的分段运镜：宏观锚定 → 环绕推进 → 视角穿透。
 * 三段各自缓动，末段收窄 FOV 制造「进房」的压迫感；
 * 到位那一刻给一次触觉 + 一声卡扣，这是「抽屉手感」的来源。
 */
/**
 * 抽屉式：
 *   ① 点击 → 楼体整体上下分开（上半上移、下半下沉）
 *   ② 同时镜头切到固定机位（正面、略俯视，能同时看到塔楼和裙楼）
 *   ③ 从缝里把「一整层裙楼」朝观众抽出来
 *   ④ 再点一次 → 进入房间
 */
function openDrawer() {
  if (!engine || !sliceBand || engine.timelinePlaying) return;
  const b = engine.contentBounds();
  if (!b) return;
  const cam = engine.camera;
  const anchorTile = engine.shed.densest;
  const cx = anchorTile ? anchorTile.center[0] : (b.min[0] + b.max[0]) / 2;
  const cz = anchorTile ? anchorTile.center[2] : (b.min[2] + b.max[2]) / 2;
  const midY = (sliceBand.y0 + sliceBand.y1) / 2;
  const h = b.max[1] - b.min[1];

  // ================================================================
  // 抽屉调参区（位置都是世界坐标，单位米；正 Y 向上）
  // ================================================================

  /** 楼体上半部分上移多少 */
  const upShift = h * 0.15;
  /** 楼体下半部分下沉多少 */
  const downShift = h * 0.12;
  /** 裂缝底边的高度 */
  const gapBottom = sliceBand.y0 - downShift;

  /** 抽屉水平位置：左右（改这里让楼层左右平移） */
  const DRAWER_X = cx;
  /** 抽屉水平位置：前后（± 可让楼层靠前/靠后） */
  const DRAWER_Z = cz;
  /** 抽屉「落位」高度 —— 想让它停高一点就 +8，低一点就 -8 */
  const DRAWER_END_Y = midY;
  /** 抽屉「起始」高度 —— 决定它从楼体内部多深的地方升上来 */
  const DRAWER_START_Y = gapBottom - 3;
  /** 上升距离（自动算，不用改） */
  const DRAWER_RISE = DRAWER_END_Y - DRAWER_START_Y;

  /** 抽屉开口朝向：0=正面，0.5≈30°斜侧，0.9≈90°侧面 */
  const fixedYaw = 1.5;

  const dir: [number, number, number] = [0, 1, 0];
  const roomAt: [number, number, number] = [DRAWER_X, DRAWER_END_Y + 4, DRAWER_Z];

  // 先把切分高度写进 uSlice（split 用它决定从哪一层裂开），但不做位移、不做压暗
  engine.openSlice({ y0: sliceBand.y0, y1: sliceBand.y1, lift: 0, dir: [0, 1, 0], dim: 1 }, 1);

  // ① 楼体上下分开：作为独立的第一拍，跑完停一下
  engine.openSplit(upShift, downShift, 1100);

  // ③ 等拆分完全停稳（1.35s）再抽出整层，两拍之间有 0.35s 的「停一拍」
  window.setTimeout(() => {
    engine?.showRoom([DRAWER_X, DRAWER_START_Y, DRAWER_Z], dir, DRAWER_RISE, 1500, 'outBack');
    sfx.whoosh(1.4);
  }, 1350);

  sfx.whoosh(1.0);
  card.classList.add('dim');
  hint.classList.add('hide');

  // ② 镜头切到固定机位
  engine.playTimeline(
    [
      { t: 0, target: cam.target, distance: cam.distance, yaw: cam.yaw, pitch: cam.pitch, fov: cam.fov },
      // 第一拍：镜头切到固定机位，把拆分过程看清楚
      { t: 1.0, target: [cx, midY + 8, cz], distance: 340, yaw: fixedYaw, pitch: 0.3, fov: 56, ease: 'outCubic' },
      // 停一拍：什么都别动，让观众看到「楼已经分开」
      { t: 1.35, target: [cx, midY + 8, cz], distance: 340, yaw: fixedYaw, pitch: 0.3, fov: 56, ease: 'linear' },
      // 第二拍：镜头跟着抽屉往侧面挪一点
      { t: 2.9, target: [roomAt[0], roomAt[1], roomAt[2]], distance: 322, yaw: fixedYaw + 0.04, pitch: 0.26, fov: 56, ease: 'inOutCubic' },
    ],
    () => {
      drawerOpen = true;
      hint.textContent = '本月主推楼层已抽出 · 轻触进入房间';
      hint.classList.remove('hide');
      sfx.latch();
      haptic(14);
    },
  );
}

/** 穿越进房：0–1.5s 沿法线四段推进（FOV 锁 50），落位后 0.5s 引导 */
let entering = false;
let inRoom = false;

function enterRoom() {
  if (!engine || !drawerOpen || entering || inRoom) return;
  entering = true;

  const stage = document.getElementById('stage')!;
  const flash = document.getElementById('flash')!;
  const pose = engine.roomPose;

  // ① 只播过场特效：白闪 + 虚化，不做镜头推进
  stage.classList.remove('switching');
  void (stage as HTMLElement).offsetWidth;
  stage.classList.add('switching');
  flash.classList.remove('run');
  void flash.offsetWidth;
  flash.classList.add('run');

  sfx.whoosh(0.7);
  window.setTimeout(() => sfx.surge(0.55), 380);

  // ② 特效峰值时瞬切到「第二页」——相机直接落在室内机位，没有飞行过程
  window.setTimeout(() => {
    if (!engine) return;
    const fx = Math.sin(pose.yaw);
    const fz = Math.cos(pose.yaw);
    const cam = engine.camera;
    engine.swapToInterior(pose.pos[0], pose.pos[1], pose.pos[2], pose.yaw);

    // 落位机位：房间右后角，斜看床与转角窗（对齐原型图构图）
    const L = (lx: number, ly: number, lz: number): [number, number, number] => [
      pose.pos[0] + lx * fz + lz * fx,
      pose.pos[1] + ly,
      pose.pos[2] - lx * fx + lz * fz,
    ];
    const eye = L(3.1, 1.52, 2.3);
    const look = L(-1.7, 0.8, -2.6);
    const dx = eye[0] - look[0];
    const dy = eye[1] - look[1];
    const dz = eye[2] - look[2];
    cam.target = look;
    cam.distance = Math.hypot(dx, dy, dz);
    cam.yaw = Math.atan2(dx, dz);
    cam.pitch = Math.asin(dy / cam.distance);
    cam.fov = 52;
    engine.controls.enabled = true;
    engine.controls.syncFromCamera?.();
    document.body.classList.add('in-room');
    document.getElementById('roombar')?.classList.add('show');
    mountRoom(engine);
    card.classList.add('dim');
    hint.classList.add('hide');
  }, 430);

  // ③ 特效结束：交还交互，页面已经是第二页
  window.setTimeout(() => {
    stage.classList.remove('switching');
    flash.classList.remove('run');
    entering = false;
    inRoom = true;
    haptic(9);
    sfx.gull(0.3);
    hint.textContent = '上滑看房型 · 轻触窗户看海';
    hint.classList.remove('hide');
  }, 960);
}

/** 从第二页返回首屏 */
function exitRoom() {
  if (!engine || !inRoom) return;
  inRoom = false;
  engine.hideInterior();
  engine.hideRoom(0);
  engine.closeSplit(500);
  engine.openSlice({ y0: 0, y1: 0, lift: 0, dir: [0, 1, 0], dim: 1 }, 1);
  document.body.classList.remove('in-room');
  document.getElementById('roombar')?.classList.remove('show');
  unmountRoom();
  drawerOpen = false;
  card.classList.remove('dim');
  hint.textContent = '轻触卡片「进入」· 拉开这一层';
  if (homePose) engine.flyTo(homePose, 800);
}

function closeDrawer() {
  drawerOpen = false;
  engine?.hideRoom(450);
  engine?.closeSplit(700);
  engine?.closeSlice(600);
  if (engine && homePose) engine.flyTo(homePose, 900);
  hint.textContent = '轻触楼层 · 拉开抽屉';
  hint.classList.remove('hide');
}

function enterSpace() {
  if (usingLocalModel && sliceBand) {
    if (drawerOpen) enterRoom();
    else openDrawer();
    return;
  }
  if (!engine || !manifest) return;
  if (engine.timelinePlaying) return;
  const cam = engine.camera;
  const base = homePose ?? {
    target: [...cam.target] as Vec3,
    distance: cam.distance,
    yaw: cam.yaw,
    pitch: cam.pitch,
  };
  const b = engine.contentBounds();
  const cx = b ? (b.min[0] + b.max[0]) / 2 : base.target[0];
  const cy = b ? (b.min[1] + b.max[1]) / 2 : base.target[1];
  const cz = b ? (b.min[2] + b.max[2]) / 2 : base.target[2];

  const keys: CameraKey[] = [
    { t: 0, target: [...cam.target] as Vec3, distance: cam.distance, yaw: cam.yaw, pitch: cam.pitch, fov: cam.fov },
    // 1 宏观锚定：拉近建筑，建立上帝视角
    { t: 0.55, target: [cx, cy + 2, cz], distance: base.distance * 0.78, yaw: base.yaw - 0.1, pitch: 0.52, ease: 'outCubic' },
    // 2 环绕推进：慢一点，给「抽屉滑出」留出节奏
    { t: 1.45, target: [cx, cy + 1, cz], distance: base.distance * 0.6, yaw: base.yaw - 0.34, pitch: 0.4, fov: 51, ease: 'inOutCubic' },
    // 3 视角穿透：压低到「门口平视」，FOV 收窄，落点是入口立面
    { t: 2.2, target: [cx, cy * 0.45, cz], distance: base.distance * 0.5, yaw: base.yaw - 0.46, pitch: 0.16, fov: 46, ease: 'outCubic' },
  ];

  card.classList.add('dim');
  hint.classList.add('hide');
  sfx.whoosh(1.2);
  engine.playTimeline(keys, () => {
    sfx.latch();
    haptic(12);
    openSheet();
  });
}

function bindUI() {
  $('#enterBtn').addEventListener('click', enterSpace);
  $('#backBtn').addEventListener('click', exitRoom);
  hotspot.addEventListener('click', enterSpace);
  $('#sheetClose').addEventListener('click', () => {
    closeSheet();
    if (usingLocalModel && sliceBand) closeDrawer();
    else if (engine && homePose) engine.flyTo(homePose, 1100);
  });
  scrim.addEventListener('click', () => {
    closeSheet();
  });
  $('#scanBtn').addEventListener('click', () => toast('扫描 · 对准空间二维码即可进入（演示）'));
  document.querySelectorAll<HTMLElement>('.tab').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      el.classList.add('active');
      const tab = el.dataset.tab;
      if (tab === 'capsule') toast('时空胶囊 · 已为你保存 3 个视角');
    });
  });

  let pressTimer = 0;
  let pressStart = { x: 0, y: 0 };
  canvas.addEventListener('pointerdown', (e) => {
    pressStart = { x: e.clientX, y: e.clientY };
    pressTimer = window.setTimeout(() => {
      toast('已封存当前视角 · 时空胶囊 +1');
      if (navigator.vibrate) navigator.vibrate(12);
    }, 700);
  });
  const cancelPress = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 12) clearTimeout(pressTimer);
    else clearTimeout(pressTimer);
  };
  canvas.addEventListener('pointerup', cancelPress);
  canvas.addEventListener('pointercancel', () => clearTimeout(pressTimer));
  canvas.addEventListener('pointermove', cancelPress);

  $('#agent').addEventListener('click', () => toast('云小圣：这栋穹顶建于 1987 年，正东朝向看海。'));
}

/* ----------------------------------------------------------- 锚点跟随渲染 */

function updateAnchors() {
  if (!engine || !manifest) return;
  const view = engine.viewport;
  if (!manifest.hotspots.length) {
    hotspot.classList.remove('show');
    objtag.classList.remove('show');
    brackets.classList.remove('show');
    return;
  }
  const anchor = manifest.hotspots[0].position;
  const p = engine.project(anchor as Vec3);
  const center = engine.project([0, 12, 0] as Vec3);
  const visible = p.visible && p.x > 0 && p.x < view.width && p.y > 80;
  // project 返回 CSS 像素，而 HUD 内部使用 885×1920 设计坐标，需要换算
  const k = 1 / Math.max(hudScale, 0.05);
  const dx = p.x * k;
  const dy = p.y * k;
  const cx = Math.max(220, Math.min(665, dx));
  const cy = Math.max(480, Math.min(1010, dy - 30));

  hotspot.style.left = `${cx}px`;
  hotspot.style.top = `${cy}px`;
  hotspot.classList.toggle('show', visible && ready);
  objtag.style.left = `${cx}px`;
  objtag.style.top = `${Math.max(392, cy - 92)}px`;
  objtag.classList.toggle('show', visible && ready);
  brackets.style.left = `${center.x * k}px`;
  brackets.style.top = `${center.y * k + 10}px`;
  brackets.classList.toggle('show', visible && ready);
}

/* --------------------------------------------------------- 调试模式（真实资产） */

/**
 * 不用改代码，直接通过 URL 参数加载自己的模型：
 *   ?ply=assets/local/hotel.ply        点云（.ply / .splat，本地或远程）
 *   ?tiles=https://host/tileset.json   倾斜摄影 3D Tiles
 *   &offset=1,2,3 &scale=0.001 &rotY=90       点云整体对齐（可选）
 *   &toffset=... &tscale=... &trotY=...       3D Tiles 整体对齐（可选）
 *   &fit=0                                     关闭自动取景
 */
const debugPly = params.get('ply');
const debugTiles = params.get('tiles');
const manifestParam = params.get('manifest');
const isDebugScene = !!(debugPly || debugTiles);
/** 点云/瓦片参数，或自定义 manifest：都按「模型调试台」处理（隐藏地标卡、给足预算） */
const isModelScene = isDebugScene || !!manifestParam;
void isModelScene;

function triple(v: string | null): [number, number, number] | undefined {
  if (!v) return undefined;
  const p = v.split(',').map((n) => Number(n));
  if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) return undefined;
  return [p[0], p[1], p[2]];
}

function num(v: string | null): number | undefined {
  if (v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function buildDebugManifest(): SceneManifest {
  return {
    version: 1,
    scene: {
      id: 'debug',
      name: '四维空间',
      subtitle: 'FOUR-DIMENSION SPACE',
      location: '调试场景',
      anchor: { label: '本地模型', detail: 'DEBUG' },
      tags: [],
    },
    camera: { target: [0, 3, 0], distance: 60, yaw: 0.2, pitch: 0.55, fov: 55, introFrom: { distance: 120, pitch: 0.8, yawOffset: 0.3 } },
    splat: {
      tiles: [],
      source: debugPly ? new URL(debugPly, document.baseURI).href : undefined,
      transform: {
        translate: triple(params.get('offset')),
        rotateX: num(params.get('rotX')),
        rotateY: num(params.get('rotY')),
        rotateZ: num(params.get('rotZ')),
        scale: num(params.get('scale')),
      },
    },
    tileset: debugTiles ? new URL(debugTiles, document.baseURI).href : undefined,
    tilesetTransform: {
      translate: triple(params.get('toffset')),
      rotateX: num(params.get('trotX')),
      rotateY: num(params.get('trotY')),
      rotateZ: num(params.get('trotZ')),
      scale: num(params.get('tscale')),
    },
    hotspots: [],
  };
}

/* ---------------------------------------------------------------- 主流程 */

async function boot() {
  if (new URLSearchParams(location.search).get('engine') === 'pc') {
    const { bootPc } = await import('./pc/boot');
    await bootPc();
    return;
  }

  try {
    engine = new Engine(canvas);
    engine.init();
  } catch (err) {
    showFallback(err instanceof Error ? err.message : String(err));
    return;
  }

  const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${(n / 1000).toFixed(1)}k`);
  const statsCb = (s: PerfStats) => {
    if (params.get('debug') === '1') {
      perf.hidden = false;
      const pct = s.total > 0 ? Math.round((s.splats / s.total) * 100) : 100;
      perf.textContent =
        `${s.fps} FPS  ${s.frameMs}ms\n` +
        `splat ${fmt(s.splats)} / ${fmt(s.total)}  ${pct}%\n` +
        `cap ${fmt(s.budget)}  draw ${s.drawCalls}  tile ${s.sse}\n` +
        `GPU ${s.gpuMemoryMB}MB  ${s.quality} x${s.renderScale.toFixed(2)}`;
      if (s.gpuMemoryMB > 420) perf.textContent += '\n⚠ 显存偏高';
    }
  };

  (engine as Engine).setHooks({
    onStats: statsCb,
    onFrame: updateAnchors,
    onContextLost: () => toast('显卡上下文丢失，正在恢复…', 2600),
    onContextRestored: () => toast('渲染已恢复'),
    onError: (e) => {
      console.warn('[app]', e);
      toast(`加载异常：${e.message.slice(0, 24)}`, 2600);
    },
  });

  let base = new URL('assets/yuehua/', document.baseURI).href;
  if (manifestParam) {
    const u = new URL(manifestParam, document.baseURI);
    base = u.href.slice(0, u.href.lastIndexOf('/') + 1);
  }
  setProgress(0.04);

  if (isDebugScene) {
    document.body.classList.add('is-debug');
    manifest = buildDebugManifest();
    const what = [debugPly ? 'PLY' : '', debugTiles ? 'TILES' : ''].filter(Boolean).join(' + ');
    const tag = document.getElementById('dbgTag');
    if (tag) {
      tag.hidden = false;
      (document.getElementById('dbgWhat') as HTMLElement).textContent = what;
    }
    loadSub.textContent = debugPly ? '正在解析点云…' : '正在加载倾斜摄影…';
  } else if (params.get('scene') !== 'demo') {
    // 默认优先本机 models/ 下的真实模型；不存在时回落到演示场景
    const localUrl = '/models/HS_Bolimuqiang/manifest.json';
    let local: SceneManifest | null = null;
    try {
      const r = await fetch(localUrl);
      if (r.ok) local = (await r.json()) as SceneManifest;
    } catch {
      /* 忽略，走回落 */
    }
    if (local) {
      manifest = local;
      base = new URL(localUrl.slice(0, localUrl.lastIndexOf('/') + 1), document.baseURI).href;
      usingLocalModel = true;
    } else {
      const r = await fetch(new URL('manifest.json', base));
      manifest = (await r.json()) as SceneManifest;
    }
  } else if (manifestParam) {
    const res = await fetch(new URL(manifestParam, document.baseURI));
    if (!res.ok) throw new Error(`manifest 加载失败 HTTP ${res.status}`);
    manifest = (await res.json()) as SceneManifest;
    document.body.classList.add('is-debug');
    const tag = document.getElementById('dbgTag');
    if (tag) {
      tag.hidden = false;
      (document.getElementById('dbgWhat') as HTMLElement).textContent = manifest.scene?.name || 'MANIFEST';
    }
  } else {
    const res = await fetch(new URL('manifest.json', base));
    manifest = (await res.json()) as SceneManifest;
  }

  // 对齐参数合并进当前 manifest（对本地真实模型同样生效）
  const rt = {
    translate: triple(params.get('offset')),
    rotateX: num(params.get('rotX')),
    rotateY: num(params.get('rotY')),
    rotateZ: num(params.get('rotZ')),
    scale: num(params.get('scale')),
  };
  if (rt.translate || rt.rotateX !== undefined || rt.rotateY !== undefined || rt.rotateZ !== undefined || rt.scale !== undefined) {
    manifest.splat.transform = { ...(manifest.splat.transform ?? {}), ...rt };
  }
  const tt = {
    translate: triple(params.get('toffset')),
    rotateX: num(params.get('trotX')),
    rotateY: num(params.get('trotY')),
    rotateZ: num(params.get('trotZ')),
    scale: num(params.get('tscale')),
  };
  if (tt.translate || tt.rotateX !== undefined || tt.rotateY !== undefined || tt.rotateZ !== undefined || tt.scale !== undefined) {
    manifest.tilesetTransform = { ...(manifest.tilesetTransform ?? {}), ...tt };
  }

  if (params.get('debug') === '1') {
    (window as unknown as { __engine?: Engine }).__engine = engine;
  }
  engine.camera.fov = manifest.camera.fov;
  const c = manifest.camera;
  const pose: CameraPose = { target: [...c.target], distance: c.distance, yaw: c.yaw, pitch: c.pitch };
  const manifestFit = !!manifestParam && params.get('fit') === '1';
  const skipIntro = params.get('shot') === '1' || params.get('intro') === '0' || manifestFit;
  if (!isDebugScene) homePose = pose;

  if (isDebugScene) {
    engine.applyCameraPose(pose);
    engine.controls.enabled = true;
  } else if (skipIntro) {
    engine.applyCameraPose(pose);
  } else {
    engine.applyCameraPose({
      target: [...c.target],
      distance: c.introFrom.distance,
      yaw: c.yaw + c.introFrom.yawOffset,
      pitch: c.introFrom.pitch,
    });
  }

  const budgetParam = Number(params.get('budget'));
  if (Number.isFinite(budgetParam) && budgetParam > 0) {
    // 上限保护：一次绘制超过 600 万点，桌面也会掉到个位数帧率
    engine.setBudgetOverride(Math.min(budgetParam, 6_000_000));
  } else if (usingLocalModel) engine.setBudgetOverride(4_000_000);
  else if (isDebugScene) engine.setBudgetOverride(1_500_000);
  else if (manifestParam) engine.setBudgetOverride(1_500_000);

  engine.start();

  let hidLoader = false;
  await engine.loadScene(manifest, base, (p, detail) => {
    setProgress(0.04 + p * 0.96);
    if (detail) loadSub.textContent = detail;
    if (!hidLoader && !isDebugScene && p > 0.5) {
      hidLoader = true;
      ready = true;
      hideLoader();
      if (!skipIntro) {
        engine!.playIntro(
          { target: [...c.target], distance: c.introFrom.distance, yaw: c.yaw + c.introFrom.yawOffset, pitch: c.introFrom.pitch },
          pose,
          2400,
        );
        engine!.startResolve(2200);
      } else {
        engine!.controls.enabled = true;
        engine!.setResolveInstant();
      }
    }
  });

  ready = true;
  setProgress(1);
  if (isDebugScene) {
    if (params.get('fit') !== '0' && engine.autoFrame()) {
      toast('已自动取景 · 可拖动环视');
    }
    loadSub.textContent = '调试场景已加载';
    homePose = {
      target: [...engine.camera.target] as Vec3,
      distance: engine.camera.distance,
      yaw: engine.camera.yaw,
      pitch: engine.camera.pitch,
    };
    engine.controls.setLimits(homePose.distance * 0.1, homePose.distance * 5);
    if (!skipIntro) {
      const from: CameraPose = {
        ...homePose,
        distance: homePose.distance * 1.55,
        pitch: Math.min(1.25, homePose.pitch + 0.2),
        yaw: homePose.yaw - 0.28,
      };
      engine.playIntro(from, homePose, 2600);
      engine.startResolve(2300);
    } else {
      engine.setResolveInstant();
    }
    const st = engine.shed.stats;
    if (st.total > (budgetParam || 1_500_000) * 1.4) {
      setTimeout(
        () => toast(`点云共 ${fmt(st.total)} 点，当前只绘制 ${fmt(st.splats)} · 加 &budget=${Math.min(st.total, 4_000_000)} 看全量`, 4200),
        1200,
      );
    }
    if (st.gpuMemoryBytes > 450 * 1048576) {
      setTimeout(() => toast('显存占用偏高，移动端会崩溃，建议先抽稀', 3600), 2600);
    }
  }
  if (manifestFit || params.get('fit') === '1') {
    engine.cancelTimeline();
    if (engine.autoFrame()) homePose = {
      target: [...engine.camera.target] as Vec3,
      distance: engine.camera.distance,
      yaw: engine.camera.yaw,
      pitch: engine.camera.pitch,
    };
    engine.setResolveInstant();
  }
  if (!hidLoader) hideLoader();
  if (params.get('hud') === '0') document.getElementById('hud')!.classList.add('hide');
  if (params.get('debug') === '1' || isDebugScene) perf.hidden = false;
  if (usingLocalModel) {
    const b = engine.contentBounds();
    if (b) {
      const h = b.max[1] - b.min[1];
      const y0 = b.min[1] + h * 0.46;
      sliceBand = { y0, y1: y0 + h * 0.07 };
      // 模型上不再挂浮动标注，交互统一收进底部卡片
      manifest.hotspots = [];
      document.getElementById('hint')!.textContent = '轻触卡片「进入」· 拉开这一层';
    }
  }

  engine.controls.autoRotate = !skipIntro && params.get('spin') !== '0';
  engine.controls.onDoubleTap = () => {
    if (!engine || !homePose) return;
    engine.flyTo(homePose, 900);
    toast('已回到初始视角', 1400);
  };
  bindUI();
  updateAnchors();
}

boot().catch((err) => {
  console.error(err);
  showFallback(err instanceof Error ? err.message : String(err));
});
