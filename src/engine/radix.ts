/**
 * 3DGS 深度排序：把视空间深度量化到 16bit，用两趟 8bit 计数排序（LSD radix）。
 * 复杂度 O(n)，200k 个 splat 单线程约 3~5ms，远快于 Array.sort。
 * 该模块同时被主线程（降级路径）和 sort.worker 引用。
 */
export class DepthSorter {
  private keys: Uint16Array = new Uint16Array(0);
  private idx: Uint32Array = new Uint32Array(0);
  private idxTmp: Uint32Array = new Uint32Array(0);
  private counts = new Uint32Array(256);
  private capacity = 0;

  private ensure(n: number) {
    if (n <= this.capacity) return;
    this.capacity = Math.max(n, Math.ceil(this.capacity * 1.5), 1024);
    this.keys = new Uint16Array(this.capacity);
    this.idx = new Uint32Array(this.capacity);
    this.idxTmp = new Uint32Array(this.capacity);
  }

  /**
   * @param pos 交错 [x,y,z,...]（与 splat 索引一一对应）
   * @param count splat 数量
   * @param fwd 相机前向单位向量
   * @param cam 相机位置
   * @param near 最近深度（用于量化范围）
   * @param far 最远深度
   * @returns 由远及近的索引数组（内部复用，调用方需立即消费或拷贝）
   */
  sort(
    pos: Float32Array,
    count: number,
    cam: [number, number, number],
    fwd: [number, number, number],
    near: number,
    far: number,
  ): Uint32Array {
    this.ensure(count);
    const keys = this.keys;
    const idx = this.idx;
    const cx = cam[0], cy = cam[1], cz = cam[2];
    const fx = fwd[0], fy = fwd[1], fz = fwd[2];
    const range = Math.max(far - near, 1e-3);
    const inv = 65535 / range;

    for (let i = 0; i < count; i++) {
      const d = (pos[i * 3] - cx) * fx + (pos[i * 3 + 1] - cy) * fy + (pos[i * 3 + 2] - cz) * fz;
      let q = (d - near) * inv;
      q = q < 0 ? 0 : q > 65535 ? 65535 : q;
      // 反转：key 升序 => 由远及近
      keys[i] = 65535 - q;
      idx[i] = i;
    }

    this.pass(keys, idx, this.idxTmp, count, 0);
    this.pass(keys, this.idxTmp, idx, count, 8);
    return idx.subarray(0, count);
  }

  /** 稳定计数排序：keys 永远按 splat 原始索引取值 */
  private pass(
    keys: Uint16Array,
    idxIn: Uint32Array,
    idxOut: Uint32Array,
    n: number,
    shift: number,
  ) {
    const counts = this.counts;
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[(keys[idxIn[i]] >> shift) & 255]++;
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      const c = counts[i];
      counts[i] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const src = idxIn[i];
      idxOut[counts[(keys[src] >> shift) & 255]++] = src;
    }
  }
}
