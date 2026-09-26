// Image2Splat 主控：文件入口 → 深度推理 → 点云构建 → 交互/导出。

import { SplatViewer } from './viewer.js';
import { buildCloud, normalizeDepth, WORLD } from './splat.js';
import { exportPLY, exportSplat, exportCanvasPNG } from './exporter.js';
import { extractFrames } from './video.js';

const $ = (id) => document.getElementById(id);
const els = {
  dropzone: $('dropzone'), fileInput: $('fileInput'),
  landing: $('landing'), workspace: $('workspace'),
  deviceChip: $('deviceChip'),
  srcCanvas: $('srcCanvas'), depthCanvas: $('depthCanvas'),
  videoStrip: $('videoStrip'), frameNote: $('frameNote'),
  qualitySeg: $('qualitySeg'), qualityNote: $('qualityNote'),
  strengthRange: $('strengthRange'), strengthOut: $('strengthOut'),
  sizeRange: $('sizeRange'), sizeOut: $('sizeOut'),
  invertChk: $('invertChk'),
  exportPly: $('exportPly'), exportSplat: $('exportSplat'), exportDepth: $('exportDepth'),
  changeFileBtn: $('changeFileBtn'),
  statusText: $('statusText'), statusPill: $('statusPill'),
  autoOrbitBtn: $('autoOrbitBtn'), resetViewBtn: $('resetViewBtn'), shotBtn: $('shotBtn'),
  cloudInfo: $('cloudInfo'), toast: $('toast'),
};

const MOCK = new URLSearchParams(location.search).has('mock');
const state = {
  kind: null,            // 'image' | 'video'
  bitmap: null,          // 图片解码结果
  frames: [], selFrame: 0,
  source: null, imgData: null, depth: null, cloud: null,
  params: { quality: 512, strength: 0.45, size: 1, invert: false },
  busy: false, dirty: false, inferMs: 0,
};

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const viewer = new SplatViewer($('viewport'), { onUserOrbit: syncOrbitBtn });
viewer.setAutoRotate(!reduceMotion);
syncOrbitBtn();

/* ---------------- UI 基础 ---------------- */

function setStatus(text, busy) {
  els.statusText.textContent = text;
  els.statusPill.querySelector('.spinner').hidden = !busy;
}

let toastTimer = null;
function toast(msg, isErr = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('is-err', isErr);
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, isErr ? 5200 : 3600);
}

function syncOrbitBtn() {
  els.autoOrbitBtn.classList.toggle('is-active', viewer.autoRotate);
}

function updateDeviceChip() {
  if (MOCK) { els.deviceChip.textContent = '🧪 Mock 深度'; return; }
  els.deviceChip.textContent = ('gpu' in navigator) ? '⚡ WebGPU 就绪' : '⚙️ CPU · WASM';
}
updateDeviceChip();

/* ---------------- 深度推理封装 ---------------- */

async function estimate(canvas) {
  if (MOCK) {
    await new Promise(r => setTimeout(r, 350));
    return mockDepth(canvas);
  }
  const dm = await import('./depth.js');
  dm.setProgressHandler((p, txt) => setStatus(`加载深度模型… ${txt || Math.round(p * 100) + '%'}`, true));
  const t0 = performance.now();
  const out = await dm.estimateDepth(canvas);
  state.inferMs = performance.now() - t0;
  els.deviceChip.textContent = dm.currentDevice() === 'webgpu' ? '⚡ WebGPU 已启用' : '⚙️ CPU · WASM';
  return out;
}

// 离线开发 / 无网络自检：合成一张「中心近、下方近」的深度图
function mockDepth(canvas) {
  const w = canvas.width, h = canvas.height;
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w - 0.5, v = y / h - 0.5;
      const r2 = u * u * 1.6 + v * v * 2.4;
      data[y * w + x] = Math.exp(-r2 * 9) * 0.85 + (1 - v - 0.5) * 0.3 + 0.5;
    }
  }
  return { data, w, h };
}

/* ---------------- 输入与预处理 ---------------- */

async function imageToBitmap(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* 老浏览器回退 */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }
}

