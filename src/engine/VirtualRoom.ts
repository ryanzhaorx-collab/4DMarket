import { OrbitCamera } from './Camera';
import { createProgram, type ProgramInfo } from './glutil';
import { mat4, mat4Multiply, type Mat4 } from './math';
import { TILE_FS, TILE_VS } from './shaders';

type RGB = [number, number, number];

/** 极简盒状网格构建器：所有家具都是盒子 */
export class MeshBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  box(
    min: [number, number, number],
    max: [number, number, number],
    color: RGB,
    alpha = 1,
  ) {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const faces: { n: RGB; q: [number, number, number][] }[] = [
      { n: [0, 0, 1], q: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
      { n: [0, 0, -1], q: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]] },
      { n: [1, 0, 0], q: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]] },
      { n: [-1, 0, 0], q: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
      { n: [0, 1, 0], q: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]] },
      { n: [0, -1, 0], q: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
    ];
    for (const f of faces) {
      const base = this.pos.length / 3;
      for (const p of f.q) {
        this.pos.push(p[0], p[1], p[2]);
        this.nrm.push(f.n[0], f.n[1], f.n[2]);
        this.col.push(color[0], color[1], color[2], Math.round(alpha * 255));
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
}

export const ROOM_COLORS = {
  floor: [26, 24, 21] as RGB,
  slab: [16, 15, 14] as RGB,
  wall: [58, 56, 52] as RGB,
  trim: [214, 178, 106] as RGB,
  glass: [150, 186, 204] as RGB,
  wood: [82, 62, 44] as RGB,
  bed: [222, 218, 210] as RGB,
  sheet: [238, 236, 230] as RGB,
  lamp: [240, 214, 150] as RGB,
  floorIn: [96, 88, 76] as RGB,
  wallIn: [138, 130, 116] as RGB,
  woodIn: [126, 96, 66] as RGB,
  leaf: [74, 102, 56] as RGB,
};

export type RoomPreset = 'podium' | 'suite';

export class VirtualRoom {
  private gl: WebGL2RenderingContext;
  private prog: ProgramInfo;
  private vao: WebGLVertexArrayObject | null = null;
  private indexCount = 0;
  private model: Mat4 = mat4();
  private alpha = 0;
  private reveal = 1;
  private readonly height: number;
  private readonly presetName: RoomPreset;

  constructor(gl: WebGL2RenderingContext, preset: RoomPreset = 'podium') {
    this.gl = gl;
    this.presetName = preset;
    this.height = preset === 'podium' ? 6.0 : 3.2;
    this.prog = createProgram(gl, TILE_VS, TILE_FS, 'room');
    const b = preset === 'podium' ? this.buildPodium() : this.buildSuite();
    this.upload(b);
  }

  private upload(b: MeshBuilder) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) return;
    gl.bindVertexArray(vao);

    const mk = (
      data: ArrayBufferView, loc: number, size: number,
      type: number, normalized = false,
    ) => {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.vertexAttribPointer(loc, size, type, normalized, 0, 0);
      gl.enableVertexAttribArray(loc);
    };

    mk(new Float32Array(b.pos), 0, 3, gl.FLOAT);
    mk(new Float32Array(b.nrm), 1, 3, gl.FLOAT);
    mk(new Uint8Array(b.col), 2, 4, gl.UNSIGNED_BYTE, true);
    mk(new Float32Array((b.pos.length / 3) * 2), 3, 2, gl.FLOAT);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(b.idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.vao = vao;
    this.indexCount = b.idx.length;
  }

  private buildPodium() {
    const b = new MeshBuilder();
    const W = 46;     // 半宽 92m —— 整层裙楼，而不是一间房
    const D = 21;     // 半深 42m
    const H = 6.0;    // 层高（两层通高的大堂）
    const T = 0.4;

    // 楼板（外挑 1m）
    b.box([-W - 1, -0.9, -D - 1], [W + 1, 0, D + 1], ROOM_COLORS.slab);
    b.box([-W, 0, -D], [W, 0.08, D], ROOM_COLORS.floor);

    // 顶部金边收口
    b.box([-W - 0.5, H - 0.24, -D - 0.5], [W + 0.5, H, -D], ROOM_COLORS.trim);
    b.box([-W - 0.5, H - 0.24, D], [W + 0.5, H, D + 0.5], ROOM_COLORS.trim);
    b.box([-W - 0.5, H - 0.24, -D], [-W, H, D], ROOM_COLORS.trim);
    b.box([W, H - 0.24, -D], [W + 0.5, H, D], ROOM_COLORS.trim);

    // 背墙 + 柱网（大堂体量）
    b.box([-W, 0, -D], [W, H, -D + T], ROOM_COLORS.wall);
    for (let i = -2; i <= 2; i++) {
      for (let j = -1; j <= 1; j++) {
        const px = i * (W / 2.6);
        const pz = j * (D / 1.6);
        b.box([px - 0.5, 0, pz - 0.5], [px + 0.5, H - 0.24, pz + 0.5], ROOM_COLORS.wall);
      }
    }

    // 三面幕墙：竖梃 + 玻璃
    const curtain = (sign: 1 | -1) => {
      const n = 14;
      for (let i = 0; i <= n; i++) {
        const t = -1 + (2 * i) / n;
        b.box([t * W - 0.12, 0.08, sign * D - 0.12], [t * W + 0.12, H - 0.24, sign * D + 0.12], ROOM_COLORS.trim);
      }
      b.box([-W, 0.08, sign * D - 0.05], [W, H - 0.24, sign * D + 0.05], ROOM_COLORS.glass, 0.13);
      b.box([-W, 0, sign * D - 0.1], [W, 0.34, sign * D + 0.1], ROOM_COLORS.trim);
    };
    curtain(1);
    curtain(-1);
    for (const sign of [1, -1]) {
      for (let i = 0; i <= 8; i++) {
        const t = -1 + (2 * i) / 8;
        b.box([sign * W - 0.12, 0.08, t * D - 0.12], [sign * W + 0.12, H - 0.24, t * D + 0.12], ROOM_COLORS.trim);
      }
      b.box([sign * W - 0.05, 0.08, -D], [sign * W + 0.05, H - 0.24, D], ROOM_COLORS.glass, 0.13);
    }

    // 前台 + 沙发组 + 装饰树
    b.box([-6, 0, -D + 6], [2, 1.15, -D + 7.6], ROOM_COLORS.wood);
    b.box([-6.2, 1.15, -D + 5.9], [2.2, 1.3, -D + 7.7], ROOM_COLORS.trim);
    for (const x of [-22, -12, 14, 24]) {
      b.box([x, 0, -6], [x + 4.4, 0.55, -2.2], ROOM_COLORS.bed);
      b.box([x, 0, -6.4], [x + 4.4, 1.1, -5.8], ROOM_COLORS.bed);
      b.box([x + 0.4, 0.55, -2.6], [x + 4.0, 0.75, -2.2], ROOM_COLORS.sheet);
    }
    for (const x of [-34, 0, 34]) {
      b.box([x - 0.35, 0, 0], [x + 0.35, 3.2, 0.7], ROOM_COLORS.wood);
      b.box([x - 2.2, 2.4, -0.9], [x + 2.2, 4.6, 0.9], ROOM_COLORS.leaf);
    }
    return b;
  }

  /** 客房：10 × 8 × 3.2m，按原型图布置（暖木地板、白床红抱枕、藤椅、落地窗海景） */
  private buildSuite() {
    const b = new MeshBuilder();
    const W = 5;
    const D = 4;
    const H = 3.2;

    // —— 地板：暖色木条 ——
    const plank = [0.62, 0.46, 0.32] as RGB;
    for (let i = 0; i < 16; i++) {
      const z0 = -D + (i * 2 * D) / 16;
      const z1 = z0 + (2 * D) / 16 - 0.03;
      const tone = i % 2 ? 1.0 : 0.9;
      b.box([-W, 0, z0], [W, 0.05, z1], [plank[0] * 255 * tone, plank[1] * 255 * tone, plank[2] * 255 * tone] as RGB);
    }
    // —— 地毯 ——
    b.box([-3.0, 0.05, -2.2], [1.6, 0.075, 1.4], [96, 86, 76]);
    b.box([-2.9, 0.075, -2.1], [1.5, 0.085, 1.3], [128, 114, 98]);

    // —— 天花 + 灯槽 ——
    b.box([-W, H - 0.16, -D], [W, H, D], [232, 226, 214]);
    b.box([-2.6, H - 0.2, -1.6], [2.6, H - 0.16, 1.2], [246, 226, 176]);

    // —— 右墙（床头背板 + 木饰面）——
    b.box([W - 0.18, 0, -D], [W, H, D], [206, 196, 182]);
    b.box([W - 0.2, 0, -2.4], [W - 0.05, 1.6, 1.2], [92, 66, 48]);
    // —— 后墙 ——
    b.box([-W, 0, D - 0.18], [W, H, D], [210, 200, 186]);

    // —— 落地窗：-Z 整面 + -X 一段（270°）——
    const mull = [42, 44, 48] as RGB;
    b.box([-W, 0, -D], [W, H, -D + 0.1], [176, 206, 228], 0.16);
    for (let i = 0; i <= 5; i++) {
      const t = -1 + (2 * i) / 5;
      b.box([t * W - 0.05, 0, -D - 0.02], [t * W + 0.05, H, -D + 0.12], mull);
    }
    b.box([-W, H - 0.16, -D - 0.02], [W, H, -D + 0.12], mull);
    b.box([-W, 0, -D - 0.02], [W, 0.12, -D + 0.12], mull);

    b.box([-W, 0, -D], [-W + 0.1, H, -0.4], [176, 206, 228], 0.16);
    for (let i = 0; i <= 3; i++) {
      const z = -D + (i * (D - 0.4)) / 3;
      b.box([-W - 0.02, 0, z - 0.05], [-W + 0.12, H, z + 0.05], mull);
    }
    // 转角柱
    b.box([-W, 0, -D], [-W + 0.16, H, -D + 0.16], [232, 226, 214]);

    // —— 海天背景（窗外）——
    b.box([-W * 5, 1.35, -D - 3.2], [W * 5, H * 3, -D - 3.0], [186, 212, 232]);
    b.box([-W * 5, -1.2, -D - 3.2], [W * 5, 1.35, -D - 3.0], [96, 132, 152]);
    b.box([-W * 5, 1.28, -D - 3.25], [W * 5, 1.42, -D - 2.95], [222, 236, 244]);
    b.box([-W * 5, -1.2, -D - 3.2], [-W - 0.2, H * 3, -D - 3.0], [150, 180, 200]);

    // —— 床（正对窗，前景主体）——
    b.box([-1.45, 0, -1.2], [1.15, 0.55, 1.15], [226, 220, 208]);      // 床体
    b.box([-1.4, 0.55, -1.15], [1.1, 0.8, 1.1], [248, 245, 238]);      // 被面
    b.box([-1.6, 0, 0.55], [1.3, 1.4, 1.2], [92, 66, 48]);             // 床头板
    for (const x of [-1.15, -0.55, 0.05, 0.65]) {
      b.box([x - 0.26, 0.8, 0.62], [x + 0.26, 1.1, 1.12], [252, 250, 245]);  // 枕头
    }
    b.box([-0.55, 0.8, 0.35], [0.25, 1.04, 0.72], [170, 46, 40]);      // 红抱枕
    b.box([-1.35, 0.5, -1.1], [0.6, 0.82, 0.0], [252, 249, 243]);      // 被角

    // —— 床头柜 + 台灯 ——
    b.box([-3.05, 0, 0.5], [-1.75, 0.55, 1.25], [92, 66, 48]);
    b.box([-2.75, 0.55, 0.7], [-2.15, 0.72, 1.0], [240, 214, 150]);
    b.box([-2.5, 0.72, 0.78], [-2.4, 1.15, 0.92], [120, 96, 70]);

    // —— 藤椅 + 边几（窗前）——
    b.box([-4.4, 0, -3.2], [-3.0, 0.42, -1.9], [206, 190, 160]);
    b.box([-4.45, 0.42, -3.25], [-3.9, 0.95, -1.85], [212, 196, 166]);
    b.box([-3.0, 0.35, -2.8], [-2.4, 0.42, -2.2], [236, 232, 222]);
    b.box([-2.7, 0, -2.75], [-2.65, 0.35, -2.25], [120, 96, 70]);
    b.box([-4.0, 0.42, -2.9], [-3.1, 0.62, -2.2], [206, 150, 70]);   // 芥黄搭毯

    // —— 落地灯 ——
    b.box([-4.6, 0, -0.6], [-4.5, 1.5, -0.5], [120, 96, 70]);
    b.box([-4.85, 1.5, -0.85], [-4.25, 1.95, -0.25], [244, 226, 178]);

    // —— 电视（左墙）——
    b.box([-W + 0.05, 1.0, -1.4], [-W + 0.18, 1.95, 1.2], [26, 28, 32]);
    b.box([-W + 0.18, 1.02, -1.36], [-W + 0.2, 1.93, 1.16], [58, 66, 76]);

    // —— 窗帘（两侧）——
    for (const x of [-W + 0.35, W - 0.35]) {
      b.box([x - 0.18, 0, -D + 0.15], [x + 0.18, H - 0.2, -D + 0.7], [214, 198, 168]);
    }
    b.box([-W + 0.2, H - 0.36, -D + 0.1], [W - 0.2, H - 0.26, -D + 0.3], [120, 96, 70]);

    // —— 行李架 / 绿植 ——
    b.box([-2.2, 0, 2.2], [0.4, 0.4, 2.9], [92, 66, 48]);
    b.box([2.6, 0, 1.6], [3.4, 0.5, 2.4], [74, 102, 56]);
    b.box([2.85, 0.5, 1.85], [3.15, 1.3, 2.15], [64, 92, 50]);

    return b;
  }

  /** 世界位姿：position + 绕 Y 朝向 + 缩放 */
  setPose(x: number, y: number, z: number, yaw: number, scale: number, alpha: number, reveal = 1) {
    this.reveal = reveal;
    const m = mat4();
    const c = Math.cos(yaw) * scale;
    const s = Math.sin(yaw) * scale;
    m[0] = c;
    m[2] = -s;
    m[5] = scale;
    m[8] = s;
    m[10] = c;
    m[12] = x;
    m[13] = y;
    m[14] = z;
    this.model = m;
    this.alpha = alpha;
  }

  get visible() {
    return this.alpha > 0.002;
  }

  render(cam: OrbitCamera) {
    if (!this.visible || !this.vao) return;
    const gl = this.gl;
    const p = this.prog;
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.uniforms.get('uViewProj') ?? null, false, cam.viewProj);
    gl.uniformMatrix4fv(p.uniforms.get('uModel') ?? null, false, this.model);
    gl.uniform3f(p.uniforms.get('uLightDir') ?? null, -0.42, 0.82, 0.38);
    gl.uniform3f(p.uniforms.get('uFogColor') ?? null, 0.84, 0.86, 0.87);
    gl.uniform1f(p.uniforms.get('uFogNear') ?? null, 100000);
    gl.uniform1f(p.uniforms.get('uFogFar') ?? null, 200000);
    gl.uniform1i(p.uniforms.get('uTex') ?? null, 0);
    gl.uniform1f(p.uniforms.get('uUseTex') ?? null, 0);
    gl.uniform3f(p.uniforms.get('uBaseColor') ?? null, 1, 1, 1);
    gl.uniform1f(p.uniforms.get('uAlphaMul') ?? null, this.alpha);
    gl.uniform1f(p.uniforms.get('uReveal') ?? null, this.reveal);
    gl.uniform1f(p.uniforms.get('uRevealH') ?? null, this.height);
    gl.uniform1f(p.uniforms.get('uAmbient') ?? null, this.presetName === 'suite' ? 0.62 : 0.58);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }

  dispose() {
    const gl = this.gl;
    if (this.vao) gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.prog.program);
  }
}

// 避免未使用告警
void mat4Multiply;
