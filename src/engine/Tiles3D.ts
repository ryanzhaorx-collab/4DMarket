import { OrbitCamera } from './Camera';
import { Frustum } from './Frustum';
import { loadGLTF, type GLTFContent, type GLTFPrimitive } from './gltf';
import { createProgram, type ProgramInfo } from './glutil';
import { mat4, mat4FromArray, mat4Identity, mat4Multiply, mat4TransformPoint, type Mat4, type Vec3 } from './math';
import { TILE_FS, TILE_VS } from './shaders';

/** 3D Tiles（倾斜摄影 / 白模）最小实现：tileset.json + glb / b3dm，屏幕误差驱动 LOD，GPU 预算内 LRU 淘汰。 */

interface GpuPrim {
  vao: WebGLVertexArrayObject;
  count: number;
  texture: WebGLTexture | null;
  baseColor: [number, number, number, number];
  bytes: number;
}

interface GpuContent {
  prims: GpuPrim[];
  bytes: number;
  lastUsed: number;
}

interface TileNode {
  world: Mat4;
  center: Vec3;
  radius: number;
  geometricError: number;
  refine: 'ADD' | 'REPLACE';
  uri: string | null;
  children: TileNode[];
  content: GpuContent | null;
  loading: boolean;
  failed: boolean;
  selected: boolean;
  lastSelected: number;
}

interface RawTile {
  boundingVolume?: { box?: number[]; sphere?: number[]; region?: number[] };
  geometricError?: number;
  refine?: 'ADD' | 'REPLACE';
  content?: { uri?: string; url?: string; boundingVolume?: unknown };
  children?: RawTile[];
  transform?: number[];
}

function boundingSphere(t: RawTile): { center: Vec3; radius: number } {
  const bv = t.boundingVolume;
  if (bv?.sphere) {
    return { center: [bv.sphere[0], bv.sphere[1], bv.sphere[2]], radius: bv.sphere[3] };
  }
  if (bv?.box) {
    const b = bv.box;
    const center: Vec3 = [b[0], b[1], b[2]];
    // 三个半轴向量正交，包围球半径 = sqrt(|a|²+|b|²+|c|²)（求和会严重高估，导致 LOD 永远选到父级）
    const r = Math.sqrt(
      b[3] * b[3] + b[4] * b[4] + b[5] * b[5] +
      b[6] * b[6] + b[7] * b[7] + b[8] * b[8] +
      b[9] * b[9] + b[10] * b[10] + b[11] * b[11],
    );
    return { center, radius: r };
  }
  return { center: [0, 0, 0], radius: 1 };
}

function parseB3dm(buffer: ArrayBuffer): { glb: ArrayBuffer; center: Vec3 } {
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'b3dm' && magic !== 'i3dm') throw new Error(`不支持的瓦片格式 ${magic}`);
  const headerLen = magic === 'b3dm' ? 28 : 32;
  const ftJson = dv.getUint32(12, true);
  const ftBin = dv.getUint32(16, true);
  const btJson = dv.getUint32(20, true);
  const btBin = dv.getUint32(24, true);
  const ftStart = headerLen;
  let center: Vec3 = [0, 0, 0];
  try {
    const txt = new TextDecoder().decode(new Uint8Array(buffer, ftStart, ftJson)).replace(/\0+$/, '').trim();
    if (txt) {
      const ft = JSON.parse(txt);
      if (Array.isArray(ft.RTC_CENTER) && ft.RTC_CENTER.length === 3) center = [ft.RTC_CENTER[0], ft.RTC_CENTER[1], ft.RTC_CENTER[2]];
    }
  } catch {
    /* 要素表损坏时忽略 RTC */
  }
  const glbStart = ftStart + ftJson + ftBin + btJson + btBin;
  return { glb: buffer.slice(glbStart), center };
}

export interface TilesStats {
  selected: number;
  loaded: number;
  drawCalls: number;
  gpuBytes: number;
}