// 把 bitmap/帧画布缩放绘制到最长边 = maxSide 的工作画布
function fitCanvas(src, maxSide) {
  const sw = src.width || src.videoWidth;
  const sh = src.height || src.videoHeight;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(2, Math.round(sw * scale));
  const h = Math.max(2, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(src, 0, 0, w, h);
  return canvas;
}

async function handleFile(file) {
  if (!file) return;
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (!isImage && !isVideo) {
    toast('请选择图片或视频文件', true);
    return;
  }

  try {
    if (isImage) {
      state.kind = 'image';
      state.frames = [];
      els.videoStrip.hidden = true;
      els.frameNote.hidden = true;
      state.bitmap = await imageToBitmap(file);
      enterWorkspace();
      await runPipeline();
    } else {
      state.kind = 'video';
      enterWorkspace();
      setStatus('解析视频帧…', true);
      els.videoStrip.hidden = false;
      els.frameNote.hidden = false;
      els.videoStrip.innerHTML = '';
      state.frames = await extractFrames(file, {
        count: 16,
        onFrame: (i, n) => setStatus(`解析视频帧… ${i}/${n}`, true),
      });
      buildStrip();
      state.selFrame = state.frames.reduce(
        (best, f, i) => (f.sharp > state.frames[best].sharp ? i : best), 0);
      markStrip();
      await runPipeline();
    }
  } catch (err) {
    console.error(err);
    toast(err?.message || '处理失败，请换一个文件试试', true);
    setStatus('出错了，可重新选择文件', false);
  }
}

function enterWorkspace() {
  els.landing.hidden = true;
  els.workspace.hidden = false;
  els.exportPly.disabled = true;
  els.exportSplat.disabled = true;
  els.exportDepth.disabled = true;
}

/* ---------------- 流水线 ---------------- */

async function runPipeline() {
  if (state.busy) { state.dirty = true; return; }
  state.busy = true;
  try {
    // 1) 工作画布（颜色来源 + 推理输入，二者同分辨率）
    const src = state.kind === 'video' ? state.frames[state.selFrame].canvas : state.bitmap;
    state.source = fitCanvas(src, state.params.quality);
    state.imgData = state.source.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, state.source.width, state.source.height);
    drawThumb(els.srcCanvas, state.source);

    // 2) 深度推理
    setStatus(state.kind === 'video' ? '所选帧深度推理中…' : '深度推理中…', true);
    state.depth = await estimate(state.source);
    drawDepthPreview();

    // 3) 点云
    rebuildCloud();
  } catch (err) {
    console.error(err);
    toast(err?.message || '推理失败', true);
    setStatus('出错了', false);
  } finally {
    state.busy = false;
    if (state.dirty) { state.dirty = false; runPipeline(); }
  }
}

function rebuildCloud() {
  if (!state.depth || !state.imgData) return;
  const t0 = performance.now();
  state.cloud = buildCloud(state.imgData, state.depth, state.params);
  const buildMs = performance.now() - t0;
  viewer.setCloud(state.cloud);

  els.cloudInfo.textContent =
    `${state.cloud.count.toLocaleString('zh-CN')} 泼溅 · 推理 ${(state.inferMs / 1000).toFixed(1)}s + 重建 ${Math.round(buildMs)}ms`;
  setStatus('完成 · 拖拽旋转 / 滚轮缩放', false);
  els.exportPly.disabled = false;
  els.exportSplat.disabled = false;
  els.exportDepth.disabled = false;
}

function drawThumb(canvasEl, src) {
  canvasEl.width = src.width;
  canvasEl.height = src.height;
  canvasEl.getContext('2d').drawImage(src, 0, 0);
}

function drawDepthPreview() {
  const { w, h } = state.depth;
  const dn = normalizeDepth(state.depth, state.params.invert);
  const im = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(dn[i] * 255);
    im.data[i * 4] = v; im.data[i * 4 + 1] = v; im.data[i * 4 + 2] = v;
    im.data[i * 4 + 3] = 255;
  }
  els.depthCanvas.width = w;
  els.depthCanvas.height = h;
  els.depthCanvas.getContext('2d').putImageData(im, 0, 0);
}

