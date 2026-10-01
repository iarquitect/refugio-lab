// Rhino-like views: one perspective (orbit) and three parallel views locked to their direction (pan + zoom only).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const VIEWS = {
  perspective: { label: 'Perspectiva' },
  top: { label: 'Superior', dir: [0, 0, 1], up: [0, 1, 0] },
  front: { label: 'Frontal', dir: [0, -1, 0], up: [0, 0, 1] },
  right: { label: 'Derecha', dir: [1, 0, 0], up: [0, 0, 1] }
};

export class ViewManager {
  constructor(dom, { center = new THREE.Vector3(0, 0, 2), onChange = () => {} } = {}) {
    this.dom = dom; this.center = center; this.onChange = onChange;
    this.persp = new THREE.PerspectiveCamera(38, 1, 0.1, 2000); this.persp.up.set(0, 0, 1);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 3000);
    this.aspect = 1; this.frustum = 90; this.states = {}; this.name = 'perspective'; this.camera = this.persp;
    this.controls = null; this.set('perspective', true);
  }
  get isOrtho() { return this.name !== 'perspective'; }
  setAspect(a) { this.aspect = a; this.persp.aspect = a; this.persp.updateProjectionMatrix(); this.updateOrtho(); }
  updateOrtho() { const h = this.frustum / 2, w = h * this.aspect; Object.assign(this.ortho, { left: -w, right: w, top: h, bottom: -h }); this.ortho.updateProjectionMatrix(); }
  save() {
    if (!this.controls) return;
    this.states[this.name] = { pos: this.camera.position.clone(), target: this.controls.target.clone(), zoom: this.camera.zoom };
  }
  set(name, reset = false) {
    if (!VIEWS[name]) return;
    this.save(); this.controls?.dispose();
    this.name = name; this.camera = name === 'perspective' ? this.persp : this.ortho;
    const c = new OrbitControls(this.camera, this.dom);
    c.enableDamping = name === 'perspective'; c.dampingFactor = 0.09; c.screenSpacePanning = true; c.zoomToCursor = true;
    if (name === 'perspective') {
      c.maxPolarAngle = Math.PI * 0.495; c.minDistance = 2; c.maxDistance = 400;
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    } else {
      c.enableRotate = false; c.minZoom = 0.25; c.maxZoom = 40;
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
      c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    }
    this.controls = c;
    const st = !reset && this.states[name];
    if (st) { this.camera.position.copy(st.pos); c.target.copy(st.target); this.camera.zoom = st.zoom; this.orient(); }
    else this.frame();
    this.camera.updateProjectionMatrix(); c.update();
    this.onChange(name);
  }
  orient() { const v = VIEWS[this.name]; if (v.up) this.camera.up.set(...v.up); else this.camera.up.set(0, 0, 1); }
  frame() {
    const c = this.controls, t = this.center.clone();
    if (this.name === 'perspective') {
      this.camera.up.set(0, 0, 1); const f = Math.max(1, 0.85 / this.aspect);
      this.camera.position.set(t.x + 53 * f, t.y - 70 * f, 57 * f); this.camera.zoom = 1;
    } else {
      const v = VIEWS[this.name]; this.orient();
      if (this.name !== 'top') t.z = 3;
      this.camera.position.set(t.x + v.dir[0] * 400, t.y + v.dir[1] * 400, t.z + v.dir[2] * 400);
      this.frustum = this.name === 'top' ? 80 : 46; this.updateOrtho();
      this.camera.zoom = Math.min(1, this.aspect / 0.9) ;
    }
    c.target.copy(t); this.camera.lookAt(t); this.camera.updateProjectionMatrix(); c.update();
  }
  update() { this.controls.update(); }
}
