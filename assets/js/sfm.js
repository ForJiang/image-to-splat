// 多视角结构：纯 JS 特征提取（FAST-12 + 定向 BRIEF）与匹配 + 自实现对极几何
// （RANSAC 8 点法 → 本质矩阵 SVD 分解 → 手性检验 → DLT 三角化）+ PnP 位姿精化。
// 不用 OpenCV.js：默认构建是同步内联 wasm，会在主线程长时间冻结页面
// （内嵌 WebView 下直接把渲染进程拖死）；本实现零 wasm，逐视图 await 让出主线程。
// 单目深度只给「一张图的 2.5D」，这里交给 SfM 决定真实相机位姿，
// 再把每张图的深度融合进同一世界坐标系——得到的是可环绕的完整点云。

// 无 EXIF 内参时的通用水平视场角
const FOV_DEG = 60;
const MAX_FEATURES = 1400;
const BRIEF_PAIRS = 512; // 512 bit 描述子（比 256 bit 边际大一倍，弱纹理场景尤其明显）
const RANSAC_ITERS = 600;
const RANSAC_THRESH = 1.5; // 像素（Sampson 误差）
const MATCH_MAX_D = 260; // 512 bit 描述子允许的最大 Hamming 距离
const MATCH_RATIO = 0.9; // Lowe 比率检验阈值

/* ============ 特征检测与描述（FAST + BRIEF） ============ */

// FAST-12 圆上 16 个偏移（半径 3）
const CIRCLE = [
  [0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3],
  [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3],
];

function grayOf(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width: W, height: H } = canvas;
  const d = ctx.getImageData(0, 0, W, H).data;
  const g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }
  return { g, W, H };
}

function detectFeatures(canvas) {
  const { g, W, H } = grayOf(canvas);
  const pts = []; // [x, y, score]
  const R = 3;
  const border = 34; // 定向窗口 P=15 + BRIEF 采样半径 16 + 余量：边缘点采样越界会拿到兜底值
  const T = 12;
  for (let y = border; y < H - border; y++) {
    for (let x = border; x < W - border; x++) {
      const Ip = g[y * W + x];
      let cnt1 = 0, cnt2 = 0;
      let pass = false;
      for (let k = 0; k < 16; k++) {
        const v = g[(y + CIRCLE[k][1]) * W + x + CIRCLE[k][0]];
        if (v > Ip + T) cnt1++;
        else if (v < Ip - T) cnt2++;
        else { cnt1 = 0; cnt2 = 0; }
        if (cnt1 >= 12 || cnt2 >= 12) { pass = true; break; }
      }
      if (!pass) continue;
      // 角点响应：16 邻域对比度和
      let score = 0;
      for (let k = 0; k < 16; k++) {
        score += Math.abs(g[(y + CIRCLE[k][1]) * W + x + CIRCLE[k][0]] - Ip);
      }
      pts.push([x, y, score]);
    }
  }
  // 3x3 非极大抑制 + 取前 N
  pts.sort((a, b) => b[2] - a[2]);
  const kept = [];
  const mask = new Uint8Array(W * H);
  for (const p of pts) {
    if (kept.length >= MAX_FEATURES) break;
    const [x, y] = p;
    let ok = true;
    for (let dy = -2; dy <= 2 && ok; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (mask[(y + dy) * W + x + dx]) { ok = false; break; }
      }
    }
    if (!ok) continue;
    mask[y * W + x] = 1;
    kept.push(p);
  }
  const desc = describeAll(g, W, kept);
  return { pts: kept, desc };
}

// 预生成 BRIEF 采样点对（单位圆内（高斯分布近似：均匀盘））。
// 采样半径 16px：要覆盖「双点 cluster」的伴点间距（投影 12-14px），
// 否则描述子只看到单个点、毫无区分度（7.5px 半径下伴点在采样盘外）。
const BRIEF_P = (() => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pairs = [];
  for (let i = 0; i < BRIEF_PAIRS; i++) {
    const a = rnd() * Math.PI * 2, b = rnd() * Math.PI * 2;
    const ra = Math.sqrt(rnd()) * 16, rb = Math.sqrt(rnd()) * 16;
    pairs.push([Math.cos(a) * ra, Math.sin(a) * ra, Math.cos(b) * rb, Math.sin(b) * rb]);
  }
  return pairs;
})();

function sampleBilinear(g, W, x, y) {
  if (x < 0 || y < 0 || x >= W - 1 || y >= W - 1) return g[0]; // 越界兜底（正常不会走到）
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  return g[y0 * W + x0] * (1 - fx) * (1 - fy)
    + g[y0 * W + x0 + 1] * fx * (1 - fy)
    + g[(y0 + 1) * W + x0] * (1 - fx) * fy
    + g[(y0 + 1) * W + x0 + 1] * fx * fy;
}

function describeAll(g, W, pts) {
  const P = 15; // 方向估计窗口半径
  const out = [];
  for (const [x, y] of pts) {
    // 强度质心定向（ORB 式）
    let m01 = 0, m10 = 0;
    for (let dy = -P; dy <= P; dy++) {
      for (let dx = -P; dx <= P; dx++) {
        const v = g[(y + dy) * W + x + dx];
        m01 += v * dy;
        m10 += v * dx;
      }
    }
    const ang = Math.atan2(m01, m10);
    const c = Math.cos(ang), s = Math.sin(ang);
    // 256 bit 定向 BRIEF
    const bits = new Uint32Array(BRIEF_PAIRS / 32);
    for (let i = 0; i < BRIEF_PAIRS; i++) {
      const p = BRIEF_P[i];
      const ax = x + p[0] * c - p[1] * s;
      const ay = y + p[0] * s + p[1] * c;
      const bx = x + p[2] * c - p[3] * s;
      const by = y + p[2] * s + p[3] * c;
      if (sampleBilinear(g, W, ax, ay) > sampleBilinear(g, W, bx, by)) {
        bits[i >> 5] |= 1 << (i & 31);
      }
    }
    out.push(bits);
  }
  return out;
}

