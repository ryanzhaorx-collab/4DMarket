# 四维空间 · 代码规范

> 这份文档是**唯一事实来源**。人写代码、AI 写代码，都必须遵守。
> 改动规范本身需要 PR + 至少 1 人 review，不许「先按我的习惯来」。

---

## 0. 一条总原则

**能跑、能降级、能看懂。** 这个项目跑在手机 WebView 里，用户的设备比我们的想象力差得多：
任何新功能都必须回答三个问题——「低端机怎么办」「断网怎么办」「不支持 WebGL 怎么办」。
没有答案，就不算写完。

---

## 1. 项目结构

```
四维空间App/
├─ src/
│  ├─ main.ts              入口：URL 参数、启动流程、页面流转
│  ├─ app.css              全部样式（无 CSS-in-JS、无预处理器）
│  ├─ engine/              3D 引擎层（自研 WebGL2）
│  │  ├─ Engine.ts         生命周期、渲染循环、动效编排
│  │  ├─ SplatRenderer.ts  3DGS 渲染
│  │  ├─ Tiles3D.ts        3D Tiles（倾斜摄影）
│  │  ├─ Camera.ts / OrbitControls.ts / CameraTimeline.ts
│  │  ├─ shaders.ts        所有 GLSL 字符串
│  │  └─ pc/               PlayCanvas 分支（PcEngine / platform）
│  ├─ ui/                  DOM 层：音效、室内交互（room.ts）
│  └─ pc/                  PlayCanvas 入口与启动
├─ tools/                  离线资产工具（Node 脚本）
├─ scripts/                本地服务、环境检查
├─ platforms/weapp|capacitor
├─ models/                 ← 不进仓库（.gitignore）
└─ docs/                   文档与截图
```

### 模块边界（硬规则）

| 层 | 可以 import | 禁止 import |
| --- | --- | --- |
| `ui/` | `engine/*` 的类型、`ui/*` | 其它层的实现细节 |
| `engine/` | `engine/*` | `ui/*`、`main.ts`（引擎不认识 UI） |
| `main.ts` | 任意 | 被任意模块 import（只有它 import 别人） |
| `tools/` | 无（纯 Node） | `src/` 的任何 .ts |

**为什么**：引擎要能单独抽出来给小程序/别的壳复用；UI 要能在没有 3D 的情况下跑（降级海报）。

---

## 2. TypeScript

- `strict` 全开（见 `tsconfig.json`），**不许** `// @ts-ignore`；确实要绕过写 `// @ts-expect-error 原因`。
- **禁止 `any`**。外部弱类型格式（glTF）在 `eslint.config.js` 里显式豁免，其余一律 `unknown` + 断言。
- 导出优先 `export function` / `export class`，默认导出只用于入口文件。
- 类型别名放**使用处上方**，不要建 `types.ts` 垃圾场。
- 数值单位写在变量名里：`distanceM`、`durationMs`、`delayS`。**这个项目踩过 `dt` 毫秒/秒混用的坑，动效直接失效。**

---

## 3. 3D / 引擎规则

- **单位：米。** 所有几何、相机距离、位移都用米，不写像素。
- **坐标系：数据 Z-up，渲染 Y-up。** 进入渲染前必须显式转换（PlayCanvas 里是 root 绕 X 转 -90°）。
  > 转换后「本地 +Z = 世界 +Y」，别再拿本地 Y 当高度用——这个坑我们踩过，拆分变成了横向平移。
- **资源必须配对释放**：`createTexture` ↔ `deleteTexture`、`createProgram` ↔ `deleteProgram`。
  新增 GPU 资源时，同步在 `dispose()` 里加释放，PR 里要能看到。
- **渲染循环里不许分配对象**。向量/矩阵用模块级复用（`mat4()` 缓存），否则 GC 抖动会掉帧。
- **着色器**统一写在 `shaders.ts`，命名 `XXX_VS` / `XXX_FS`；GLSL 里 `flat`、`sample` 等都是保留字，别当变量名。
- 相机状态只有五个量：`target / distance / yaw / pitch / fov`，任何镜头动效都写成 `CameraTimeline` 关键帧，**不许直接改 camera 再 rAF 插值**。

---

## 4. 性能预算（硬指标，超标就是 bug）

| 指标 | 上限 | 说明 |
| --- | --- | --- |
| 帧率 | ≥ 30 FPS（中端机）/ ≥ 50 FPS（高端机） | 低于 30 必须自动降档 |
| 主包 JS | ≤ 150KB（gzip） | PlayCanvas 走动态 import，不进主包 |
| 首屏可交互 | ≤ 3s（4G） | 先出远景，细节后台补 |
| 单次上传 splat | ≤ 6M 点 | `budgetOverride` 已做钳制 |
| 像素比 | ≤ 2.0（手机） | 3x 屏按 2x 渲染，省 55% 填充 |
| 单帧 GPU 内存 | ≤ 320MB | 超过大概率在 iOS 上被系统杀 |

**新增任何逐帧逻辑，都要回答：它在 Saver 档（30FPS）下还跑得动吗？**

---

## 5. 跨端（iOS / Android / 鸿蒙 / 微信小程序）

