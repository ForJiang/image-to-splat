// Image2Splat 主控：文件入口 → 深度推理 → 点云构建 → 交互/导出。

import { buildCloud, normalizeDepth } from './splat.js';
import { exportPLY, exportSplat, exportCanvasPNG } from './exporter.js';
import { extractFrames } from './video.js';
import { buildMultiViewCloud } from './multiview.js';
import { startWaveBackground } from './wave-bg.js';
import { revealAll } from './reveal.js';
import { t, applyI18n, detectLang, setLang, getLang } from './i18n.js';

const $ = (id) => document.getElementById(id);
const els = {
  langBtn: $('langBtn'),
  dropzone: $('dropzone'), fileInput: $('fileInput'),
  optQuality: $('optQuality'), optStrength: $('optStrength'), optStrengthVal: $('optStrengthVal'),
  optSize: $('optSize'), optSizeVal: $('optSizeVal'), optInvert: $('optInvert'),
  rebuildBtn: $('rebuildBtn'), exportPly: $('exportPly'), exportSplat: $('exportSplat'), exportDepth: $('exportDepth'),
  progressWrap: $('progressWrap'), progressBar: $('progressBar'), progressText: $('progressText'),
  sourceHead: $('sourceHead'), sourceCount: $('sourceCount'),
  thumbs: $('thumbs'), srcCanvas: $('srcCanvas'), depthCanvas: $('depthCanvas'),
  videoStrip: $('videoStrip'), frameNote: $('frameNote'), samplesRow: $('samplesRow'),
  viewsPanel: $('viewsPanel'), viewsList: $('viewsList'), viewsCount: $('viewsCount'),
  viewsNote: $('viewsNote'), mvBuildBtn: $('mvBuildBtn'), viewsClearBtn: $('viewsClearBtn'),
  statusText: $('statusText'), cloudCount: $('cloudCount'),
  orbitBtn: $('orbitBtn'), resetBtn: $('resetBtn'), shotBtn: $('shotBtn'),
  viewport: $('viewport'),
  summary: $('summary'), statSplats: $('statSplats'), statInfer: $('statInfer'), statBuild: $('statBuild'),
  statSplatsL: $('statSplatsL'), statInferL: $('statInferL'), statBuildL: $('statBuildL'),
  toasts: $('toasts'),
};

const MOCK = new URLSearchParams(location.search).has('mock');
const state = {
  mode: 'single',        // 'single' | 'multi'
  kind: null,            // 单图模式：'image' | 'video'
  mvBitmaps: [],         // 多图模式：解码后的位图
  bitmap: null,
  frames: [], selFrame: 0,
  source: null, imgData: null, depth: null, cloud: null,
  params: { quality: 512, strength: 0.45, size: 1, invert: false },
  busy: false, dirty: false, inferMs: 0,
};

/* ---------------- 波场背景 / 入场动画 / 双语 ---------------- */

startWaveBackground($('bgCanvas'));

function syncLangBtn() {
  els.langBtn.textContent = t('lang.btn');
}
setLang(detectLang());
applyI18n();
syncLangBtn();
// 桌面端模型随应用打包，把「首用需下载」文案换成离线版（改 data-i18n 键，语言切换后仍正确）
if (window.i2sDesktop?.isDesktop) {
  const sub = document.querySelector('[data-i18n="drop.sub"]');
  if (sub) { sub.setAttribute('data-i18n', 'drop.sub.desktop'); sub.textContent = t('drop.sub.desktop'); }
}

els.langBtn.addEventListener('click', () => {
  setLang(getLang() === 'zh' ? 'en' : 'zh');
  applyI18n();
  syncLangBtn();
  syncStatsLabels();
  renderViews();
  toast(t('lang.switched'));
});

/* ---------------- UI 基础 ---------------- */

function setStatus(text) {
  els.statusText.textContent = text;
}

function toast(msg, isErr = false) {
  const div = document.createElement('div');
  div.className = 'toast' + (isErr ? ' is-err' : '');
  // cleaner 约定：成功 ✓ / 失败 ✕ 前缀（词典里已带 ✓ 的不再重复）
  div.textContent = (isErr ? '✕' : msg.startsWith('✓') ? '' : '✓') + msg.replace(/^✓\s*/, '');
  els.toasts.appendChild(div);
  setTimeout(() => div.remove(), isErr ? 5200 : 3600);
}

function syncOrbitBtn() {
  if (!viewer) return;
  els.orbitBtn.classList.toggle('is-active', viewer.autoRotate);
  els.orbitBtn.setAttribute('aria-pressed', String(viewer.autoRotate));
}

