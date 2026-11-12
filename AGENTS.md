# AGENTS.md · 给 AI 助手的项目说明

> 任何 AI 在本仓库写代码前，**先读完这一页**，再读 `docs/CODING-STANDARD.md`。

## 这是什么项目

「四维空间」实景三维看房：3DGS + 倾斜摄影的移动端加载器，跑在 **iOS / Android / 鸿蒙 App 的 WebView** 和 **微信小程序 web-view** 里。
两条渲染路径：

- `src/engine/` 自研 WebGL2 引擎（默认，带完整动效）
- `src/engine/pc/` PlayCanvas 分支（`?engine=pc`，团队调研后的替代方案）

## 硬规则（违反即打回）

1. **单位是米，数据 Z-up，渲染 Y-up。** 坐标转换必须显式写。
2. **禁止 `any`**（`gltf.ts` 已豁免）；`strict` 全开；不许 `@ts-ignore`。
3. **不许整文件重写**，只做定点修改；改完必须 `npm run check` 通过。
4. **任何 3D 功能都要有降级**：不支持 WebGL2 → 静态海报，功能不丢。
5. **动效必须可跳过**，结束后必须交还交互。
6. **`models/`、`dist/`、`node_modules/` 不进仓库**；资产走工具脚本生成。
7. **新增 CSS 类名前，先全局搜重名**。
8. **渲染循环里不许 new 对象**。

## 改动后的自检清单

```bash
npm run check          # typecheck + lint
npm run build          # 构建
node scripts/serve.mjs # 本地预览 5178
```

视觉改动要截图；动效改动要录屏。交付说明里写清：**改了哪些文件、为什么、怎么验证**。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | Vite 开发服务器（HMR） |
| `npm run build` | 类型检查 + 构建到 `dist/` |
| `npm run serve` | 预览 `dist/`（带资产代理） |
| `npm run check` | typecheck + lint |
| `?engine=pc` | 切 PlayCanvas 渲染分支 |
| `?debug=1` | 打开调试信息（默认关闭） |

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `src/main.ts` | 启动流程、页面流转、URL 参数 |
| `src/engine/Engine.ts` | 自研引擎生命周期与动效编排 |
| `src/engine/pc/PcEngine.ts` | PlayCanvas 适配层（接口与自研引擎同名） |
| `src/engine/pc/platform.ts` | 跨端能力探测与降级 |
| `src/ui/room.ts` | 第二页：热点 / 选中 / 下单面板 |
| `docs/CODING-STANDARD.md` | 完整规范（**必读**） |
| `docs/COMPAT.md` | 跨端兼容矩阵 |
