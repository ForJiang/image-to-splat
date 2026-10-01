# Image2Splat 桌面端

网页版的 Electron 桌面壳。**前端代码零分叉**：`main.js` 注册 `app://` 自定义协议，把仓库根的 `index.html` / `assets/` / `models/` 按 http 语义提供给渲染进程；原生能力（文件选择器、保存对话框、「打开方式」）通过 preload 注入的 `window.i2sDesktop` 暴露，网页版里该对象不存在，自动回退到原有链路。

## 开发

```bash
npm install     # 首次（需要 Node.js ≥ 20）
npm start       # 直接用仓库根的文件跑，方便改前端即时生效
npm run start:mock   # 合成深度图，不加载 50MB 模型
```

## 构建

```bash
npm run build       # → dist/Image2Splat.app（models/ 一并打进 .app，约 190MB）
npm run build:dmg   # → dist/Image2Splat-<version>-arm64.dmg（含 /Applications 拖拽位）
```

只配了 macOS arm64；其他平台改 `package.json` 里 `build` 脚本的 `--platform` / `--arch`。

## 说明

- `app://` 而非 `file://`：ES module 的 import、fetch、wasm 的 `WebAssembly.instantiateStreaming`、WebGPU 都需要 http 语义，`file://` 会被 CORS / opaque origin 卡死。
- MIME 表在 `main.js` 顶部：`.wasm → application/wasm`、`.js → text/javascript` 等必须显式给对。
- 模型走 `--extra-resource` 进 `Contents/Resources`，因此**打包后完全离线**；开发态（`npm start`）直接读仓库里的 `models/`。
- 未签名：本机构建可直接运行；他人下载后需 `xattr -dr com.apple.quarantine /Applications/Image2Splat.app`。要上架/分发请接开发者证书。
- 图标由 `icons/make-icon.py` 生成（纯标准库，无 PIL 依赖），改配色/几何后重跑 `python3 icons/make-icon.py` 即可。
