import { detectFormat, parsePly, parseSplat, splitIntoTiles } from './splatFormat';
import type { SplatPayload, SplatWorkerRequest, SplatWorkerResponse } from './types';

interface Job {
  resolve: (tiles: SplatPayload[]) => void;
  reject: (err: Error) => void;
  onProgress?: (loaded: number, total: number) => void;
}

/**
 * 3DGS 资产加载器：
 * - 优先用 Worker 完成 fetch + 解析 + 切块，主线程零阻塞；
 * - Worker 不可用（老 WebView / CSP 限制）时自动退回主线程解析。
 */
export class SplatLoader {
  private worker: Worker | null = null;
  private jobs = new Map<number, Job>();
  private nextId = 1;

  constructor() {
    try {
      const w = new Worker(new URL('./workers/splat.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<SplatWorkerResponse>) => this.onMessage(ev.data);
      w.onerror = () => this.degrade();
      this.worker = w;
    } catch {
      this.worker = null;
    }
  }

  private degrade() {
    this.worker?.terminate();
    this.worker = null;
    for (const [, job] of this.jobs) job.reject(new Error('worker 失效，改用主线程解析'));
    this.jobs.clear();
  }

  private onMessage(msg: SplatWorkerResponse) {
    const job = this.jobs.get(msg.id);
    if (!job) return;
    if (msg.type === 'progress') {
      job.onProgress?.(msg.loaded, msg.total);
      return;
    }
    this.jobs.delete(msg.id);
    if (msg.type === 'tiles') job.resolve(msg.tiles);
    else job.reject(new Error(msg.message));
  }

  load(
    url: string,
    noSplit: boolean,
    onProgress?: (l: number, t: number) => void,
    rotOrder?: 'wxyz' | 'xyzw' | 'auto',
  ): Promise<SplatPayload[]> {
    if (this.worker) {
      const id = this.nextId++;
      const req: SplatWorkerRequest = { type: 'parse', url, id, noSplit, rotOrder };
      return new Promise<SplatPayload[]>((resolve, reject) => {
        this.jobs.set(id, { resolve, reject, onProgress });
        this.worker!.postMessage(req);
      });
    }
    return this.loadMainThread(url, noSplit, onProgress, rotOrder);
  }

  private async loadMainThread(
    url: string,
    noSplit: boolean,
    onProgress?: (l: number, t: number) => void,
    rotOrder?: 'wxyz' | 'xyzw' | 'auto',
  ): Promise<SplatPayload[]> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const total = Number(res.headers.get('content-length') ?? 0);
    const buffer = await res.arrayBuffer();
    onProgress?.(buffer.byteLength, total || buffer.byteLength);
    const format = detectFormat(url);
    const parsed = format === 'ply' ? parsePly(buffer, { rotOrder }) : parseSplat(buffer);
    return noSplit ? [parsed] : splitIntoTiles(parsed);
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.jobs.clear();
  }
}