/* ---------------- 视频帧条 ---------------- */

function buildStrip() {
  for (let i = 0; i < state.frames.length; i++) {
    const f = state.frames[i];
    const btn = document.createElement('button');
    btn.className = 'vf';
    btn.title = `${f.t.toFixed(1)}s · 清晰度 ${Math.round(f.sharp)}`;
    const c = document.createElement('canvas');
    c.width = 76; c.height = 48;
    c.getContext('2d').drawImage(f.canvas, 0, 0, 76, 48);
    const t = document.createElement('span');
    t.className = 'ft';
    t.textContent = f.t.toFixed(1) + 's';
    btn.append(c, t);
    btn.addEventListener('click', () => {
      if (state.selFrame === i) return;
      state.selFrame = i;
      markStrip();
      runPipeline();
    });
    els.videoStrip.appendChild(btn);
  }
}

function markStrip() {
  [...els.videoStrip.children].forEach((b, i) =>
    b.classList.toggle('is-sel', i === state.selFrame));
}

/* ---------------- 事件接线 ---------------- */

// 拖放与选择
['dragover', 'dragenter'].forEach(ev =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    if (!els.workspace.hidden) return;
    els.dropzone.classList.add('is-drag');
  }));
['dragleave', 'drop'].forEach(ev =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'drop' && !els.workspace.hidden) return;
    els.dropzone.classList.remove('is-drag');
    if (ev === 'drop') {
      const f = e.dataTransfer?.files?.[0];
      if (f) handleFile(f);
    }
  }));
els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
});
els.fileInput.addEventListener('change', () => {
  handleFile(els.fileInput.files[0]);
  els.fileInput.value = '';
});
els.changeFileBtn.addEventListener('click', () => els.fileInput.click());

// 示例
document.querySelectorAll('.sample-btn').forEach(btn =>
  btn.addEventListener('click', async () => {
    try {
      const blob = await fetch(btn.dataset.src).then(r => {
        if (!r.ok) throw new Error(r.status);
        return r.blob();
      });
      handleFile(new File([blob], btn.dataset.src, { type: 'image/jpeg' }));
    } catch {
      toast('示例加载失败：请通过 HTTP 服务访问本站（如 python3 -m http.server）', true);
    }
  }));

// 参数
els.qualitySeg.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn || btn.classList.contains('is-active')) return;
  els.qualitySeg.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('is-active'));
  btn.classList.add('is-active');
  state.params.quality = +btn.dataset.v;
  runPipeline(); // 重新推理
});

els.strengthRange.addEventListener('input', () => {
  state.params.strength = +els.strengthRange.value;
  els.strengthOut.textContent = state.params.strength.toFixed(2);
  rebuildCloud();
});
els.sizeRange.addEventListener('input', () => {
  state.params.size = +els.sizeRange.value;
  els.sizeOut.textContent = state.params.size.toFixed(2);
  rebuildCloud();
});
els.invertChk.addEventListener('change', () => {
  state.params.invert = els.invertChk.checked;
  drawDepthPreview();
  rebuildCloud();
});

// 视口工具
els.autoOrbitBtn.addEventListener('click', () => {
  viewer.setAutoRotate(!viewer.autoRotate);
  syncOrbitBtn();
});
els.resetViewBtn.addEventListener('click', () => viewer.resetView());
els.shotBtn.addEventListener('click', async () => {
  const blob = await viewer.screenshot();
  if (blob) exportCanvasPNGFrom(blob);
});
function exportCanvasPNGFrom(blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'image2splat-view.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// 导出
els.exportPly.addEventListener('click', () => {
  if (!state.cloud) return;
  exportPLY(state.cloud);
  toast('已导出 .ply 点云');
});
els.exportSplat.addEventListener('click', () => {
  if (!state.cloud) return;
  exportSplat(state.cloud);
  toast('已导出 .splat，可拖入 SuperSplat 查看');
});
els.exportDepth.addEventListener('click', () => {
  exportCanvasPNG(els.depthCanvas, `image2splat-depth-${state.depth?.w || 0}.png`);
  toast('已导出深度图');
});
