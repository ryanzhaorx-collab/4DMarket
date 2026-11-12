/**
 * 首屏的 PlayCanvas 分支（?engine=pc）。
 * 复用现有的 DOM/UI（卡片、进度胶囊、第二页实景），只把 3D 层换成 PcEngine。
 */
import { PcEngine } from '../engine/pc/PcEngine';
import { mountRoom, unmountRoom } from '../ui/room';
import { Sfx, haptic } from '../ui/sfx';
import { probe } from '../engine/pc/platform';

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

  const engine = new PcEngine({
    canvas,
    layers: [0, 1, 2, 3, 4, 5].map((i) => `/models/HS_Bolimuqiang/layer-${i}.sog`),
  });

  const sfx = new Sfx();
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
  engine.startResolve(1500);
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

  const openDrawer = () => {
    if (busy || inRoom) return;
    busy = true;
    sfx.whoosh(1.2);
    card.classList.add('dim');
    hint.classList.add('hide');
    engine.controls.autoRotate = false;

    // ① 宏观锚定：楼体脱街景、悬浮、缓慢自转（暗场 + 拉远一点）
    document.body.classList.add('godview');
    engine.playTimeline(
      [
        { t: 0, target: [...engine.camera.target] as [number, number, number], distance: engine.camera.distance, yaw: engine.camera.yaw, pitch: engine.camera.pitch, fov: engine.camera.fov },
        { t: 1.1, target: [cx, midY + 20, cz], distance: 620, yaw: 0.18, pitch: 0.14, fov: 46, ease: 'inOutCubic' },
      ],
      () => {
        engine.controls.autoRotate = true;
      },
    );

    // ② 空间折叠：千层糕展开（1.1s 起，1.6s）
    window.setTimeout(() => {
      engine.controls.autoRotate = false;
      engine.openUnfold(16, 1900, 3);
      sfx.whoosh(0.8);
      engine.playTimeline(
        [
          { t: 0, target: [cx, midY + 20, cz], distance: 620, yaw: 0.18, pitch: 0.14, fov: 46 },
          { t: 2.0, target: [cx, midY + 10, cz], distance: 560, yaw: 0.22, pitch: 0.12, fov: 46, ease: 'inOutCubic' },
        ],
      );
    }, 1100);

    // ③ 抽屉卡位：目标层抽出 + 震动 + 机械声
    window.setTimeout(() => {
      // 目标层（第 3 层）展开后在 midY + 37m 的位置：盒子就在原地，只沿视线方向轻推出来
      const yaw = engine.camera.yaw;
      const dir: [number, number, number] = [Math.sin(yaw) * 0.55, 0.12, Math.cos(yaw) * 0.55];
      engine.showRoom([cx, midY + 8, cz], dir, 20, 1400, 'outBack');
      sfx.latch();
      haptic(16);
    }, 2700);

    engine.playTimeline(
      [
        { t: 0, target: [...engine.camera.target] as [number, number, number], distance: engine.camera.distance, yaw: engine.camera.yaw, pitch: engine.camera.pitch, fov: engine.camera.fov },
        { t: 1.0, target: [cx, midY + 8, cz], distance: 340, yaw: 0.55, pitch: 0.3, fov: 56, ease: 'outCubic' },
      ],
      () => {
        const yaw = engine.camera.yaw;
        const dir: [number, number, number] = [Math.sin(yaw) * 0.85, 0.55, Math.cos(yaw) * 0.85];
        engine.showRoom([cx, midY - 24, cz], dir, 60, 1500, 'outBack');
        window.setTimeout(() => {
          drawerOpen = true;
          busy = false;
          sfx.latch();
          haptic(14);
          hint.textContent = '本月主推楼层已抽出 · 轻触进入房间';
          hint.classList.remove('hide');
        }, 1500);
      },
    );
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
