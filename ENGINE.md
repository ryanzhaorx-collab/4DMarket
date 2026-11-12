# 渲染引擎设计说明

本文只讲引擎，UI 与业务在 `src/main.ts` / `src/app.css`。

## 1. 为什么不用 three.js / Cesium

移动端 3DGS + 倾斜摄影的瓶颈不在"能不能画"，而在：

1. 每帧要重排十几万个高斯并上传索引；
2. 显存和带宽都紧，顶点数据不能反复上传；
3. 包里每多 200KB，小程序 web-view 的首屏就多几百毫秒。

three.js 处理 3DGS 需要自定义 InstancedBufferGeometry + 每帧重排 attribute，Cesium 的 3D Tiles 又带着整套地理坐标系。两者叠加 ≈ 1.2MB 起步。最终选择：

- **3DGS**：裸 WebGL2 + 纹理实例化，全部自己写（约 700 行）；
- **3D Tiles**：自实现最小子集（tileset 遍历 + glTF/b3dm 读取），约 600 行；
- 结果：生产包 57KB JS（gzip 21KB），冷启动没有框架初始化耗时。

## 2. 数据布局

每块 splat 五张纹理，共用同一套 texel 索引：

| 纹理 | 格式 | 内容 |
| --- | --- | --- |
| `uPos` | RGBA32F | x, y, z, opacity |
| `uScale` | RGBA32F | σx, σy, σz（米） |
| `uRot` | RGBA32F | 四元数 x, y, z, w |
| `uCol` | RGBA8 | r, g, b, 255 |
| `uIdx` | R32UI | 由远及近的 splat 索引 |

纹理宽 1024，高按点数向上取整到整行，多余 texel 补 0（避免 `texImage2D` 因行对齐报 `ArrayBufferView not big enough`）。

每 splat 显存：16×3 + 4 + 4 = **56 字节**。20 万点 ≈ 11MB。

## 3. 顶点着色器

```glsl
int slot = gl_InstanceID * uIdxStride;      // 预算不足时跳采样
uint gi  = texelFetch(uIdx, ...).r;         // 排序后的真实索引
vec4 vp  = uView * vec4(pos, 1.0);
// 3D 协方差 Σ = R S Sᵀ Rᵀ
// 雅可比 J = ∂(fx·x/z, fy·y/z)/∂(x,y,z)
mat3 cov = J * V * Σ * Vᵀ * Jᵀ;             // 像素单位
float radius = 3·sqrt(λmax);                // 3σ 包围
clip.xy += corner * radius / halfPx * clip.w;
```

要点：

- **像素空间**算协方差，不用 NDC。NDC 下二次型系数会到 1e6 量级，fp32 精度不够，边缘会出现块状条纹。
- `a += 0.3`（像素²）是 3DGS 原论文的低通项，用来保证亚像素高斯至少占 1px，否则远处会闪。
- 相机背后 / 近平面（`vp.z > -0.02`）的实例直接把 clip 推到 `z=2` 丢弃，避免 `w<0` 时 quad 翻转成巨大三角形糊屏。

## 4. 片元着色器

```glsl
float power = -0.5 * (c.x·d.x² + 2·c.y·d.x·d.y + c.z·d.y²);
float alpha = min(0.995, vAlpha * exp(power));
if (alpha < 0.004) discard;
fragColor = vec4(color.rgb * alpha, alpha);   // 预乘
```

混合：`blendFuncSeparate(ONE, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)`。

深度：`depthMask(false) + depthFunc(LEQUAL)`，即**只测试不写入**——让 splat 被倾斜摄影的不透明几何正确遮挡，同时 splat 之间完全靠排序保证顺序（3DGS 的标准做法）。

## 5. 排序调度

```
每帧:
  相机位移 > 0.35m 或方向变化 > 0.14° → epoch++
  for 可见块 (按屏幕占比降序):
     若 activeLayer.sortedEpoch != epoch 且未在途 → 投递排序任务
  同时最多 1 个在途任务（避免队列堆积）
```

Worker 侧：

```js
d = dot(p - cam, fwd)                  // 视向深度
q = clamp((d - near) / (far - near) * 65535)
key = 65535 - q                         // 反转 → 升序即"由远及近"
两趟 8bit LSD 计数排序
```

排序结果 `Uint32Array` 通过 transferable 回传，主线程 `texSubImage2D` 更新索引纹理（4B/点，20 万点 = 800KB/次，PCIe 带宽下 <0.3ms）。

**为什么是 16bit**：3DGS 只需要近似顺序，16bit 在 50m 深度跨度下精度约 0.8mm，远小于高斯本身尺寸；换来的是两趟计数排序（4 次线性扫描）而不是三趟 32bit。

**块间顺序**：按块中心到相机距离降序绘制。块内已排序，块间用距离近似，30m 以上的分块在移动端视角下误差不可见。

## 6. LOD 与预算

