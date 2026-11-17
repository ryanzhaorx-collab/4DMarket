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
    background: '/models/yuehua/scene.sog',
    floors: [1, 2, 3, 4, 5].map((i) => `/models/yuehua/bldg/layer-${i}.sog`),
    roomUrl: '/models/yuehua/room.sog',
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
  engine.roomSize = { w: tune.boxW, d: tune.boxD, h: tune.boxH };
  engine.setRoomYaw(tune.glassYaw);
  if (new URLSearchParams(location.search).get('tune') === '1') {
    mountTune(
      tune,
      () => {
        drawerOpen = false;
        inRoom = false;
        busy = false;
        openDrawer();
      },
      (p) => {
        // 尺寸变化即时重建玻璃盒
        engine.roomSize = { w: p.boxW, d: p.boxD, h: p.boxH };
        engine.setRoomYaw(p.glassYaw);
        engine.rebuildRoom();
      },
    );
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
    // 目标楼：用户在 ?pick=1 里取的坐标（x≈99, z≈-72），层高取中段
    const TOX = 99;
    const TOZ = -72;
    const TOY = 30 + tune.pushStartY;
    const yawNow = engine.camera.yaw;
    const PUSH: [number, number, number] = [Math.sin(yawNow), 0, Math.cos(yawNow)];
    const PLATE: [number, number, number] = [TOX, TOY, TOZ];
    const cam0 = {
      target: [...engine.camera.target] as [number, number, number],
      distance: engine.camera.distance,
      yaw: engine.camera.yaw,
      pitch: engine.camera.pitch,
      fov: engine.camera.fov,
    };

    // 唯一的镜头时间轴：所有目标点都由 PUSH / PLATE 推导，保证和盘子一致
    // 镜头只跳一次：从当前机位切到目标楼正前方，之后完全不动
    const camIn = {
      t: 1.2,
      target: [TOX, TOY, TOZ] as [number, number, number],
      distance: 130,
      yaw: 0.98,
      pitch: 0.16,
      fov: 46,
      ease: 'inOutCubic' as const,
    };
    const camStay = { ...camIn, t: 6.5, ease: 'linear' as const };

    engine.playTimeline(
      [
        { t: 0, ...cam0 },
        camIn,
        camStay,
      ],
      () => {
        drawerOpen = true;
        busy = false;
        hint.textContent = '本月主推楼层已抽出 · 轻触进入房间';
        hint.classList.remove('hide');
      },
    );

    // ① 环境变化：星空淡入（不压 UI）
    document.body.classList.add('night-mode');
    sfx.whoosh(0.6);

    // ② 镜头推入的同时暗场升起，把「撤大场景 / 换楼层」这一下盖住
    const veil = document.getElementById('swapveil');
    window.setTimeout(() => veil?.classList.add('on'), 420);

    window.setTimeout(() => {
      engine.setBackgroundVisible(false);
      engine.showFloors(true);
    }, 900);

    // ③ 暗场回落，楼层开始分层（观众看到的是「推近 → 变暗 → 楼已经分开了」）
    window.setTimeout(() => {
      veil?.classList.remove('on');
      engine.openUnfold(tune.unfoldSpread, tune.unfoldDuration, 3);
      sfx.whoosh(0.9);
    }, 1250);


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

    // ① 先推近：镜头朝房间俯冲一小段（0.55s），给「进去」一个动势
    const cam = engine.camera;
    const aim = engine.roomPose.pos;
    engine.playTimeline(
      [
        { t: 0, target: [...cam.target] as [number, number, number], distance: cam.distance, yaw: cam.yaw, pitch: cam.pitch, fov: cam.fov },
        {
          t: 0.55,
          target: [aim[0], aim[1], aim[2]],
          distance: Math.max(9, cam.distance * 0.42),
          yaw: cam.yaw,
          pitch: cam.pitch - 0.04,
          fov: cam.fov + 6,
          ease: 'inOutCubic',
        },
      ],
    );
    sfx.whoosh(0.9);

    // ② 推近完成后再白闪过场切页
    window.setTimeout(() => {
      flash.classList.remove('run');
      void flash.offsetWidth;
      flash.classList.add('run');
      stage.classList.add('switching');
      sfx.whoosh(0.7);
    }, 480);

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
    document.getElementById('roomlabel')?.classList.remove('show');
    document.body.classList.remove('order-open', 'night-mode');
    engine.setBackgroundVisible(true);
    engine.showFloors(false);
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

  // ?pick=1：在地面上取世界坐标（用于定位「要拆分的那栋楼」）
  if (q.get('pick') === '1') {
    const badge = document.createElement('div');
    badge.style.cssText =
      'position:fixed;left:12px;top:120px;z-index:999;padding:10px 14px;border-radius:10px;' +
      'background:rgba(8,12,16,.9);border:1px solid rgba(214,178,106,.4);color:#f0d9a0;' +
      'font:13px/1.6 -apple-system,sans-serif;pointer-events:none;white-space:pre';
    badge.textContent = '点一下地面取坐标';
    document.body.appendChild(badge);

    // 用相机基向量构造射线：r = normalize(cross(f, up))，u = cross(r, f)
    // 注意 r 的符号：写成 [f.z, 0, -f.x] 会左右镜像，转动镜头后取点就飘
    const pickPoint = (clientX: number, clientY: number) => {
      const cam = engine.camera;
      const rect = canvas.getBoundingClientRect();
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
      const tan = Math.tan((cam.fov * Math.PI) / 360);
      const aspect = rect.width / rect.height;

      const f: [number, number, number] = [
        cam.target[0] - cam.eye[0],
        cam.target[1] - cam.eye[1],
        cam.target[2] - cam.eye[2],
      ];
      const fl = Math.hypot(f[0], f[1], f[2]) || 1;
      f[0] /= fl; f[1] /= fl; f[2] /= fl;

      // r = normalize(cross(f, (0,1,0))) = normalize((-f.z, 0, f.x))
      const r: [number, number, number] = [-f[2], 0, f[0]];
      const rl = Math.hypot(r[0], r[2]) || 1;
      r[0] /= rl; r[2] /= rl;

      // u = cross(r, f)
      const u: [number, number, number] = [
        r[1] * f[2] - r[2] * f[1],
        r[2] * f[0] - r[0] * f[2],
        r[0] * f[1] - r[1] * f[0],
      ];

      const dir: [number, number, number] = [
        f[0] + r[0] * ndcX * tan * aspect + u[0] * ndcY * tan,
        f[1] + r[1] * ndcX * tan * aspect + u[1] * ndcY * tan,
        f[2] + r[2] * ndcX * tan * aspect + u[2] * ndcY * tan,
      ];

      if (Math.abs(dir[1]) < 1e-4) return null;          // 射线与地面平行
      const t = -cam.eye[1] / dir[1];
      if (t <= 0) return null;                            // 交点在身后
      return { x: cam.eye[0] + dir[0] * t, z: cam.eye[2] + dir[2] * t };
    };


    canvas.addEventListener('pointermove', (e) => {
      const p = pickPoint(e.clientX, e.clientY);
      badge.textContent = p ? `x ${p.x.toFixed(0)}   z ${p.z.toFixed(0)}\n（点一下复制）` : '射线与地面平行，抬高视角';
    });
    canvas.addEventListener('click', (e) => {
      const p = pickPoint(e.clientX, e.clientY);
      if (!p) return;
      const txt = `${p.x.toFixed(0)}, ${p.z.toFixed(0)}`;
      void navigator.clipboard?.writeText(txt).catch(() => {});
      badge.textContent = `已复制：${txt}`;
      console.warn('[pick]', txt);
    });
  }

  // ?dbg=1：左上角显示资产加载情况（排查空洞用）
  if (q.get('dbg') === '1') {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;left:12px;top:70px;z-index:999;padding:8px 12px;border-radius:8px;' +
      'background:rgba(8,12,16,.85);border:1px solid rgba(120,210,255,.4);color:#9fe0ff;' +
      'font:12px/1.5 -apple-system,sans-serif;white-space:pre';
    document.body.appendChild(box);
    const tick = () => {
      const r = engine.loadReport;
      box.textContent = `背景 ${r.background ? '✓' : '✗'}  楼层 ${r.floors}/${r.floorTotal}  房间 ${r.room ? '✓' : '✗'}`;
      window.setTimeout(tick, 500);
    };
    tick();
  }

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
