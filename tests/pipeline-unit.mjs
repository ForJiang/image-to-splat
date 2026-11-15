// pipeline 单测：splat.js 深度归一化 + multiview.js 等距采样（Node 直跑，无 DOM 依赖）。
// 断言版：失败退出码 1，供 CI（.github/workflows）与本地 node tests/pipeline-unit.mjs 使用。
import { normalizeDepth, buildCloud } from '../assets/js/splat.js';
import { pickEvenly } from '../assets/js/multiview.js';

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.error(`  ✕ ${name}${detail ? ' — ' + detail : ''}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ---------- normalizeDepth：基础性质 ---------- */
// 主体 0..100 + 2 个极端离群值：2%~98% 分位归一化不应被离群点拖垮尺度
const mkDepth = () => {
  const data = new Float32Array(64 * 48);
  for (let i = 0; i < data.length; i++) data[i] = (i % 101);
  data[0] = 1e6; data[1] = -1e6; // 离群
  return { data, w: 64, h: 48 };
};

{
  const dn = normalizeDepth(mkDepth(), false);
  let inRange = true, monotonic = true;
  for (let i = 0; i < dn.length; i++) {
    if (!(dn[i] >= 0 && dn[i] <= 1)) inRange = false;
  }
  // 无离群的相邻值（值差 1，分位跨度内）应保持序
  for (let i = 10; i < 90; i++) {
    if (!(dn[i + 1] > dn[i])) { monotonic = false; break; }
  }
  check('normalizeDepth 输出全部落在 [0,1]', inRange);
  check('normalizeDepth 保序（越大越近）', monotonic);
  check('离群点不拖垮尺度（中段值不全被压到 0/1）',
    dn[50] > 0.4 && dn[50] < 0.6, `dn[50]=${dn[50].toFixed(3)}`);
}

/* ---------- normalizeDepth：重复调用一致（滑杆重拖场景的缓存正确性） ---------- */
// 独立参照实现（与产品算法同一定义）：用于交叉调用时核对每个对象各自的结果，
// 防止「按对象缓存」实现成全局缓存导致串扰。
function refNormalize(depth, invert) {
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
function eqArr(a, b, eps = 1e-9) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!near(a[i], b[i], eps)) return false;
  return true;
}
{
  const A = mkDepth();
  const B = mkDepth();
  for (let i = 0; i < B.data.length; i++) B.data[i] = (i * i) % 101; // 非仿射差异（分位归一化对仿射不变，整体平移/缩放区分不了对象）
  const refA = refNormalize(A, false);
  const refB = refNormalize(B, false);
  let refDiffer = false;
  for (let i = 0; i < refA.length; i++) if (!near(refA[i], refB[i], 1e-9)) { refDiffer = true; break; }
  check('参照自检：A/B 参考结果确实不同', refDiffer);

  // 交叉调用 A→B→A→B(invert)：每次都必须命中各自对象的正确结果
  const ok = eqArr(normalizeDepth(A, false), refA)
    && eqArr(normalizeDepth(B, false), refB)
    && eqArr(normalizeDepth(A, false), refA)
    && eqArr(normalizeDepth(B, true), refNormalize(B, true));
  check('交叉调用下各对象结果正确（缓存不串扰）', ok);
  const d2 = normalizeDepth(A, false);
  check('同一 depth 反复调用结果逐元素一致', eqArr(d2, refA));
}

/* ---------- normalizeDepth：invert 对调 ---------- */
{
  const depth = mkDepth();
  const up = normalizeDepth(depth, false);
  const inv = normalizeDepth(depth, true);
  let flipped = true;
  // 容差 1e-6：dn 是 Float32Array，1−v 的 float32 存储误差 ~1e-8，容差必须宽于表示精度
  for (let i = 0; i < up.length; i++) if (!near(inv[i], 1 - up[i], 1e-6)) { flipped = false; break; }
  check('invert=true 时逐元素 1−v 对调', flipped);
}

/* ---------- buildCloud：冒烟（重构归一化时的回归网） ---------- */
{
  const W = 8, H = 6;
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { px[i * 4] = i; px[i * 4 + 1] = 128; px[i * 4 + 2] = 0; px[i * 4 + 3] = i % 2 ? 255 : 0; }
  const depth = { data: new Float32Array(W * H).map((_, i) => i), w: W, h: H };
  const cloud = buildCloud({ width: W, height: H, data: px }, depth, { strength: 0.45, size: 1, invert: false });
  let finite = true, sized = true;
  for (let i = 0; i < cloud.count; i++) {
    if (!isFinite(cloud.positions[i * 3] + cloud.positions[i * 3 + 1] + cloud.positions[i * 3 + 2])) finite = false;
    if (!(cloud.sizes[i] > 0)) sized = false;
  }
  check('buildCloud 跳过透明像素', cloud.count === W * H / 2, `count=${cloud.count}（期望 ${W * H / 2}）`);
  check('buildCloud 位置全部有限、尺寸为正', finite && sized);
}

/* ---------- pickEvenly：超上限等距采样（>12 张照片场景） ---------- */
{
  check('n≤k 时全部保留原序', JSON.stringify(pickEvenly([1, 2, 3], 12)) === '[1,2,3]');
  check('n=k 时等于自身', JSON.stringify(pickEvenly([9, 8, 7], 3)) === '[9,8,7]');
  const out = pickEvenly(Array.from({ length: 24 }, (_, i) => i), 12);
  check('n>k 时返回 k 个', out.length === 12, `len=${out.length}`);
  check('等距采样含首尾两端', out[0] === 0 && out[out.length - 1] === 23,
    `first=${out[0]} last=${out[out.length - 1]}`);
  let strict = true;
  for (let i = 1; i < out.length; i++) if (out[i] <= out[i - 1]) strict = false;
  check('等距采样严格递增（无重复、保持环绕顺序）', strict, out.join(','));
  check('k=1 不产生 NaN', pickEvenly([5, 6, 7], 1).length === 1 && pickEvenly([5, 6, 7], 1)[0] === 5);
}

console.log(`\npipeline-unit: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