const POPCOUNT = (() => {
  const t = new Uint8Array(65536);
  for (let i = 1; i < 65536; i++) t[i] = t[i >> 1] + (i & 1);
  return t;
})();

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ^ b[i];
    d += POPCOUNT[x & 0xffff] + POPCOUNT[x >>> 16];
  }
  return d;
}

// 互相最近邻 + Lowe 比率检验 + 阈值过滤：[aIdx, bIdx, dist]
// 比率检验（d1 < 0.9·d2）把「最近和次近差不多近」的歧义对滤掉，
// 比单纯阈值更能保精度——真对典型 30-60 bit，混淆对往往在 110+ bit。
// 返回距离供调用方按匹配质量排序（RANSAC 优先从高质量匹配采样）。
function matchDescriptors(A, B) {
  if (!A.length || !B.length) return [];
  const nnAB = new Int32Array(A.length).fill(-1);
  const dAB = new Int32Array(A.length).fill(9999);
  const d2AB = new Int32Array(A.length).fill(9999);
  for (let i = 0; i < A.length; i++) {
    let bd = 9999, bd2 = 9999, bi = -1;
    for (let j = 0; j < B.length; j++) {
      const d = hamming(A[i], B[j]);
      if (d < bd) { bd2 = bd; bd = d; bi = j; }
      else if (d < bd2) bd2 = d;
    }
    dAB[i] = bd;
    d2AB[i] = bd2;
    nnAB[i] = bi;
  }
  const pairs = [];
  for (let j = 0; j < B.length; j++) {
    let bi = -1, bd = 9999, bd2 = 9999;
    for (let i = 0; i < A.length; i++) {
      const d = hamming(B[j], A[i]);
      if (d < bd) { bd2 = bd; bd = d; bi = i; }
      else if (d < bd2) bd2 = d;
    }
    if (bi < 0 || nnAB[bi] !== j) continue;
    if (dAB[bi] < MATCH_MAX_D && dAB[bi] < MATCH_RATIO * d2AB[bi] && bd < MATCH_RATIO * bd2) pairs.push([bi, j, dAB[bi]]);
  }
  return pairs;
}

/* ============ 对极几何（自实现） ============ */

// 对称矩阵 Jacobi 特征分解：A[n×n] 对称 → v[j*n+k] = 特征向量 k 的第 j 个分量
function jacobiEigen(A, n) {
  const a = Float64Array.from(A);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-18) continue;
        const app = a[p * n + p], aqq = a[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p], akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k], aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p], vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  // 排序（特征值降序），特征向量同步重排
  const idx = Array.from({ length: n }, (_, i) => i).sort((x, y) => a[y * n + y] - a[x * n + x]);
  const vecs = new Float64Array(n * n);
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) vecs[j * n + k] = v[j * n + idx[k]];
  }
  return vecs;
}

// 3x3 SVD：返回 U（u[i*3+k]）、S（降序）、V（v[i*3+k]）
function svd3(A) {
  const AtA = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = i; j < 3; j++) {
      AtA[i * 3 + j] = AtA[j * 3 + i] = A[i] * A[j] + A[3 + i] * A[3 + j] + A[6 + i] * A[6 + j];
    }
  }
  const v = jacobiEigen(AtA, 3);
  // 直接计算奇异值：σ_k = ||A·v_k||
  const S = [0, 1, 2].map(k => {
    const vx = v[0 * 3 + k], vy = v[1 * 3 + k], vz = v[2 * 3 + k];
    return Math.hypot(
      A[0] * vx + A[1] * vy + A[2] * vz,
      A[3] * vx + A[4] * vy + A[5] * vz,
      A[6] * vx + A[7] * vy + A[8] * vz);
  });
  const u = new Float64Array(9);
  for (let k = 0; k < 3; k++) {
    if (S[k] < 1e-12) {
      // σ_k ≈ 0：A·v_k 模长为 0，无法归一化出该左奇异向量（本质矩阵的 σ3 恒为 0，
      // 这条路必然走到）。u 是列存储 u[j*3+k]，用前两列叉积补正交基；
      // 千万别写成 u[k*3+j] 行主序——那会清零 U 的第 k 行，毁掉前两个奇异向量。
      if (k === 2) {
        const a = [u[0], u[3], u[6]], b = [u[1], u[4], u[7]];
        u[2] = a[1] * b[2] - a[2] * b[1];
        u[5] = a[2] * b[0] - a[0] * b[2];
        u[8] = a[0] * b[1] - a[1] * b[0];
      } else {
        u[k * 3 + k] = 1;
      }
      continue;
    }
    for (let j = 0; j < 3; j++) {
      const vx = v[0 * 3 + k], vy = v[1 * 3 + k], vz = v[2 * 3 + k];
      u[j * 3 + k] = (A[j * 3] * vx + A[j * 3 + 1] * vy + A[j * 3 + 2] * vz) / S[k];
    }
  }
  return { u, s: S, v };
}

