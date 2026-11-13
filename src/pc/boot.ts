/**
 * 首屏的 PlayCanvas 分支（?engine=pc）。
 * 复用现有的 DOM/UI（卡片、进度胶囊、第二页实景），只把 3D 层换成 PcEngine。
 */
import { PcEngine } from '../engine/pc/PcEngine';
import { mountRoom, unmountRoom } from '../ui/room';
import { Sfx, haptic } from '../ui/sfx';
import { probe } from '../engine/pc/platform';
import { loadTune, mountTune, type TuneParams } from '../ui/tune';
// 团队提供的查看器（纯 JS，字段按 JSDoc 推断）
import { SplatViewer } from '../engine/pc/viewer/splat-viewer.js';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

export async function bootPc() {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const cap = probe();

  // 不支持 WebGL2：直接降级到静态海报，不白屏
  if (!cap.webgl2) {
    document.body.classList.add('is-poster');
    document.getElementById('loader')?.remove();
    const hint0 = document.getElementById('hint');
    if (hint0) {
      hint0.textContent = '当前设备不支持 3D 实景 · 已切换为静态展示';
      hint0.classList.remove('hide');
    }
    const card0 = document.querySelector('.card');
    card0?.classList.add('show');
    return;
  }

  // 像素比封顶：手机上 3x 屏按 2 倍渲染，省 55% 像素
  const dpr = Math.min(window.devicePixelRatio || 1, cap.dprCap);
  document.documentElement.style.setProperty('--dpr', String(dpr));
  const card = $('.card');
  const hint = $('#hint');
  const flash = $('#flash');
  const stage = $('#stage');

  // 室内扫描的朝向/缩放可以用 URL 快速校准：?ir=-90,0,0&is=1
  const q = new URLSearchParams(location.search);
  const ir = (q.get('ir') ?? '-90,0,0').split(',').map(Number);
  const iscale = Number(q.get('is') ?? '1');

  const engine = new PcEngine({
    canvas,
    layers: [0, 1, 2, 3, 4, 5].map((i) => `/models/HS_Bolimuqiang/layer-${i}.sog`),
    roomUrl: '/models/room.sog',
  });

  engine.interiorRot = [ir[0] || 0, ir[1] || 0, ir[2] || 0];
  const ro = (q.get('ro') ?? '0,0,0').split(',').map(Number);
  engine.interiorOffset = [ro[0] || 0, ro[1] || 0, ro[2] || 0];
  const rd = Number(q.get('rd'));
  if (rd > 0) engine.roomDistance = rd;
  engine.interiorScale = iscale || 1;

  const sfx = new Sfx();

  // 调参面板（?tune=1）：所有动画数值都从这里读
  const tune: TuneParams = loadTune();
  if (new URLSearchParams(location.search).get('tune') === '1') {
    mountTune(tune, () => {
      drawerOpen = false;
      inRoom = false;
      busy = false;
      openDrawer();
    });
  }
  const loader = document.getElementById('loader');
  const pct = document.getElementById('loadPct');
  const sub = document.getElementById('loadSub');
  if (pct) pct.innerHTML = '1/3';

  // 首块就绪就撤遮罩，剩下的在后台补
  engine.onFirstPaint = () => {
    if (pct) pct.innerHTML = '100<i>%</i>';
    if (sub) sub.textContent = '远景已就绪 · 细节后台加载';
    if (loader) {
      loader.classList.add('done');
      window.setTimeout(() => loader.remove(), 700);
    }
  };
  engine.onFullLoad = () => {
    if (sub) sub.textContent = '3DGS · 实景 1:1 · 已全部就绪';
  };

  await engine.start();

  const b = engine.contentBounds()!;
  const cx = (b.min[0] + b.max[0]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  const midY = 22;
  const home = {
    target: [cx, midY, cz] as [number, number, number],
    distance: 460,
    yaw: 0.62,
    pitch: 0.38,
    fov: 52,
  };

  // 入场：远景推进 + resolve 凝聚
  engine.applyCameraPose({ ...home, distance: 900, fov: 64 });
  // 先出点云，再慢慢显影：等所有分层就绪再开始扫，避免各层各自起跑
  // 入场显影：每层加载完自动开扫（时长在这里设定）
  engine.playDevelop(tune.developDuration, 0);
  document.getElementById('flash')?.classList.add('run');
  engine.playTimeline(
    [
      { t: 0, target: home.target, distance: 900, yaw: home.yaw, pitch: home.pitch, fov: 64 },
      { t: 2.4, target: home.target, distance: home.distance, yaw: home.yaw, pitch: home.pitch, fov: home.fov, ease: 'outCubic' },
    ],
    () => {
      engine.controls.autoRotate = true;
      hint.textContent = '轻触卡片「进入」· 拉开这一层';
      hint.classList.remove('hide');
    },
  );

  let drawerOpen = false;
  let inRoom = false;
  let busy = false;
  let roomViewer: SplatViewer | null = null;

  const openDrawer = () => {
    if (busy || inRoom) return;
    busy = true;
    sfx.whoosh(1.2);
    card.classList.add('dim');
    hint.classList.add('hide');
    engine.controls.autoRotate = false;
    document.body.classList.add('godview');

    // 目标楼层在「左塔」里：x 往左、z 往前的偏移，高度取中间那刀
    const TOX = cx - 38;
    const TOZ = cz - 14;
    const TOY = midY + tune.pushStartY;
    const yawNow = engine.camera.yaw;
    const PUSH: [number, number, number] = [Math.sin(yawNow), 0, Math.cos(yawNow)];
    const PUSH_DIST = tune.pushDistance;
    const PLATE: [number, number, number] = [TOX, TOY, TOZ];
    const at = (d: number): [number, number, number] => [
      PLATE[0] + PUSH[0] * d,
      PLATE[1],
      PLATE[2] + PUSH[2] * d,
    ];

    const cam0 = {
      target: [...engine.camera.target] as [number, number, number],
      distance: engine.camera.distance,
      yaw: engine.camera.yaw,
      pitch: engine.camera.pitch,
      fov: engine.camera.fov,
    };

    // 唯一的镜头时间轴：所有目标点都由 PUSH / PLATE 推导，保证和盘子一致
    const camA = { t: 1.0, target: [cx, midY + 14, cz] as [number, number, number], distance: 600, yaw: 0.95, pitch: 0.22, fov: 46 };
    const camB = { t: 2.8, target: [cx, midY + 10, cz] as [number, number, number], distance: 590, yaw: 0.98, pitch: 0.2, fov: 46 };
    const camC = { t: 4.0, target: at(20), distance: 300, yaw: 1.0, pitch: 0.16, fov: 44 };
    const camD = { t: 6.2, target: at(PUSH_DIST), distance: 21, yaw: 1.0, pitch: 0.12, fov: 42 };
    engine.playTimeline(
      [
        { t: 0, ...cam0 },
        { ...camA, ease: 'inOutCubic' },
        { ...camB, ease: 'inOutCubic' },
        { ...camC, ease: 'inOutCubic' },
        { ...camD, ease: 'inOutCubic' },
      ],
      () => {
        drawerOpen = true;
        busy = false;
        hint.textContent = '本月主推楼层已抽出 · 轻触进入房间';
        hint.classList.remove('hide');
      },
    );

    // 分层展开与镜头同步开始，不再用 setTimeout 另起一条时间轴
    engine.openUnfold(tune.unfoldSpread, tune.unfoldDuration, 3);
    sfx.whoosh(0.8);

    // ① 拆分完：玻璃层在原地渐显（不位移）
    window.setTimeout(() => {
      engine.showRoom(PLATE, [0, 0, 0], 0, 700, 'linear');
    }, 2500);

    // ② 渐显后：沿 PUSH 朝镜头平推
    window.setTimeout(() => {
      engine.showRoom(PLATE, PUSH, tune.pushDistance, tune.pushDuration, 'inOutCubic');
      sfx.latch();
      haptic(14);
    }, 3250);
  };

  const enterRoom = () => {
    if (busy || !drawerOpen || inRoom) return;
    busy = true;
    flash.classList.remove('run');
    void flash.offsetWidth;
    flash.classList.add('run');
    stage.classList.add('switching');
    sfx.whoosh(0.7);
    window.setTimeout(() => {
      engine.hideRoom(0);
      // 第二页换成团队的 SplatViewer（自带显影特效 + 手势 + 自动取景）
      const rc = document.getElementById('roomScene') as HTMLCanvasElement;
      if (rc && !roomViewer) {
        const opts = {
          pixelRatio: Math.min(window.devicePixelRatio || 1, cap.dprCap),
          effect: 'develop',
        };
        roomViewer = new SplatViewer(rc, opts as never);
        void roomViewer.load({ id: 'room', url: '/models/room.sog', name: '270° 海景房' });
      }
      document.body.classList.add('in-room');
      document.getElementById('roombar')?.classList.add('show');
      mountRoom(engine as unknown as Parameters<typeof mountRoom>[0]);
      card.classList.add('dim');
      hint.classList.add('hide');
    }, 400);
    window.setTimeout(() => {
      stage.classList.remove('switching');
      flash.classList.remove('run');
      inRoom = true;
      busy = false;
      haptic(9);
      sfx.gull(0.3);
      hint.textContent = '上滑看房型 · 轻触窗户看海';
      hint.classList.remove('hide');
    }, 950);
  };

  const exitRoom = () => {
    if (!inRoom) return;
    inRoom = false;
    drawerOpen = false;
    document.body.classList.remove('in-room');
    document.getElementById('roombar')?.classList.remove('show');
    unmountRoom();
    roomViewer?.destroy();
    roomViewer = null;
    document.getElementById('orderPanel')?.classList.remove('open');
    document.getElementById('detailPanel')?.classList.remove('open');
    document.getElementById('paypage')?.classList.remove('open');
    document.getElementById('orderVeil')?.classList.remove('show');
    document.body.classList.remove('order-open');
    engine.exitRoomScene();
    engine.hideRoom(0);
    engine.closeSplit(700);
    card.classList.remove('dim');
    hint.textContent = '轻触卡片「进入」· 拉开这一层';
    engine.playTimeline(
      [
        { t: 0, target: [...engine.camera.target] as [number, number, number], distance: engine.camera.distance, yaw: engine.camera.yaw, pitch: engine.camera.pitch, fov: engine.camera.fov },
        { t: 0.9, target: home.target, distance: home.distance, yaw: home.yaw, pitch: home.pitch, fov: home.fov, ease: 'outCubic' },
      ],
      () => { engine.controls.autoRotate = true; },
    );
  };

  const enterSpace = () => {
    if (inRoom) return;
    if (drawerOpen) enterRoom();
    else openDrawer();
  };

  $('#enterBtn').addEventListener('click', enterSpace);
  document.getElementById('hotspot')?.addEventListener('click', enterSpace);
  $('#backBtn').addEventListener('click', exitRoom);

  (window as unknown as { __pc?: unknown }).__pc = engine;
}
