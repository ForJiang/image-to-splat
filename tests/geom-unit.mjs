// Node 侧几何单测：不经过浏览器，直接验证 sfm.js 的数值构件
import { __debug } from '../assets/js/sfm.js';

const W = 512, H = 384;
const f = W / (2 * Math.tan(Math.PI / 6));
const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const norm = v => { const l = Math.hypot(...v) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const lookAt = (C, target, up) => {
  const fwd = norm(sub(target, C));
  const right = norm(cross(fwd, up));
  const up2 = cross(right, fwd);
  return { R: [right[0],right[1],right[2], up2[0],up2[1],up2[2], fwd[0],fwd[1],fwd[2]], C };
};
const xform = (R, C, p) => { const d = sub(p, C); return [R[0]*d[0]+R[1]*d[1]+R[2]*d[2], R[3]*d[0]+R[4]*d[1]+R[5]*d[2], R[6]*d[0]+R[7]*d[1]+R[8]*d[2]]; };
const project = (gtv, p) => { const Xc = xform(gtv.R, gtv.C, p); if (Xc[2] <= 0.05) return null; return [f*Xc[0]/Xc[2]+256, f*Xc[1]/Xc[2]+192]; };

const g0 = lookAt([Math.sin(0)*6.5, 2, Math.cos(0)*6.5], [0,-0.1,0], [0,1,0]);
const g1 = lookAt([Math.sin(Math.PI/5)*6.5, 2, Math.cos(Math.PI/5)*6.5], [0,-0.1,0], [0,1,0]);

// 场景点
const pts3 = [];
for (let x = -3; x <= 3; x += 1) for (let y = -2; y <= 3; y += 1) for (let z = -3; z <= 3; z += 1) pts3.push([x, y, z]);
const p1 = [], p2 = [];
for (const p of pts3) { const a = project(g0, p), b = project(g1, p); if (a && b) { p1.push(a); p2.push(b); } }
console.log('GT 对应点:', p1.length);

const F = __debug.estimateFundamental(p1.slice(0, 8), p2.slice(0, 8));
console.log('F:', F ? Array.from(F).map(v => +v.toFixed(6)) : null);
if (F) {
  let res = 0;
  for (let i = 0; i < p1.length; i++) {
    const x1 = [p1[i][0], p1[i][1], 1], x2 = [p2[i][0], p2[i][1], 1];
    res += Math.abs(x2[0]*(F[0]*x1[0]+F[1]*x1[1]+F[2]) + x2[1]*(F[3]*x1[0]+F[4]*x1[1]+F[5]) + (F[6]*x1[0]+F[7]*x1[1]+F[8]));
  }
  console.log('F 代数残差均值:', (res/p1.length).toExponential(2));
}

const Karr = [f, 0, 256, 0, f, 192, 0, 0, 1];
const rel = __debug.estimateRelativeMotion(p1, p2, Karr);
console.log('相对位姿:', rel ? { inliers: rel.inliers.reduce((s,x)=>s+x,0), R: rel.R.map(v=>+v.toFixed(3)), t: rel.t.map(v=>+v.toFixed(3)) } : null);
// GT
const Bt = [g0.R[0],g0.R[3],g0.R[6], g0.R[1],g0.R[4],g0.R[7], g0.R[2],g0.R[5],g0.R[8]];
const gtR = [];
for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) gtR[i*3+j] = g1.R[i*3]*Bt[j] + g1.R[i*3+1]*Bt[3+j] + g1.R[i*3+2]*Bt[6+j];
const d = sub(g1.C, g0.C);
const gtT = [g0.R[0]*d[0]+g0.R[1]*d[1]+g0.R[2]*d[2], g0.R[3]*d[0]+g0.R[4]*d[1]+g0.R[5]*d[2], g0.R[6]*d[0]+g0.R[7]*d[1]+g0.R[8]*d[2]];
console.log('GT R:', gtR.map(v=>+v.toFixed(3)), '\nGT t:', gtT.map(v=>+v.toFixed(3)));