// 8 点法（Hartley 归一化）估计 F：p1/p2 为 8 个 [x,y]
function estimateFundamental(p1, p2) {
  const n = p1.length;
  let cx1 = 0, cy1 = 0, cx2 = 0, cy2 = 0;
  for (let i = 0; i < n; i++) { cx1 += p1[i][0]; cy1 += p1[i][1]; cx2 += p2[i][0]; cy2 += p2[i][1]; }
  cx1 /= n; cy1 /= n; cx2 /= n; cy2 /= n;
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    s1 += Math.hypot(p1[i][0] - cx1, p1[i][1] - cy1);
    s2 += Math.hypot(p2[i][0] - cx2, p2[i][1] - cy2);
  }
  s1 = Math.SQRT2 * n / Math.max(s1, 1e-9);
  s2 = Math.SQRT2 * n / Math.max(s2, 1e-9);

  const M = [];
  for (let i = 0; i < n; i++) {
    const q1 = [s1 * p1[i][0] - s1 * cx1, s1 * p1[i][1] - s1 * cy1, 1];
    const q2 = [s2 * p2[i][0] - s2 * cx2, s2 * p2[i][1] - s2 * cy2, 1];
    M.push(([q2[0] * q1[0], q2[0] * q1[1], q2[0], q2[1] * q1[0], q2[1] * q1[1], q2[1], q1[0], q1[1]].concat([-1])));
  }
  // 8 点法标准解：A f = 0 的最小二乘零空间（不能固定 f33=1——
  // 真实 F 的 f33 经常接近 0，固定后 8x8 直接奇异）。用 AᵀA 最小特征向量。
  const AtA = new Float64Array(81);
  for (const r of M) {
    for (let i = 0; i < 9; i++) {
      if (r[i] === 0) continue;
      for (let j = 0; j < 9; j++) AtA[i * 9 + j] += r[i] * r[j];
    }
  }
  const v9 = jacobiEigen(AtA, 9);
  // 退化检测：共面/临界曲面配置下零空间是二维的（平面场景的 8 点法病态），
  // 最小特征向量不再唯一确定 F，RANSAC 会锁死在伪共识上。
  // 阈值 1e-9 只拒「精确退化」（次小特征值塌到机器精度）；带噪声的近平面
  // 配置（次小特征值 ~噪声²，1e-6 量级）仍保留——它们携带真实几何信息。
  const lam = [];
  for (let k = 0; k < 9; k++) {
    let s = 0;
    for (let i = 0; i < 9; i++) {
      let vi = 0;
      for (let j = 0; j < 9; j++) vi += AtA[i * 9 + j] * v9[j * 9 + k];
      s += v9[i * 9 + k] * vi;
    }
    lam.push(Math.max(0, s));
  }
  if (lam[7] < 1e-9 * lam[0]) return null;
  const F8 = Array.from({ length: 9 }, (_, i) => v9[i * 9 + 8]); // 最小特征值（降序末位）
  // 秩 2 约束
  const { u, s, v } = svd3(F8);
  const Ffix = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    Ffix[i * 3 + j] = u[i * 3] * s[0] * v[j * 3] + u[i * 3 + 1] * s[1] * v[j * 3 + 1];
  }
  // F = T2ᵀ Ffix T1
  const T1 = [s1, 0, -s1 * cx1, 0, s1, -s1 * cy1, 0, 0, 1];
  const T2 = [s2, 0, -s2 * cx2, 0, s2, -s2 * cy2, 0, 0, 1];
  const T2t = [T2[0], T2[3], T2[6], T2[1], T2[4], T2[7], T2[2], T2[5], T2[8]];
  const tmp = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    tmp[i * 3 + j] = T2t[i * 3] * Ffix[j] + T2t[i * 3 + 1] * Ffix[3 + j] + T2t[i * 3 + 2] * Ffix[6 + j];
  }
  const F = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    F[i * 3 + j] = tmp[i * 3] * T1[j] + tmp[i * 3 + 1] * T1[3 + j] + tmp[i * 3 + 2] * T1[6 + j];
  }
  return F;
}

function sampson(F, p1, p2) {
  const x1 = [p1[0], p1[1], 1], x2 = [p2[0], p2[1], 1];
  const l1 = [F[0] * x1[0] + F[1] * x1[1] + F[2], F[3] * x1[0] + F[4] * x1[1] + F[5], F[6] * x1[0] + F[7] * x1[1] + F[8]];
  const l2 = [F[0] * x2[0] + F[3] * x2[1] + F[6], F[1] * x2[0] + F[4] * x2[1] + F[7], F[2] * x2[0] + F[5] * x2[1] + F[8]];
  const a = x1[0] * l2[0] + x1[1] * l2[1] + l2[2];
  const den = l1[0] * l1[0] + l1[1] * l1[1] + l2[0] * l2[0] + l2[1] * l2[1];
  if (den < 1e-12) return 1e9;
  return Math.sqrt((2 * a * a) / den);
}

function ransacFundamental(p1, p2) {
  const n = p1.length;
  if (n < 16) return null;
  let bestF = null, bestCount = 0;
  const pick = () => {
    const s = new Set();
    // 输入已按匹配质量排序时，70% 概率只在前半（更可信的一半）里采——
    // 低精度匹配集里 8 个全内联的概率是 w⁸，偏向高质量匹配等效 PROSAC，
    // 能把每次采样的内联率从 30% 拉到 60%+，600 次迭代才够用。
    const half = Math.max(8, Math.floor(n / 2));
    const guided = bestF && bestCount >= 20 && Math.random() < 0.25;
    let guard = 0;
    while (s.size < 8 && guard++ < 200) {
      const r = n > 12 && Math.random() < 0.7 ? Math.floor(Math.random() * half) : Math.floor(Math.random() * n);
      if (guided && sampson(bestF, p1[r], p2[r]) >= RANSAC_THRESH) continue;
      s.add(r);
    }
    return s.size === 8 ? [...s] : null;
  };
  // 不设提前退出：错模型（如平面退化下的伪共识）也会达到很高的内联数，
  // 早停会让 RANSAC 停在第一个 70% 共识上而不是全局最优。600 次全跑完也很快。
  for (let it = 0; it < RANSAC_ITERS; it++) {
    const sample = pick();
    if (!sample) continue;
    const F = estimateFundamental(sample.map(i => p1[i]), sample.map(i => p2[i]));
    if (!F) continue;
    let count = 0;
    for (let i = 0; i < n; i++) if (sampson(F, p1[i], p2[i]) < RANSAC_THRESH) count++;
    if (count > bestCount) { bestCount = count; bestF = F; }
  }
  return { F: bestF, count: bestCount };
}

// E = Kᵀ·F·K，并强制共面奇异值（K 行主序 [f,0,cx; 0,f,cy; 0,0,1]）
function essentialFromF(F, K) {
  // (KᵀF)[i][j] = Σ_m K[m][i]·F[m][j]
  const KtF = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    KtF[i * 3 + j] = K[i] * F[j] + K[3 + i] * F[3 + j] + K[6 + i] * F[6 + j];
  }
  // E[i][j] = Σ_m (KᵀF)[i][m]·K[m][j]
  const E = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    E[i * 3 + j] = KtF[i * 3] * K[j] + KtF[i * 3 + 1] * K[3 + j] + KtF[i * 3 + 2] * K[6 + j];
  }
  const { u, s, v } = svd3(E);
  const s0 = (s[0] + s[1]) / 2;
  const En = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    En[i * 3 + j] = s0 * (u[i * 3] * v[j * 3] + u[i * 3 + 1] * v[j * 3 + 1]);
  }
  return En;
}