// 统计卡标签随模式/语言切换：多图模式后两张是「视图数 / 总耗时」
function syncStatsLabels() {
  const multi = state.mode === 'multi';
  els.statSplatsL.textContent = t('summary.splats');
  els.statInferL.textContent = multi ? t('summary.views') : t('summary.infer');
  els.statBuildL.textContent = multi ? t('summary.elapsed') : t('summary.build');
}

/* ---------------- 3D 视口（懒加载：three.js 不进首屏关键路径） ---------------- */

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let viewer = null;

async function ensureViewer() {
  if (viewer) return viewer;
  // viewer.js 静态依赖 three.js（1.3MB）：拖文件前不需要它，动态加载保证首屏只下轻量模块
  const { SplatViewer } = await import('./viewer.js');
  viewer = new SplatViewer(els.viewport, { onUserOrbit: syncOrbitBtn });
  viewer.setAutoRotate(!reduceMotion);
  syncOrbitBtn();
  return viewer;
}

els.orbitBtn.addEventListener('click', async () => {
  const v = await ensureViewer();
  v.setAutoRotate(!v.autoRotate);
  syncOrbitBtn();
});
els.resetBtn.addEventListener('click', async () => {
  (await ensureViewer()).resetView();
});
els.shotBtn.addEventListener('click', async () => {
  const blob = await (await ensureViewer()).screenshot();
  if (!blob) return;
  downloadBlob(blob, 'image2splat-view.png');
  toast(exportToast('toast.shotDownloaded'));
});

/* ---------------- 深度推理封装 ---------------- */

async function estimate(canvas) {
  if (MOCK) {
    await new Promise(r => setTimeout(r, 350));
    return mockDepth(canvas);
  }
  const dm = await import('./depth.js');
  dm.setProgressHandler((p) => {
    els.progressWrap.hidden = false;
    els.progressBar.style.width = `${Math.round(p * 100)}%`;
    els.progressText.textContent = `${Math.round(p * 100)}%`;
    setStatus(t('status.model', { pct: Math.round(p * 100) + '%' }));
  });
  const t0 = performance.now();
  const out = await dm.estimateDepth(canvas);
  state.inferMs = performance.now() - t0;
  els.progressWrap.hidden = true;
  return out;
}

// 离线开发 / 自检：合成一张「中心近、下方近」的深度图（?mock=1）
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
  // willReadFrequently：软件光栅，理由同 multiview.fitCanvas——喂深度推理的像素必须确定
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, w, h);
  return canvas;
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const images = files.filter(f => f.type.startsWith('image/'));
  const nonImages = files.length - images.length;

  // 两张及以上图片 → 多视角完整重建路径；其余沿用单文件链路
  if (images.length >= 2 && !nonImages) {
    try {
      state.mvBitmaps = await Promise.all(images.map(imageToBitmap));
      state.mode = 'multi';
      els.videoStrip.hidden = true;
      els.frameNote.hidden = true;
      els.sourceHead.hidden = true;
      els.thumbs.hidden = true;
      els.samplesRow.hidden = true;
      els.viewsPanel.hidden = false;
      renderViews();
      revealAll();
    } catch (err) {
      console.error(err);
      toast(t('error.pipeline'), true);
    }
    return;
  }
  handleFile(files[0]);
}

async function handleFile(file) {
  if (!file) return;
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (!isImage && !isVideo) {
    toast(t('toast.unsupported'), true);
    return;
  }

  try {
    state.mode = 'single';
    els.viewsPanel.hidden = true;
    if (isImage) {
      state.kind = 'image';
      state.frames = [];
      els.videoStrip.hidden = true;
      els.frameNote.hidden = true;
      state.bitmap = await imageToBitmap(file);
      await runPipeline();
    } else {
      state.kind = 'video';
      setStatus(t('status.parsing', { i: 0, n: 16 }));
      els.videoStrip.hidden = false;
      els.frameNote.hidden = false;
      els.videoStrip.innerHTML = '';
      state.frames = await extractFrames(file, {
        count: 16,
        onFrame: (i, n) => setStatus(t('status.parsing', { i, n })),
      });
      buildStrip();
      state.selFrame = state.frames.reduce(
        (best, f, i) => (f.sharp > state.frames[best].sharp ? i : best), 0);
      markStrip();
      await runPipeline();
    }
    els.samplesRow.hidden = true;
  } catch (err) {
    console.error(err);
    toast(err?.message === 'E_VIDEO' ? t('error.video') : (err?.message || t('error.pipeline')), true);
    setStatus(t('status.error'));
  }
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

    // 2) 深度推理（视口模块与推理并行下载，不相互阻塞）
    const viewerReady = ensureViewer();
    setStatus(t('status.infer'));
    state.depth = await estimate(state.source);
    drawDepthPreview();
    await viewerReady;

    // 3) 点云
    rebuildCloud();
    els.sourceHead.hidden = false;
    els.thumbs.hidden = false;
    els.sourceCount.textContent = `${state.source.width}×${state.source.height}`;
    els.rebuildBtn.disabled = false;
    els.exportPly.disabled = false;
    els.exportSplat.disabled = false;
    els.exportDepth.disabled = false;
    els.summary.hidden = false;
    revealAll();
  } catch (err) {
    console.error(err);
    toast(err?.message === 'E_VIDEO' ? t('error.video') : (err?.message || t('error.pipeline')), true);
    setStatus(t('status.error'));
  } finally {
    state.busy = false;
    if (state.dirty) { state.dirty = false; runPipeline(); }
  }
}

