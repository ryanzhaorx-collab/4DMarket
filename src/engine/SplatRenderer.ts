import { OrbitCamera } from './Camera';
import { createProgram, createQuadVAO, createTexture, type ProgramInfo } from './glutil';
import { DepthSorter } from './radix';
import { SPLAT_FS, SPLAT_VS } from './shaders';
import type { SplatPayload } from './types';

interface LayerGPU {
  pos: WebGLTexture;
  scale: WebGLTexture;
  rot: WebGLTexture;
  col: WebGLTexture;
  idx: WebGLTexture;
  width: number;
  height: number;
  /** 纹理行对齐后的 texel 数（≥ count），索引上传时用于补齐 */
  texels: number;
  idxScratch: Uint32Array;
  count: number;
}

interface Layer {
  lod: number;
  sortId: number;
  payload: SplatPayload;
  gpu: LayerGPU | null;
  /** 0..1 淡入系数，切换 LOD 时交叉淡入，避免闪跳 */
  fade: number;
  targetFade: number;
  /** 当前索引纹理里已经排好序的相机 epoch */
  sortedEpoch: number;
  pendingSeq: number;
  disposed: boolean;
}

interface Tile {
  id: number;
  key: string;
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  radius: number;
  layers: Layer[];
  active: Layer | null;
  visible: boolean;
  distance: number;
  priority: number;
  lastEpoch: number;
}

export interface SplatStats {
  /** 常驻显存的总点数 */
  total: number;
  sorts: number;
  tiles: number;
  visibleTiles: number;
  splats: number;
  drawCalls: number;
  gpuMemoryBytes: number;
}

const MAX_TEX = 1024;