// 分解本质矩阵 → 4 个候选 {R, t}。
// 注意：E 的 σ3 恒为 0，svd3 对零奇异值的 u3 是任意回退值，不可信；
// 这里显式构造 U：u1/u2 = E·v1,2 / σ，u3 = u1 × u2（Hartley-Zisserman Th.9.19）。
function decomposeEssential(E) {
  const AtA = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = i; j < 3; j++) {
    AtA[i * 3 + j] = AtA[j * 3 + i] = E[i] * E[j] + E[3 + i] * E[3 + j] + E[6 + i] * E[6 + j];
  }
  const v = jacobiEigen(AtA, 3); // v[j*3+k]：第 k 个右奇异向量的第 j 分量
  const vk = (k) => [v[0 * 3 + k], v[1 * 3 + k], v[2 * 3 + k]];
  const s1 = norm3(apply3(E, vk(0)));
  const s2 = norm3(apply3(E, vk(1)));
  const u1 = apply3(E, vk(0)).map(x => x / (s1 || 1));
  const u2 = apply3(E, vk(1)).map(x => x / (s2 || 1));
  const u3 = cross3(u1, u2);
  // U 的列是奇异向量：U[i][k] = u_k[i]（行主序逐行拼：第 i 行 = (u1[i], u2[i], u3[i])）
  const U = [u1[0], u2[0], u3[0], u1[1], u2[1], u3[1], u1[2], u2[2], u3[2]];
  const Vt = [v[0], v[3], v[6], v[1], v[4], v[7], v[2], v[5], v[8]];
  // HZ Th.9.19 要求 U、V ∈ SO(3)。u3 = u1×u2 已保证 det U = +1；
  // 若 det V = −1，取反 v3（E = σ1·u1v1ᵗ + σ2·u2v2ᵗ 不含 v3，E 不变），
  // 这样 R = U·W·Vᵗ 自然都是真旋转。
  const det3 = (M) => M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
  if (det3(Vt) < 0) { Vt[6] = -Vt[6]; Vt[7] = -Vt[7]; Vt[8] = -Vt[8]; }
  const W = [0, -1, 0, 1, 0, 0, 0, 0, 1];
  const Wt = [0, 1, 0, -1, 0, 0, 0, 0, 1];
  const mul3 = (A, B) => {
    const C = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
    }
    return C;
  };
  const R1 = mul3(mul3(U, W), Vt);
  const R2 = mul3(mul3(U, Wt), Vt);
  const s0 = (s1 + s2) / 2;
  const out = [];
  for (const R of [R1, R2]) {
    for (const ts of [[u3[0], u3[1], u3[2]], [-u3[0], -u3[1], -u3[2]]]) {
      out.push({ R: R.slice(), t: [ts[0] * s0, ts[1] * s0, ts[2] * s0] });
    }
  }
  return out;
}

const norm3 = (v) => Math.hypot(v[0], v[1], v[2]);
const apply3 = (M, x) => [
  M[0] * x[0] + M[1] * x[1] + M[2] * x[2],
  M[3] * x[0] + M[4] * x[1] + M[5] * x[2],
  M[6] * x[0] + M[7] * x[1] + M[8] * x[2],
];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

// DLT 三角化（世界系 = 相机1 系）。固定 W=1 的 4×3 最小二乘：
// 两个视图只提供 2 行约束，齐次 4 未知数的零空间是二维的——直接取最小
// 特征向量会落进退化子空间（W 分量趋 0），解出来是垃圾。固定 W=1 后
// 4 个方程 3 个未知数，最小二乘有唯一解。
function triangulateDLT(R, t, uv1, uv2, f, cx) {
  const u1 = (uv1[0] - cx[0]) / f, v1 = (uv1[1] - cx[1]) / f;
  const u2 = (uv2[0] - cx[0]) / f, v2 = (uv2[1] - cx[1]) / f;
  // [行系数, 右端项]：视图1 的 (X,Y,Z) 与视图2 投影方程
  const rows = [
    [[-1, 0, u1], 0],
    [[0, -1, v1], 0],
    [[u2 * R[6] - R[0], u2 * R[7] - R[1], u2 * R[8] - R[2]], t[0] - u2 * t[2]],
    [[v2 * R[6] - R[3], v2 * R[7] - R[4], v2 * R[8] - R[5]], t[1] - v2 * t[2]],
  ];
  const AtA = new Float64Array(9);
  const Atb = new Array(3).fill(0);
  for (const [r, b] of rows) {
    for (let i = 0; i < 3; i++) {
      Atb[i] += r[i] * b;
      for (let m = 0; m < 3; m++) AtA[i * 3 + m] += r[i] * r[m];
    }
  }
  // 解 AtA·x = Atb：AtA 对称半正定，用特征分解求逆
  const V = jacobiEigen(AtA, 3);
  const lam = [];
  for (let k = 0; k < 3; k++) {
    let s = 0;
    for (let i = 0; i < 3; i++) {
      let vi = 0;
      for (let m = 0; m < 3; m++) vi += AtA[i * 3 + m] * V[m * 3 + k];
      s += V[i * 3 + k] * vi;
    }
    lam.push(s);
  }
  const x = new Array(3).fill(0);
  for (let k = 0; k < 3; k++) {
    if (lam[k] < 1e-12) return null;
    let c = 0;
    for (let i = 0; i < 3; i++) c += V[i * 3 + k] * Atb[i];
    c /= lam[k];
    for (let m = 0; m < 3; m++) x[m] += V[m * 3 + k] * c;
  }
  return x;
}

