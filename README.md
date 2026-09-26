# Image2Splat · 图生 3D 高斯泼溅

在**浏览器里**把一张图片或视频帧变成可交互的 3D 高斯泼溅（Gaussian Splatting）点云：拖入文件 → 本地深度估计 → 生成数十万枚带颜色的高斯「泼溅」→ 拖拽旋转、一键导出 `.ply` / `.splat`。

**纯静态、无后端、模型全自托管** —— Depth Anything V2、transformers.js、three.js 全部随仓库分发，站点不请求任何第三方域名；图片和视频从不离开访客的设备。

**线上地址：<https://forjiang.github.io/image-to-splat/>**

## 功能

- **图片模式**：JPG / PNG / WebP，自动处理 EXIF 旋转
- **视频模式**：均匀抽 16 帧，按拉普拉斯方差自动选最清晰的一帧（可手动点选）
- **实时参数**：深度强度、泼溅大小、反转深度即时生效（无需重新推理）；重建分辨率 384 / 512 / 640 三档
- **渲染**：three.js 自定义着色器，不透明圆盘 + 径向明暗近似高斯体积感，深度写入正确遮挡，无需逐帧排序
- **导出**：`.ply`（Blender / CloudCompare / SuperSplat 可开）、`.splat`（antimatter15 / SuperSplat 泼溅格式）、深度图 PNG、当前视角截图
- **加速**：有 WebGPU 时以 fp16 运行，否则自动回退 int8 量化 + WASM；模型下载后浏览器缓存

## 使用

线上直接访问即可。本地运行（需要 HTTP 服务，不能 `file://` 直开）：

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

调试模式：`?mock=1` 用合成深度图代替模型，可离线验证点云/导出链路。

## 原理

```
输入图 ──缩放──▶ Depth Anything V2 (ONNX, WebGPU fp16 / WASM q8)
                        │ predicted_depth（浮点反深度，值越大越近）
                        ▼
        2%–98% 分位归一化 ──▶ Z = (d − 0.5) × 强度
                        │
每个像素 ────────────────▶ 高斯圆盘（原图颜色，尺寸 ∝ 1/(1+3×|∇depth|)，位置抖动）
                        ▼
              three.js Points 着色器渲染 / 导出 PLY、SPLAT
```

目录结构：

```
├── index.html              # 单页应用
├── css/style.css
├── js/                     # main 主控 / depth 推理 / splat 点云 / viewer 渲染
│                           # exporter 导出 / video 抽帧
├── vendor/                 # 自托管依赖：three.js、transformers.js + ORT wasm
├── models/                 # Depth Anything V2 small（fp16 49.6MB + q8 27.3MB）
└── assets/                 # 内置示例图
```

## 诚实的边界

单视角重建本质是 **2.5D**：生成的是「正面 + 深度浮雕」，被遮挡的背面无法凭空还原，大角度旋转会露馅。完整的多视角 3D 高斯泼溅需要多角度照片 + GPU 训练（nerfstudio、Postshot、gsplat 等）。本站适合快速预览、浮雕艺术效果与 3D 素材起步。

## 致谢

- [Depth Anything V2](https://depth-anything-v2.github.io/) · onnx-community 的 ONNX 权重
- [transformers.js](https://huggingface.co/docs/transformers.js)（Hugging Face）
- [three.js](https://threejs.org) · OrbitControls
- [.splat 格式](https://github.com/antimatter15/splat)（antimatter15）· [SuperSplat](https://playcanvas.com/supersplat)

## License

MIT © 2026 ForJiang