function rebuildCloud() {
  if (!state.depth || !state.imgData || !viewer) return;
  const t0 = performance.now();
  state.cloud = buildCloud(state.imgData, state.depth, state.params);
  const buildMs = performance.now() - t0;
  viewer.setCloud(state.cloud);

  els.cloudCount.textContent = state.cloud.count.toLocaleString();
  els.statSplats.textContent = state.cloud.count.toLocaleString();
  els.statInfer.textContent = `${(state.inferMs / 1000).toFixed(1)}s`;
  els.statBuild.textContent = `${Math.round(buildMs)}ms`;
  state.mode = 'single';
  syncStatsLabels();
  setStatus(t('status.done'));
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
    btn.title = `${f.t.toFixed(1)}s`;
    const c = document.createElement('canvas');
    c.width = 76; c.height = 48;
    c.getContext('2d').drawImage(f.canvas, 0, 0, 76, 48);
    const time = document.createElement('span');
    time.className = 'ft';
    time.textContent = f.t.toFixed(1) + 's';
    btn.append(c, time);
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

/* ---------------- 多视角：视图列表与重建 ---------------- */

function renderViews() {
  els.viewsList.innerHTML = '';
  state.mvBitmaps.forEach((bm, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'vf';
    const c = document.createElement('canvas');
    c.width = 88; c.height = 56;
    const s = Math.max(88 / bm.width, 56 / bm.height);
    c.getContext('2d').drawImage(bm, (88 - bm.width * s) / 2, (56 - bm.height * s) / 2, bm.width * s, bm.height * s);

    const idx = document.createElement('span');
    idx.className = 'ft';
    idx.textContent = `#${i + 1}`;

    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.type = 'button';
    rm.textContent = '×';
    rm.title = t('views.rm');
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      state.mvBitmaps.splice(i, 1);
      renderViews();
    });

    wrap.append(c, idx, rm);
    els.viewsList.appendChild(wrap);
  });

  els.viewsCount.textContent = t('views.counted', { n: state.mvBitmaps.length });
  els.viewsNote.textContent = state.mvBitmaps.length > 12 ? t('views.tooMany') : t('views.hint');
  els.mvBuildBtn.disabled = state.mvBitmaps.length < 2;
}

els.viewsClearBtn.addEventListener('click', () => {
  state.mvBitmaps = [];
  els.viewsPanel.hidden = true;
  els.viewsList.innerHTML = '';
});

const MV_ERRORS = {
  E_TEXTURE: () => t('views.err.texture'),
  E_MATCH: () => t('views.err.match'),
  E_EMPTY: () => t('views.err.empty'),
};

els.mvBuildBtn.addEventListener('click', async () => {
  if (state.mvBitmaps.length < 2 || state.busy) return;
  state.busy = true;
  const t0 = performance.now();
  els.exportPly.disabled = true;
  els.exportSplat.disabled = true;
  els.exportDepth.disabled = true;
  try {
    // 深度模型与 multiview 共用同一模块实例，提前挂上下载进度
    const dm = await import('./depth.js');
    dm.setProgressHandler((p) => {
      els.progressWrap.hidden = false;
      els.progressBar.style.width = `${Math.round(p * 100)}%`;
      els.progressText.textContent = `${Math.round(p * 100)}%`;
    });

    els.mvBuildBtn.textContent = t('views.building');
    const cloud = await buildMultiViewCloud(state.mvBitmaps, state.params, (kind, key, vars) => {
      // 约定：onProgress(kind, ...)——'status' 带 (key, vars)，'progress' 带分数
      if (kind === 'progress') {
        els.progressWrap.hidden = false;
        els.progressBar.style.width = `${Math.round(key * 100)}%`;
        els.progressText.textContent = `${Math.round(key * 100)}%`;
      } else {
        setStatus(t(key, vars));
      }
    });
    els.progressWrap.hidden = true;

    const v = await ensureViewer();
    v.setCloud(cloud);
    state.cloud = cloud;
    state.mode = 'multi';

    els.cloudCount.textContent = `${cloud.count.toLocaleString()} · ${cloud.viewCount} ${t('summary.views')}`;
    els.statSplats.textContent = cloud.count.toLocaleString();
    els.statInfer.textContent = String(cloud.viewCount);
    els.statBuild.textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
    syncStatsLabels();

    setStatus(t('status.done'));
    els.exportPly.disabled = false;
    els.exportSplat.disabled = false;
    els.exportDepth.disabled = false;
    els.summary.hidden = false;
    revealAll();
  } catch (err) {
    console.error(err);
    els.progressWrap.hidden = true;
    const map = MV_ERRORS[err?.message];
    toast(map ? map() : (err?.message || t('error.pipeline')), true);
    setStatus(t('status.error'));
  } finally {
    state.busy = false;
    els.mvBuildBtn.textContent = t('views.build');
  }
});

