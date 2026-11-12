# 用你自己的模型调试

不用改代码，加两个 URL 参数就能把 `.ply` 点云和 3D Tiles 倾斜摄影挂进来。

## 0. 一句话版本

```bash
cp 你的模型.ply public/assets/local/          # 或者放任意能被 http 访问的地方
open "http://localhost:5178/?ply=assets/local/你的模型.ply&tiles=/__proxy/https/对方域名/tileset.json&fit=1&debug=1"
```

模型不在坐标系原点、或者和倾斜摄影对不上，就加 `offset` / `rotY` / `scale` 调。

## 1. 最快路径：URL 参数

```bash
npm run dev        # http://localhost:5178
```

### 只加载你的 PLY

把文件丢进 `public/assets/local/`（目录已建好，文件名随意），然后：

```
http://localhost:5178/?ply=assets/local/我的模型.ply&fit=1&debug=1
```

`.ply` 和 `.splat` 都支持；引擎会在 Worker 里解析、按空间自动切块，再交给渲染层。

### 只加载 3D Tiles

```
http://localhost:5178/?tiles=https://你的域名/path/tileset.json&fit=1&debug=1
```

如果对方服务器没开 CORS，用内置代理绕过去（只在本机开发服务器生效）：

```
http://localhost:5178/?tiles=/__proxy/https/你的域名/path/tileset.json&fit=1&debug=1
```

代理规则：`/__proxy/<协议>/<域名>/<路径>` → `<协议>://<域名>/<路径>`，
`tileset.json` 里的相对路径（`content.uri`）会按同一条规则继续代理，整棵瓦片树都能通。

### 两个一起调

```
http://localhost:5178/?ply=assets/local/我的模型.ply&tiles=/__proxy/https/xxx/tileset.json&fit=1&debug=1
```

## 2. 参数表

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `ply` | 点云地址，相对路径按页面解析，也可写绝对 URL | — |
| `tiles` | `tileset.json` 地址 | — |
| `fit` | 加载完自动取景（`0` 关闭） | 开 |
| `debug` | 右下角性能浮层 + 暴露 `window.__engine` | 开（调试模式） |
| `offset` | 点云平移 `x,y,z`（米） | `0,0,0` |
| `rotX` / `rotY` / `rotZ` | 点云绕 X / Y / Z 轴旋转（度） | `0` |
| `scale` | 点云等比缩放 | `1` |
| `toffset` | 3D Tiles 平移 | `0,0,0` |
| `trotX` / `trotY` / `trotZ` | 3D Tiles 绕 X / Y / Z 轴旋转（度） | `0` |
| `tscale` | 3D Tiles 等比缩放 | `1` |
| `rot` | PLY 四元数顺序：`wxyz`(INRIA) / `xyzw` / `auto` | auto |
| `budget` | splat 绘制预算，调试大模型时调高 | 150 万（调试模式） |
| `hud` | `0` 隐藏全部 UI | — |

对不齐时先用 `fit=1` 找到两个模型，再调 `offset` / `rot*` / `scale`。例：

```
?ply=...&tiles=...&scale=0.001&offset=0,0,0&trotX=-90&trotY=90&fit=1
```

**旋转约定**：三轴都用右手系、角度制，合成顺序固定 `R = Rz · Ry · Rx`（先 X，再 Y，最后 Z），
和 Blender/3ds Max 的 XYZ 欧拉一致。旋转轴是**世界原点**，模型偏离原点时会整体移动——
`fit=1` 会自动重新取景，再用 `offset` 微调。常见的 Z-up → Y-up 转换就是 `rotX=-90`。

## 3. PLY 要求

支持两种编码：

- **二进制小端**（INRIA 3DGS 标准导出，推荐）
- **ASCII**（`format ascii 1.0`，逐行解析，几万点以内可用）

需要的属性（名字必须一致）：

| 属性 | 含义 |
| --- | --- |
| `x y z` | 位置，单位米，**Y 轴向上** |
| `f_dc_0 f_dc_1 f_dc_2` | 球谐 0 阶颜色（引擎按 `0.5 + 0.28209 * dc` 还原） |
| `opacity` | logit 不透明度（引擎做 sigmoid） |
| `scale_0..2` | **对数**尺度（引擎做 exp，单位米） |
| `rot_0..3` | 四元数 `(x, y, z, w)`，会归一化 |

`f_rest_*`（高阶球谐）、`nx/ny/nz` 会被忽略，有也没关系。

### 四元数顺序（最容易踩的坑）

3DGS 的 PLY 有两种写法：

- **INRIA 官方导出**：`rot_0..3 = (w, x, y, z)`
- 部分转换工具：`rot_0..3 = (x, y, z, w)`

顺序读反不会报错，只会让每个高斯随机转一下——画面表现为**拉长的丝状色块、发白、结构糊成一片**，看起来特别像"模型没加载完"。

