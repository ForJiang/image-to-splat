// 3D 视口：three.js Points + 自定义着色器渲染高斯泼溅。
// 不透明圆盘 + 中心提亮的径向着色，配合深度写入获得正确遮挡，无需每帧排序。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const VERT = /* glsl */`
attribute vec3 aColor;
attribute float aSize;
uniform float uScale;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float ps = aSize * uScale / max(0.1, -mv.z);
  gl_PointSize = clamp(ps, 1.0, 128.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;        // 0(圆心) → 1(圆周)
  if (r2 > 1.0) discard;
  float shade = 1.0 - 0.45 * r2;     // 径向提亮中心，近似高斯体积感
  gl_FragColor = vec4(vColor * shade, 1.0);
}
`;

export class SplatViewer {
  constructor(container, { onUserOrbit } = {}) {
    this.container = container;
    this.onUserOrbit = onUserOrbit;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#070a10');

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 150;
    this.controls.addEventListener('start', () => {
      this.setAutoRotate(false);
      this.onUserOrbit?.();
    });

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this._uniforms = { uScale: { value: 600 } };
    this._points = null;
    this._home = null;
    this.autoRotate = false;
    this._rotSpeed = 0.35; // rad/s
    this._clock = new THREE.Clock();
    this._shotResolve = null;

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);
    this._resize();
    this.renderer.setAnimationLoop(() => this._tick());
  }

  _resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // gl_PointSize 是设备像素：把世界尺寸换算成像素的比例因子
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    this._uniforms.uScale.value =
      (h * pr) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
  }

  setCloud({ positions, colors, sizes }) {
    if (this._points) {
      this.group.remove(this._points);
      this._points.geometry.dispose();
      this._points.material.dispose();
      this._points = null;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.computeBoundingBox();

    const mat = new THREE.ShaderMaterial({
      uniforms: this._uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthWrite: true,
    });
    this._points = new THREE.Points(geo, mat);
    this._points.frustumCulled = false;
    this.group.add(this._points);

    // 相机取景：按点云包围盒自适应距离
    const bb = geo.boundingBox;
    const span = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, 1);
    const dist = span / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.5;
    this._home = {
      pos: new THREE.Vector3(dist * 0.22, dist * 0.14, dist),
      target: new THREE.Vector3(0, 0, 0),
    };
    this.resetView();
  }

  resetView() {
    if (this._home) {
      this.camera.position.copy(this._home.pos);
      this.controls.target.copy(this._home.target);
    }
    this.group.rotation.set(0, 0, 0);
    this.controls.update();
  }

  setAutoRotate(v) {
    this.autoRotate = v;
  }

  // 渲染一帧后截取画布（保证像素已绘制）
  screenshot() {
    return new Promise((resolve) => { this._shotResolve = resolve; });
  }

  _tick() {
    const dt = Math.min(this._clock.getDelta(), 0.05);
    if (this.autoRotate) this.group.rotation.y += this._rotSpeed * dt;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (this._shotResolve) {
      const resolve = this._shotResolve;
      this._shotResolve = null;
      this.renderer.domElement.toBlob((b) => resolve(b), 'image/png');
    }
  }
}
