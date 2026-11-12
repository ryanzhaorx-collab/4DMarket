/// <reference lib="webworker" />
import { DepthSorter } from '../radix';
import type { SortRegister, SortRequest, SortResult } from '../types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const sorter = new DepthSorter();
const tiles = new Map<number, { pos: Float32Array; count: number }>();

ctx.onmessage = (ev: MessageEvent<SortRegister | SortRequest>) => {
  const m = ev.data;
  if (m.type === 'register') {
    tiles.set(m.tileId, { pos: m.pos, count: m.count });
    return;
  }
  if (m.type === 'sort') {
    const t = tiles.get(m.tileId);
    if (!t) return;
    try {
      const out = sorter.sort(t.pos, t.count, m.cam, m.fwd, m.near, m.far);
      const copy = out.slice();
      const res: SortResult = { type: 'sorted', tileId: m.tileId, seq: m.seq, indices: copy };
      ctx.postMessage(res, [copy.buffer]);
    } catch (err) {
      // 排序失败不应导致整帧崩掉，回报空结果由主线程降级为原始顺序
      ctx.postMessage({ type: 'sorted', tileId: m.tileId, seq: m.seq, indices: new Uint32Array(0) });
      console.warn('[sort] failed', err);
    }
  }
};