- `manifest` 里同一 `key` 的 `lod=0/1` 合并为一个 tile；
- 新 LOD 到达 → 立即 `fade=1` 顶上（绘制顺序保证它在上层），旧 LOD `targetFade=0` → 每帧 `fade -= dt*2.6` → 归零后 `deleteTexture` 释放显存；
- 可见总点数 > 预算时 `stride = ceil(total/budget)`，`uIdxStride` 让实例按步长取索引，排序关系不变，画面降采样但不错位。

## 7. 倾斜摄影

`Tiles3D` 的遍历函数返回"子树是否已选出内容"：

```
if 有子节点 && SSE > maxSSE:
    any = 任一子节点被选中
    if !any && 本节点有内容: 选本节点（子节点还没加载出来时先用父级兜底）
    if any && refine == ADD:  也选本节点
else if 有内容: 选本节点
```

- 内容加载并发 3，失败标记 `failed` 不重试（避免坏瓦片拖垮整场）；
- 每个 primitive 建 VAO，纹理用 `createImageBitmap` 异步解码；
- 超预算按 `lastUsed` 淘汰，保留当前选中的瓦片。

## 8. 自适应画质

| 档位 | 渲染倍率 | splat 预算 | maxSSE | 每帧排序 |
| --- | --- | --- | --- | --- |
| Ultra | 1.00 | 420k | 14 | 3 |
| High | 0.95 | 300k | 18 | 3 |
| Medium | 0.82 | 200k | 24 | 2 |
| Low | 0.68 | 120k | 34 | 2 |
| Saver | 0.55 | 70k | 48 | 1 |

初始档位由 `navigator.deviceMemory` 与 UA 决定（移动端默认 Medium，内存 <2.5GB 直接 Saver）。之后只看帧时间 EMA。

## 9. 容错

- **上下文丢失**：`Engine.onLost` 阻止默认行为并停循环；`onRestored` 重建 program / VAO / 纹理（`SplatRenderer` 保留 CPU 侧 payload，`rebuildGPU()` 重传），并重新拉取 tileset。
- **Worker 失败**：`SplatLoader` 与排序都有主线程降级路径，功能不减，只是帧率下降。
- **加载超时**：排序任务 1.5s 未回自动作废；资产请求失败只影响单块。
- **渲染异常**：`tick()` 整体 try/catch，一旦抛错停帧、上报、保留 UI。

## 10. 入场与交互手感

### 点云凝聚（resolve）

不开新几何、不走后处理，直接在 splat 顶点着色器里做：

```glsl
float h1 = hash11(float(gi));                      // 每个点固定的随机相位
float appear = smoothstep(h1*0.55, h1*0.55+0.45, uResolve);
vec3  dir    = normalize(randomVec3(gi));
world = pos + dir * uScatter * (1.0 - appear);     // 从散开位置收回
scl  *= mix(0.22, 1.0, appear);                    // 尺寸由小变大
vAlpha *= appear;                                  // 透明度跟随
```

- `uResolve` 由 `Engine.startResolve(duration)` 驱动，`easeOutCubic` 0→1；
- `uScatter` 取内容包围盒对角线的 30%，不同尺度的模型观感一致；
- 每个点用 `hash11(gi)` 取相位，所以是「一波粉尘逐渐凝实」，不是整体淡入；
- `uResolve >= 0.999` 时整段分支被跳过，稳态零开销。

### 交互阻尼

控件不再直接把指针增量写到相机，而是：

1. 指针增量 → `targetYaw / targetPitch`；
2. 每帧 `cam += (target - cam) * (1 - exp(-dt*14))`，时间常数约 70ms；
3. 松手后把速度按 `0.9^(dt*60)` 衰减，产生滑行；
4. 空闲 3.8s 后 `targetYaw += 0.06 * dt` 缓慢自转，任何触碰清零；
5. 双击回到 `homePose`（`flyTo` 900ms 缓动）。

> 注意 `update(dt)` 的单位是**秒**。早期版本传了毫秒，导致平滑系数恒为 1、惯性每帧清零——手感和惯性实际上都没生效。

### 缩放范围

默认 10~420m 的固定上下限对真实模型是错的（几百米的场景根本拉不开，几公里的模型也怼不近）。
`autoFrame()` / `applyCameraPose()` 会按当前距离动态设置 `[distance*0.08, distance*5]`。

## 11. 扩展点

| 需求 | 改哪里 |
| --- | --- |
| 支持 `.spz` / `.ksplat` 压缩格式 | `splatFormat.ts` 加解析函数（spz 可用 `DecompressionStream('gzip')`） |
| GPU 端排序（百万级场景） | 把 `radix.ts` 换成 compute + bitonic，或改用 3-pass GPU radix |
| 球谐（SH）高阶颜色 | `uCol` 扩成 SH 系数纹理，片元按视角方向重建 |
| 单体化点选 | `Engine.project` 已有，补射线-包围盒命中 + 物体 ID 纹理 |
| 云渲染兜底 | 保留 `manifest` 抽象，把渲染层换成视频流即可 |