export class Tiles3D {
  private gl: WebGL2RenderingContext;
  private prog: ProgramInfo;
  private root: TileNode | null = null;
  private frustum = new Frustum();
  private base = '';
  private whiteTex: WebGLTexture;
  private budgetBytes = 220 * 1024 * 1024;
  private gpuBytes = 0;
  private queue: TileNode[] = [];
  private loadingCount = 0;
  private maxConcurrent = 3;
  private selected: TileNode[] = [];
  private stats: TilesStats = { selected: 0, loaded: 0, drawCalls: 0, gpuBytes: 0 };
  private unloadTimer = 0;
  private frame = 0;
  private rootTransform: Mat4 = mat4Identity(mat4());

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = createProgram(gl, TILE_VS, TILE_FS, 'tiles');
    const t = gl.createTexture();
    if (!t) throw new Error('纹理创建失败');
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.whiteTex = t;
    this.prog.uniforms.set('uTex', null);
  }

  get isLoaded() {
    return this.root !== null;
  }

  get tileStats(): TilesStats {
    return this.stats;
  }

  /** 叠加在 tileset 根节点变换之上的对齐矩阵 */
  setRootTransform(m: Mat4) {
    this.rootTransform = m;
  }

  /** 根节点包围球换算出的包围盒（世界坐标） */
  get bounds(): { min: [number, number, number]; max: [number, number, number] } | null {
    if (!this.root) return null;
    const c = this.root.center;
    const r = this.root.radius;
    return {
      min: [c[0] - r, c[1] - r, c[2] - r],
      max: [c[0] + r, c[1] + r, c[2] + r],
    };
  }

  async load(url: string, base = ''): Promise<void> {
    this.base = base || url.slice(0, url.lastIndexOf('/') + 1);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`tileset 加载失败 HTTP ${res.status}`);
    const json = await res.json();
    this.root = this.buildNode(json.root as RawTile, this.rootTransform, 'REPLACE');
  }

  private buildNode(raw: RawTile, parent: Mat4, inheritRefine: 'ADD' | 'REPLACE'): TileNode {
    const local = mat4FromArray(raw.transform);
    const world = mat4Multiply(mat4(), parent, local);
    const { center, radius } = boundingSphere(raw);
    const c = mat4TransformPoint([0, 0, 0], world, center);
    const node: TileNode = {
      world,
      center: [c[0], c[1], c[2]],
      radius: radius * this.worldScale(world),
      geometricError: raw.geometricError ?? 0,
      refine: raw.refine ?? inheritRefine,
      uri: raw.content?.uri ?? raw.content?.url ?? null,
      children: [],
      content: null,
      loading: false,
      failed: false,
      selected: false,
      lastSelected: 0,
    };
    if (node.uri) node.uri = new URL(node.uri, this.base || location.href).href;
    node.children = (raw.children ?? []).map((c2) => this.buildNode(c2, world, node.refine));
    return node;
  }

  private worldScale(m: Mat4): number {
    return Math.max(
      Math.hypot(m[0], m[1], m[2]),
      Math.hypot(m[4], m[5], m[6]),
      Math.hypot(m[8], m[9], m[10]),
    );
  }

  private visit(node: TileNode, cam: OrbitCamera, screenHeight: number, maxSSE: number): boolean {
    const d = Math.max(0, Math.hypot(
      node.center[0] - cam.eye[0], node.center[1] - cam.eye[1], node.center[2] - cam.eye[2],
    ) - node.radius);
    const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
    const sse = (node.geometricError * screenHeight) / Math.max(2 * d * tanHalf, 1e-3);
    const hasChildren = node.children.length > 0;

    if (hasChildren && sse > maxSSE) {
      let any = false;
      for (const c of node.children) {
        if (this.frustum.sphereVisible(c.center[0], c.center[1], c.center[2], c.radius)) {
          if (this.visit(c, cam, screenHeight, maxSSE)) any = true;
        }
      }
      if (!any && node.uri) {
        this.select(node);
        return true;
      }
      if (any && node.refine === 'ADD' && node.uri) this.select(node);
      return any;
    }

    if (node.uri) {
      this.select(node);
      return true;
    }
    // 纯组织节点：继续向下
    let any = false;
    for (const c of node.children) if (this.visit(c, cam, screenHeight, maxSSE)) any = true;
    return any;
  }

  private select(node: TileNode) {
    node.selected = true;
    node.lastSelected = this.frame;
    this.selected.push(node);
    if (!node.content && !node.loading && !node.failed) this.queue.push(node);
  }

  update(cam: OrbitCamera, screenHeight: number, maxSSE = 24) {
    this.frame++;
    this.selected = [];
    this.frustum.update(cam.viewProj);
    if (this.root) this.visit(this.root, cam, screenHeight, maxSSE);
    this.pump();

    // 超出预算时，按最久未使用淘汰
    if (this.gpuBytes > this.budgetBytes && this.frame - this.unloadTimer > 30) {
      this.unloadTimer = this.frame;
      const candidates = this.selected
        .filter((n) => n.content)
        .sort((a, b) => (a.content!.lastUsed ?? 0) - (b.content!.lastUsed ?? 0));
      for (const n of candidates) {
        if (this.gpuBytes <= this.budgetBytes * 0.8) break;
        this.release(n);
      }
    }
    this.stats.selected = this.selected.length;
    this.stats.loaded = this.countLoaded(this.root);
    this.stats.gpuBytes = this.gpuBytes;
  }

  private countLoaded(n: TileNode | null): number {
    if (!n) return 0;
    let c = n.content ? 1 : 0;
    for (const ch of n.children) c += this.countLoaded(ch);
    return c;
  }

  private pump() {
    while (this.loadingCount < this.maxConcurrent && this.queue.length) {
      const node = this.queue.shift()!;
      if (node.content || node.loading || node.failed) continue;
      node.loading = true;
      this.loadingCount++;
      this.loadNode(node)
        .catch((err) => {
          node.failed = true;
          console.warn('[tiles] 内容加载失败', node.uri, err);
        })
        .finally(() => {
          node.loading = false;
          this.loadingCount--;
        });
    }
  }

  private async loadNode(node: TileNode) {
    if (!node.uri) return;
    const res = await fetch(node.uri);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    let glbBuffer = buffer;
    let rtc: Vec3 = [0, 0, 0];
    if (/\.b3dm(\?|$)|\.i3dm(\?|$)/i.test(node.uri)) {
      const parsed = parseB3dm(buffer);
      glbBuffer = parsed.glb;
      rtc = parsed.center;
    }
    const gltf: GLTFContent = await loadGLTF(glbBuffer, node.uri);
    const content = this.upload(gltf);
    if (rtc[0] || rtc[1] || rtc[2]) {
      // RTC_CENTER 是相对于包围体中心的偏移，直接加进节点世界矩阵
      node.world[12] += rtc[0];
      node.world[13] += rtc[1];
      node.world[14] += rtc[2];
    }
    node.content = content;
  }

  private upload(gltf: GLTFContent): GpuContent {
    const prims: GpuPrim[] = [];
    for (const p of gltf.primitives) prims.push(this.uploadPrim(p));
    const bytes = gltf.bytes;
    this.gpuBytes += bytes;
    return { prims, bytes, lastUsed: this.frame };
  }

  private uploadPrim(p: GLTFPrimitive): GpuPrim {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('VAO 创建失败');
    gl.bindVertexArray(vao);

    const pos = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, p.position, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const normals = p.normal ?? new Float32Array(p.position.length);
    if (!p.normal) {
      for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1;
    }
    const nrm = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, nrm);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    const colors = p.color ?? this.whiteColors(p.position.length / 3);
    const col = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, col);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    const uvs = p.uv ?? new Float32Array((p.position.length / 3) * 2);
    const uv = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, uv);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0);

    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, p.index, gl.STATIC_DRAW);

    gl.bindVertexArray(null);

    let texture: WebGLTexture | null = null;
    if (p.texture) {
      texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // glTF 的 UV 原点在左上，与 WebGL 上传后 v=0 的行一致，故不做 flipY
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, p.texture);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    return {
      vao,
      count: p.index.length,
      texture,
      baseColor: p.baseColor,
      bytes: p.position.byteLength + p.index.byteLength,
    };
  }

  private whiteColors(n: number): Uint8Array {
    const c = new Uint8Array(n * 4);
    c.fill(230);
    return c;
  }

  private release(node: TileNode) {
    if (!node.content) return;
    const gl = this.gl;
    for (const p of node.content.prims) {
      gl.deleteVertexArray(p.vao);
      if (p.texture) gl.deleteTexture(p.texture);
    }
    this.gpuBytes -= node.content.bytes;
    node.content = null;
  }

  reset() {
    this.gpuBytes = 0;
    const walk = (n: TileNode | null) => {
      if (!n) return;
      n.content = null;
      for (const c of n.children) walk(c);
    };
    walk(this.root);
  }

  render(cam: OrbitCamera) {
    const gl = this.gl;
    const prog = this.prog;
    if (!this.root) return;
    gl.useProgram(prog.program);
    gl.uniformMatrix4fv(prog.uniforms.get('uViewProj') ?? null, false, cam.viewProj);
    gl.uniform3f(prog.uniforms.get('uLightDir') ?? null, -0.42, 0.82, 0.38);
    // 雾随观察距离自适应：远看大范围地形时不能把模型糊掉
    const fogNear = Math.max(240, cam.distance * 1.8);
    gl.uniform3f(prog.uniforms.get('uFogColor') ?? null, 0.84, 0.86, 0.87);
    gl.uniform1f(prog.uniforms.get('uFogNear') ?? null, fogNear);
    gl.uniform1f(prog.uniforms.get('uFogFar') ?? null, fogNear * 3.4);
    gl.uniform1i(prog.uniforms.get('uTex') ?? null, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    let draws = 0;
    for (const node of this.selected) {
      const content = node.content;
      if (!content) continue;
      content.lastUsed = this.frame;
      for (const p of content.prims) {
        gl.uniformMatrix4fv(prog.uniforms.get('uModel') ?? null, false, node.world);
        gl.uniform1f(prog.uniforms.get('uUseTex') ?? null, p.texture ? 1 : 0);
        gl.uniform3f(prog.uniforms.get('uBaseColor') ?? null, p.baseColor[0], p.baseColor[1], p.baseColor[2]);
        gl.uniform1f(prog.uniforms.get('uReveal') ?? null, 1);
        gl.uniform1f(prog.uniforms.get('uAmbient') ?? null, 0.42);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, p.texture ?? this.whiteTex);
        gl.bindVertexArray(p.vao);
        gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_INT, 0);
        draws++;
      }
    }
    gl.bindVertexArray(null);
    gl.disable(gl.CULL_FACE);
    this.stats.drawCalls = draws;
  }

  dispose() {
    const gl = this.gl;
    const walk = (n: TileNode | null) => {
      if (!n) return;
      this.release(n);
      for (const c of n.children) walk(c);
    };
    walk(this.root);
    gl.deleteTexture(this.whiteTex);
    gl.deleteProgram(this.prog.program);
  }
}
