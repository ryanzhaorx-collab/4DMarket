/**
 * 极简 glTF 2.0 / GLB 读取器，仅覆盖倾斜摄影瓦片需要的子集：
 * 三角网格、顶点色、baseColorTexture、节点变换。
 * 不依赖 three.js，避免移动端包体与解析开销。
 */

export interface GLTFPrimitive {
  position: Float32Array;
  normal: Float32Array | null;
  uv: Float32Array | null;
  color: Uint8Array | null;
  index: Uint32Array;
  baseColor: [number, number, number, number];
  texture: ImageBitmap | null;
}

export interface GLTFContent {
  primitives: GLTFPrimitive[];
  /** 该 content 的包围球（局部坐标） */
  center: [number, number, number];
  radius: number;
  bytes: number;
}

const COMPONENT: Record<number, { ctor: 'Int8Array' | 'Uint8Array' | 'Int16Array' | 'Uint16Array' | 'Uint32Array' | 'Float32Array'; size: number }> = {
  5120: { ctor: 'Int8Array', size: 1 },
  5121: { ctor: 'Uint8Array', size: 1 },
  5122: { ctor: 'Int16Array', size: 2 },
  5123: { ctor: 'Uint16Array', size: 2 },
  5125: { ctor: 'Uint32Array', size: 4 },
  5126: { ctor: 'Float32Array', size: 4 },
};

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

interface AccessorView {
  data: ArrayBufferView;
  count: number;
  components: number;
  componentType: number;
  normalized: boolean;
  stride: number;
}

function accessorView(json: any, buffers: ArrayBuffer[], index: number): AccessorView {
  const acc = json.accessors[index];
  const bv = json.bufferViews[acc.bufferView];
  const comp = COMPONENT[acc.componentType];
  if (!comp) throw new Error(`不支持的 componentType ${acc.componentType}`);
  const components = COMPONENTS[acc.type];
  const buffer = buffers[bv.buffer];
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = bv.byteStride ?? comp.size * components;
  const Ctor = (globalThis as any)[comp.ctor] as any;
  // 交错数据：逐顶点拷贝到紧凑数组
  if (stride !== comp.size * components) {
    const out = new Ctor(acc.count * components);
    for (let i = 0; i < acc.count; i++) {
      const src = new Ctor(buffer, base + i * stride, components);
      out.set(src, i * components);
    }
    return { data: out, count: acc.count, components, componentType: acc.componentType, normalized: !!acc.normalized, stride };
  }
  const data = new Ctor(buffer, base, acc.count * components);
  return { data, count: acc.count, components, componentType: acc.componentType, normalized: !!acc.normalized, stride };
}

function toFloat(view: AccessorView, comps: number): Float32Array {
  const n = view.count * comps;
  const out = new Float32Array(n);
  const src = view.data as any;
  const scale = view.normalized ? (view.componentType === 5121 ? 1 / 255 : view.componentType === 5123 ? 1 / 65535 : view.componentType === 5120 ? 1 / 127 : view.componentType === 5122 ? 1 / 32767 : 1) : 1;
  for (let i = 0; i < n; i++) out[i] = src[i] * scale;
  return out;
}

function toColor(view: AccessorView): Uint8Array {
  const n = view.count * view.components;
  const out = new Uint8Array(view.count * 4);
  const src = view.data as any;
  const norm = view.componentType === 5126 ? 1 : view.normalized ? (view.componentType === 5121 ? 1 / 255 : view.componentType === 5123 ? 1 / 65535 : 1) : 1;
  for (let i = 0; i < view.count; i++) {
    out[i * 4] = Math.max(0, Math.min(255, Math.round(src[i * view.components] * norm * 255)));
    out[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(src[i * view.components + 1] * norm * 255)));
    out[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(src[i * view.components + 2] * norm * 255)));
    out[i * 4 + 3] = 255;
  }
  void n;
  return out;
}

function decodeDataUri(uri: string): ArrayBuffer {
  const comma = uri.indexOf(',');
  const meta = uri.slice(0, comma);
  const payload = uri.slice(comma + 1);
  if (meta.includes('base64')) {
    const bin = atob(payload);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  return new TextEncoder().encode(decodeURIComponent(payload)).buffer;
}

function parseGLB(buffer: ArrayBuffer): { json: any; bin: ArrayBuffer | null } {
  const dv = new DataView(buffer);
  const magic = dv.getUint32(0, true);
  if (magic !== 0x46546c67) throw new Error('不是合法的 GLB');
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`不支持的 GLB 版本 ${version}`);
  let offset = 12;
  let json: any = null;
  let bin: ArrayBuffer | null = null;
  while (offset < buffer.byteLength) {
    const len = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === 0x4e4f534a) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, len)));
    } else if (type === 0x004e4942) {
      bin = buffer.slice(start, start + len);
    }
    offset = start + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('GLB 缺少 JSON chunk');
  return { json, bin };
}

