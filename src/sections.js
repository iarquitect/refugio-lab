// Section planes: a horizontal plan cut and a vertical cut. Clipping on the GPU, cut outlines computed on the CPU.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export class Sections {
  constructor(scene) {
    this.plan = { enabled: false, z: 1.2 };
    this.cut = { enabled: false, angle: 0, offset: 0, flip: false };
    this.planPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1.2);
    this.cutPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
    this.group = new THREE.Group(); scene.add(this.group);
    this.material = new LineMaterial({ color: 0x151515, linewidth: 2.6, worldUnits: false, depthTest: true });
    this.terrainMaterial = new LineMaterial({ color: 0x4a4a46, linewidth: 1.8, worldUnits: false });
    this.lines = null; this.terrainLines = null; this.crop = null; this.frames = new THREE.Group(); this.group.add(this.frames);
  }
  setResolution(w, h) { this.material.resolution.set(w, h); this.terrainMaterial.resolution.set(w, h); }
  /** Planes for building materials. */
  buildingPlanes() { const p = []; if (this.plan.enabled) p.push(this.planPlane); if (this.cut.enabled) p.push(this.cutPlane); return p; }
  terrainPlanes() { const p = this.cut.enabled ? [this.cutPlane] : []; if (this.crop) p.push(...this.crop); return p; }
  update() {
    this.planPlane.constant = this.plan.z;
    const a = THREE.MathUtils.degToRad(this.cut.angle), n = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
    if (this.cut.flip) n.negate();
    // Keep points where n·p + c >= 0. Offset is measured along the unflipped normal.
    this.cutPlane.normal.copy(n); this.cutPlane.constant = (this.cut.flip ? 1 : -1) * this.cut.offset;
  }
  /** meshes: THREE.Mesh list of building elements; terrain: THREE.Mesh. */
  rebuild(meshes, terrain, extent = 60) {
    this.update();
    for (const o of [this.lines, this.terrainLines]) if (o) { this.group.remove(o); o.geometry.dispose(); }
    this.lines = this.terrainLines = null;
    this.frames.clear();
    const planes = this.buildingPlanes();
    const segs = [];
    for (const plane of planes) {
      const others = planes.filter(p => p !== plane);
      for (const m of meshes) collect(m, plane, others, segs);
    }
    if (segs.length) { const g = new LineSegmentsGeometry().setPositions(segs); this.lines = new LineSegments2(g, this.material); this.lines.renderOrder = 5; this.group.add(this.lines); }
    if (terrain && (this.cut.enabled || this.crop)) {
      const ts = [], tp = this.terrainPlanes();
      for (const pl of tp) collect(terrain, pl, tp.filter(q => q !== pl), ts, 0.03);
      if (ts.length) { const g = new LineSegmentsGeometry().setPositions(ts); this.terrainLines = new LineSegments2(g, this.terrainMaterial); this.group.add(this.terrainLines); }
    }
    // Faint frames that show where each plane is.
    const frameMat = new THREE.LineDashedMaterial({ color: 0x2f6f9f, dashSize: 0.8, gapSize: 0.5, transparent: true, opacity: 0.55 });
    if (this.plan.enabled) {
      const e = extent, z = this.plan.z, pts = [[-e, -e], [e, -e], [e, e], [-e, e], [-e, -e]].map(p => new THREE.Vector3(p[0], p[1], z));
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), frameMat); l.computeLineDistances(); this.frames.add(l);
    }
    if (this.cut.enabled) {
      const n = this.cutPlane.normal, o = n.clone().multiplyScalar(-this.cutPlane.constant), t = new THREE.Vector3(-n.y, n.x, 0), e = extent;
      const pts = [[-e, -4], [e, -4], [e, 12], [-e, 12], [-e, -4]].map(([s, z]) => o.clone().addScaledVector(t, s).setZ(z));
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), frameMat); l.computeLineDistances(); this.frames.add(l);
    }
  }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
function collect(mesh, plane, others, out, lift = 0) {
  const g = mesh.geometry, pos = g.getAttribute('position'), idx = g.getIndex(), m = mesh.matrixWorld;
  const count = idx ? idx.count : pos.count, get = i => idx ? idx.getX(i) : i;
  const pts = [_a, _b, _c], d = [0, 0, 0];
  for (let i = 0; i < count; i += 3) {
    for (let k = 0; k < 3; k++) { pts[k].fromBufferAttribute(pos, get(i + k)).applyMatrix4(m); d[k] = plane.distanceToPoint(pts[k]); }
    const hits = [];
    for (let k = 0; k < 3; k++) {
      const j = (k + 1) % 3;
      if ((d[k] > 0) !== (d[j] > 0)) { const t = d[k] / (d[k] - d[j]); hits.push(pts[k].clone().lerp(pts[j], t)); }
    }
    if (hits.length !== 2) continue;
    // Only keep the parts of the outline that survive the other planes.
    if (others.some(p => p.distanceToPoint(hits[0]) < -1e-4 && p.distanceToPoint(hits[1]) < -1e-4)) continue;
    for (const p of others) clipSegment(hits, p);
    if (!hits.length) continue;
    out.push(hits[0].x, hits[0].y, hits[0].z + lift, hits[1].x, hits[1].y, hits[1].z + lift);
  }
}
function clipSegment(h, p) {
  const da = p.distanceToPoint(h[0]), db = p.distanceToPoint(h[1]);
  if (da >= 0 && db >= 0) return; if (da < 0 && db < 0) { h.length = 0; return; }
  const q = h[0].clone().lerp(h[1], da / (da - db));
  if (da < 0) h[0] = q; else h[1] = q;
}
