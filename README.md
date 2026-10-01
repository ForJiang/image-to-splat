# Image2Splat · 图生 3D 高斯泼溅

> 把一张图片、一段视频或多张环绕照片，变成可旋转的 3D 高斯泼溅点云——深度估计模型为每个像素估算距离，生成数十万枚带颜色的高斯「泼溅」；多图模式先用纯 JS 的 SfM 解出相机位姿，再把各视角深度融合进同一坐标系，得到可完整环绕的点云。**纯静态部署，推理与渲染全部在浏览器里完成，文件不上传任何服务器。**

[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-在线-3ddc97.svg)](https://forjiang.github.io/image-to-splat/)
[![License: MIT](https://img.shields.io/badge/License%20MIT-d8d8ff.svg)](LICENSE)
[![No Build](https://img.shields.io/badge/build-none-success.svg)](index.html)
[![Model](https://img.shields.io/badge/model-自托管%2077MB-informational.svg)](models/depth-anything-v2-small)

English intro at the bottom: [English](#english)

---

## 功能特性

| | |
| --- | --- |
| 图片模式 | 拖入 JPG / PNG / WebP 即可重建，`createImageBitmap` 自动烘焙 EXIF 方向，手机直拍也能用 |
| 多图完整重建 | 一次导入 8-12 张环绕照片，解算相机位姿后融合成可完整环绕的点云（不只是正面浮雕）；视图列表支持单张移除、重建、清空 |
| 视频自动选帧 | 均匀抽 16 帧，按拉普拉斯方差自动挑最清晰的一帧参与重建，也可以手动点选换帧；seek 不了的分片视频（如 MediaRecorder 直出）自动降级为播放采样 |
| 实时参数 | 深度强度、泼溅大小、深度方向调整即时生效（约 30ms，无需重新推理）；重建分辨率 流畅 384 / 均衡 512 / 高清 640 三档 |
| 高斯点云渲染 | three.js 自定义 Points 着色器：不透明圆盘 + 径向明暗近似高斯体积感，深度写入获得正确遮挡，无需逐帧排序；边缘泼溅自动收缩、位置抖动打散网格感 |
| 多格式导出 | `.ply`（Blender / CloudCompare / SuperSplat 可开）、`.splat`（antimatter15 / SuperSplat 泼溅格式，按体积降序 + 恒等四元数）、深度图 PNG、当前视角截图 |
| WebGPU 加速 | 有 WebGPU 以 fp16 运行，否则自动回退 int8 量化 + WASM；模型浏览器缓存后二次访问基本秒开 |
| 中英双语 | 跟随系统语言，顶栏一键切换，移动端自适应 |
| 卡片入场动画 | 主面板、3D 预览、汇总统计随滚动淡入上移；`prefers-reduced-motion` 下自动静止，无 JS 时内容直接可见 |
| 移动端稳定 | 背景画布尺寸稳定捕获 + 独立合成层，滚动时背景钉住不滑不抖；毛玻璃效果按屏幕宽度降级，保证滚动流畅 |
| 隐私优先 | 无任何上传代码，模型加载后断网也能用；无日志、无追踪 |
| 真正静态 | 无构建、无依赖安装，GitHub Pages 直接发布；模型与依赖全部自托管，不请求任何第三方域名 |
| 首屏轻载 | three.js 与深度模型均按需懒加载：首屏资源约 60KB，渲染库不进关键路径；拖文件后视口模块与推理并行下载，空闲 3 秒或首次交互时预热，二次访问模型直接命中缓存 |

## 界面预览

![界面预览](docs/screenshot.png)

深色玻璃面板 + WebGL 正弦波线条背景（原生 WebGL1 复刻 three.js `RawShaderMaterial` 效果，零第三方依赖，`prefers-reduced-motion` 下自动静止、页面隐藏时暂停渲染；移动端滚动时背景稳定，不随地址栏收放重排）。顶栏固定 60px 高，与 [image-metadata-cleaner](https://forjiang.github.io/image-metadata-cleaner/)、[rvc-sound-clone](https://forjiang.github.io/rvc-sound-clone/) 的排版规格一致。

## 它是怎么工作的

```
单图 / 视频（2.5D）：
浏览器（纯静态站点）
 ├─ 拖入 / 选择 -> 图片解码（EXIF 方向烘焙）或视频抽帧（清晰度自动选帧）
 ├─ 缩放到 384 / 512 / 640 -> Depth Anything V2 推理（WebGPU fp16 / WASM q8）
 ├─ predicted_depth 浮点反深度 -> 2%–98% 分位归一化 -> Z = (d − 0.5) × 强度
 ├─ 每个像素 -> 高斯圆盘（原图颜色，尺寸 ∝ 1/(1+2×|∇depth|)，确定性抖动）
 └─ three.js Points 着色器渲染 -> 导出 .ply / .splat / 深度图 PNG

多图（完整环绕）：
 ├─ 每张图 FAST-12 角点 + 定向 BRIEF（512 bit）描述子，互相最近邻 + 比率检验匹配
 ├─ RANSAC 8 点法（退化配置剔除 + 质量偏置采样）-> 本质矩阵 -> 手性检验 -> 三角化
 ├─ 逐对链式位姿（种子点定标 + PnP 精化）-> 全部视角的相机位姿 + 稀疏种子点
 ├─ 每张图单独跑深度估计，用种子点把单目深度的未知尺度对齐到 SfM 度量
 └─ 逐像素抬升到同一世界坐标系 -> 体素哈希去重融合（重叠区颜色自动平均）
```

| 模块 | 职责 |
| --- | --- |
| `assets/js/depth.js` | transformers.js 加载自托管模型（禁用远端回退），WebGPU/WASM 双后端自动降级，聚合下载进度 |
| `assets/js/sfm.js` | 纯 JS 多视角 SfM：FAST-12 + 定向 BRIEF 描述子、互相最近邻匹配、RANSAC 8 点法（Hartley 归一化 + 退化剔除）、本质矩阵分解、DLT 三角化、增量位姿链 + PnP 精化；无 wasm，逐视图让出主线程 |
| `assets/js/splat.js` | 深度归一化、梯度计算、逐像素生成泼溅（位置 / 颜色 / 尺寸三组属性） |
| `assets/js/multiview.js` | 多视图融合：逐视图深度 + 种子点尺度对齐 + 体素哈希融合，输出与单图模式一致的泼试点云 |
| `assets/js/viewer.js` | three.js 场景与自定义泼溅着色器，轨道控制、自动环绕、像素级截图（由 main.js 动态 import，three.js 不占首屏） |
| `assets/js/video.js` | 双路径抽帧：按时长 seek（先修分片视频的 `Infinity` 时长），失败降级 `requestVideoFrameCallback` 播放采样 |
| `assets/js/exporter.js` | 二进制 PLY（binary_little_endian）与 32 字节/点 .splat（体积降序）编码 |
| `assets/js/main.js` | 状态机与事件接线：文件入口、推理、重建、交互/导出；视口模块懒加载与预热 |
| `assets/js/wave-bg.js` | 正弦波线条背景（原生 WebGL1，uniforms 与参考组件一致） |
| `assets/js/i18n.js` | 中英双语文案 |
| `assets/js/reveal.js` | 卡片入场动画：滚动揭示（时间戳节流 + 400ms 轮询兜底，不依赖 IntersectionObserver / rAF） |
| `models/` | Depth Anything V2 small 自托管权重：fp16 49.6MB（WebGPU）+ q8 27.3MB（WASM） |

## 快速开始

**在线使用**：<https://forjiang.github.io/image-to-splat/> —— 打开即用，首次需下载约 50 MB 模型（之后有缓存）。

**本地运行**（任一静态服务器均可）：

```bash
python3 -m http.server 8000
# 打开 http://127.0.0.1:8000
```

**调试模式**：`?mock=1` 用合成深度图代替模型，可离线验证点云 / 导出链路。

## 桌面应用

不想开浏览器？同一套前端代码套了一个 Electron 桌面壳（`desktop/`），与网页版功能一致，另有几处原生增强：

- 深度模型（约 77 MB）随应用打包，**首次启动即用、完全离线**，没有下载等待
- 点击拖入区弹系统文件选择器（图片 / 视频多选），导出走系统保存对话框
- 支持「用 Image2Splat 打开」：Finder 里选中图片右键「打开方式」，或命令行 `open -a Image2Splat a.jpg b.jpg`（多张自动进入多图重建）

开发与构建（需要 Node.js ≥ 20）：

```bash
cd desktop
npm install
npm start          # 开发运行（直接读仓库里的 index.html / assets / models）
npm run build      # 打包 Image2Splat.app，模型作为 extra-resource 打进 .app（约 330MB）
npm run build:dmg  # 进一步打成可分发的 .dmg（约 177MB，含 /Applications 拖拽位）
```

实现要点：主进程注册 `app://` 自定义协议，把仓库静态文件提供给渲染进程——ES module、fetch、wasm、WebGPU 全部按 http 语义工作（`file://` 下会被 CORS 卡死）；原生对话框与「打开方式」经 `window.i2sDesktop` 桥接，网页端检测不到该对象时自动回退到原有下载 / 选择链路，两份代码同源。应用未做代码签名：本机构建可直接运行；分发给他人前需 `xattr -dr com.apple.quarantine /Applications/Image2Splat.app`，或改用开发者证书签名。构建脚本目前只出 macOS arm64，Windows / Linux 把 `--platform` / `--arch` 换掉即可；发布到 GitHub Releases 时把 `dist/*.dmg` 传上去即可（仓库里只提交源码，构建产物与 node_modules 已 gitignore）。

## 常见问题

**多张照片能重建出完整的 3D 模型吗？** 能，这是多图模式的用途：一次导入 8-12 张环绕拍摄的照片（相邻照片保持 60% 以上重叠），站点会解算相机位姿并把各视角深度融合，得到可完整环绕的点云，被遮挡的背面由相邻视角补上。单张图则只有正面信息，生成的是「正面 + 深度浮雕」（2.5D）；若还想更进一步（带光照的真实高斯泼溅），那需要多角度照片加 GPU 训练（nerfstudio、Postshot 等）。

**多图模式怎么拍效果最好？** 手持围绕物体转动拍摄，每转 10-15° 拍一张，相邻两张重叠越多越好；光线均匀、避免大面积纯色/反光表面（角点太少会导致特征匹配不足）。对齐失败的视角会被自动跳过，汇总里会显示实际使用的视图数。

**我的图片或视频会被上传吗？** 不会。模型加载后，SfM、深度推理、点云构建、导出全部在你的浏览器里完成，断网也能用；页面没有任何上传代码。

**首次使用为什么要等一会儿？** 首次需要下载约 50 MB 的深度模型（随站点自托管），之后浏览器会缓存，二次访问基本秒开。

**什么样的素材效果最好？** 主体清晰、有明确前后层次的场景，比如人物、盆栽、建筑立面；视频建议环绕物体拍摄，选物体正对镜头的一帧。

---

## English

**Image2Splat** — turn a single photo, a video frame, or a set of orbiting shots into a rotatable 3D gaussian-splatting point cloud. A depth-estimation model measures the distance of every pixel and raises hundreds of thousands of colored splats; in multi-photo mode a pure-JavaScript SfM pass solves the camera poses first and fuses every view into one consistent world frame, so you get a full orbit instead of a front-facing relief. Fully client-side, zero uploads, zero third-party requests.

- **Live**: <https://forjiang.github.io/image-to-splat/>
- **Local**: `python3 -m http.server 8000`, open `index.html`
- **Debug**: `?mock=1` replaces the model with a synthetic depth map (offline pipeline check)
- **Pipeline (single)**: decode; Depth Anything V2 (WebGPU fp16 / WASM q8, self-hosted ONNX); percentile-normalized depth; one gaussian disc per pixel; custom three.js Points shader; export `.ply` / `.splat`
- **Pipeline (multi)**: FAST-12 + steered BRIEF (512-bit) descriptors; mutual-NN + ratio-test matching; RANSAC 8-point F (degeneracy-rejected, quality-biased sampling) to essential matrix with cheirality check; chained poses calibrated by seed points with DLT PnP refinement; per-view depth rescaled onto the SfM metric; voxel-hash fusion with averaged colors
- **Design**: same dark-glass system as [image-metadata-cleaner](https://forjiang.github.io/image-metadata-cleaner/) — 60px topbar, WebGL sine-wave background, reveal animations, zh/en i18n
- **Desktop**: `desktop/` wraps the same frontend in an Electron shell — the ~77 MB model ships inside the app (offline from first launch), native open/save dialogs, and "Open With" support; same codebase via an `app://` custom protocol, web builds fall back automatically
- **Performance**: ~60KB first paint; three.js is dynamically imported and never sits in the critical path, and the depth model is fetched on first drop — the viewer module warms up 3s after load (or on first interaction) so the first rebuild starts with everything already in flight

## License

[MIT](LICENSE)
