// Node 侧几何单测：不经过浏览器，直接验证 sfm.js 的数值构件。
// 断言版：失败退出码 1，供 CI（.github/workflows）与本地 node tests/geom-unit.mjs 使用。
//
// 确定性：estimateRelativeMotion 的 RANSAC 采样走 Math.random，先替换成固定
// 种子 LCG 再动态 import sfm.js，保证逐次运行一致；断言阈值按确定性输出留
// 5-10 倍余量（精确合成对应点下误差应在 1e-3 量级以内）。
let _seed = 20240601;
Math.random = () => {
  _seed = (_seed * 1103515245 + 12345) % 2147483648;
  return _seed / 2147483648;
};

const { __debug } = await import('../assets/js/sfm.js');

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.error(`  ✕ ${name}${detail ? ' — ' + detail : ''}`); }
}

const W = 512, H = 384;
const f = W / (2 * Math.tan(Math.PI / 6));
const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const norm = v => { const l = Math.hypot(...v) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };
const cross3 = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const lookAt = (C, target, up) => {
  const fwd = norm(sub(target, C));
  const right = norm(cross3(fwd, up));
  const up2 = cross3(right, fwd);
  return { R: [right[0],right[1],right[2], up2[0],up2[1],up2[2], fwd[0],fwd[1],fwd[2]], C };
};
const xform = (R, C, p) => { const d = sub(p, C); return [R[0]*d[0]+R[1]*d[1]+R[2]*d[2], R[3]*d[0]+R[4]*d[1]+R[5]*d[2], R[6]*d[0]+R[7]*d[1]+R[8]*d[2]]; };
const project = (gtv, p) => { const Xc = xform(gtv.R, gtv.C, p); if (Xc[2] <= 0.05) return null; return [f*Xc[0]/Xc[2]+256, f*Xc[1]/Xc[2]+192]; };

// 旋转误差角：acos((trace(R_gtᵗ·R_est) − 1)/2)，夹到 acos 定义域
function rotAngleDeg(est, gt) {
  const gtT = [gt[0], gt[3], gt[6], gt[1], gt[4], gt[7], gt[2], gt[5], gt[8]];
  const M = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    M[i*3+j] = gtT[i*3] * est[j] + gtT[i*3+1] * est[3+j] + gtT[i*3+2] * est[6+j];
  }
  const tr = M[0] + M[4] + M[8];
  const c = Math.min(1, Math.max(-1, (tr - 1) / 2));
  return Math.acos(c) * 180 / Math.PI;
}
function vecAngleDeg(a, b) {
  const na = norm(a), nb = norm(b);
  const c = Math.min(1, Math.max(-1, na[0]*nb[0] + na[1]*nb[1] + na[2]*nb[2]));
  return Math.acos(c) * 180 / Math.PI;
}

/* ---------- GT 场景：两台相机环绕同一 3D 点阵 ---------- */
const g0 = lookAt([Math.sin(0)*6.5, 2, Math.cos(0)*6.5], [0,-0.1,0], [0,1,0]);
const g1 = lookAt([Math.sin(Math.PI/5)*6.5, 2, Math.cos(Math.PI/5)*6.5], [0,-0.1,0], [0,1,0]);

const pts3 = [];
for (let x = -3; x <= 3; x += 1) for (let y = -2; y <= 3; y += 1) for (let z = -3; z <= 3; z += 1) pts3.push([x, y, z]);
const p1 = [], p2 = [];
for (const p of pts3) { const a = project(g0, p), b = project(g1, p); if (a && b) { p1.push(a); p2.push(b); } }
console.log(`GT 对应点: ${p1.length}`);
check('GT 对应点数量充足（≥250）', p1.length >= 250, `${p1.length}`);

