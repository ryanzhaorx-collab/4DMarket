# App 壳（iOS / Android）

引擎是标准 WebGL2 应用，App 端用 **Capacitor** 把 `dist/` 装进原生 WebView 即可，无需把渲染逻辑翻成原生代码。

## 一次性初始化

```bash
cd 四维空间App
npm i -D @capacitor/cli @capacitor/core @capacitor/ios @capacitor/android
npx cap add ios
npx cap add android
```

## 每次发版

```bash
npm run build           # 产出 dist/
npx cap sync            # 同步到 ios/ 与 android/
npx cap open ios        # Xcode：签名后真机运行
npx cap open android    # Android Studio：构建 APK / AAB
```

## 关键原生配置（不要漏）

### iOS（`ios/App/App/Info.plist`）

```xml
<key>UIStatusBarStyle</key><string>UIStatusBarStyleLightContent</string>
<key>UIViewControllerBasedStatusBarAppearance</key><false/>
<key>UIRequiresFullScreen</key><true/>
<!-- 允许内联媒体播放、禁用回弹 -->
<key>UIScrollView bounce</key><false/>
```

WKWebView 从 iOS 15 起默认支持 WebGL2，无需额外开关。

### Android（`android/app/src/main/AndroidManifest.xml`）

```xml
<application android:hardwareAccelerated="true" android:largeHeap="true">
  <meta-data android:name="android.webkit.WebView.EnableSafeBrowsing" android:value="false" />
</application>
```

`android/app/src/main/java/.../MainActivity.java` 里建议开启：

```java
WebView.setWebContentsDebuggingEnabled(false); // 生产关闭
// 关键：禁用 WebView 的渲染降级，避免部分机型回退到软件渲染
webView.getSettings().setRenderPriority(WebSettings.RenderPriority.HIGH);
```

另外建议在 `capacitor.config.ts` 中保持 `android.allowMixedContent = false`，全部资源走 https 或本地 `capacitor://`。

## 性能与稳定性清单

| 项 | 建议 |
| --- | --- |
| WebView 版本 | Android ≥ 9（Chromium 66+ 才有稳定 WebGL2）；低版本直接走降级海报 |
| 首屏 | `dist/` 内置 + `assets/yuehua/manifest.json` 预加载，1.5s 内出首帧 |
| 内存 | 单场景 splat 控制在 30 万点以内（约 16MB 显存），倾斜摄影瓦片 LRU 上限 220MB |
| 后台切换 | `visibilitychange` 已暂停渲染循环，回到前台自动恢复并重建排序 |
| 上下文丢失 | 监听 `webglcontextlost`，恢复后自动重建纹理（`SplatRenderer.rebuildGPU`） |
| 降级 | 无 WebGL2 / 显存不足时显示静态海报 + 房型浮层，交易链路不受影响 |
