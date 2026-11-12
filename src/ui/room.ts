/**
 * 第二页（屏6/屏7/屏11）：室内漫游的交互层。
 * 只做 DOM + 投影，不碰渲染器；所有位置都是套间的局部坐标（10×8×3.2m）。
 */
import type { Engine } from '../engine/Engine';

type Obj = {
  id: string;
  label: string;
  at: [number, number, number];
  /** 需要画标签的「主推」热点 */
  featured?: boolean;
  kind?: 'window';
};

/** 26 个可点物体 */
const OBJECTS: Obj[] = [
  { id: 'window', label: '窗户 · 看海', at: [0, 1.72, -3.92], featured: true, kind: 'window' },
  { id: 'bed', label: '大床', at: [-1.95, 0.78, -2.3], featured: true },
  { id: 'nightstand', label: '床头柜', at: [-0.72, 0.62, -2.4] },
  { id: 'bedlamp', label: '床头灯', at: [-0.8, 1.12, -2.92] },
  { id: 'desk', label: '书桌', at: [2.0, 0.82, -3.0], featured: true },
  { id: 'desklamp', label: '台灯', at: [2.66, 1.16, -3.0] },
  { id: 'bench', label: '窗前长凳', at: [0, 0.5, -3.6] },
  { id: 'rug', label: '地毯', at: [0, 0.06, -0.2] },
  { id: 'chair', label: '单人椅', at: [-2.9, 0.92, -0.1] },
  { id: 'pendant', label: '吊灯', at: [0, 2.55, -1.8] },
  { id: 'curtain', label: '窗帘', at: [-4.7, 1.6, -3.5] },
  { id: 'tv', label: '电视', at: [4.86, 1.5, -2.0] },
  { id: 'wardrobe', label: '衣柜', at: [-4.8, 1.2, -1.0] },
  { id: 'door', label: '门', at: [-4.86, 1.1, 1.5] },
  { id: 'switch', label: '开关', at: [-4.9, 1.4, 2.5] },
  { id: 'socket', label: '插座', at: [-4.9, 0.36, -0.2] },
  { id: 'ac', label: '空调', at: [3.0, 2.85, -3.6] },
  { id: 'ceiling', label: '顶灯', at: [2.5, 3.02, -2.0] },
  { id: 'art', label: '装饰画', at: [4.9, 1.72, -0.6] },
  { id: 'plant', label: '绿植', at: [-4.3, 0.62, 2.2] },
  { id: 'pillow', label: '抱枕', at: [-2.6, 0.92, -2.9] },
  { id: 'duvet', label: '被褥', at: [-2.0, 0.82, -1.7] },
  { id: 'slipper', label: '拖鞋', at: [-1.2, 0.08, -1.0] },
  { id: 'robe', label: '浴袍', at: [4.8, 1.3, -1.2] },
  { id: 'cup', label: '水杯', at: [1.5, 0.84, -3.1] },
  { id: 'book', label: '书', at: [1.92, 0.84, -2.9] },
];

const SCREEN_POS: Record<string, [number, number]> = {
  window: [24, 26],
  bed: [63, 52],
  nightstand: [84, 50],
  bedlamp: [76, 42],
  desk: [11, 58],
  desklamp: [30, 46],
  bench: [47, 66],
  rug: [52, 80],
  chair: [44, 40],
  pendant: [52, 18],
  curtain: [15, 34],
  tv: [90, 30],
  wardrobe: [8, 30],
  door: [6, 72],
  switch: [12, 50],
  socket: [16, 64],
  ac: [66, 16],
  ceiling: [46, 10],
  art: [80, 22],
  plant: [22, 74],
  pillow: [58, 44],
  duvet: [68, 64],
  slipper: [40, 86],
  robe: [4, 52],
  cup: [86, 62],
  book: [20, 60],
};
const PHOTO_MODE = true;

let raf = 0;
let mounted = false;
const lit = new Set<string>(['window', 'bed', 'desk']);
let current: string | null = null;

export function mountRoom(engine: Engine) {
  if (mounted) return;
  mounted = true;
  const layer = document.getElementById('roomAnchors')!;
  const selbox = document.createElement('div');
  selbox.className = 'selbox';
  selbox.innerHTML =
    '<i></i><i></i><i></i><i></i><span class="sel-tag">SELECTED · 已选中</span>';
  layer.appendChild(selbox);

  const nodes = new Map<string, HTMLButtonElement>();
  for (const o of OBJECTS) {
    const b = document.createElement('button');
    b.className = 'rspot' + (o.featured ? ' featured' : '');
    b.dataset.id = o.id;
    b.innerHTML =
      `<span class="dot"><span class="ring"></span><span class="ring"></span><span class="ring"></span></span>` +
      (o.featured ? `<span class="label">◆ ${o.label}</span>` : '');
    b.addEventListener('click', () => select(o, b));
    layer.appendChild(b);
    nodes.set(o.id, b);
  }

  const select = (o: Obj, node: HTMLButtonElement) => {
    current = o.id;
    node.classList.add('on');
    if (!lit.has(o.id)) {
      lit.add(o.id);
      updateProgress();
    }
    if (o.kind === 'window') openDetail();
    else closeDetail();
    engine.controls.enabled = true;
  };

  const project = () => {
    raf = requestAnimationFrame(project);
    if (PHOTO_MODE) {
      const s2 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--s')) || 0.44;
      const W = window.innerWidth / s2;
      const H = window.innerHeight / s2;
      for (const o of OBJECTS) {
        const node = nodes.get(o.id);
        const p = SCREEN_POS[o.id];
        if (!node || !p) continue;
        node.style.display = '';
        node.style.left = `${(p[0] / 100) * W}px`;
        node.style.top = `${(p[1] / 100) * H}px`;
        node.style.opacity = '1';
      }
      if (current) {
        const o = OBJECTS.find((x) => x.id === current)!;
        const p = SCREEN_POS[o.id];
        if (p) {
          selbox.classList.add('show');
          selbox.style.left = `${(p[0] / 100) * W}px`;
          selbox.style.top = `${(p[1] / 100) * H}px`;
          selbox.style.width = '260px';
          selbox.style.height = '260px';
        }
      }
      return;
    }
    const pose = engine.roomPose;
    const world = projectToScreen(engine, pose.pos, pose.yaw);
    for (const o of OBJECTS) {
      const node = nodes.get(o.id);
      if (!node) continue;
      const p = world(o.at);
      if (!p) { node.style.display = 'none'; continue; }
      node.style.display = '';
      node.style.left = `${p[0]}px`;
      node.style.top = `${p[1]}px`;
      node.style.opacity = p[2] < 0.3 ? '0.25' : '1';
    }
    if (current) {
      const o = OBJECTS.find((x) => x.id === current)!;
      const p = world(o.at);
      if (p) {
        selbox.classList.add('show');
        selbox.style.left = `${p[0]}px`;
        selbox.style.top = `${p[1]}px`;
        selbox.style.width = '150px';
        selbox.style.height = '150px';
      }
    } else {
      selbox.classList.remove('show');
    }
  };
  raf = requestAnimationFrame(project);

  bindOrderPanel();
  bindDetail();
}