/* ---------------- 导出 ---------------- */

// 桌面端走系统保存对话框（exporter.saveAs 已内置该判断），话术随之下沉
function exportToast(key) {
  return t(window.i2sDesktop?.saveBlob ? 'toast.savedLocal' : key);
}

async function downloadBlob(blob, filename) {
  const dk = window.i2sDesktop;
  if (dk?.saveBlob) {
    await dk.saveBlob(blob, filename);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

els.exportPly.addEventListener('click', () => {
  if (!state.cloud) { toast(t('toast.needFirst'), true); return; }
  exportPLY(state.cloud, `image2splat-${state.cloud.count}pts.ply`);
  toast(exportToast('toast.plyDownloaded'));
});
els.exportSplat.addEventListener('click', () => {
  if (!state.cloud) { toast(t('toast.needFirst'), true); return; }
  exportSplat(state.cloud, `image2splat-${state.cloud.count}.splat`);
  toast(exportToast('toast.splatDownloaded'));
});
els.exportDepth.addEventListener('click', () => {
  if (!state.depth) { toast(t('toast.needFirst'), true); return; }
  exportCanvasPNG(els.depthCanvas, `image2splat-depth-${state.depth.w}.png`);
  toast(exportToast('toast.depthDownloaded'));
});
els.rebuildBtn.addEventListener('click', () => runPipeline());

/* ---------------- 事件接线 ---------------- */

// 拖放与选择
['dragover', 'dragenter'].forEach(ev =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('drag');
  }));
['dragleave', 'drop'].forEach(ev =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('drag');
    if (ev === 'drop') {
      const files = e.dataTransfer?.files;
      if (files?.length) handleFiles(files);
    }
  }));
els.dropzone.addEventListener('click', async () => {
  // 桌面端：点击投递区 = 系统文件选择器（图片/视频混合多选）
  const dk = window.i2sDesktop;
  if (dk?.openMedia) {
    const files = await dk.openMedia();
    if (files.length) handleFiles(files);
    return;
  }
  els.fileInput.click();
});
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.dropzone.click(); }
});
els.fileInput.addEventListener('change', () => {
  handleFiles(els.fileInput.files);
  els.fileInput.value = '';
});
// 桌面端「用 Image2Splat 打开」：Finder 右键 / open -a 传入的文件汇入同一入口
window.i2sDesktop?.onOpenFiles?.((files) => { if (files.length) handleFiles(files); });

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
      toast(t('toast.sampleFailed'), true);
    }
  }));

// 参数
els.optQuality.addEventListener('change', () => {
  state.params.quality = +els.optQuality.value;
  runPipeline(); // 重新推理
});
els.optStrength.addEventListener('input', () => {
  state.params.strength = +els.optStrength.value;
  els.optStrengthVal.textContent = state.params.strength.toFixed(2);
  rebuildCloud();
});
els.optSize.addEventListener('input', () => {
  state.params.size = +els.optSize.value;
  els.optSizeVal.textContent = state.params.size.toFixed(2);
  rebuildCloud();
});
els.optInvert.addEventListener('change', () => {
  state.params.invert = els.optInvert.value === 'on';
  drawDepthPreview();
  rebuildCloud();
});

setStatus(t('status.idle'));
revealAll();
// 视口预热：拖文件时 three.js 已在下载或就绪；只看不用的访客不花这笔流量。
// 延迟 3 秒或首次指针交互（谁先到谁触发），与推理时的并行预载互不重复。
let warmed = false;
const warm = async () => {
  if (warmed) return;
  warmed = true;
  await new Promise(r => setTimeout(r, 3000));
  ensureViewer();
};
warm();
window.addEventListener('pointerdown', warm, { once: true });