// 本质矩阵非线性精化：8 点法的 F 噪声经 KᵀFK + σ 平均放大后，
// 直接分解出的位姿误差约 1°——三角化点投回观测会差 5-10px。
// 这里对内联点的 Sampson 距离（归一化坐标）做几轮 Gauss-Newton，
// 每轮把 E 重新投影回本质流形（σ1=σ2、秩 2），再交给 decomposeEssential。
// 9×9 正规方程用 jacobiEigen 解（对称矩阵可对角化求逆）。
function refineEssential(E, x1s, x2s, rounds) {
  let e = Array.from(E);
  const n0 = Math.sqrt(e.reduce((s, v) => s + v * v, 0)) || 1;
  e = e.map(v => v / n0);
  const resid = (m) => {
    const out = [];
    for (let k = 0; k < x1s.length; k++) {
      const x1 = x1s[k], x2 = x2s[k];
      const l1 = [m[0] * x1[0] + m[1] * x1[1] + m[2], m[3] * x1[0] + m[4] * x1[1] + m[5]];
      const l2 = [m[0] * x2[0] + m[3] * x2[1] + m[6], m[1] * x2[0] + m[4] * x2[1] + m[7]];
      const a = x2[0] * (m[0] * x1[0] + m[1] * x1[1] + m[2])
        + x2[1] * (m[3] * x1[0] + m[4] * x1[1] + m[5])
        + (m[6] * x1[0] + m[7] * x1[1] + m[8]);
      const den = l1[0] * l1[0] + l1[1] * l1[1] + l2[0] * l2[0] + l2[1] * l2[1];
      out.push(den > 1e-12 ? a / Math.sqrt(den) : 0);
    }
    return out;
  };
  for (let it = 0; it < rounds; it++) {
    const r0 = resid(e);
    const h = 1e-7;
    const J = [];
    for (let k = 0; k < x1s.length; k++) {
      const row = new Array(9).fill(0);
      J.push(row);
    }
    for (let p = 0; p < 9; p++) {
      const ep = e.slice();
      ep[p] += h;
      const rp = resid(ep);
      for (let k = 0; k < x1s.length; k++) J[k][p] = (rp[k] - r0[k]) / h;
    }
    // 正规方程 JᵀJ Δ = −Jᵀr，用特征分解解（加 LM 阻尼保稳定）
    const JtJ = new Float64Array(81), Jtr = new Array(9).fill(0);
    for (let k = 0; k < x1s.length; k++) {
      for (let i = 0; i < 9; i++) {
        if (J[k][i] === 0) continue;
        Jtr[i] += J[k][i] * r0[k];
        for (let m = 0; m < 9; m++) JtJ[i * 9 + m] += J[k][i] * J[k][m];
      }
    }
    const lam = 1e-6 * (JtJ[0] + JtJ[10] + JtJ[20] + JtJ[30] + JtJ[40] + JtJ[50] + JtJ[60] + JtJ[70] + JtJ[80]) / 9;
    const V = jacobiEigen(JtJ, 9); // vecs[j*9+k]（注意：只返回特征向量，特征值要自己算）
    const lamK = [];
    for (let k = 0; k < 9; k++) {
      let s = 0;
      for (let i = 0; i < 9; i++) {
        let vi = 0;
        for (let m = 0; m < 9; m++) vi += JtJ[i * 9 + m] * V[m * 9 + k];
        s += V[i * 9 + k] * vi;
      }
      lamK.push(Math.max(0, s));
    }
    const delta = new Array(9).fill(0);
    for (let k = 0; k < 9; k++) {
      const lk = lamK[k] + lam;
      if (lk < 1e-12) continue;
      let c = 0;
      for (let i = 0; i < 9; i++) c += V[i * 9 + k] * (-Jtr[i]);
      c /= lk;
      for (let j = 0; j < 9; j++) delta[j] += V[j * 9 + k] * c;
    }
    let moved = 0;
    for (let p = 0; p < 9; p++) { e[p] += delta[p]; moved = Math.max(moved, Math.abs(delta[p])); }
    if (moved < 1e-10) break;
  }
  // 投影回本质流形：秩 2 + σ1=σ2
  const { u, s, v } = svd3(e);
  const s0 = (s[0] + s[1]) / 2;
  const out = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j2 = 0; j2 < 3; j2++) {
    out[i * 3 + j2] = s0 * (u[i * 3] * v[j2 * 3] + u[i * 3 + 1] * v[j2 * 3 + 1]);
  }
  return out;
}

