/**
 * 室内模型单测页：只加载 room.sog + 一圈玻璃墙。
 * 用来验证「玻璃墙尺寸 = 模型尺寸」「模型朝向是否正确」。
 * 用法：/room.html?url=/models/yuehua/room.sog&ir=-90,0,0
 */
import * as pc from 'playcanvas';
// @ts-ignore 团队查看器（纯 JS）
import { SplatViewer } from '../engine/pc/viewer/splat-viewer.js';

const q = new URLSearchParams(location.search);
const url = q.get('url') ?? '/models/yuehua/room.sog';
const rot = (q.get('ir') ?? '-90,0,0').split(',').map(Number);
const info = document.getElementById('info')!;
const canvas = document.getElementById('rc') as HTMLCanvasElement;

const viewer = new SplatViewer(canvas, { pixelRatio: Math.min(devicePixelRatio, 2), reveal: false } as never);

void (async () => {
const res = await viewer.load({ id: 'room', url });

const aabb = res?.aabb as { center: pc.Vec3; halfExtents: pc.Vec3 } | null;
if (!aabb) {
  info.textContent = '模型没有包围盒';
} else {
  const h = aabb.halfExtents;
  const c = aabb.center;
  // 模型（Z-up）：宽 2hx，深 2hy，高 2hz
  const w = h.x * 2;
  const d = h.y * 2;
  const hh = h.z * 2;

  info.textContent =
    `尺寸 ${w.toFixed(2)} × ${d.toFixed(2)} × ${hh.toFixed(2)} m\n` +
    `中心 ${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)}\n` +
    `朝向 ${rot.join(',')}\n拖拽旋转 · 滚轮缩放`;

  // 一圈玻璃墙（与模型同心、同尺寸）
  const app = (viewer as unknown as { app: pc.Application }).app;
  const y0 = c.z - hh / 2;
  const y1 = c.z + hh / 2;
  const x0 = c.x - w / 2;
  const x1 = c.x + w / 2;
  const z0 = c.y - d / 2;
  const z1 = c.y + d / 2;

  const quads: number[][][] = [
    [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
    [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]],
  ];
  const pos: number[] = [];
  const idx: number[] = [];
  quads.forEach((q4) => {
    const base = pos.length / 3;
    q4.forEach((p) => pos.push(p[0], p[1], p[2]));
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const mesh = new pc.Mesh(app.graphicsDevice);
  mesh.setPositions(new Float32Array(pos));
  mesh.setNormals(new Float32Array(pos.map((_, i) => (i % 3 === 1 ? 1 : 0))));
  mesh.setIndices(new Uint32Array(idx));
  mesh.update(pc.PRIMITIVE_TRIANGLES);

  const mat = new pc.StandardMaterial();
  mat.emissive = new pc.Color(0.3, 0.8, 1);
  mat.emissiveIntensity = 2;
  mat.opacity = 0.18;
  mat.blendType = pc.BLEND_NORMAL;
  mat.depthWrite = false;
  mat.cull = pc.CULLFACE_NONE;
  mat.update();

  const e = new pc.Entity('glass', app);
  e.addComponent('render', { type: 'asset' });
  e.render!.meshInstances = [new pc.MeshInstance(mesh, mat)];
  e.setEulerAngles(rot[0], rot[1], rot[2]);
  app.root.addChild(e);
}
})();
