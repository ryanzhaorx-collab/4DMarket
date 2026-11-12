/** PlayCanvas 分支的最小可跑流程：加载 → 入场 → 上下拆分 → 整层抽出 */
import { PcEngine } from '../engine/pc/PcEngine';

const canvas = document.getElementById('pc') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const btn = document.getElementById('go') as HTMLButtonElement;

const engine = new PcEngine({
  canvas,
  layers: [0, 1, 2, 3, 4, 5].map((i) => `/models/HS_Bolimuqiang/layer-${i}.sog`),
});

void (async () => {
  hud.textContent = 'PlayCanvas · 加载 3DGS…';
  await engine.start();
  engine.controls.autoRotate = true;

  hud.textContent = 'PlayCanvas · 就绪';
  btn.disabled = false;
})();

let opened = false;
btn.addEventListener('click', () => {
  if (opened) return;
  opened = true;
  const b = engine.contentBounds()!;
  const cx = (b.min[0] + b.max[0]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  const midY = 22;
  const h = b.max[1] - b.min[1];

  engine.openSplit(h * 0.13, h * 0.1, 1100);
  const cam = engine.camera;
  engine.playTimeline(
    [
      { t: 0, target: [...cam.target], distance: cam.distance, yaw: cam.yaw, pitch: cam.pitch, fov: cam.fov },
      { t: 1.0, target: [cx, midY + 8, cz], distance: 340, yaw: 0.55, pitch: 0.3, fov: 56, ease: 'outCubic' },
      { t: 1.35, target: [cx, midY + 8, cz], distance: 340, yaw: 0.55, pitch: 0.3, fov: 56, ease: 'linear' },
    ],
    () => {
      window.setTimeout(() => {
        const camYaw = engine.camera.yaw;
        const dir: [number, number, number] = [Math.sin(camYaw) * 0.85, 0.55, Math.cos(camYaw) * 0.85];
        engine.showRoom([cx, midY - 22, cz], dir, 58, 1500, 'outBack');
      }, 200);
    },
  );
});

setInterval(() => {
  const s = engine.stats;
  hud.textContent = `PlayCanvas · ${s.fps} FPS\n3DGS 分块 ${s.tiles}/3 · ${opened ? '已拆分' : '待进入'}`;
}, 400);
