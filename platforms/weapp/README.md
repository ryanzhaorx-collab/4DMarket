# 微信小程序壳（web-view）

小程序端不重新实现渲染内核，而是用 `<web-view>` 承载同一份 H5 引擎产物——这样 3DGS / 倾斜摄影的着色器、排序、LOD 逻辑只有一套，App 与小程序表现一致。

## 为什么必须用 web-view

- 小程序 `<canvas type="webgl">` 只暴露 WebGL 1.0 与有限扩展，**拿不到 GLSL ES 3.00、浮点纹理与整数纹理**，而 3DGS 渲染强依赖这三项（协方差投影需要 RGBA32F，排序索引需要 R32UI）。
- 小程序渲染层不允许自定义 WebGL 上下文创建与上下文丢失恢复，3DGS 这类重负载场景闪退风险不可控。
- `<web-view>` 内是完整的 WKWebView / Chromium 内核，WebGL2 能力与 App 一致，且可复用同一套降级与看门狗逻辑。

> 如果业务必须"纯原生小程序"，唯一可行路径是**云渲染**（服务端渲染 + 视频流回传），属于另一套架构，本工程未包含。

## 接入步骤

1. `npm run build`，把 `dist/` 部署到 **HTTPS** 域名（建议 CDN + gzip/br，`.splat` 文件加长缓存）。
2. 修改 `app.js` 里的 `h5Url` 指向部署地址（需以 `/` 结尾）。
3. 小程序后台 → 开发 → 开发管理 → 开发设置 → **业务域名**，添加该域名（需上传校验文件到域名根目录）。
4. 微信开发者工具导入 `platforms/weapp`，`project.config.json` 里的 `appid` 换成真实 AppID。
5. 真机预览：iOS 需在 web-view 内允许 WebGL2（默认允许）；Android 需确认 X5 内核版本（建议关闭 X5 回退，使用系统内核）。

## 联调技巧

- 开发者工具「详情 → 本地设置」勾选「不校验合法域名」，即可用 `http://<局域网IP>:5178/` 直接调试。
- H5 内通过 `window.__wxjs_environment === 'miniprogram'` 识别宿主，自动隐藏模拟状态栏（见 `src/main.ts`）。
- H5 可用 `wx.miniProgram.postMessage({ data: { type: 'share', url } })` 与小程序通信。