引擎默认 `auto`：抽样比较 `|rot_0|` 和 `|rot_3|` 的均值（真实 3DGS 的 w 分量系统性偏大）自动判定。
如果自动判定错了，手动指定：

```
?ply=...&rot=wxyz      # 或 xyzw
```

### 绘制预算 vs 加载完成

调试浮层第一行是 `splat 已绘制 / 常驻总数 百分比`：

```
splat 413.2k / 7.12M  6%      ← 只画了 6%
cap 1.50M  draw 40  tile 6
GPU 397MB  Ultra x1.00
```

- **加载**是否完成看 `GPU` 和 `draw`：`draw 40` 说明 40 个分块都已上传显存，加载是完整的；
- **看到多少**由 `cap` 决定：超过预算后按等步长抽样绘制，画面会变稀，但不会错位。
- 桌面调试可以临时拉满：`?budget=6000000`（显存和帧率自己权衡）；移动端建议先抽稀到 30 万点以内。

### 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 报「仅支持二进制小端或 ASCII」 | 用了 `binary_big_endian` | 用 CloudCompare / Open3D 转小端 |
| 拉长的丝状色块 / 发白 / 像没加载完 | **四元数顺序读反**（最常见） | 引擎会自动判定；错了就加 `?rot=wxyz` 或 `?rot=xyzw` |
| 点云糊成一片 / 巨大色块 | 属性名不是 `f_dc_*`（比如某些工具导出 `red/green/blue`） | 引擎会退回 `red/green/blue`；若都没有则按灰度显示 |
| 只有薄薄一层点、结构稀 | 点数远超预算（看 `splat x / y` 的百分比） | 调 `?budget=`，或先抽稀 |
| 模型很平或方向反了 | 坐标系不是 Y-up（有些管线是 Z-up） | 用 `?rotY=90` 调不平的绕向；Z-up 需要先在导出端转换 |
| 只看到一堆散点 | 点太少或 `scale` 太小 | 真实 3DGS 一般 10 万点以上；低于 1 万点会明显稀疏 |
| 加载很慢 / 页面卡死 | 单文件几百万点 | 先抽稀到 100 万点以内，或按区域导出多块 |

**自检工具**：`node tools/splat-to-ply.mjs <a.splat> <b.ply>` 可以把 `.splat` 转成标准 PLY，
拿它对照你自己文件的属性名和取值范围最快。

`samples/` 下有两份现成样例（不参与构建，用前复制到 `public/assets/local/`）：

```bash
cp samples/demo.ply public/assets/local/
open http://localhost:5178/?ply=assets/local/demo.ply&fit=1&debug=1
```

- `samples/demo.ply`：11.4 万点，二进制（INTRA 标准导出样式）
- `samples/ascii-test.ply`：400 点，ASCII，用来验证非二进制分支

## 4. 3D Tiles 要求

- `tileset.json`，`asset.version` 1.0（1.1 未完整支持）
- 瓦片内容支持 `.glb` / `.gltf` / `.b3dm` / `.i3dm`
- 建议 `refine: REPLACE`；`ADD` 也支持（父级会保留）
- 需要 `boundingVolume.box` 或 `sphere`；`region`（经纬度）暂不支持
- 有 `root.transform` 会正常叠加；没有则按 Y-up 米制处理
- **ECEF / 地理坐标（坐标值 6.3e6 量级）不能直接和本地 PLY 对齐**，需要先用工具转成局部 ENU

### 四元数顺序（最容易踩的坑）

3DGS 的 PLY 有两种写法：

- **INRIA 官方导出**：`rot_0..3 = (w, x, y, z)`
- 部分转换工具：`rot_0..3 = (x, y, z, w)`

顺序读反不会报错，只会让每个高斯随机转一下——画面表现为**拉长的丝状色块、发白、结构糊成一片**，看起来特别像"模型没加载完"。

引擎默认 `auto`：抽样比较 `|rot_0|` 和 `|rot_3|` 的均值（真实 3DGS 的 w 分量系统性偏大）自动判定。
如果自动判定错了，手动指定：

```
?ply=...&rot=wxyz      # 或 xyzw
```

### 绘制预算 vs 加载完成

调试浮层第一行是 `splat 已绘制 / 常驻总数 百分比`：

```
splat 413.2k / 7.12M  6%      ← 只画了 6%
cap 1.50M  draw 40  tile 6
GPU 397MB  Ultra x1.00
```

- **加载**是否完成看 `GPU` 和 `draw`：`draw 40` 说明 40 个分块都已上传显存，加载是完整的；
- **看到多少**由 `cap` 决定：超过预算后按等步长抽样绘制，画面会变稀，但不会错位。
- 桌面调试可以临时拉满：`?budget=6000000`（显存和帧率自己权衡）；移动端建议先抽稀到 30 万点以内。