// 由已匹配点对估计相对位姿（相机2 相对相机1）
function estimateRelativeMotion(p1, p2, Karr) {
  const r0 = ransacFundamental(p1, p2);
  if (!r0 || !r0.F || r0.count < 8) return null;
  // RANSAC 的 F 来自 8 个带噪声的匹配（8 点法特征向量条件数差），
  // 用更宽阈值收集的内联点做最小二乘重拟合，把采样噪声平掉——F 准了 E 才准。
  // 两道保险：重拟合返回 null（内联集退化）时保留旧 F；新 F 按原阈值
  // 数出的内联数不能变少，否则也保留旧 F（防止被退化子集带偏）。
  let F = r0.F;
  for (let round = 0; round < 3; round++) {
    const in1 = [], in2 = [];
    for (let i = 0; i < p1.length; i++) {
      if (sampson(F, p1[i], p2[i]) < RANSAC_THRESH * 2.5) { in1.push(p1[i]); in2.push(p2[i]); }
    }
    if (in1.length < 12) break;
    const Fn = estimateFundamental(in1, in2);
    if (!Fn) break;
    let c1 = 0, c2 = 0;
    for (let i = 0; i < p1.length; i++) {
      if (sampson(F, p1[i], p2[i]) < RANSAC_THRESH) c1++;
      if (sampson(Fn, p1[i], p2[i]) < RANSAC_THRESH) c2++;
    }
    if (c2 < c1) break;
    F = Fn;
    if (c2 === c1) break;
  }
  // 候选 F（原始 + 重拟合）× 每个 F 的 4 个 (R,t) 分解，用手性计数全局竞争。
  // 平面退化下的伪共识模型对极内联很高，但其 (R,t) 三角化后大量点落在相机
  // 后方——手性计数是比内联数更硬的判据，伪模型在这里现形。
  const Fs = F !== r0.F ? [r0.F, F] : [r0.F];
  const cxy = [Karr[2], Karr[5]]; // 主点（triangulateDLT 需要 [cx, cy] 数组）
  // 本质矩阵精化：对内联点最小化 Sampson 距离（归一化坐标），
  // 把 8 点法 + σ 平均带来的约 1° 位姿误差压到 0.1° 量级。
  const in1n = [], in2n = [];
  for (let i = 0; i < p1.length; i++) {
    if (sampson(F, p1[i], p2[i]) < RANSAC_THRESH) {
      in1n.push([(p1[i][0] - cxy[0]) / Karr[0], (p1[i][1] - cxy[1]) / Karr[0], 1]);
      in2n.push([(p2[i][0] - cxy[0]) / Karr[0], (p2[i][1] - cxy[1]) / Karr[0], 1]);
    }
  }
  const Es = [];
  for (const Fc of Fs) {
    const Ec = essentialFromF(Fc, Karr);
    if (in1n.length >= 20) Es.push([Fc, refineEssential(Ec, in1n, in2n, 5)]);
    Es.push([Fc, Ec]);
  }
  let best = null;
  for (const [Fc, Ec] of Es) {
    for (const c of decomposeEssential(Ec)) {
      let pos = 0, total = 0;
      const step = Math.max(1, Math.floor(p1.length / 80));
      for (let i = 0; i < p1.length; i += step) {
        const X = triangulateDLT(c.R, c.t, p1[i], p2[i], Karr[0], cxy);
        total++;
        if (!X || !isFinite(X[0] + X[1] + X[2]) || X[2] <= 0) continue;
        const z2 = c.R[6] * X[0] + c.R[7] * X[1] + c.R[8] * X[2] + c.t[2];
        if (z2 > 0) pos++;
      }
      if (!best || pos > best.pos) best = { R: c.R, t: c.t, pos, total, F: Fc };
    }
  }
  if (!best) return null;
  // 手性验收：真位姿能把过半采样点三角化到两个相机的前方；错模型（含伪共识）
  // 大约只有一半点在前方。判据用 0.5 而不是更严的 0.6——带噪 F 的真位姿
  // 通过率常在 55-70%，门太高会把正确但不够精确的位姿误杀。
  if (best.pos < best.total * 0.5) return null;
  const inliers = new Uint8Array(p1.length);
  for (let i = 0; i < p1.length; i++) inliers[i] = sampson(best.F, p1[i], p2[i]) < RANSAC_THRESH ? 1 : 0;
  return { R: best.R, t: best.t, inliers };
}

// 姿态约定：pose = 12 个数（行主序 R(9) + t(3)），X_cam = R * X_world + t
function identityPose() { return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]; }

function m3mul(a, b) {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return out;
}

// 复合位姿：X_cam_j = R·X_cam_i + t，X_cam_i = poseA 的映射。
// 注意平移要用「相对旋转 R」作用 poseA 的平移（R·t_A + t），
// 不能用合成旋转 R2——第一对 t_A=0 时两者相同，之后会持续漂移。
function composePose(poseA, R, t) {
  const R2 = m3mul(R, poseA.slice(0, 9));
  return [...R2,
    R[0] * poseA[9] + R[1] * poseA[10] + R[2] * poseA[11] + t[0],
    R[3] * poseA[9] + R[4] * poseA[10] + R[5] * poseA[11] + t[1],
    R[6] * poseA[9] + R[7] * poseA[10] + R[8] * poseA[11] + t[2]];
}

/**
 * 增量 SfM：相邻/隔帧匹配 → 对极几何相对位姿 → 内联点三角化登记全局轨迹 →
 * 之后的帧用「已有 3D 点 ↔ 2D 点」的最小二乘 PnP（线性 DLT）精化位姿。
 * 零第三方依赖，逐视图 await 让出主线程。
 */
