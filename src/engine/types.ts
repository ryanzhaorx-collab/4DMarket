/** 引擎内部共享类型（主线程 / Worker）。 */

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** 模型级变换：用于两个不同来源模型的快速对齐（调试用） */
export interface LayerTransform {
  translate?: [number, number, number];
  /** 角度制，绕世界 X 轴 */
  rotateX?: number;
  /** 角度制，绕世界 Y 轴 */
  rotateY?: number;
  /** 角度制，绕世界 Z 轴 */
  rotateZ?: number;
  scale?: number;
}

/** 解析后的一块 splat 数据（结构化数组，可直接上传 GPU） */
export interface SplatPayload {
  min: [number, number, number];
  max: [number, number, number];
  count: number;
  /** xyz 交错 */
  pos: Float32Array;
  /** xyz 交错，单位：米（线性尺度） */
  scale: Float32Array;
  /** xyzw 交错，单位四元数 */
  rot: Float32Array;
  /** rgb 交错，0-255 */
  color: Uint8Array;
  /** 0-1 */
  alpha: Float32Array;
}

export interface SplatParseOptions {
  /** PLY 四元数分量顺序；默认 auto（按 |w| 分布自动判定） */
  rotOrder?: 'wxyz' | 'xyzw' | 'auto';
}

export type SplatWorkerRequest =
  | { type: 'parse'; url: string; id: number; noSplit?: boolean; rotOrder?: SplatParseOptions['rotOrder'] }
  | { type: 'parse-buffer'; buffer: ArrayBuffer; format: 'ply' | 'splat'; id: number; noSplit?: boolean; rotOrder?: SplatParseOptions['rotOrder'] };

export type SplatWorkerResponse =
  | { type: 'progress'; id: number; loaded: number; total: number }
  | { type: 'tiles'; id: number; tiles: SplatPayload[]; ms: number }
  | { type: 'error'; id: number; message: string };

export interface SortRequest {
  type: 'sort';
  tileId: number;
  cam: [number, number, number];
  fwd: [number, number, number];
  near: number;
  far: number;
  seq: number;
}

export interface SortRegister {
  type: 'register';
  tileId: number;
  pos: Float32Array;
  count: number;
}

export interface SortResult {
  type: 'sorted';
  tileId: number;
  seq: number;
  indices: Uint32Array;
}

export interface SplatManifestTile {
  url: string;
  min: [number, number, number];
  max: [number, number, number];
  /** 0 = 代理（粗），1 = 精细；同一空间位置的不同 LOD 用同一 key 关联 */
  lod: number;
  key?: string;
  vertexCount?: number;
  bytes?: number;
}

export interface SceneManifest {
  version: number;
  scene: {
    id: string;
    name: string;
    subtitle: string;
    location: string;
    anchor: { label: string; detail: string };
    tags: string[];
  };
  camera: {
    target: [number, number, number];
    distance: number;
    yaw: number;
    pitch: number;
    fov: number;
    introFrom: { distance: number; pitch: number; yawOffset: number };
  };
  splat: {
    /** 分块 + 多级 LOD 清单（推荐） */
    tiles: SplatManifestTile[];
    /** 也可以直接给单文件资产（.ply/.splat），引擎会按空间自动切块 */
    source?: string;
    /** 点云整体对齐变换（常用于 PLY 单位/姿态与倾斜摄影不一致时） */
    transform?: LayerTransform;
    /** PLY 四元数顺序，默认 auto */
    rotOrder?: 'wxyz' | 'xyzw' | 'auto';
  };
  tileset?: string;
  /** 3D Tiles 整体对齐变换（叠加在 tileset 根节点 transform 之上） */
  tilesetTransform?: LayerTransform;
  hotspots: { id: string; label: string; position: [number, number, number]; kind?: string }[];
}

export interface PerfStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  splats: number;
  sse: number;
  renderScale: number;
  budget: number;
  /** 常驻点数 */
  total: number;
  gpuMemoryMB: number;
  quality: string;
}