### 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 控制台 `CORS` 报错 | 瓦片服务器没放开跨域 | 用 `/__proxy/` 代理；或让对方加 `Access-Control-Allow-Origin: *` |
| 只出现一大块平面 | 相机太远，LOD 停在父级 | 调近相机，或先 `fit=1` 看整体 |
| 什么都看不到 | `boundingVolume` 写错 / 瓦片在高空 | 用 `?debug=1` 看 `tile` 数是否 > 0，再检查 `root.transform` |
| 模型飘在空中或陷进地面 | 两套坐标原点不一致 | 用 `toffset` 抬高/平移，或 `trotY` 对齐朝向 |

## 5. 控制台接口

`?debug=1` 时页面会挂 `window.__engine`：

```js
__engine.camera.distance          // 当前相机距离
__engine.contentBounds()          // 已加载内容的包围盒（点云 + 瓦片）
__engine.autoFrame()              // 重新自动取景
__engine.tileRenderer.tileStats   // { selected, loaded, drawCalls, gpuBytes }
__engine.shed.tileCount           // 点云分块数
__engine.camera.distance = 120    // 直接改，方便找视角
```

## 6. 调好之后怎么固化

URL 参数只适合临时看。定下来后写进 `public/assets/<场景名>/manifest.json`：

```jsonc
{
  "version": 1,
  "scene": { "id": "yuehua", "name": "四维空间", "location": "福建 · 东山岛", "tags": ["看海窗景"] },
  "camera": { "target": [0, 4, 10], "distance": 93, "yaw": 0.12, "pitch": 0.7, "fov": 55,
              "introFrom": { "distance": 220, "pitch": 1.02, "yawOffset": 0.5 } },
  "splat": {
    "tiles": [],
    "source": "hotel.ply",
    "transform": { "translate": [0, 0, 0], "rotateX": 0, "rotateY": 0, "rotateZ": 0, "scale": 1 }
  },
  "tileset": "tiles/tileset.json",
  "tilesetTransform": { "translate": [0, 0, 0], "rotateX": 0, "rotateY": 0, "rotateZ": 0, "scale": 1 },
  "hotspots": [{ "id": "hotel", "label": "悦华酒店 · 270° 海景", "position": [0, 26.5, 0] }]
}
```

然后把 `src/main.ts` 里的 `assets/yuehua/` 换成新目录即可（或继续用 URL 参数指定 `manifest`）。

## 7. 把大 PLY 切成 LOD（推荐先做这一步）

单文件 PLY 会整包上传显存，几百万点就会卡。用离线工具切块 + 抽低模：

```bash
npm run lod -- 你的模型.ply --out public/assets/local/hotel --chunk 150000 --lod 0.15
```

| 参数 | 含义 | 默认 |
| --- | --- | --- |
| `--out` | 输出目录（会被 vite 当静态资源） | `public/assets/local/scene` |
| `--chunk` | 每块目标点数 | 150000 |
| `--lod` | 低模保留比例 | 0.2 |
| `--keep` | 高模再保留多少（大模型必备，配合 `--lod` 控制总量） | 1 |

产出：

```
hotel/manifest.json
hotel/splat/lod0/c0_0_0.splat   约 20%，首屏先出图
hotel/splat/lod1/c0_0_0.splat   全量，流式精修
```

然后 `?manifest=assets/local/hotel/manifest.json&fit=1&debug=1` 直接看。

**实测 7.44M 点 / 397MB（HS 玻璃幕墙）**：解析 2.6s、切块 7.6s（峰值内存 966MB），
`--chunk 120000 --lod 0.08 --keep 0.5` 产出 39 块，LOD0 595k / 18MB、LOD1 3.72M / 113MB，显存 199MB。

**实测 1.83M 点 / 118MB**：处理 2s、峰值内存 493MB；产出 27 块 × 2 级，
LOD0 8.4MB、LOD1 55.7MB；浏览器 60fps / 27 draw call / 显存 98MB。
未切块时同样的模型是 397MB 显存 + 只绘制 6%。

顺序说明：LOD0 全部先请求，LOD1 随后逐块替换并交叉淡入（`key` 相同的两块会合并成一个 tile）。

## 8. 性能建议（真机）

| 指标 | 建议值 | 说明 |
| --- | --- | --- |
| 点云总量 | ≤ 30 万点 | 约 16MB 显存（56 字节/点） |
| 单块点数 | ≤ 6 万 | 单块排序 1~3ms，块太多会增加 draw call |
| 分级 | 2 级 LOD | 低模 ≈ 精细的 15~20% |
| 倾斜摄影 | 单瓦片 ≤ 600 万三角面 | 显存预算内按 LRU 淘汰 |
| 首包 | ≤ 8MB | 先出 LOD0，再逐块精修 |

超过这个量级，先按区域拆分资产（引擎会自动做块，但网络和显存是硬约束）。
