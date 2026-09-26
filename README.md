# Image2Splat · 图生 3D 高斯泼溅

把一张图片或一段视频，变成可旋转的 3D 高斯泼溅点云。深度估计模型为每个像素估算距离，生成数十万枚带颜色的高斯「泼溅」——全部在浏览器里完成，文件不会上传到任何服务器。

**线上地址：<https://forjiang.github.io/image-to-splat/>**（与 [image-metadata-cleaner](https://forjiang.github.io/image-metadata-cleaner/) 同一设计系统）

## ✨ 功能

- **图片模式**：JPG / PNG / WebP，自动处理 EXIF 旋转
- **视频模式**：均匀抽 16 帧，按拉普拉斯方差自动选最清晰的一帧，也可以手动点选；seek 不了的分片视频自动降级为播放采样
- **实时参数**：深度强度、泼溅大小、深度方向即时生效（不用重新推理）；重建分辨率三档
- **中英双语**：跟随系统语言，顶栏一键切换
- **导出**：`.ply`（Blender / CloudCompare / SuperSplat 可开）、`.splat`（antimatter15 / SuperSplat 泼溅格式）、深度图 PNG、当前视角截图
- **加速**：有 WebGPU 时以 fp16 运行，否则自动回退 int8 量化 + WASM；模型下载后浏览器缓存

## 🖼️ 它是怎么工作的

```
输入图 ──缩放──▶ Depth Anything V2 (ONNX, WebGPU fp16 / WASM q8)
                        │ predicted_depth（浮点反深度，值越大越近）
                        ▼
        2%–98% 分位归一化 ──▶ Z = (d − 0.5) × 强度
                        │
每个像素 ────────────────▶ 高斯圆盘（原图颜色，尺寸 ∝ 1/(1+2×|∇depth|)，位置抖动）
                        ▼
              three.js Points 着色器渲染 / 导出 PLY、SPLAT
```

## 🔒 隐私

无服务器 · 无日志 · 无追踪。模型加载后，深度推理、点云构建、导出全部发生在你的浏览器标签页里，断网也能用；页面没有任何上传代码。

## 🚀 本地运行

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

调试模式：`?mock=1` 用合成深度图代替模型，可离线验证点云/导出链路。

## 📁 目录结构

```
├── index.html              # 单页应用
├── assets/
│   ├── css/style.css       # 深色玻璃主题（与 image-metadata-cleaner 同一设计系统）
│   └── js/                 # main 主控 / depth 推理 / splat 点云 / viewer 渲染
│                           # exporter 导出 / video 抽帧 / i18n 双语 / wave-bg 波场背景 / reveal 入场
├── vendor/                 # 自托管依赖：three.js、transformers.js + ORT wasm
├── models/                 # Depth Anything V2 small（fp16 49.6MB + q8 27.3MB）
└── assets/sample-*.jpg     # 内置示例图
```

## ❓ 诚实的边界

单视角重建本质是 **2.5D**：生成的是「正面 + 深度浮雕」，被遮挡的背面无法凭空还原，大角度旋转会露馅。完整的多视角 3D 高斯泼溅需要多角度照片 + GPU 训练（nerfstudio、Postshot、gsplat 等）。本站适合快速预览、浮雕艺术效果与 3D 素材起步。

## 🙏 致谢

- [Depth Anything V2](https://depth-anything-v2.github.io/) · onnx-community 的 ONNX 权重
- [transformers.js](https://huggingface.co/docs/transformers.js)（Hugging Face）
- [three.js](https://threejs.org) · OrbitControls
- [.splat 格式](https://github.com/antimatter15/splat)（antimatter15）· [SuperSplat](https://playcanvas.com/supersplat)

## 📄 License

MIT © 2026 ForJiang
