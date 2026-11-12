/**
 * 极简 UI 音效：全部用 WebAudio 现场合成，不引入任何音频文件。
 * 动效的「到位感」一半靠声音——所以只在关键帧上给两个音：推近的 whoosh、到位的 latch。
 */
export class Sfx {
  enabled = true;
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;

  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** 抽屉卡到位：低频短促的“哒” */
  latch() {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(340, t);
    osc.frequency.exponentialRampToValueAtTime(88, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.1, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.17);
  }

  /** 穿越峰值：短促气流感（<100ms） */
  surge(vol = 0.6) {
    const ctx = this.ensure();
    if (!ctx || !this.noise) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1600, t);
    bp.frequency.exponentialRampToValueAtTime(5200, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol * 0.14, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    src.connect(bp); bp.connect(g); g.connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.1);
  }

  /** 海鸥单声 */
  gull(vol = 0.3) {
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const [dt, f0, f1] of [[0, 1500, 900], [0.16, 1350, 820]] as const) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f0, t + dt);
      osc.frequency.exponentialRampToValueAtTime(f1, t + dt + 0.14);
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.exponentialRampToValueAtTime(vol * 0.09, t + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.16);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t + dt);
      osc.stop(t + dt + 0.18);
    }
  }

  /** 视角推进：带通噪声扫频的“呼” */
  whoosh(duration = 1.1) {
    const ctx = this.ensure();
    if (!ctx) return;
    if (!this.noise) {
      const len = Math.floor(ctx.sampleRate * 1.2);
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(260, t);
    bp.frequency.exponentialRampToValueAtTime(1500, t + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.05, t + duration * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(bp);
    bp.connect(gain);
    gain.connect(ctx.destination);
    src.start(t);
    src.stop(t + duration + 0.05);
  }
}

/** 触觉反馈：iOS Safari 不支持 vibrate，静默失败即可 */
export function haptic(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* 忽略 */
  }
}
