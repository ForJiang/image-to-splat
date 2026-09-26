// 由「颜色 ImageData + 深度图」构建高斯点云。
// 每个像素 → 一枚带颜色的高斯圆盘：XY 按像素位置、Z 按归一化深度，
// 边缘（深度梯度大）处泼溅收缩，位置加确定性抖动以消除规则网格感。

export const WORLD = 10; // 点云宽度固定映射到 10 个世界单位

// 2%~98% 分位稳健归一化（极值离群点不拖垮整体尺度），返回 0..1，越大越近
export function normalizeDepth(depth, invert) {
  const { data, w, h } = depth;
  const n = w * h;
  const sorted = Float32Array.from(data).sort();
  const lo = sorted[Math.floor(n * 0.02)] ?? 0;
  const hi = sorted[Math.min(n - 1, Math.floor(n * 0.98))] ?? 1;
  const span = Math.max(hi - lo, 1e-6);

  const dn = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = (data[i] - lo) / span;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    dn[i] = invert ? 1 - v : v;
  }
  return dn;
}

function hash(i, k) {
  let x = (Math.imul(i + 1, 2654435761) ^ Math.imul(k, 40503)) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return x / 4294967296;
}

export function buildCloud(imgData, depth, params) {
  const { width: W, height: H, data: px } = imgData;
  const n = W * H;
  const dn = normalizeDepth(depth, params.invert);

  // 深度梯度（边缘检测）：|dx| + |dy|
  const grad = new Float32Array(n);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      grad[i] = Math.abs(dn[i + 1] - dn[i - 1]) + Math.abs(dn[i + W] - dn[i - W]);
    }
  }

  const strength = params.strength;
  const base = params.size;
  const cell = WORLD / W; // 单像素对应的世界尺寸

  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  let c = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const p = i * 4;
      if (px[p + 3] < 10) continue; // 透明像素跳过

      const h1 = hash(i, 1), h2 = hash(i, 2), h3 = hash(i, 3), h4 = hash(i, 4);
      const d = dn[i];

      positions[c * 3]     = ((x + 0.5 + (h1 - 0.5) * 0.9) / W - 0.5) * WORLD;
      positions[c * 3 + 1] = (0.5 - (y + 0.5 + (h2 - 0.5) * 0.9) / H) * WORLD;
      positions[c * 3 + 2] = (d - 0.5) * strength * WORLD + (h3 - 0.5) * cell * 0.5;

      colors[c * 3]     = px[p] / 255;
      colors[c * 3 + 1] = px[p + 1] / 255;
      colors[c * 3 + 2] = px[p + 2] / 255;

      // 尺寸：基准约 1.3 个像素宽 × 用户系数 × 随机起伏 ÷ (1 + 2×梯度，梯度封顶 1.5)
      const g = Math.min(grad[i], 1.5);
      sizes[c] = Math.max(
        cell * 1.3 * base * (0.8 + 0.45 * h4) / (1 + 2 * g),
        cell * 0.25
      );
      c++;
    }
  }

  return {
    positions: positions.subarray(0, c * 3),
    colors: colors.subarray(0, c * 3),
    sizes: sizes.subarray(0, c),
    count: c,
  };
}
