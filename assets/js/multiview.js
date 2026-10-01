// 多视图深度融合：每张图单独跑深度估计，用 SfM 三角化的点把「单目深度的
// 未知尺度」对齐到真实度量，再把所有视角的像素抬升到同一世界坐标系，
// 体素哈希去重融合成一枚完整可环绕的高斯点云。

import { estimateStructure, projectToView } from './sfm.js';
import { normalizeDepth } from './splat.js';

const MAX_VIEWS = 12;
const MAX_SPLATS = 1200000;

export async function buildMultiViewCloud(bitmaps, params, onProgress) {
  // 1) 视图降采样到最长边 ≤512（特征匹配与颜色同一来源）
  const views = bitmaps.slice(0, MAX_VIEWS).map(b => fitCanvas(b, params.quality));
  const N = views.length;

  // 2) SfM：相机位姿 + 稀疏种子点
  onProgress?.('status', 'sfm.features', { i: 0, n: N });
  const { poses, tracks, f, cx } = await estimateStructure(views, (stage, i, n) => {
    onProgress?.('status', `sfm.${stage}`, { i, n });
  });

  // 体素尺寸：用种子点的深度中位数换算「每像素对应的世界长度」，×1.5 去重
  const zs = [];
  tracks.forEach(t => { if (t.p3) zs.push(t.p3[2]); });
  zs.sort((a, b) => a - b);
  const medianZ = zs.length ? zs[zs.length >> 1] : 1;
  const voxel = Math.max(medianZ / f * 1.5, 1e-4);

  const depthMod = await import('./depth.js');
  const voxelCells = new Map(); // 哈希键 -> 累积体素
  let usedViews = 0;

  // 3) 逐视图深度 + SfM 尺度对齐 + 抬升融合
  for (let v = 0; v < N; v++) {
    onProgress?.('status', 'sfm.depth', { i: v + 1, n: N });
    onProgress?.('progress', v / N);

    const depth = await depthMod.estimateDepth(views[v]);
    const dn = normalizeDepth(depth, params.invert);
    const W = views[v].width, H = views[v].height;

    // 深度梯度（边缘泼溅收缩用与单图模式一致的思路）
    const grad = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        grad[i] = Math.min(Math.abs(dn[i + 1] - dn[i - 1]) + Math.abs(dn[i + W] - dn[i - W]), 1.5);
      }
    }

    // 3a) 尺度对齐：投影到本视图的种子点，z_proj / dn 比值取中位数
    const ratios = [];
    tracks.forEach(t => {
      if (!t.p3) return;
      const o = t.obs.find(o => o.v === v);
      if (!o) return;
      const proj = projectToView(poses[v], f, cx, t.p3);
      if (!proj) return;
      const px = Math.round(proj.u), py = Math.round(proj.v);
      if (px < 1 || py < 1 || px >= W - 1 || py >= H - 1) return;
      const dm = dn[py * W + px];
      if (dm < 0.03) return;
      ratios.push(proj.z / dm);
    });
    if (ratios.length < 12) continue; // 该视角对齐失败，跳过
    ratios.sort((a, b) => a - b);
    const scale = ratios[ratios.length >> 1];
    usedViews++;

    // 3b) 抬升每个像素：X_cam = d·(ray)，X_world = Rᵀ(X_cam − t)
    const img = views[v].getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, W, H).data;
    const pose = poses[v];
    const invR = [pose[0], pose[3], pose[6], pose[1], pose[4], pose[7], pose[2], pose[5], pose[8]]; // Rᵀ 行主序

    for (let y = 0; y < H; y++) {
      const yn = (y + 0.5 - cx[1]) / f;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (img[i * 4 + 3] < 10) continue;
        const d = scale * dn[i];
        if (d <= 0) continue;
        const xn = (x + 0.5 - cx[0]) / f;
        const dx = xn * d - pose[9], dy = yn * d - pose[10], dz = d - pose[11];
        const Xw = invR[0] * dx + invR[1] * dy + invR[2] * dz;
        const Yw = invR[3] * dx + invR[4] * dy + invR[5] * dz;
        const Zw = invR[6] * dx + invR[7] * dy + invR[8] * dz;

        // 空间哈希去重：多视角重叠区颜色自动平均
        const key = (Math.round(Xw / voxel) * 73856093) ^ (Math.round(Yw / voxel) * 19349663) ^ (Math.round(Zw / voxel) * 83492791);
        let cell = voxelCells.get(key);
        if (!cell) {
          // 注意：g（绿）和 gd（梯度）必须是两个字段——写成同名键会互相污染
          cell = { x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, w: 0, n: 0, gd: 0 };
          voxelCells.set(key, cell);
        }
        cell.x += Xw; cell.y += Yw; cell.z += Zw;
        cell.r += img[i * 4]; cell.g += img[i * 4 + 1]; cell.b += img[i * 4 + 2];
        cell.w += 1; cell.n += 1; cell.gd += grad[i];
      }
    }
  }

  onProgress?.('progress', 1);
  if (!voxelCells.size || usedViews === 0) throw new Error('E_EMPTY');

  // 4) 归一化到 10 单位宽度、几何中心归零（与单图模式一致，视口取景通用）
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9;
  voxelCells.forEach(c => {
    const x = c.x / c.w, y = c.y / c.w, z = c.z / c.w;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  });
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-3);
  const s = 10 / span;
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2, mz = (minZ + maxZ) / 2;

  const stride = Math.ceil(voxelCells.size / MAX_SPLATS);
  const total = Math.min(voxelCells.size, MAX_SPLATS);
  const positions = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const sizes = new Float32Array(total);

  const cellWorld = 10 / Math.max(views[0].width, 1);
  let k = 0, seen = 0;
  voxelCells.forEach(c => {
    if (seen++ % stride !== 0 || k >= total) return;
    const o = k * 3;
    positions[o] = (c.x / c.w - mx) * s;
    positions[o + 1] = (c.y / c.w - my) * s;
    positions[o + 2] = (c.z / c.w - mz) * s;
    colors[o] = c.r / c.n / 255;
    colors[o + 1] = c.g / c.n / 255;
    colors[o + 2] = c.b / c.n / 255;
    const avgGrad = c.gd / c.n;
    const jitter = 0.75 + 0.5 * ((k * 2654435761) % 997) / 997;
    sizes[k] = Math.max(cellWorld * params.size * jitter / (1 + 2.5 * avgGrad), cellWorld * 0.25);
    k++;
  });

  return { positions, colors, sizes, count: k, viewCount: usedViews };
}

function fitCanvas(src, maxSide) {
  const sw = src.width || src.videoWidth;
  const sh = src.height || src.videoHeight;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(sw * scale));
  canvas.height = Math.max(2, Math.round(sh * scale));
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}