- 能力探测统一走 `src/engine/pc/platform.ts`，**不许**在业务代码里散落 UA 判断。
- 任何 3D 路径都必须有**静态海报降级**：`is-poster` + 房型面板，功能不丢。
- 小程序里 `web-view` 的触摸事件要用 `bindtouchstart/move/end` 转发，不要假设 `pointerdown` 可用。
- iOS 上避免多实例（同时两个 WebGL 上下文大概率被杀）；退出页面要 `dispose()`。

---

## 6. 动效规则

- 时长：微交互 120–200ms；转场 400–900ms；叙事镜头 1.5–3s。**超过 3s 必须可跳过。**
- 缓动：进场 `outCubic`，退出 `inCubic`，抽屉/弹出 `outBack`（过冲 ≤ 12%）。**不许线性**（除非是 loading）。
- 所有叙事动效都要支持**点击跳过**（100ms 内响应）。
- 音频/震动只在关键帧触发一次；震动强度 ≤ 20ms，且不在动画中间触发。
- 动效完成后必须**交还交互**（`controls.enabled = true`），这是最容易忘的一步。

---

## 7. HUD / CSS

- 设计稿宽度固定 **885px**；HUD 用 `--s = min(vw/885, vh/1000)` 等比缩放，高度 `calc(100vh / var(--s))` 自适应。
  > 这样任何比例的屏幕都铺满宽度，不会出现黑边。
- 类名用语义化小写+连字符（`.orderpanel`、`.rspot`）；**新增类名前先全局搜一遍**，本项目踩过 `.order` 重名把面板压扁的坑。
- z-index 只用这几档：背景 0、3D 画布 1、房间页 20、遮罩 40、HUD 60、弹层 80。**不许随手写 999**。
- 颜色只用 `app.css` 顶部的 CSS 变量，不许在组件里写死色值。

---

## 8. 资产管线

原始扫描 → 分块 LOD → 引擎可用格式，**全程用 tools 里的脚本，不许手工改文件**。

```bash
# 1. PLY → 分块 + 两级 LOD（输出 .splat 分块 + manifest）
node tools/ply-to-lod.mjs --in model.ply --out models/xxx --chunk 120000

# 2. 分块合并成整块 ply（给 PlayCanvas 之类不吃分块的引擎）
node tools/merge-lod-ply.mjs models/xxx/manifest.json lod0 models/xxx/merged.ply

# 3. 按高度切成三块（上下拆分 + 抽屉用）
node tools/split-ply-y.mjs models/xxx/merged.ply models/xxx/split 15.6 28.6

# 4. 压缩（线上只用这一种）
npx splat-transform models/xxx/split-lower.ply models/xxx/split-lower.sog
```

命名规范：`{场景}-{部件}.{格式}`，如 `split-lower.sog`、`split-mid.sog`。
**`models/` 永远不进仓库**，走 CDN；仓库里只放 manifest 和构建脚本。

---

## 9. Git

- 分支：`main`（可发布）、`feat/xxx`、`fix/xxx`、`chore/xxx`。
- 提交信息用中文，格式 `<类型>: <做了什么>`：
  ```
  feat: 抽屉改成自下而上浮出
  fix: 拆分时中间层未消隐导致裂缝被填住
  ```
- 一次提交只做一件事；**不许提交 `dist/`、`models/`、`node_modules/`**（`.gitignore` 已挡）。
- 合并前必须过：`npm run check`（typecheck + lint）。
- 动效/视觉改动必须附**截图或录屏**。

---

## 10. AI 协作规则（重要）

所有人用 AI 写代码时，把这份文件 + `AGENTS.md` 一起给模型，并要求：

1. **改之前先读**：`AGENTS.md` → 本文件 → 目标文件所在目录的现有实现。
2. **禁止整文件重写**，只做最小定点修改；改完必须能通过 `npm run check`。
3. **禁止改 `models/`、`docs/*.jpg`**（资产和截图），除非任务就是换资产。
4. **新增动效必须写清**：时长、缓动、是否可跳过、完成后是否交还交互。
5. **新增 3D 代码必须写清**：坐标系、单位、降级方案。
6. AI 交付时必须给出：改了哪些文件、为什么、怎么验证（截图/命令）。

---

## 11. 我们踩过的坑（新增一条 = 少一个通宵）

| 坑 | 症状 | 结论 |
| --- | --- | --- |
| `dt` 单位混用 | 阻尼/惯性完全不生效 | 时间参数一律带单位后缀 |
| 四元数 w/x/y/z 顺序 | 点云渲染成噪点 | PLY 读取必须自动判序（`wxyz` / `xyzw`） |
| PlayCanvas root 旋转后坐标 | 拆分变成横向平移 | 本地 +Z 才是世界 +Y |
| `mesh.setColors32` 传 0–1 浮点 | 模型全黑 | 32 位版本要 0–255 |
| CSS 类名重名 | 面板被压成一条 | 新增类名先全局搜 |
| 无头浏览器 `hidden` 状态 | 截图永远是第一帧，误判「动效没生效」 | 截图脚本要 `Page.setWebLifecycleState('active')` |
| 夜间构建 Node 版本 | `??=` 语法报错 | 仓库带 `.nvmrc`，CI 锁 Node 18 |