export async function estimateStructure(views, onProgress) {
  const N = views.length;
  const W = views[0].width, H = views[0].height;
  const f = W / (2 * Math.tan((FOV_DEG / 2) * Math.PI / 180));
  const cx = [W / 2, H / 2];
  const Karr = [f, 0, cx[0], 0, f, cx[1], 0, 0, 1];

  onProgress?.('features', 0, N);
  const feats = [];
  for (let i = 0; i < N; i++) {
    feats.push(detectFeatures(views[i]));
    onProgress?.('features', i + 1, N);
    await Promise.resolve(); // 让出主线程
  }
  if (feats.some(x => x.pts.length < 60)) throw new Error('E_TEXTURE');

  const poses = [identityPose()];
  // trackId → { p3:[x,y,z], obs:[{v, ki}] }
  const tracks = new Map();
  // (视图, 特征号) → trackId 索引：轨迹的 key 只记首个观测视图，
  // 但按任意视图反查轨迹（尺度定标、延命轨迹）都得走这个索引。
  const trackIndex = new Map();

  for (let j = 1; j < N; j++) {
    onProgress?.('pose', j - 1, N - 1);

    let best = null;
    // 相邻位姿优先，匹配不足时回退到隔帧（甚至隔两帧）再试：
    // 视角间隔越大匹配越少也越不稳定，小步进更容易出可用对。
    const tried = [];
    const seenI = new Set();
    for (const i of [j - 1, Math.max(0, j - 2), Math.max(0, j - 3)]) {
      if (i === j || seenI.has(i)) continue;
      seenI.add(i);
      const pairs = matchDescriptors(feats[i].desc, feats[j].desc);
      if (pairs.length < 16) continue; // RANSAC 8 点法下限
      pairs.sort((a, b) => a[2] - b[2]); // 按 Hamming 距离升序：RANSAC 优先采高质量匹配
      const p1 = pairs.map(p => feats[i].pts[p[0]]);
      const p2 = pairs.map(p => feats[j].pts[p[1]]);
      const rel = estimateRelativeMotion(p1, p2, Karr);
      const inl = rel ? rel.inliers.reduce((s, x) => s + x, 0) : 0;
      if (rel && (!best || inl > best.inl)) best = { i, pairs, rel, inl };
      await Promise.resolve();
    }
    if (!best) throw new Error('E_MATCH');

    poses[j] = composePose(poses[best.i], best.rel.R, best.rel.t);

    // 尺度定标：本质矩阵只给相对平移的方向，每个 pair 的尺度是任意的。
    // 不校准的话链式合成后各视图尺度漂移（第 8 个相机距能漂到 2 倍），
    // 轨迹在世界系里互相错开、重投影误差爆炸。
    // 办法：这对匹配里若有「视图 i 中已有轨迹」的点，它们的世界坐标已知，
    // 投到 cam-i 的深度 ÷ 单位尺度三角化深度 = 尺度比，取中位数定标。
    {
      const poseI = poses[best.i];
      const samples = [];
      for (let k = 0; k < best.pairs.length; k++) {
        if (!best.rel.inliers[k]) continue;
        const ex = tracks.get(trackIndex.get(`${best.i}:${best.pairs[k][0]}`) || '');
        if (!ex) continue;
        const pr = projectToView(poseI, f, cx, ex.p3);
        if (!pr || pr.z <= 0) continue;
        const X1 = triangulateDLT(best.rel.R, best.rel.t,
          [feats[best.i].pts[best.pairs[k][0]][0], feats[best.i].pts[best.pairs[k][0]][1]],
          [feats[j].pts[best.pairs[k][1]][0], feats[j].pts[best.pairs[k][1]][1]], f, cx);
        if (!X1 || X1[2] <= 0) continue;
        const r = pr.z / X1[2];
        if (r > 1e-3 && r < 1e3) samples.push(r);
      }
      if (samples.length >= 3) {
        samples.sort((a, b) => a - b);
        const sc = samples[samples.length >> 1];
        best.rel = { R: best.rel.R, t: best.rel.t.map(v => v * sc), inliers: best.rel.inliers };
        poses[j] = composePose(poses[best.i], best.rel.R, best.rel.t);
      }
    }

    // 内联点三角化并登记轨迹（X 处于 best.i 相机系，再变换到世界系）
    const pose = poses[best.i];
    const invR = [pose[0], pose[3], pose[6], pose[1], pose[4], pose[7], pose[2], pose[5], pose[8]];
    for (let k = 0; k < best.pairs.length; k++) {
      if (!best.rel.inliers[k]) continue;
      const uvI = [feats[best.i].pts[best.pairs[k][0]][0], feats[best.i].pts[best.pairs[k][0]][1]];
      const uvJ = [feats[j].pts[best.pairs[k][1]][0], feats[j].pts[best.pairs[k][1]][1]];
      const X = triangulateDLT(best.rel.R, best.rel.t, uvI, uvJ, f, cx);
      if (!X || X[2] <= 0 || !isFinite(X[0] + X[1] + X[2]) || X[2] > 60) continue;
      // 双视图重投影校验：三角化点必须同时投回两个观测视图（针孔相机特有：
      // 2D-2D 对应的反向延长线必然相交，cast 不校验会把噪声放大成远古轨迹）。
      // 这里的 X 在 cam-i 系，best.rel 把它送到 cam-j。
      const ei = Math.hypot(f * X[0] / X[2] + cx[0] - uvI[0], f * X[1] / X[2] + cx[1] - uvI[1]);
      const Xj = [
        best.rel.R[0] * X[0] + best.rel.R[1] * X[1] + best.rel.R[2] * X[2] + best.rel.t[0],
        best.rel.R[3] * X[0] + best.rel.R[4] * X[1] + best.rel.R[5] * X[2] + best.rel.t[1],
        best.rel.R[6] * X[0] + best.rel.R[7] * X[1] + best.rel.R[8] * X[2] + best.rel.t[2],
      ];
      if (Xj[2] <= 0) continue;
      const ej = Math.hypot(f * Xj[0] / Xj[2] + cx[0] - uvJ[0], f * Xj[1] / Xj[2] + cx[1] - uvJ[1]);
      if (ei > 10 || ej > 10) continue; // 10px：匹配噪声 + 位姿误差下三角化的正常投影偏差量级
      const d = [X[0] - pose[9], X[1] - pose[10], X[2] - pose[11]];
      const p3 = [
        invR[0] * d[0] + invR[1] * d[1] + invR[2] * d[2],
        invR[3] * d[0] + invR[4] * d[1] + invR[5] * d[2],
        invR[6] * d[0] + invR[7] * d[1] + invR[8] * d[2],
      ];
      const trackId = `${best.i}:${best.pairs[k][0]}`;
      const exId = trackIndex.get(trackId);
      const ex = exId ? tracks.get(exId) : null;
      if (ex) {
        ex.obs.push({ v: j, ki: best.pairs[k][1] });
        trackIndex.set(`${j}:${best.pairs[k][1]}`, exId);
      } else {
        tracks.set(trackId, { p3, obs: [{ v: best.i, ki: best.pairs[k][0] }, { v: j, ki: best.pairs[k][1] }] });
        trackIndex.set(trackId, trackId);
        trackIndex.set(`${j}:${best.pairs[k][1]}`, trackId);
      }
    }

    refineWithPnP(poses, tracks, feats[j].pts, j, f, cx);
    await Promise.resolve();
  }

  return { poses, tracks, f, cx };
}