async function decodeImage(buffer: ArrayBuffer, mime: string): Promise<ImageBitmap | null> {
  try {
    const blob = new Blob([buffer], { type: mime || 'image/jpeg' });
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/** 解析 GLB / glTF，返回可直接上传 GPU 的图元 */
export async function loadGLTF(buffer: ArrayBuffer, baseUrl = ''): Promise<GLTFContent> {
  let json: any;
  let bin: ArrayBuffer | null = null;
  if (new DataView(buffer).getUint32(0, true) === 0x46546c67) {
    const glb = parseGLB(buffer);
    json = glb.json;
    bin = glb.bin;
  } else {
    json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer)));
  }

  const buffers: ArrayBuffer[] = [];
  for (let i = 0; i < (json.buffers?.length ?? 0); i++) {
    const b = json.buffers[i];
    if (i === 0 && bin && !b.uri) buffers.push(bin);
    else if (b.uri?.startsWith('data:')) buffers.push(decodeDataUri(b.uri));
    else if (b.uri) {
      const res = await fetch(new URL(b.uri, baseUrl || location.href).href);
      buffers.push(await res.arrayBuffer());
    } else buffers.push(new ArrayBuffer(0));
  }

  // 图片（baseColorTexture）
  const images: (ImageBitmap | null)[] = [];
  for (let i = 0; i < (json.images?.length ?? 0); i++) {
    const img = json.images[i];
    try {
      if (img.bufferView !== undefined) {
        const bv = json.bufferViews[img.bufferView];
        const buf = buffers[bv.buffer].slice(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
        images.push(await decodeImage(buf, img.mimeType));
      } else if (img.uri) {
        const res = await fetch(new URL(img.uri, baseUrl || location.href).href);
        images.push(await decodeImage(await res.arrayBuffer(), img.mimeType ?? 'image/jpeg'));
      } else images.push(null);
    } catch {
      images.push(null);
    }
  }

  const texForMaterial = (matIndex: number | undefined): ImageBitmap | null => {
    if (matIndex === undefined) return null;
    const mat = json.materials?.[matIndex];
    const texIndex = mat?.pbrMetallicRoughness?.baseColorTexture?.index;
    if (texIndex === undefined) return null;
    const imgIndex = json.textures?.[texIndex]?.source;
    if (imgIndex === undefined) return null;
    return images[imgIndex] ?? null;
  };

  const primitives: GLTFPrimitive[] = [];
  let bytes = 0;
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const attrs = prim.attributes ?? {};
      if (attrs.POSITION === undefined) continue;
      const posView = accessorView(json, buffers, attrs.POSITION);
      const position = toFloat(posView, 3);
      const normal = attrs.NORMAL !== undefined ? toFloat(accessorView(json, buffers, attrs.NORMAL), 3) : null;
      const uv = attrs.TEXCOORD_0 !== undefined ? toFloat(accessorView(json, buffers, attrs.TEXCOORD_0), 2) : null;
      const color = attrs.COLOR_0 !== undefined ? toColor(accessorView(json, buffers, attrs.COLOR_0)) : null;

      let index: Uint32Array;
      if (prim.indices !== undefined) {
        const iv = accessorView(json, buffers, prim.indices);
        index = iv.data instanceof Uint32Array ? iv.data : new Uint32Array(iv.data as any);
      } else {
        index = new Uint32Array(position.length / 3);
        for (let i = 0; i < index.length; i++) index[i] = i;
      }

      const mat = json.materials?.[prim.material];
      const bcf = mat?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
      primitives.push({
        position,
        normal,
        uv,
        color,
        index,
        baseColor: [bcf[0], bcf[1], bcf[2], bcf[3] ?? 1],
        texture: texForMaterial(prim.material),
      });
      bytes += position.byteLength + index.byteLength + (normal?.byteLength ?? 0) + (color?.byteLength ?? 0) + (uv?.byteLength ?? 0);
    }
  }

  // 包围球
  let cx = 0, cy = 0, cz = 0, n = 0;
  for (const p of primitives) {
    for (let i = 0; i < p.position.length; i += 3) { cx += p.position[i]; cy += p.position[i + 1]; cz += p.position[i + 2]; n++; }
  }
  if (n) { cx /= n; cy /= n; cz /= n; }
  let r = 0;
  for (const p of primitives) {
    for (let i = 0; i < p.position.length; i += 3) {
      const d = Math.hypot(p.position[i] - cx, p.position[i + 1] - cy, p.position[i + 2] - cz);
      if (d > r) r = d;
    }
  }
  return { primitives, center: [cx, cy, cz], radius: r || 1, bytes };
}
