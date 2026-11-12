/// <reference lib="webworker" />
import { detectFormat, parsePly, parseSplat, splitIntoTiles } from '../splatFormat';
import type { SplatWorkerRequest, SplatWorkerResponse } from '../types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: SplatWorkerResponse, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

function collectBuffers(tiles: { pos: Float32Array; scale: Float32Array; rot: Float32Array; color: Uint8Array; alpha: Float32Array }[]) {
  const list: Transferable[] = [];
  for (const t of tiles) {
    list.push(t.pos.buffer, t.scale.buffer, t.rot.buffer, t.color.buffer, t.alpha.buffer);
  }
  return list;
}

async function fetchBuffer(url: string, id: number): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  if (!res.body || !total) return await res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastEmit = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const now = performance.now();
    if (now - lastEmit > 80) {
      lastEmit = now;
      post({ type: 'progress', id, loaded, total });
    }
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out.buffer;
}

ctx.onmessage = async (ev: MessageEvent<SplatWorkerRequest>) => {
  const req = ev.data;
  try {
    const t0 = performance.now();
    let buffer: ArrayBuffer;
    let format: 'ply' | 'splat';
    if (req.type === 'parse') {
      buffer = await fetchBuffer(req.url, req.id);
      format = detectFormat(req.url);
    } else {
      buffer = req.buffer;
      format = req.format;
    }
    const parsed = format === 'ply' ? parsePly(buffer, { rotOrder: req.rotOrder }) : parseSplat(buffer);
    const tiles = req.noSplit ? [parsed] : splitIntoTiles(parsed);
    post(
      { type: 'tiles', id: req.id, tiles, ms: Math.round(performance.now() - t0) },
      collectBuffers(tiles),
    );
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