// 线性 DLT PnP：用 K=[f|c] 从 3x4 投影矩阵直接提取 R,t，Gram-Schmidt 正交化。
// 两道保险：新位姿必须比重投影误差更小才接受（否则 DLT 被外协带偏，反而毁掉
// 对极几何刚算出的好位姿）；位姿变化时同步变换所有轨迹的世界坐标
// （位姿是后续位姿的复合基准，轨迹坐标系必须跟着走）。
function refineWithPnP(poses, tracks, pts, j, f, cx) {
  const A = [];
  const used = [];
  tracks.forEach(t => {
    if (!t.p3) return;
    const o = t.obs.find(o => o.v === j);
    if (!o) return;
    const X = t.p3;
    const u = pts[o.ki][0], v = pts[o.ki][1];
    A.push([-X[0], -X[1], -X[2], -1, 0, 0, 0, 0, u * X[0], u * X[1], u * X[2], u]);
    A.push([0, 0, 0, 0, -X[0], -X[1], -X[2], -1, v * X[0], v * X[1], v * X[2], v]);
    used.push({ X, u, v });
  });
  if (A.length < 24) return;
  const AtA = new Float64Array(144);
  for (const r of A) {
    for (let i = 0; i < 12; i++) {
      if (r[i] === 0) continue;
      for (let k = 0; k < 12; k++) AtA[i * 12 + k] += r[i] * r[k];
    }
  }
  const v12 = jacobiEigen(AtA, 12);
  const p = [];
  for (let k = 0; k < 12; k++) p.push(v12[k * 12 + 11]); // 最小特征值（降序末位）

  // P = K[R|t] ⇒ R 行 = (Πi − ci·Π3)/f，t = (τi − ci·τ3)/f
  const row1 = p.slice(0, 4), row2 = p.slice(4, 8), row3 = p.slice(8, 12);
  const pre1 = [0, 1, 2].map(k => (row1[k] - cx[0] * row3[k]) / f);
  const pre2 = [0, 1, 2].map(k => (row2[k] - cx[1] * row3[k]) / f);
  const preScale = (Math.hypot(...pre1) + Math.hypot(...pre2) + Math.hypot(...row3)) / 3 || 1;
  const e1 = pre1.map(v => v / (Math.hypot(...pre1) || 1));
  const dot = e1[0] * pre2[0] + e1[1] * pre2[1] + e1[2] * pre2[2];
  const e2raw = [pre2[0] - dot * e1[0], pre2[1] - dot * e1[1], pre2[2] - dot * e1[2]];
  const e2 = e2raw.map(v => v / (Math.hypot(...e2raw) || 1));
  const e3 = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  const det = e1[0] * (e2[1] * e3[2] - e2[2] * e3[1])
    - e1[1] * (e2[0] * e3[2] - e2[2] * e3[0])
    + e1[2] * (e2[0] * e3[1] - e2[1] * e3[0]);
  const d = det < 0 ? -1 : 1;
  const cand = [
    e1[0] * d, e1[1], e1[2],
    e2[0], e2[1], e2[2],
    e3[0] * d, e3[1], e3[2],
    (row1[3] - cx[0] * row3[3]) / f / preScale * d,
    (row2[3] - cx[1] * row3[3]) / f / preScale,
    (row3[3] * d) / preScale,
  ];
  const errOf = (pose) => {
    let s = 0;
    for (const c of used) {
      const X = pose[0] * c.X[0] + pose[1] * c.X[1] + pose[2] * c.X[2] + pose[9];
      const Y = pose[3] * c.X[0] + pose[4] * c.X[1] + pose[5] * c.X[2] + pose[10];
      const Z = pose[6] * c.X[0] + pose[7] * c.X[1] + pose[8] * c.X[2] + pose[11];
      if (Z <= 1e-4) return Infinity;
      s += Math.hypot(f * X / Z + cx[0] - c.u, f * Y / Z + cx[1] - c.v);
    }
    return s / used.length;
  };
  if (errOf(cand) >= errOf(poses[j])) return; // 新位姿没有更好，保留对极几何的结果
  // 位姿变化 Δ = P_new ∘ P_old⁻¹，所有轨迹世界坐标跟着变换
  const old = poses[j];
  const oR = old.slice(0, 9), ot = old.slice(9);
  const oRt = [oR[0], oR[3], oR[6], oR[1], oR[4], oR[7], oR[2], oR[5], oR[8]];
  const dR = [
    cand[0] * oRt[0] + cand[1] * oRt[3] + cand[2] * oRt[6],
    cand[0] * oRt[1] + cand[1] * oRt[4] + cand[2] * oRt[7],
    cand[0] * oRt[2] + cand[1] * oRt[5] + cand[2] * oRt[8],
    cand[3] * oRt[0] + cand[4] * oRt[3] + cand[5] * oRt[6],
    cand[3] * oRt[1] + cand[4] * oRt[4] + cand[5] * oRt[7],
    cand[3] * oRt[2] + cand[4] * oRt[5] + cand[5] * oRt[8],
    cand[6] * oRt[0] + cand[7] * oRt[3] + cand[8] * oRt[6],
    cand[6] * oRt[1] + cand[7] * oRt[4] + cand[8] * oRt[7],
    cand[6] * oRt[2] + cand[7] * oRt[5] + cand[8] * oRt[8],
  ];
  const dt = [
    cand[9] - (dR[0] * ot[0] + dR[1] * ot[1] + dR[2] * ot[2]),
    cand[10] - (dR[3] * ot[0] + dR[4] * ot[1] + dR[5] * ot[2]),
    cand[11] - (dR[6] * ot[0] + dR[7] * ot[1] + dR[8] * ot[2]),
  ];
  tracks.forEach(t => {
    if (!t.p3) return;
    t.p3 = [
      dR[0] * t.p3[0] + dR[1] * t.p3[1] + dR[2] * t.p3[2] + dt[0],
      dR[3] * t.p3[0] + dR[4] * t.p3[1] + dR[5] * t.p3[2] + dt[1],
      dR[6] * t.p3[0] + dR[7] * t.p3[1] + dR[8] * t.p3[2] + dt[2],
    ];
  });
  for (let k = 0; k < 12; k++) poses[j][k] = cand[k];
}

/** 把一个 SfM 3D 点投影回视图 v 的像素坐标 */
export function projectToView(pose, f, cx, p3) {
  const X = pose[0] * p3[0] + pose[1] * p3[1] + pose[2] * p3[2] + pose[9];
  const Y = pose[3] * p3[0] + pose[4] * p3[1] + pose[5] * p3[2] + pose[10];
  const Z = pose[6] * p3[0] + pose[7] * p3[1] + pose[8] * p3[2] + pose[11];
  if (Z <= 1e-4) return null;
  return { u: f * X / Z + cx[0], v: f * Y / Z + cx[1], z: Z };
}

// 调试/回归测试导出（浏览器实测各环节数值用）
export const __debug = {
  detectFeatures, matchDescriptors, estimateRelativeMotion,
  estimateFundamental, sampson, triangulateDLT, svd3, jacobiEigen,
  decomposeEssential, essentialFromF, ransacFundamental,
  grayOf, describeAll,
};
