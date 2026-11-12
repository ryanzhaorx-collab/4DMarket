import type { CapacitorConfig } from '@capacitor/cli';

/**
 * App 壳（iOS / Android）配置。
 * 用法：
 *   npm i -D @capacitor/cli @capacitor/core @capacitor/ios @capacitor/android
 *   npx cap add ios && npx cap add android
 *   npm run build && npx cap sync && npx cap open ios
 */
const config: CapacitorConfig = {
  appId: 'com.yunsheng.fourspace',
  appName: '四维空间',
  webDir: 'dist',
  // 全部资源随包内置，离线也能加载；真实项目可将 assets/yuehua 改到 CDN
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
    hostname: 'fourspace.local',
  },
  android: {
    allowMixedContent: false,
    captureInput: false,
    webContentsDebuggingEnabled: false,
  },
  ios: {
    contentInset: 'never',
    allowsLinkPreview: false,
    scrollEnabled: false,
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#06080B',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#06080B',
      overlaysWebView: true,
    },
  },
};

export default config;
