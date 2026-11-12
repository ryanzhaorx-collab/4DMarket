# 跨端兼容矩阵

目标端：**App（iOS / Android / HarmonyOS）+ 微信小程序（web-view）**。
原则：**任何一步失败都降级，绝不白屏。**

## 运行时探测（`src/engine/pc/platform.ts`）

| 能力 | 探测方式 | 不满足时 |
| --- | --- | --- |
| WebGL2 | `canvas.getContext('webgl2')` | 切静态海报 + 房型面板，提示"当前设备不支持 3D 实景" |
| 平台 | UA + `__wxjs_environment` | 决定像素比与资产档位 |
| 设备内存 | `navigator.deviceMemory` | ≤3GB → 像素比 1.5、先只加载下半部分 |
| 最大纹理 | `MAX_TEXTURE_SIZE` | 记入日志，供后端下发不同资产 |

## 各端策略

| 端 | 渲染 | 像素比上限 | 资产 | 备注 |
| --- | --- | --- | --- | --- |
| iOS Safari / WKWebView | WebGL2 | 2.0 | SOG 6.9MB | 内存吃紧，避免多实例 |
| Android Chrome / WebView | WebGL2 | 2.0（低端 1.5） | SOG 6.9MB | 碎片化大，按 `deviceMemory` 降档 |
| HarmonyOS ArkWeb | WebGL2 | 1.75 | SOG 6.9MB | 内核是 Chromium，按 Android 处理 |
| 微信小程序 | web-view 内 WebGL2 | 1.75 | SOG 6.9MB | 需 `web-view` 域名白名单；不支持则走海报 |
| 桌面预览 | WebGL2 | 2.0 | SOG 6.9MB | 开发用 |

## 分级加载（手机上"点开就能看"的关键）

1. 先加载 `split-lower.sog`（3.8MB）→ 撤遮罩，远景可看
2. 后台并行加载 `split-mid.sog`（0.8MB）+ `split-upper.sog`（2.3MB）
3. 全部就绪后提示"已全部就绪"

弱网兜底：首块 10s 未就绪 → 走静态海报，不阻塞用户。

## 已知限制

- **resolve 入场**目前是近似（整体缩放 + 镜头推进），真·逐点刷成实体需要给 gsplat 材质打 shader patch，排期在 P5b。
- 小程序 `web-view` 里 **canvas 触摸事件**需用 `bindtouchstart` 转发，已在 `platforms/weapp` 外壳里预留。