/* ---------- F：8 点法（分散采样，避开共线退化） ---------- */
// 旧脚本取 p1.slice(0,8)：点阵序是 x 外层 z 内层，前 8 个点共线 → 8 点法退化
// （estimateFundamental 的退化检测直接返回 null）。
//
// 8 个盒角点也不行：角点落在 span{x²−9, z²−9, y²−y−6} 的三维 quadric 族上，
// 加入两个相机中心后仍有解——点集+双中心共一张临界 quadric（扭曲对歧义），
// F 本就不可唯一确定（实测 lam[7]/lam[0]≈1.6e-17），退化检测同样正确拒绝。
// 因此最小 8 点组用「7 角点 + 1 内点(1,0,1)」：打破所有候选 quadric，
// 恢复一般位置。
{
  const Fcrit = __debug.estimateFundamental(
    [[-3,-2,-3],[3,-2,-3],[-3,3,-3],[3,3,-3],[-3,-2,3],[3,-2,3],[-3,3,3],[3,3,3]]
      .map(p => pts3.find(q => q[0]===p[0] && q[1]===p[1] && q[2]===p[2]))
      .map(p => project(g0, p)),
    [[-3,-2,-3],[3,-2,-3],[-3,3,-3],[3,3,-3],[-3,-2,3],[3,-2,3],[-3,3,3],[3,3,3]]
      .map(p => pts3.find(q => q[0]===p[0] && q[1]===p[1] && q[2]===p[2]))
      .map(p => project(g1, p)));
  check('临界构型（8 角点 + 双相机共 quadric）被正确拒绝', Fcrit === null);

  const pick8 = [
    [-3,-2,-3],[3,-2,-3],[-3,3,-3],[3,3,-3],
    [-3,-2,3],[3,-2,3],[-3,3,3],   // 7 角点
    [1,0,1],                        // + 1 内点打破临界 quadric
  ].map(p => pts3.find(q => q[0]===p[0] && q[1]===p[1] && q[2]===p[2]));
  const F8 = __debug.estimateFundamental(pick8.map(p => project(g0, p)), pick8.map(p => project(g1, p)));
  check('F 估计成功（7 角点+内点，一般位置）', !!F8);
  if (F8) {
    let maxS = 0;
    for (let i = 0; i < p1.length; i++) maxS = Math.max(maxS, __debug.sampson(F8, p1[i], p2[i]));
    check('F(8点) 全对应 Sampson < 0.5px', maxS < 0.5, `max=${maxS.toExponential(2)}px`);
  }
  // 最小二乘 F（全部对应点）：验证 Hartley 归一化 → 特征向量 → 秩 2 投影 → 反归一化全链路。
  // 常数项 +1 修复后精确对应应达机器精度（修复前 0.67px，f33 被翻号）。
  const Fls = __debug.estimateFundamental(p1, p2);
  check('F 估计成功（294 点最小二乘）', !!Fls);
  if (Fls) {
    let maxS = 0;
    for (let i = 0; i < p1.length; i++) maxS = Math.max(maxS, __debug.sampson(Fls, p1[i], p2[i]));
    check('F(最小二乘) 全对应 Sampson < 0.5px', maxS < 0.5, `max=${maxS.toExponential(2)}px`);
  }
}

/* ---------- 相对位姿 vs GT ---------- */
// 位姿约定：X_cam2 = R·X_cam1 + t（t 只比方向，尺度任意）。
// GT 平移 = R1·(C0−C1)。旧脚本用 R0ᵗ·(C1−C0) 当参照——那是「基线在 cam0 系的
// 方向」，与估计量的约定不同（实测差一个旋转，y/z 分量还会变号），对照无效。
const gtR = (() => {
  const Bt = [g0.R[0],g0.R[3],g0.R[6], g0.R[1],g0.R[4],g0.R[7], g0.R[2],g0.R[5],g0.R[8]]; // R0ᵗ
  const out = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    out[i*3+j] = g1.R[i*3]*Bt[j] + g1.R[i*3+1]*Bt[3+j] + g1.R[i*3+2]*Bt[6+j];
  }
  return out;
})();
const gtT = (() => {
  const d = sub(g0.C, g1.C); // C0−C1
  return [
    g1.R[0]*d[0] + g1.R[1]*d[1] + g1.R[2]*d[2],
    g1.R[3]*d[0] + g1.R[4]*d[1] + g1.R[5]*d[2],
    g1.R[6]*d[0] + g1.R[7]*d[1] + g1.R[8]*d[2],
  ];
})();

const Karr = [f, 0, 256, 0, f, 192, 0, 0, 1];
const rel = __debug.estimateRelativeMotion(p1, p2, Karr);
check('相对位姿估计成功', !!rel);
if (rel) {
  const inl = rel.inliers.reduce((s, x) => s + x, 0);
  check('内联点覆盖率高（≥95%）', inl >= p1.length * 0.95, `${inl}/${p1.length}`);
  const rErr = rotAngleDeg(rel.R, gtR);
  check('旋转误差 < 2°', rErr < 2, `${rErr.toFixed(4)}°`);
  const tErr = vecAngleDeg(rel.t, gtT);
  check('平移方向误差 < 2°', tErr < 2, `${tErr.toFixed(4)}°`);
}

/* ---------- DLT 三角化 round-trip（用 GT 相对位姿） ---------- */
// 三角化输出处于「视图1相机系」：与 xform(g0.R, g0.C, p) 逐点对照。
{
  let worst = 0, count = 0;
  for (const p of pts3) {
    const a = project(g0, p), b = project(g1, p);
    if (!a || !b) continue;
    const X = __debug.triangulateDLT(gtR, gtT, a, b, f, [256, 192]);
    if (!X) continue;
    count++;
    const ref = xform(g0.R, g0.C, p);
    const err = Math.hypot(X[0]-ref[0], X[1]-ref[1], X[2]-ref[2]) / (Math.hypot(ref[0], ref[1], ref[2]) || 1);
    worst = Math.max(worst, err);
  }
  check(`DLT 三角化 round-trip（${count} 点）相对误差 < 1e-6`, count > 0 && worst < 1e-6, `max=${worst.toExponential(2)}`);
}

console.log(`\ngeom-unit: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
