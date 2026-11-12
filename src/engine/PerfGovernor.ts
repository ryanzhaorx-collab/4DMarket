/** 自适应画质：以帧时间为唯一依据，分档调整渲染分辨率、splat 预算、倾斜摄影误差阈值。 */

export interface QualityTier {
  name: string;
  renderScale: number;
  splatBudget: number;
  maxSSE: number;
  sortsPerFrame: number;
}

export const TIERS: QualityTier[] = [
  { name: 'Ultra', renderScale: 1.0, splatBudget: 420_000, maxSSE: 14, sortsPerFrame: 3 },
  { name: 'High', renderScale: 0.95, splatBudget: 300_000, maxSSE: 18, sortsPerFrame: 3 },
  { name: 'Medium', renderScale: 0.82, splatBudget: 200_000, maxSSE: 24, sortsPerFrame: 2 },
  { name: 'Low', renderScale: 0.68, splatBudget: 120_000, maxSSE: 34, sortsPerFrame: 2 },
  { name: 'Saver', renderScale: 0.55, splatBudget: 70_000, maxSSE: 48, sortsPerFrame: 1 },
];

export class PerfGovernor {
  tier: QualityTier;
  private index: number;
  private emaMs = 16.7;
  private frames = 0;
  private goodFrames = 0;
  private cooldown = 0;
  private frozen = false;
  onChange: ((tier: QualityTier) => void) | null = null;

  constructor(mobileHint: boolean, memoryGB: number) {
    const start = mobileHint ? 2 : memoryGB < 4 ? 2 : 1;
    this.index = Math.min(start, TIERS.length - 1);
    this.tier = TIERS[this.index];
    if (memoryGB > 0 && memoryGB < 2.5) this.forceSet(4);
  }

  get renderScale() {
    return this.tier.renderScale;
  }

  get splatBudget() {
    return this.tier.splatBudget;
  }

  get maxSSE() {
    return this.tier.maxSSE;
  }

  get sortsPerFrame() {
    return this.tier.sortsPerFrame;
  }

  /** 严重掉帧时（例如首帧编译着色器）暂停自动降级，避免启动即降到底 */
  freezeFor(ms: number) {
    this.cooldown = Math.max(this.cooldown, ms);
  }

  sample(dtMs: number) {
    if (dtMs <= 0) return;
    // 跳帧（切后台回来）不计入
    if (dtMs > 120) return;
    this.emaMs = this.emaMs * 0.92 + dtMs * 0.08;
    this.frames++;
    if (this.cooldown > 0) {
      this.cooldown -= dtMs;
      return;
    }
    if (this.frames < 20) return;

    if (this.emaMs > 26 && this.index < TIERS.length - 1) {
      this.forceSet(this.index + 1);
      this.cooldown = 1400;
      this.goodFrames = 0;
      return;
    }
    if (this.emaMs < 13.5) {
      this.goodFrames++;
      if (this.goodFrames > 240 && this.index > 0) {
        this.forceSet(this.index - 1);
        this.cooldown = 2600;
        this.goodFrames = 0;
      }
    } else {
      this.goodFrames = 0;
    }
  }

  forceSet(index: number) {
    this.index = Math.max(0, Math.min(TIERS.length - 1, index));
    this.tier = TIERS[this.index];
    this.onChange?.(this.tier);
  }

  get frameMs() {
    return this.emaMs;
  }

  freeze(v: boolean) {
    this.frozen = v;
  }

  get isFrozen() {
    return this.frozen;
  }
}