export class SplatRenderer {
  private gl: WebGL2RenderingContext;
  private prog: ProgramInfo;
  private vao: WebGLVertexArrayObject;
  private tiles: Tile[] = [];
  private nextTileId = 1;
  private nextSeq = 1;
  private worker: Worker | null = null;
  private workerAlive = false;
  private fallbackSorter = new DepthSorter();
  private inFlight = new Map<number, { tile: Tile; layer: Layer; seq: number; sentAt: number }>();
  private appliedSorts = 0;
  private resolve = 1;
  private scatter = 0;
  private slice = {
    y0: 0, y1: 0, lift: 0,
    dir: [0, 1, 0] as [number, number, number],
    dim: 1, t: 0,
    box: [1e9, -1e9, 1e9, -1e9] as [number, number, number, number],
  };
  private split = { up: 0, down: 0, t: 0 };
  private epoch = 0;
  private lastEye: [number, number, number] = [1e9, 1e9, 1e9];
  private lastFwd: [number, number, number] = [0, 0, 1];
  private maxSortsPerFrame = 2;
  private splatBudget = 260_000;
  private gpuBytes = 0;
  private lastStats: SplatStats = { total: 0, sorts: 0, tiles: 0, visibleTiles: 0, splats: 0, drawCalls: 0, gpuMemoryBytes: 0 };
  private frustum = new Float32Array(24);

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = createProgram(gl, SPLAT_VS, SPLAT_FS, 'splat');
    this.vao = createQuadVAO(gl);
    this.initWorker();
  }

  private initWorker() {
    try {
      const w = new Worker(new URL('./workers/sort.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent) => this.onSorted(ev.data as { seq: number; indices: Uint32Array });
      w.onerror = () => {
        this.workerAlive = false;
        this.worker = null;
      };
      this.worker = w;
      this.workerAlive = true;
    } catch {
      this.workerAlive = false;
      this.worker = null;
    }
  }

  setBudget(splats: number) {
    this.splatBudget = Math.max(40_000, splats);
  }

  /** 入场进度：0 = 粉尘态，1 = 实体 */
  setResolve(t: number, scatter: number) {
    this.resolve = Math.max(0, Math.min(1, t));
    this.scatter = scatter;
  }

  /** 伪分层抽屉：band=[y0,y1] 沿 dir 平移 lift，其余部分透明度降到 dim */
  setSlice(
    y0: number, y1: number, lift: number,
    dir: [number, number, number], dim: number, t: number,
    box?: [number, number, number, number],
  ) {
    this.slice = { y0, y1, lift, dir, dim, t, box: box ?? [1e9, -1e9, 1e9, -1e9] };
  }

  /** 楼体上下拆分：上半上移、下半下沉 */
  setSplit(up: number, down: number, t: number) {
    this.split = { up, down, t };
  }

  set maxSorts(n: number) {
    this.maxSortsPerFrame = Math.max(1, Math.min(4, Math.round(n)));
  }

  get stats(): SplatStats {
    return this.lastStats;
  }

  get tileCount() {
    return this.tiles.length;
  }

  /** 点数最多的分块（通常落在塔楼主体上），用作楼层锚点 */
  get densest(): { center: [number, number, number]; count: number } | null {
    let best: { center: [number, number, number]; count: number } | null = null;
    for (const t of this.tiles) {
      const c = t.active?.payload.count ?? 0;
      if (c > 0 && (!best || c > best.count)) best = { center: t.center, count: c };
    }
    return best;
  }

  /** 已加载点云的整体包围盒（世界坐标，已含对齐变换） */
  get bounds(): { min: [number, number, number]; max: [number, number, number] } | null {
    if (!this.tiles.length) return null;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const t of this.tiles) {
      for (let i = 0; i < 3; i++) {
        if (t.min[i] < min[i]) min[i] = t.min[i];
        if (t.max[i] > max[i]) max[i] = t.max[i];
      }
    }
    return { min, max };
  }

  /**
   * 加入一块 splat。同一 key 的不同 lod 会合并为一个 tile，便于做 LOD 交叉淡入。
   */
  addTile(payload: SplatPayload, lod: number, key: string) {
    let tile = this.tiles.find((t) => t.key === key);
    if (!tile) {
      const center: [number, number, number] = [
        (payload.min[0] + payload.max[0]) / 2,
        (payload.min[1] + payload.max[1]) / 2,
        (payload.min[2] + payload.max[2]) / 2,
      ];
      const r = Math.hypot(
        payload.max[0] - payload.min[0],
        payload.max[1] - payload.min[1],
        payload.max[2] - payload.min[2],
      ) / 2;
      tile = {
        id: this.nextTileId++,
        key,
        min: payload.min,
        max: payload.max,
        center,
        radius: Math.max(r * 1.15, 0.5),
        layers: [],
        active: null,
        visible: true,
        distance: 0,
        priority: 0,
        lastEpoch: -1,
      };
      this.tiles.push(tile);
    }
    const layer: Layer = {
      lod,
      sortId: tile.id * 8 + lod,
      payload,
      gpu: null,
      fade: 1,
      targetFade: 1,
      sortedEpoch: -1,
      pendingSeq: 0,
      disposed: false,
    };
    tile.layers.push(layer);
    tile.layers.sort((a, b) => a.lod - b.lod);
    this.uploadLayer(layer);
    this.pickActiveLod(tile);

    if (this.workerAlive && this.worker) {
      const copy = payload.pos.slice();
      this.worker.postMessage({ type: 'register', tileId: layer.sortId, pos: copy, count: payload.count }, [copy.buffer]);
    }
    return tile;
  }

  /** 删除某个 key 的全部 LOD（内存预算不足或离开区域时） */
  removeTile(key: string) {
    const idx = this.tiles.findIndex((t) => t.key === key);
    if (idx < 0) return;
    const tile = this.tiles[idx];
    for (const l of tile.layers) this.disposeLayer(l);
    this.tiles.splice(idx, 1);
  }

  private pickActiveLod(tile: Tile) {
    const available = tile.layers.filter((l) => !l.disposed && l.payload.count > 0);
    if (!available.length) return;
    const best = available[available.length - 1];
    if (tile.active !== best) {
      // 高 LOD 直接顶上（绘制顺序保证它盖在低 LOD 之上），旧 LOD 淡出后释放显存
      if (tile.active) tile.active.targetFade = 0;
      tile.active = best;
      best.fade = 1;
      best.targetFade = 1;
    }
  }

  private uploadLayer(layer: Layer) {
    const gl = this.gl;
    const p = layer.payload;
    const count = p.count;
    if (!count) return;
    const width = Math.min(MAX_TEX, count);
    const height = Math.ceil(count / width);
    const texels = width * height;

    const pos = new Float32Array(texels * 4);
    const scale = new Float32Array(texels * 4);
    const col = new Uint8Array(texels * 4);
    const rot = new Float32Array(texels * 4);
    rot.set(p.rot);
    for (let i = 0; i < count; i++) {
      pos[i * 4] = p.pos[i * 3];
      pos[i * 4 + 1] = p.pos[i * 3 + 1];
      pos[i * 4 + 2] = p.pos[i * 3 + 2];
      pos[i * 4 + 3] = p.alpha[i];
      scale[i * 4] = p.scale[i * 3];
      scale[i * 4 + 1] = p.scale[i * 3 + 1];
      scale[i * 4 + 2] = p.scale[i * 3 + 2];
      col[i * 4] = p.color[i * 3];
      col[i * 4 + 1] = p.color[i * 3 + 1];
      col[i * 4 + 2] = p.color[i * 3 + 2];
      col[i * 4 + 3] = 255;
    }

    const texPos = createTexture(gl, { width, height, internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, data: pos });
    const texScale = createTexture(gl, { width, height, internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, data: scale });
    const texRot = createTexture(gl, {
      width, height, internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, data: rot,
    });
    const texCol = createTexture(gl, { width, height, internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, data: col });

    const identity = new Uint32Array(texels);
    for (let i = 0; i < texels; i++) identity[i] = i < count ? i : 0;
    const texIdx = createTexture(gl, {
      width, height, internalFormat: gl.R32UI, format: gl.RED_INTEGER, type: gl.UNSIGNED_INT, data: identity,
    });

    layer.gpu = {
      pos: texPos, scale: texScale, rot: texRot, col: texCol, idx: texIdx,
      width, height, texels, idxScratch: identity, count,
    };
    layer.sortedEpoch = -1;
    // 每 splat 52 字节数据 + 4 字节索引
    this.gpuBytes += count * 56;
  }

  private disposeLayer(layer: Layer) {
    const g = layer.gpu;
    if (!g) return;
    const gl = this.gl;
    gl.deleteTexture(g.pos);
    gl.deleteTexture(g.scale);
    gl.deleteTexture(g.rot);
    gl.deleteTexture(g.col);
    gl.deleteTexture(g.idx);
    this.gpuBytes -= layer.payload.count * 56;
    layer.gpu = null;
    layer.disposed = true;
  }

  /** 显卡上下文丢失后重建纹理 */
  rebuildGPU() {
    this.gpuBytes = 0;
    for (const tile of this.tiles) {
      for (const layer of tile.layers) {
        layer.gpu = null;
        layer.disposed = false;
        layer.sortedEpoch = -1;
        this.uploadLayer(layer);
      }
    }
  }

  private buildFrustum(cam: OrbitCamera) {
    const m = cam.viewProj;
    const f = this.frustum;
    // 左右下上近远
    const rows = [
      [m[0] + m[3], m[4] + m[7], m[8] + m[11], m[12] + m[15]],
      [m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]],
      [m[1] + m[3], m[5] + m[7], m[9] + m[11], m[13] + m[15]],
      [m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]],
      [m[2] + m[3], m[6] + m[7], m[10] + m[11], m[14] + m[15]],
      [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],
    ];
    for (let i = 0; i < 6; i++) {
      const r = rows[i];
      const l = Math.hypot(r[0], r[1], r[2]) || 1;
      f[i * 4] = r[0] / l;
      f[i * 4 + 1] = r[1] / l;
      f[i * 4 + 2] = r[2] / l;
      f[i * 4 + 3] = r[3] / l;
    }
  }

  private sphereVisible(x: number, y: number, z: number, r: number): boolean {
    const f = this.frustum;
    for (let i = 0; i < 6; i++) {
      const d = f[i * 4] * x + f[i * 4 + 1] * y + f[i * 4 + 2] * z + f[i * 4 + 3];
      if (d < -r) return false;
    }
    return true;
  }

  /** 每帧调用：视锥剔除、LOD 选择、排序调度、GPU 上传 */
  update(cam: OrbitCamera, dt: number) {
    const eye = cam.eye;
    const dx = eye[0] - this.lastEye[0];
    const dy = eye[1] - this.lastEye[1];
    const dz = eye[2] - this.lastEye[2];
    const moved = Math.hypot(dx, dy, dz);
    const dot = cam.forward[0] * this.lastFwd[0] + cam.forward[1] * this.lastFwd[1] + cam.forward[2] * this.lastFwd[2];
    if (moved > 0.35 || dot < 0.9997) {
      this.epoch++;
      this.lastEye = [eye[0], eye[1], eye[2]];
      this.lastFwd = [cam.forward[0], cam.forward[1], cam.forward[2]];
    }

    this.buildFrustum(cam);

    let visible = 0;
    let totalSplats = 0;
    for (const tile of this.tiles) {
      tile.distance = Math.hypot(
        tile.center[0] - eye[0], tile.center[1] - eye[1], tile.center[2] - eye[2],
      );
      tile.visible = this.sphereVisible(tile.center[0], tile.center[1], tile.center[2], tile.radius) && tile.distance < 1600;
      tile.priority = tile.visible ? (tile.radius / Math.max(tile.distance, 1)) * Math.max(tile.active?.payload.count ?? 0, 100) : 0;
      if (!tile.visible) continue;
      visible++;
      const layer = tile.active;
      if (layer) totalSplats += layer.payload.count;
    }

    const stride = totalSplats > this.splatBudget ? Math.ceil(totalSplats / this.splatBudget) : 1;

    // 排序调度：优先屏幕占比大、且当前 epoch 尚未排序的分块
    const now = performance.now();
    for (const [seq, rec] of this.inFlight) {
      if (now - rec.sentAt > 1500) {
        rec.layer.pendingSeq = 0;
        this.inFlight.delete(seq);
      }
    }
    const pending = [...this.inFlight.values()];
    let budget = this.maxSortsPerFrame;
    if (pending.length >= 1) budget = Math.min(budget, 1);
    if (budget > 0) {
      const candidates = this.tiles
        .filter((t) => t.visible && t.active && t.active.gpu && t.active.sortedEpoch !== this.epoch)
        .filter((t) => t.active!.pendingSeq === 0)
        .sort((a, b) => b.priority - a.priority)
        .slice(0, budget);
      for (const tile of candidates) this.requestSort(tile, cam);
    }

    // 淡入淡出
    for (const tile of this.tiles) {
      for (const layer of tile.layers) {
        if (layer.disposed) continue;
        const speed = dt > 0 ? dt * 2.6 : 0.2;
        if (layer.fade < layer.targetFade) layer.fade = Math.min(layer.targetFade, layer.fade + speed);
        else if (layer.fade > layer.targetFade) layer.fade = Math.max(layer.targetFade, layer.fade - speed);
        if (layer.targetFade === 0 && layer.fade <= 0.001 && tile.layers.length > 1) this.disposeLayer(layer);
      }
    }

    this.visibleTiles = visible;
    this.stride = stride;
  }

  private visibleTiles = 0;
  private stride = 1;

  private requestSort(tile: Tile, cam: OrbitCamera) {
    const layer = tile.active!;
    if (!layer.gpu) return;
    const seq = this.nextSeq++;
    layer.pendingSeq = seq;
    const near = tile.distance - tile.radius;
    const far = tile.distance + tile.radius;
    if (this.workerAlive && this.worker) {
      this.inFlight.set(seq, { tile, layer, seq, sentAt: performance.now() });
      this.worker.postMessage({
        type: 'sort',
        tileId: layer.sortId,
        cam: [cam.eye[0], cam.eye[1], cam.eye[2]],
        fwd: [cam.forward[0], cam.forward[1], cam.forward[2]],
        near,
        far,
        seq,
        epoch: this.epoch,
      });
    } else {
      // 主线程降级：单块排序，限制在 1.2ms 量级内
      try {
        const out = this.fallbackSorter.sort(layer.payload.pos, layer.payload.count, cam.eye, cam.forward, near, far);
        this.uploadIndices(layer, out);
        layer.sortedEpoch = this.epoch;
      } catch {
        /* 忽略：继续用旧顺序渲染 */
      }
      layer.pendingSeq = 0;
    }
  }

  private onSorted(msg: { seq: number; indices: Uint32Array }) {
    const rec = this.inFlight.get(msg.seq);
    if (rec) {
      this.inFlight.delete(msg.seq);
      rec.layer.pendingSeq = 0;
      if (msg.indices.length === rec.layer.payload.count) {
        this.uploadIndices(rec.layer, msg.indices);
        rec.layer.sortedEpoch = this.epoch;
        rec.tile.lastEpoch = this.epoch;
        this.appliedSorts++;
      }
    }
  }

  private uploadIndices(layer: Layer, indices: Uint32Array) {
    const g = layer.gpu;
    if (!g) return;
    const gl = this.gl;
    const pad = g.idxScratch;
    pad.set(indices.subarray(0, Math.min(indices.length, g.count)));
    gl.bindTexture(gl.TEXTURE_2D, g.idx);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, g.width, g.height, gl.RED_INTEGER, gl.UNSIGNED_INT, pad);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  render(cam: OrbitCamera, viewportW: number, viewportH: number) {
    const gl = this.gl;
    gl.useProgram(this.prog.program);
    gl.uniformMatrix4fv(this.prog.uniforms.get('uView') ?? null, false, cam.view);
    gl.uniformMatrix4fv(this.prog.uniforms.get('uProj') ?? null, false, cam.proj);
    gl.uniform2f(this.prog.uniforms.get('uViewport') ?? null, viewportW, viewportH);
    gl.uniform1f(this.prog.uniforms.get('uFocal') ?? null, cam.focalPixels(viewportH));
    gl.uniform1f(this.prog.uniforms.get('uMaxRadius') ?? null, Math.max(64, viewportH * 0.65));
    gl.uniform1f(this.prog.uniforms.get('uResolve') ?? null, this.resolve);
    gl.uniform1f(this.prog.uniforms.get('uScatter') ?? null, this.scatter);
    gl.uniform4f(
      this.prog.uniforms.get('uSlice') ?? null,
      this.slice.y0,
      this.slice.y1,
      this.slice.lift,
      this.slice.dim,
    );
    gl.uniform3f(
      this.prog.uniforms.get('uSliceDir') ?? null,
      this.slice.dir[0],
      this.slice.dir[1],
      this.slice.dir[2],
    );
    gl.uniform1f(this.prog.uniforms.get('uSliceT') ?? null, this.slice.t);
    gl.uniform3f(this.prog.uniforms.get('uSplit') ?? null, this.split.up, this.split.down, this.split.t);
    gl.uniform4f(
      this.prog.uniforms.get('uSliceBox') ?? null,
      this.slice.box[0], this.slice.box[1], this.slice.box[2], this.slice.box[3],
    );
    gl.uniform1i(this.prog.uniforms.get('uPos') ?? null, 0);
    gl.uniform1i(this.prog.uniforms.get('uScale') ?? null, 1);
    gl.uniform1i(this.prog.uniforms.get('uRot') ?? null, 2);
    gl.uniform1i(this.prog.uniforms.get('uCol') ?? null, 3);
    gl.uniform1i(this.prog.uniforms.get('uIdx') ?? null, 4);

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.bindVertexArray(this.vao);

    const visible = this.tiles.filter((t) => t.visible && t.active).sort((a, b) => b.distance - a.distance);
    let drawCalls = 0;
    let drawn = 0;

    for (const tile of visible) {
      // 由远及近逐块绘制；块内由索引纹理保证由远及近
      for (const layer of tile.layers) {
        if (!layer.gpu || layer.fade <= 0.004 || layer.disposed) continue;
        const g = layer.gpu;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, g.pos);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, g.scale);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, g.rot);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, g.col);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, g.idx);

        const stride = this.stride;
        const instances = Math.ceil(layer.payload.count / stride);
        gl.uniform1i(this.prog.uniforms.get('uTexW') ?? null, g.width);
        gl.uniform1i(this.prog.uniforms.get('uIdxStride') ?? null, stride);
        gl.uniform1f(this.prog.uniforms.get('uAlphaMul') ?? null, layer.fade);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instances);
        drawCalls++;
        drawn += instances;
      }
    }

    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);

    let resident = 0;
    for (const t of this.tiles) if (t.active) resident += t.active.payload.count;

    this.lastStats = {
      total: resident,
      sorts: this.appliedSorts,
      tiles: this.tiles.length,
      visibleTiles: this.visibleTiles,
      splats: drawn,
      drawCalls,
      gpuMemoryBytes: this.gpuBytes,
    };
  }

  dispose() {
    for (const t of this.tiles) for (const l of t.layers) this.disposeLayer(l);
    this.tiles = [];
    this.worker?.terminate();
    this.worker = null;
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.prog.program);
  }
}