export function unmountRoom() {
  mounted = false;
  cancelAnimationFrame(raf);
  document.getElementById('roomAnchors')!.innerHTML = '';
  document.getElementById('orderPanel')?.classList.remove('open');
  document.getElementById('detailPanel')?.classList.remove('open');
  document.getElementById('orderVeil')?.classList.remove('show');
  current = null;
}

function projectToScreen(engine: Engine, pos: [number, number, number], yaw: number) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const m = engine.camera.viewProj;
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--s')) || 0.44;
  const W = canvas.clientWidth / scale;
  const H = canvas.clientHeight / scale;
  return (local: [number, number, number]): [number, number, number] | null => {
    const x = pos[0] + local[0] * c + local[2] * s;
    const y = pos[1] + local[1];
    const z = pos[2] - local[0] * s + local[2] * c;
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0.01) return null;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    return [(cx / cw * 0.5 + 0.5) * W, (0.5 - cy / cw * 0.5) * H, cw];
  };
}

function updateProgress() {
  const b = document.querySelector('#roombar b');
  if (b) {
    const n = Math.min(8, 3 + (lit.size - 3));
    b.textContent = `点亮东山 ${n} / 8`;
    const s = document.querySelector('#roombar span');
    if (s) s.textContent = `再点亮 ${8 - n} 个解锁岛藏`;
  }
}

function bindOrderPanel() {
  const panel = document.getElementById('orderPanel')!;
  const veil = document.getElementById('orderVeil')!;
  const grab = document.getElementById('orderGrab')!;
  let y0 = 0;
  let dragging = false;
  const open = () => {
    panel.classList.add('open');
    veil.classList.add('show');
    document.body.classList.add('order-open');
  };
  const close = () => {
    panel.classList.remove('open');
    veil.classList.remove('show');
    document.body.classList.remove('order-open');
  };

  grab.addEventListener('pointerdown', (e) => { dragging = true; y0 = e.clientY; });
  window.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    if (y0 - e.clientY > 40) open();
    else if (e.clientY - y0 > 40) close();
  });
  grab.addEventListener('click', () => (panel.classList.contains('open') ? close() : open()));
  const pay = document.getElementById('paypage');
  const openPay = () => pay?.classList.add('open');
  document.getElementById('buyBtn')?.addEventListener('click', openPay);
  document.querySelectorAll('.rc-buy').forEach((b) => b.addEventListener('click', openPay));
  document.getElementById('payBack')?.addEventListener('click', () => pay?.classList.remove('open'));
  document.getElementById('payNow')?.addEventListener('click', () => {
    const btn = document.getElementById('payNow') as HTMLButtonElement;
    btn.textContent = '支付中…';
    window.setTimeout(() => { btn.textContent = '支付成功 ✓'; }, 1400);
  });
}

function openDetail() {
  document.getElementById('detailPanel')!.classList.add('open');
  document.getElementById('orderVeil')!.classList.add('show');
}
function closeDetail() {
  document.getElementById('detailPanel')!.classList.remove('open');
  document.getElementById('orderVeil')!.classList.remove('show');
}

function bindDetail() {
  document.getElementById('playVoice')?.addEventListener('click', () => {
    const btn = document.getElementById('playVoice')!;
    btn.textContent = '▶ 播放中…';
    window.setTimeout(() => (btn.textContent = '▶ 听语音'), 2200);
  });
  document.getElementById('bookmark')?.addEventListener('click', () => {
    const btn = document.getElementById('bookmark')!;
    btn.textContent = btn.textContent?.includes('★') ? '☆ 书签' : '★ 已收藏';
  });
  const step = (dir: number) => {
    const i = OBJECTS.findIndex((o) => o.id === current);
    const next = OBJECTS[(i + dir + OBJECTS.length) % OBJECTS.length];
    current = next.id;
    if (next.kind === 'window') openDetail();
    else closeDetail();
  };
  document.getElementById('prevObj')?.addEventListener('click', () => step(-1));
  document.getElementById('nextObj')?.addEventListener('click', () => step(1));
}
