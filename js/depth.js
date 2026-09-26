// 深度估计：自托管的 transformers.js + Depth Anything V2 (ONNX)
// 模型与 ORT wasm 全部随站点分发，不请求任何第三方域名。

const MODEL_ID = 'depth-anything-v2-small';

let _lib = null;        // 动态加载的 transformers.js 模块
let _pipe = null;       // 缓存的 pipeline
let _device = null;     // 'webgpu' | 'wasm'
let _progressHandler = null;

export function hasWebGPU() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export function currentDevice() {
  return _device;
}

export function setProgressHandler(fn) {
  _progressHandler = fn;
}

// 聚合各文件的下载进度 → (0~1, "x.x / y.y MB")
const _files = new Map();
function _onModelEvent(e) {
  if (!e) return;
  if (e.status === 'progress' && e.total > 0) {
    _files.set(e.file, { l: e.loaded, t: e.total });
    let L = 0, T = 0;
    _files.forEach(v => { L += v.l; T += v.t; });
    if (T > 0 && _progressHandler) {
      _progressHandler(L / T, `${(L / 1048576).toFixed(1)} / ${(T / 1048576).toFixed(1)} MB`);
    }
  } else if (e.status === 'ready' && _progressHandler) {
    _progressHandler(1, '完成');
  }
}

async function ensurePipe() {
  if (_pipe) return _pipe;

  if (!_lib) {
    _lib = await import('../vendor/transformers/transformers.min.js');
  }
  const { pipeline, env } = _lib;

  env.allowLocalModels = true;
  env.allowRemoteModels = false; // 禁止回退到 HF 远端：站点自足
  // js/depth.js → 仓库根下 models/（兼容 GitHub Pages 子路径）
  env.localModelPath = new URL('../models/', import.meta.url).pathname;
  env.useBrowserCache = true;
  env.backends.onnx.wasm.wasmPaths = new URL('../vendor/transformers/', import.meta.url).href;

  const attempts = hasWebGPU()
    ? [['webgpu', 'fp16'], ['wasm', 'q8']]
    : [['wasm', 'q8']];

  let lastErr = null;
  for (const [device, dtype] of attempts) {
    try {
      _device = device;
      _pipe = await pipeline('depth-estimation', MODEL_ID, {
        device,
        dtype,
        progress_callback: _onModelEvent,
      });
      return _pipe;
    } catch (err) {
      console.warn(`[depth] ${device} 初始化失败，尝试下一个后端:`, err);
      lastErr = err;
      _pipe = null;
    }
  }
  throw new Error('深度模型初始化失败：' + (lastErr?.message || lastErr));
}

// 输入 canvas（与点云同分辨率），输出 { data: Float32Array 原始深度, w, h }
// 约定：data 值越大代表离相机越近（反深度），由调用方决定是否反转。
export async function estimateDepth(canvas) {
  const pipe = await ensurePipe();

  let out;
  try {
    out = await pipe(canvas);
  } catch (err) {
    // 个别浏览器对 canvas 输入支持不佳，退化为 dataURL 再试一次
    console.warn('[depth] canvas 输入失败，改用 dataURL 重试:', err);
    out = await pipe(canvas.toDataURL('image/jpeg', 0.95));
  }

  const t = out.predicted_depth;
  const dims = t.dims;
  const h = dims[dims.length - 2];
  const w = dims[dims.length - 1];
  const data = t.data instanceof Float32Array ? t.data : Float32Array.from(t.data);
  return { data, w, h };
}
