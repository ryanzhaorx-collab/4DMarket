/**
 * 跨端能力探测与降级策略。
 * 目标端：iOS / Android / HarmonyOS 的 App（WebView/ArkWeb）+ 微信小程序 web-view。
 *
 * 原则：宁可降级也不能白屏——任何一步探测失败都回落到「静态海报 + 房型面板」。
 */
export type Platform = 'ios' | 'android' | 'harmony' | 'weapp' | 'desktop';
export type Tier = 'high' | 'mid' | 'low' | 'none';

export type Capability = {
  platform: Platform;
  webgl2: boolean;
  maxTexture: number;
  /** 设备内存（GB，Chrome 139+ / Android 才有） */
  memory?: number;
  /** 建议的渲染像素比上限（手机上 3x 屏按 2 倍渲染能省 55% 像素） */
  dprCap: number;
  /** 资产档位：high = 全量 SOG，low = 只加载下半部分 */
  tier: Tier;
};

export function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if ((window as unknown as { __wxjs_environment?: string }).__wxjs_environment === 'miniprogram') return 'weapp';
  if (/harmony|openharmony|arkweb/.test(ua)) return 'harmony';
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';
  return 'desktop';
}

export function probe(): Capability {
  const platform = detectPlatform();
  let webgl2 = false;
  let maxTexture = 0;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (gl) {
      webgl2 = true;
      maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    webgl2 = false;
  }

  const memory = (navigator as unknown as { deviceMemory?: number; hardwareConcurrency?: number }).deviceMemory;

  // 像素比：桌面不封顶，手机封到 2（3x 屏省 55% 像素），低端机再降到 1.5
  let dprCap = 2;
  let tier: Tier = 'high';
  if (platform === 'desktop') {
    dprCap = 2;
  } else if (platform === 'weapp' || platform === 'harmony') {
    dprCap = 1.75;
  }
  if (memory !== undefined && memory <= 3) {
    dprCap = 1.5;
    tier = 'mid';
  }
  if (!webgl2) tier = 'none';

  return { platform, webgl2, maxTexture, memory, dprCap, tier };
}

/** 按设备能力挑资产：低端只加载下半部分，先出轮廓 */
export function assetPlan(cap: Capability) {
  if (cap.tier === 'none') return null;
  return {
    progressive: true,
    first: 'split-lower.sog',
    rest: ['split-mid.sog', 'split-upper.sog'],
  };
}
