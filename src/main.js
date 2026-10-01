import './style.css';
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { createBody, generateBody, worldBody, presets, envelopeFootprint, closed, rad, sunVector, validateState, inwardLine, ringsAt, PERSON_HEIGHT } from './geometry.js';
import { createWall, createOpening, generateWall, nearestOnWall, wallSegments } from './walls.js';
import { collectMeshes, exportOBJ, download } from './export.js';
import { exportFBX } from './export-fbx.js';
import { exportIFC } from './export-ifc.js';
import { ViewManager, VIEWS } from './views.js';
import { Sections } from './sections.js';

const $ = id => document.getElementById(id);
const fmt = (v, d = 1) => v.toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const site = await fetch('/site.json').then(r => { if (!r.ok) throw Error('No se pudo cargar el terreno'); return r.json(); });

// Arctic-like model palette: white model, dark edges, mid-grey terrain, neutral background.
const COLORS = {
  bg: '#e4e5e3', ground: '#d3d4d1', terrain: '#a2a39f', contour: '#5f605c',
  skin: '#f6f6f3', skinSel: '#e2eed5', slab: '#c6c6c1', wall: '#fbfbf8', wallSel: '#e2eed5',
  edge: '#222222', edgeSel: '#17735f', rule: '#2f6f9f', person: '#39434d', draw: '#0f7b67'
};
const STORAGE = 'refugio-lab-v2', OLD_STORAGE = 'refugio-lab-v1';
let state = { format: 'refugio-lab', version: 2, siteId: site.id, bodies: [createBody('seed', { name: 'Refugio 01' })], walls: [], person: null, sun: { azimuth: 45, elevation: 42 } };
try { const saved = localStorage.getItem(STORAGE) ?? localStorage.getItem(OLD_STORAGE); if (saved) state = validateState(JSON.parse(saved), site); } catch (e) { console.warn('Proyecto local no recuperado:', e.message); }
let selection = state.bodies[0] ? { type: 'body', id: state.bodies[0].id } : null;
let baseline = null, lastMetrics = null, revision = 0, history = [], future = [], metricsBusy = false, pendingMetrics = null, currentMode = 'select', saveTimer, toastTimer;
let tool = null, drawing = null, personDrag = null, workLevel = 0, appReady = false;
const gen = { bodies: new Map(), walls: new Map() };

// ---------- Renderer, scene, views ----------
const viewport = $('viewport'), scene = new THREE.Scene(); scene.background = new THREE.Color(COLORS.bg);
let renderer;
try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); } catch (e) { $('loading').textContent = 'No se pudo iniciar la vista 3D. Activá la aceleración gráfica del navegador.'; throw e; }
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.05; renderer.localClippingEnabled = true;
viewport.prepend(renderer.domElement); renderer.domElement.setAttribute('aria-label', 'Modelo 3D interactivo');
const view = new ViewManager(renderer.domElement, { center: new THREE.Vector3(0, 0, 2), onChange: onViewChange });
const gizmo = new TransformControls(view.camera, renderer.domElement); gizmo.setSize(0.8); gizmo.setSpace('world'); gizmo.setTranslationSnap(0.1); gizmo.setRotationSnap(rad(1)); scene.add(gizmo.getHelper()); gizmo.enabled = false;
const sections = new Sections(scene);

scene.add(new THREE.HemisphereLight('#ffffff', '#a9aaa6', 2.3));
const sunlight = new THREE.DirectionalLight('#fffaf0', 2.2); sunlight.castShadow = true; sunlight.shadow.mapSize.set(2048, 2048);
Object.assign(sunlight.shadow.camera, { left: -58, right: 58, top: 58, bottom: -58, near: 1, far: 280 }); sunlight.shadow.bias = -0.00015; sunlight.shadow.normalBias = 0.04; scene.add(sunlight, sunlight.target);
const terrainGroup = new THREE.Group(), envelopeGroup = new THREE.Group(), contourGroup = new THREE.Group(), buildingGroup = new THREE.Group(), wallGroup = new THREE.Group(), labelGroup = new THREE.Group(), drawGroup = new THREE.Group(), personGroup = new THREE.Group();
scene.add(terrainGroup, envelopeGroup, contourGroup, buildingGroup, wallGroup, labelGroup, drawGroup, personGroup);
const bodyGroups = new Map(), wallGroups = new Map();
let skinMeshes = [], slabMeshes = [], wallMeshes = [];

function geometryFrom(data) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3)); g.setIndex(data.indices); g.computeVertexNormals(); return g; }
const terrainMaterial = new THREE.MeshStandardMaterial({ color: COLORS.terrain, roughness: 1, metalness: 0, side: THREE.DoubleSide });
const ground = new THREE.Mesh(geometryFrom(site.terrain), terrainMaterial); ground.receiveShadow = true; terrainGroup.add(ground);
const groundPlane = new THREE.Mesh(new THREE.PlaneGeometry(1100, 1100), new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 1 })); groundPlane.position.z = -12; groundPlane.receiveShadow = true; scene.add(groundPlane);

function line(points, color, opacity = 1, dashed = false) {
  const g = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(...p)));
  const m = dashed ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.65, gapSize: 0.35 }) : new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  const l = new THREE.Line(g, m); if (dashed) l.computeLineDistances(); return l;
}
function surface(ring, z, color, opacity) { const shape = new THREE.Shape(ring.map(p => new THREE.Vector2(...p))); const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide })); mesh.position.z = z; return mesh; }
function textSprite(text, color = '#2f6f9f', scale = 6) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 96; const ctx = canvas.getContext('2d');
  ctx.font = '600 33px Segoe UI, Arial'; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.fillText(text, 256, 58);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false }));
  sprite.scale.set(scale, scale * 96 / 512, 1); return sprite;
}

// ---------- Site: envelope, setbacks, north, contours ----------
const envelope = envelopeFootprint(site), lotRing = site.lot.slice(0, -1);
envelopeGroup.add(line(closed(lotRing).map(p => [...p, 0.05]), '#303030', 0.9));
envelopeGroup.add(line(closed(envelope).map(p => [...p, 8]), COLORS.rule, 0.85, true));
envelopeGroup.add(surface(envelope, 8, COLORS.rule, 0.06));
for (const p of envelope) envelopeGroup.add(line([[...p, 0], [...p, 8]], COLORS.rule, 0.6, true));
for (let i = 0; i < envelope.length; i++) {
  const a = envelope[i], b = envelope[(i + 1) % envelope.length], g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...a, 0, ...b, 0, ...b, 8, ...a, 8], 3)); g.setIndex([0, 1, 2, 0, 2, 3]);
  envelopeGroup.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: COLORS.rule, transparent: true, opacity: 0.04, depthWrite: false, side: THREE.DoubleSide })));
}
function setbackDiagram(edge, text) {
  const { n } = inwardLine(edge), p = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2], q = [p[0] + n[0] * 10, p[1] + n[1] * 10];
  envelopeGroup.add(line([[...p, 0.12], [...q, 0.12]], COLORS.rule, 1));
  for (const x of [p, q]) envelopeGroup.add(line([[x[0] - n[1], x[1] + n[0], 0.12], [x[0] + n[1], x[1] - n[0], 0.12]], COLORS.rule));
  const label = textSprite(text, COLORS.rule, 10); label.position.set((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, 1); envelopeGroup.add(label);
  envelopeGroup.add(line(edge.map(p => [p[0] + n[0] * 10, p[1] + n[1] * 10, 0.1]), COLORS.rule, 0.8, true));
}
setbackDiagram(site.front, 'FRENTE · 10 m'); setbackDiagram(site.back, 'FONDO · 10 m');
const heightLabel = textSprite('8 m · ALTURA MÁXIMA', COLORS.rule, 11); heightLabel.position.set(envelope[0][0] - 2, envelope[0][1], 8.7); envelopeGroup.add(heightLabel);
const northOrigin = new THREE.Vector3(24, 18, 0), northDir = new THREE.Vector3(site.north[0], site.north[1], 0);
labelGroup.add(new THREE.ArrowHelper(northDir, northOrigin, 8, '#303a40', 1.4, 0.6));
const northText = textSprite('N', '#303a40', 4); northText.position.copy(northOrigin).addScaledVector(northDir, 10); labelGroup.add(northText);
{
  const cp = [];
  for (let k = 0; k < site.terrain.indices.length; k += 3) {
    const pts = site.terrain.indices.slice(k, k + 3).map(i => site.terrain.positions.slice(i * 3, i * 3 + 3));
    if (pts.every(p => Math.hypot(p[0], p[1]) > 110)) continue;
    const min = Math.ceil(Math.min(...pts.map(p => p[2]))), max = Math.floor(Math.max(...pts.map(p => p[2])));
    for (let z = min; z <= max; z++) {
      const hits = [];
      for (let j = 0; j < 3; j++) { const a = pts[j], b = pts[(j + 1) % 3]; if ((a[2] <= z && b[2] > z) || (b[2] <= z && a[2] > z)) { const t = (z - a[2]) / (b[2] - a[2]); hits.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z + 0.035]); } }
      if (hits.length === 2) cp.push(...hits[0], ...hits[1]);
    }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
  contourGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: COLORS.contour, transparent: true, opacity: 0.28 })));
}

// ---------- Materials ----------
function disposeGroup(group) { group.traverse(o => { o.geometry?.dispose(); if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) { m.map?.dispose(); m.dispose(); } }); }
function clearGroup(group) { for (const c of [...group.children]) { group.remove(c); disposeGroup(c); } }
// Parts outside the lot, inside a setback or above 8 m are tinted orange.
const boundaryPlanes = (() => {
  const b = lotRing.map((p, i) => inwardLine([p, lotRing[(i + 1) % lotRing.length]])).map(({ a, n }) => new THREE.Vector3(n[0], n[1], n[0] * a[0] + n[1] * a[1]));
  for (const edge of [site.front, site.back]) { const { a, n } = inwardLine(edge); b.push(new THREE.Vector3(n[0], n[1], n[0] * a[0] + n[1] * a[1] + 10)); }
  return b;
})();
function addShader(material) {
  material.onBeforeCompile = shader => {
    shader.uniforms.labPlanes = { value: boundaryPlanes };
    shader.vertexShader = 'varying vec3 labPosition;\n' + shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nlabPosition=(modelMatrix * vec4(transformed,1.0)).xyz;');
    shader.fragmentShader = `varying vec3 labPosition; uniform vec3 labPlanes[${boundaryPlanes.length}];\n` + shader.fragmentShader.replace('#include <opaque_fragment>',
      `#include <opaque_fragment>\n bool labOutside=labPosition.z>8.01; for(int i=0;i<${boundaryPlanes.length};i++){if(dot(labPlanes[i].xy,labPosition.xy)<labPlanes[i].z-0.01)labOutside=true;} if(labOutside)gl_FragColor.rgb=mix(gl_FragColor.rgb,vec3(0.91,0.34,0.12),0.75);`);
  };
}
function buildingMaterial(color) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0, side: THREE.DoubleSide, wireframe: $('show-wire').checked, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  m.clippingPlanes = sections.buildingPlanes(); m.clipShadows = true; addShader(m); return m;
}
function edgeMaterial(color, opacity = 1) { const m = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }); m.clippingPlanes = sections.buildingPlanes(); return m; }
const isSel = (type, id) => selection?.type === type && selection.id === id;

// ---------- Human scale ----------
{
  const mat = new THREE.MeshStandardMaterial({ color: COLORS.person, roughness: 0.7 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.62, 4, 12), mat); torso.position.z = 1.16; torso.rotation.x = Math.PI / 2; torso.scale.set(1, 1, 0.62);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), mat); head.position.z = 1.64;
  const legs = [-0.09, 0.09].map(x => { const l = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.72, 4, 8), mat); l.rotation.x = Math.PI / 2; l.position.set(x, 0, 0.44); return l; });
  const arms = [-0.25, 0.25].map(x => { const a = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.56, 4, 8), mat); a.rotation.x = Math.PI / 2; a.position.set(x, 0, 1.08); return a; });
  for (const o of [torso, head, ...legs, ...arms]) { o.castShadow = true; o.userData.person = true; personGroup.add(o); }
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.4, 32), new THREE.MeshBasicMaterial({ color: COLORS.draw, transparent: true, opacity: 0.8, depthTest: false }));
  ring.position.z = 0.03; ring.visible = false; ring.name = 'person-ring'; personGroup.add(ring);
}
const raycaster = new THREE.Raycaster(), UP = new THREE.Vector3(0, 0, 1), DOWN = new THREE.Vector3(0, 0, -1);
function dropZ(x, y, from = 60, targets = [ground]) { raycaster.set(new THREE.Vector3(x, y, from), DOWN); raycaster.far = 200; const h = raycaster.intersectObjects(targets, false)[0]; raycaster.far = Infinity; return h ? h.point.z : 0; }
if (!state.person) { const c = envelope.reduce((a, p) => [a[0] + p[0] / envelope.length, a[1] + p[1] / envelope.length], [0, 0]); const x = c[0] + 9, y = c[1] - 4; state.person = { x, y, z: dropZ(x, y) }; }

// ---------- Scene sync ----------
function syncScene() {
  gizmo.detach();
  clearGroup(buildingGroup); bodyGroups.clear(); skinMeshes = []; slabMeshes = [];
  for (const b of state.bodies) {
    const local = generateBody(b), sel = isSel('body', b.id);
    gen.bodies.set(b.id, { local, world: worldBody(b, local) });
    const group = new THREE.Group(); group.userData = { type: 'body', id: b.id }; group.position.set(b.x, b.y, b.z); group.rotation.z = rad(b.yaw);
    const skinGeo = geometryFrom(local), skin = new THREE.Mesh(skinGeo, buildingMaterial(sel ? COLORS.skinSel : b.color));
    skin.castShadow = skin.receiveShadow = true; skin.userData = { type: 'body', id: b.id, part: 'skin' }; group.add(skin); skinMeshes.push(skin);
    group.add(new THREE.LineSegments(new THREE.EdgesGeometry(skinGeo, 28), edgeMaterial(sel ? COLORS.edgeSel : COLORS.edge, sel ? 1 : 0.85)));
    local.rings.forEach((ring, j) => { if (j % 2 === 0 && j > 0 && j < local.rings.length - 1) group.add(Object.assign(line([...ring, ring[0]], sel ? COLORS.edgeSel : '#555', 0.22), {})); });
    const slabs = new THREE.Group(); slabs.visible = $('show-floors').checked; slabs.userData.slabs = true;
    for (const s of local.slabs) {
      const g = geometryFrom(s), m = new THREE.Mesh(g, buildingMaterial(COLORS.slab)); m.castShadow = m.receiveShadow = true; m.userData = { type: 'body', id: b.id, part: 'slab' };
      slabs.add(m, new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), edgeMaterial(COLORS.edge, 0.75))); slabMeshes.push(m);
    }
    group.add(slabs); buildingGroup.add(group); bodyGroups.set(b.id, group);
  }
  for (const g of buildingGroup.children) for (const o of g.children) if (o.isLine && !o.isLineSegments) o.material.clippingPlanes = sections.buildingPlanes();
  buildingGroup.updateMatrixWorld(true);
  buildWalls(); buildPerson(); renderWorkLevels(); rebuildCuts(); attachSelected();
}
function rayUp(x, y, z) {
  raycaster.set(new THREE.Vector3(x, y, z), UP); raycaster.far = 40;
  const hit = raycaster.intersectObjects([...skinMeshes, ...slabMeshes], false).find(h => h.distance > 0.25);
  raycaster.far = Infinity; return hit ? z + hit.distance : null;
}
function wallCentroid(w) { const n = w.points.length; return w.points.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n], [0, 0]); }
function buildWalls() {
  clearGroup(wallGroup); wallGroups.clear(); wallMeshes = [];
  for (const w of state.walls) {
    const g = generateWall(w, rayUp); gen.walls.set(w.id, g);
    const c = wallCentroid(w), pos = g.positions.slice();
    for (let i = 0; i < pos.length; i += 3) { pos[i] -= c[0]; pos[i + 1] -= c[1]; }
    const geo = geometryFrom({ positions: pos, indices: g.indices }), sel = isSel('wall', w.id);
    const mesh = new THREE.Mesh(geo, buildingMaterial(sel ? COLORS.wallSel : COLORS.wall)); mesh.castShadow = mesh.receiveShadow = true; mesh.userData = { type: 'wall', id: w.id };
    const group = new THREE.Group(); group.position.set(c[0], c[1], 0); group.userData = { type: 'wall', id: w.id };
    group.add(mesh, new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), edgeMaterial(sel ? COLORS.edgeSel : COLORS.edge, sel ? 1 : 0.85)));
    wallGroup.add(group); wallGroups.set(w.id, group); wallMeshes.push(mesh);
  }
  wallGroup.updateMatrixWorld(true);
}
function buildPerson() {
  const p = state.person; personGroup.visible = !!p && $('show-person').checked;
  if (p) personGroup.position.set(p.x, p.y, p.z);
  personGroup.getObjectByName('person-ring').visible = isSel('person', 'person');
}
function rebuildCuts() {
  terrainMaterial.clippingPlanes = sections.terrainPlanes();
  const slabsVisible = $('show-floors').checked;
  sections.rebuild([...skinMeshes, ...(slabsVisible ? slabMeshes : []), ...wallMeshes], $('show-terrain').checked ? ground : null, 55);
}
function attachSelected() {
  gizmo.detach(); gizmo.enabled = false;
  if (tool || currentMode === 'select' || !selection) return;
  const obj = selection.type === 'body' ? bodyGroups.get(selection.id) : selection.type === 'wall' ? wallGroups.get(selection.id) : null;
  if (!obj) return;
  gizmo.enabled = true; gizmo.attach(obj); gizmo.setMode(currentMode === 'move' ? 'translate' : 'rotate');
  gizmo.showX = gizmo.showY = currentMode === 'move'; gizmo.showZ = currentMode === 'rotate' || selection.type === 'body';
}

// ---------- Edit history ----------
function toast(msg) { $('toast').textContent = msg; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 4200); }
const snapshot = () => JSON.stringify(state);
function beginEdit() { const s = snapshot(); if (history.at(-1) !== s) { history.push(s); if (history.length > 50) history.shift(); } future = []; }
function saveLocal() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem(STORAGE, snapshot()); } catch { toast('No hay espacio para el autoguardado. Usá Guardar proyecto.'); } }, 400); }
function changed({ rebuild = true } = {}) { if (rebuild) syncScene(); queueMetrics(); saveLocal(); $('undo').disabled = !history.length; $('redo').disabled = !future.length; }
function restore(s) { state = JSON.parse(s); if (selection && !findSel()) selection = null; renderEditor(); updateSunUI(); updateSun(); changed(); }
$('undo').onclick = () => { if (history.length) { future.push(snapshot()); restore(history.pop()); } };
$('redo').onclick = () => { if (future.length) { history.push(snapshot()); restore(future.pop()); } };
const findSel = () => selection?.type === 'body' ? state.bodies.find(b => b.id === selection.id) : selection?.type === 'wall' ? state.walls.find(w => w.id === selection.id) : selection?.type === 'person' ? state.person : null;
function select(type, id) { selection = type ? { type, id } : null; renderEditor(); syncScene(); }

function addBody(kind) {
  if (state.bodies.length >= 30) return toast('Máximo de 30 cuerpos en este prototipo.');
  beginEdit(); const b = createBody(kind, { name: `Refugio ${String(state.bodies.length + 1).padStart(2, '0')}`, y: state.bodies.length ? 5 : 0 });
  state.bodies.push(b); selection = { type: 'body', id: b.id }; renderEditor(); changed(); toast(`${presets[kind].label} añadida`);
}
document.querySelectorAll('[data-preset]').forEach(button => button.onclick = () => addBody(button.dataset.preset)); $('add-block').onclick = () => addBody('block');
$('duplicate').onclick = () => {
  const s = findSel(); if (!s || selection.type === 'person') return; beginEdit();
  const copy = structuredClone(s); copy.id = crypto.randomUUID(); copy.name = s.name + ' · copia';
  if (selection.type === 'body') { if (state.bodies.length >= 30) return; copy.x += 2; copy.y += 2; state.bodies.push(copy); }
  else { copy.points = copy.points.map(p => [p[0] + 1, p[1] + 1]); copy.openings = copy.openings.map(o => ({ ...o, id: crypto.randomUUID() })); state.walls.push(copy); }
  selection = { type: selection.type, id: copy.id }; renderEditor(); changed();
};
$('delete').onclick = () => {
  if (!selection || selection.type === 'person') return; beginEdit();
  if (selection.type === 'body') state.bodies = state.bodies.filter(b => b.id !== selection.id); else state.walls = state.walls.filter(w => w.id !== selection.id);
  selection = null; renderEditor(); changed();
};

// ---------- Editor controls ----------
const controlSpecs = {
  width: ['Ancho', 1, 35, 0.1, 'm'], depth: ['Largo', 1, 50, 0.1, 'm'], height: ['Altura de la forma', 0.5, 16, 0.05, 'm'],
  bulge: ['Expansión', 0, 0.8, 0.01, ''], waist: ['Cintura', 0, 0.5, 0.01, ''], taper: ['Afinamiento', 0, 0.9, 0.01, ''], twist: ['Torsión', -150, 150, 1, '°'], ripple: ['Ondulación', 0, 0.3, 0.01, ''], lobes: ['Lóbulos', 0, 10, 1, ''],
  shell: ['Espesor de piel', 0, 0.6, 0.01, 'm'], slab: ['Espesor de losa', 0.15, 0.5, 0.01, 'm'],
  x: ['Posición este / oeste', -50, 50, 0.1, 'm'], y: ['Posición norte / sur', -50, 50, 0.1, 'm'], z: ['Elevación', -5, 15, 0.1, 'm'], yaw: ['Giro en planta', -180, 180, 1, '°']
};
let controlSeq = 0;
function control(field, spec, container, getter, setter) {
  const [label, min, max, step, unit] = spec, uid = `${field}-${controlSeq++}`;
  const wrap = document.createElement('div'); wrap.className = 'control';
  const head = document.createElement('div'); head.className = 'control-line';
  const lab = document.createElement('label'); lab.htmlFor = `range-${uid}`; lab.textContent = label;
  const valueWrap = document.createElement('div'); valueWrap.className = 'value-wrap';
  const number = document.createElement('input'); number.id = `value-${uid}`; number.dataset.field = field; number.type = 'number'; number.min = min; number.max = max; number.step = step; number.setAttribute('aria-label', `${label} valor`);
  const unitSpan = document.createElement('span'); unitSpan.textContent = unit; valueWrap.append(number, unitSpan); head.append(lab, valueWrap);
  const range = document.createElement('input'); range.id = `range-${uid}`; range.dataset.field = field; range.type = 'range'; range.min = min; range.max = max; range.step = step; range.setAttribute('aria-label', label);
  range.value = number.value = getter(); wrap.append(head, range); container.append(wrap);
  let editing = false; const start = () => { if (!editing) { beginEdit(); editing = true; } }, end = () => { editing = false; };
  range.addEventListener('pointerdown', start); range.addEventListener('keydown', start); range.addEventListener('change', end); number.addEventListener('focus', start); number.addEventListener('blur', end);
  const apply = input => { start(); let v = Number(input.value); if (!Number.isFinite(v)) return; v = Math.max(min, Math.min(max, v)); if (step === 1) v = Math.round(v); range.value = number.value = v; setter(v); };
  range.oninput = () => apply(range); number.oninput = () => { if (number.value !== '') apply(number); };
  return { range, number };
}
const levelName = i => i === 0 ? 'Planta baja' : `Nivel ${i}`;
function renderEditor() {
  const sel = findSel(), list = $('body-list'); list.replaceChildren();
  $('body-count').textContent = state.bodies.length + state.walls.length;
  $('editor').hidden = selection?.type !== 'body' || !sel; $('wall-editor').hidden = selection?.type !== 'wall' || !sel;
  $('delete').disabled = $('duplicate').disabled = !sel || selection.type === 'person';
  if (!state.bodies.length && !state.walls.length) { const p = document.createElement('p'); p.className = 'empty-message'; p.textContent = 'Añadí una forma o dibujá un muro para comenzar.'; list.append(p); }
  const row = (type, item, swatchClass, marker) => {
    const r = document.createElement('button'); r.className = `body-row ${isSel(type, item.id) ? 'active' : ''}`; r.dataset.id = item.id;
    const sw = document.createElement('span'); sw.className = swatchClass; if (type === 'body') sw.style.background = item.color;
    const name = document.createElement('span'); name.textContent = item.name;
    const m = document.createElement('small'); m.className = 'body-status'; m.textContent = marker;
    r.append(sw, name, m); r.onclick = () => select(type, item.id); list.append(r);
  };
  for (const b of state.bodies) row('body', b, 'swatch', b.kind === 'imported' ? 'OBJ' : '');
  for (const w of state.walls) row('wall', w, 'swatch wall-swatch', '');
  applyBadges(lastMetrics);
  if (!sel) return;
  if (selection.type === 'body') renderBodyEditor(sel); else if (selection.type === 'wall') renderWallEditor(sel);
}
function renderBodyEditor(b) {
  $('selected-kind').textContent = presets[b.kind]?.label || 'OBJ';
  for (const id of ['shape-controls', 'deform-controls', 'skin-controls', 'position-controls', 'level-heights']) $(id).replaceChildren();
  for (const f of ['width', 'depth', 'height']) control(f, controlSpecs[f], $('shape-controls'), () => b[f], v => { b[f] = v; changed(); });
  if (b.kind !== 'block' && b.kind !== 'imported') for (const f of ['bulge', 'taper', 'twist', 'waist', 'ripple', 'lobes']) control(f, controlSpecs[f], $('deform-controls'), () => b[f], v => { b[f] = v; changed(); });
  const imported = b.kind === 'imported';
  if (!imported) for (const f of ['shell', 'slab']) control(f, controlSpecs[f], $('skin-controls'), () => b[f], v => { b[f] = v; changed(); });
  $('level-count').value = b.levels.length; $('level-count').disabled = imported; $('fit-height').disabled = imported;
  b.levels.forEach((h, i) => {
    const r = document.createElement('div'); r.className = 'level-row';
    const l = document.createElement('label'); l.textContent = levelName(i); l.htmlFor = `level-h-${i}`;
    const inp = document.createElement('input'); inp.type = 'number'; inp.id = `level-h-${i}`; inp.min = 2; inp.max = 8; inp.step = 0.05; inp.value = h; inp.disabled = imported;
    const u = document.createElement('span'); u.textContent = 'm piso a piso';
    let editing = false;
    inp.addEventListener('focus', () => { if (!editing) { beginEdit(); editing = true; } }); inp.addEventListener('blur', () => { editing = false; });
    inp.oninput = () => { const v = Number(inp.value); if (!Number.isFinite(v) || v < 2 || v > 8) return; b.levels[i] = v; changed(); };
    r.append(l, inp, u); $('level-heights').append(r);
  });
  for (const f of ['x', 'y', 'z', 'yaw']) control(f, controlSpecs[f], $('position-controls'), () => b[f], v => { b[f] = v; changed(); });
}
$('level-count').onchange = () => { const b = findSel(); if (selection?.type !== 'body' || !b) return; beginEdit(); const n = Number($('level-count').value); while (b.levels.length < n) b.levels.push(b.levels.at(-1) ?? 3); b.levels.length = n; renderEditor(); changed(); };
$('fit-height').onclick = () => { const b = findSel(); if (selection?.type !== 'body' || !b) return; beginEdit(); b.height = Math.max(0.5, Math.min(16, Math.round(b.levels.reduce((a, h) => a + h, 0) * 100) / 100)); renderEditor(); changed(); toast(`Altura de la forma: ${fmt(b.height, 2)} m`); };

function wallLength(w) { return wallSegments(w).reduce((a, s) => a + s.L, 0); }
function renderWallEditor(w) {
  $('wall-length').textContent = `${fmt(wallLength(w), 2)} m`;
  $('wall-controls').replaceChildren(); $('opening-list').replaceChildren();
  control('thickness', ['Espesor', 0.08, 0.6, 0.01, 'm'], $('wall-controls'), () => w.thickness, v => { w.thickness = v; changed(); });
  control('wallHeight', [w.heightMode === 'skin' ? 'Altura si no hay piel encima' : 'Altura', 0.5, 9, 0.05, 'm'], $('wall-controls'), () => w.height, v => { w.height = v; changed(); });
  $('wall-height-mode').value = w.heightMode;
  const opts = levelOptions(); $('wall-level').replaceChildren(...opts.map(([k, label]) => new Option(label, k)));
  const key = Math.round(w.base * 100); if (!opts.some(([k]) => k === key)) $('wall-level').append(new Option(`Otro · +${fmt(w.base, 2)}`, key));
  $('wall-level').value = key;
  const segs = wallSegments(w);
  w.openings.forEach((o, idx) => {
    const box = document.createElement('div'); box.className = 'opening-card';
    const head = document.createElement('div'); head.className = 'section-title';
    const t = document.createElement('h3'); t.textContent = `${o.type === 'door' ? 'Puerta' : 'Ventana'} ${idx + 1}`;
    const del = document.createElement('button'); del.className = 'icon-button'; del.textContent = '×'; del.title = 'Quitar abertura'; del.onclick = () => { beginEdit(); w.openings = w.openings.filter(x => x.id !== o.id); renderEditor(); changed(); };
    head.append(t, del); box.append(head);
    if (segs.length > 1) {
      const fc = document.createElement('div'); fc.className = 'floor-control'; const l = document.createElement('label'); l.textContent = 'Tramo';
      const s = document.createElement('select'); segs.forEach(sg => s.append(new Option(`Tramo ${sg.index + 1} · ${fmt(sg.L, 2)} m`, sg.index))); s.value = o.seg;
      s.onchange = () => { beginEdit(); o.seg = Number(s.value); const L = segs.find(x => x.index === o.seg)?.L ?? 1; o.at = Math.min(o.at, L / 2); renderEditor(); changed(); };
      fc.append(l, s); box.append(fc);
    }
    const L = segs.find(x => x.index === o.seg)?.L ?? 1;
    control(`at-${idx}`, ['Posición en el tramo', 0, Math.max(0.1, Math.round(L * 100) / 100), 0.05, 'm'], box, () => o.at, v => { o.at = v; changed(); });
    control(`w-${idx}`, ['Ancho', 0.5, 4, 0.05, 'm'], box, () => o.width, v => { o.width = v; changed(); });
    control(`h-${idx}`, ['Alto', 0.4, 3, 0.05, 'm'], box, () => o.height, v => { o.height = v; changed(); });
    if (o.type === 'window') control(`s-${idx}`, ['Antepecho', 0.1, 2.2, 0.05, 'm'], box, () => o.sill, v => { o.sill = v; changed(); });
    $('opening-list').append(box);
  });
  if (!w.openings.length) { const p = document.createElement('p'); p.className = 'micro'; p.textContent = 'Sin aberturas. Tocá "+ Puerta" o "+ Ventana" y hacé clic sobre el muro.'; $('opening-list').append(p); }
}
$('wall-height-mode').onchange = () => { const w = findSel(); if (selection?.type !== 'wall') return; beginEdit(); w.heightMode = $('wall-height-mode').value; renderEditor(); changed(); };
$('wall-level').onchange = () => { const w = findSel(); if (selection?.type !== 'wall') return; beginEdit(); w.base = Number($('wall-level').value) / 100; changed(); };
for (const [id, type] of [['add-door', 'door'], ['add-window', 'window']]) $(id).onclick = () => { if (selection?.type !== 'wall') return; setTool({ kind: 'opening', type }); toast(`Hacé clic sobre el muro donde va la ${type === 'door' ? 'puerta' : 'ventana'}. Esc para cancelar.`); };

// ---------- Levels for drawing ----------
function levelOptions() {
  const map = new Map([[0, 'Terreno · ±0,00']]);
  for (const b of state.bodies) { const g = gen.bodies.get(b.id); if (!g) continue; for (const s of g.world.slabs) { const k = Math.round(s.top * 100); if (!map.has(k)) map.set(k, `${b.name} · ${s.level === 0 ? 'PB' : 'Nivel ' + s.level} · +${fmt(s.top, 2)}`); } }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}
let workLevelTouched = false;
function renderWorkLevels() {
  const opts = levelOptions(), sel = $('work-level');
  if (!workLevelTouched || !opts.some(([k]) => k === workLevel)) workLevel = (opts.find(([k]) => k > 0) ?? opts[0])[0];
  sel.replaceChildren(...opts.map(([k, l]) => new Option(l, k))); sel.value = workLevel;
}
$('work-level').onchange = () => { workLevel = Number($('work-level').value); workLevelTouched = true; if (drawing) { drawing.points = []; if (autoPlan) { setPlanZ(levelZ() + 1.2); rebuildCuts(); } } updateDrawPreview(); };

// ---------- Tools: wall drawing and openings ----------
const drawMat = new THREE.LineBasicMaterial({ color: COLORS.draw, depthTest: false, transparent: true });
const markerTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); x.strokeStyle = COLORS.draw; x.lineWidth = 7; x.beginPath(); x.arc(32, 32, 22, 0, Math.PI * 2); x.stroke(); return new THREE.CanvasTexture(c); })();
const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: markerTex, depthTest: false, sizeAttenuation: false })); marker.scale.set(0.028, 0.028, 1); marker.visible = false; marker.renderOrder = 10; scene.add(marker);
let autoPlan = false;
function setTool(t) {
  if (t === 'wall' && !sections.plan.enabled) { autoPlan = true; sections.plan.enabled = true; $('plan-cut').checked = true; setPlanZ(levelZ() + 1.2); syncScene(); }
  if (t !== 'wall' && autoPlan) { autoPlan = false; sections.plan.enabled = false; $('plan-cut').checked = false; syncScene(); }
  tool = t; drawing = t === 'wall' ? { points: [], cursor: null } : null;
  $('draw-wall').classList.toggle('active', t === 'wall'); $('draw-wall').setAttribute('aria-pressed', t === 'wall');
  $('draw-wall').textContent = t === 'wall' ? '■ Terminar de dibujar' : '✎ Dibujar muro';
  viewport.classList.toggle('drawing', !!t); marker.visible = false; $('cursor-label').hidden = true;
  if (t === 'wall' && !['top', 'perspective'].includes(view.name)) toast('Para dibujar muros usá la vista Superior o Perspectiva.');
  applyToolToControls(); updateDrawPreview(); attachSelected(); updateNavHint();
}
$('draw-wall').onclick = () => { if (tool === 'wall') finishWall(); setTool(tool === 'wall' ? null : 'wall'); if (tool === 'wall') { setMode('select'); toast(autoPlan ? 'Planta cortada a 1,20 m del nivel mientras dibujás. Doble clic o Enter para terminar.' : 'Dibujá sobre el nivel de trabajo. Doble clic o Enter para terminar.'); } };
function applyToolToControls() { if (view.isOrtho) view.controls.mouseButtons.LEFT = tool ? -1 : THREE.MOUSE.PAN; }
function levelZ() { return workLevel / 100; }
function pointerNdc(e) { const r = renderer.domElement.getBoundingClientRect(); return new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1); }
function toScreen(x, y, z) { const v = new THREE.Vector3(x, y, z).project(view.camera), r = renderer.domElement.getBoundingClientRect(); return [(v.x + 1) / 2 * r.width, (1 - v.y) / 2 * r.height]; }
function planePoint(e, z) { raycaster.setFromCamera(pointerNdc(e), view.camera); const p = new THREE.Vector3(); return raycaster.ray.intersectPlane(new THREE.Plane(UP, -z), p) ? p : null; }
function snapPoint(e, raw) {
  const z = levelZ(), r = renderer.domElement.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const last = drawing?.points.at(-1);
  if (e.shiftKey && last) { // right angles and 45°
    const dx = raw.x - last[0], dy = raw.y - last[1], ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, L = Math.round(Math.hypot(dx, dy) * 10) / 10;
    return { x: last[0] + Math.cos(ang) * L, y: last[1] + Math.sin(ang) * L, type: 'Ángulo' };
  }
  const cands = [], near = (x, y, type, pri) => { const [sx, sy] = toScreen(x, y, z), d = Math.hypot(sx - mx, sy - my); if (d < 13) cands.push({ x, y, type, pri, d }); };
  drawing?.points.forEach((q, i) => near(q[0], q[1], i === 0 && drawing.points.length > 2 ? 'Cerrar' : 'Vértice', 0));
  for (const w of state.walls) if (Math.abs(w.base - z) < 0.05) {
    for (const q of w.points) near(q[0], q[1], 'Extremo de muro', 0);
    const n = nearestOnWall(w, raw.x, raw.y); if (n) { const s = wallSegments(w).find(s => s.index === n.seg); if (s) near(s.P[0] + s.u[0] * n.at, s.P[1] + s.u[1] * n.at, 'Sobre muro', 2); }
  }
  for (const b of state.bodies) {
    const rings = ringsAt(b, z - b.z + 0.05); if (!rings) continue;
    for (const [ring, label] of [[rings.inner, 'Cara interior de piel'], [rings.outer, 'Cara exterior de piel']]) {
      if (!ring) continue;
      for (let i = 0; i < ring.length; i += 5) near(ring[i][0], ring[i][1], label, 1);
      let best = null;
      for (let i = 0; i < ring.length; i++) { const a = ring[i], c = ring[(i + 1) % ring.length], dx = c[0] - a[0], dy = c[1] - a[1], L2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((raw.x - a[0]) * dx + (raw.y - a[1]) * dy) / L2)), px = a[0] + dx * t, py = a[1] + dy * t, d = Math.hypot(raw.x - px, raw.y - py); if (!best || d < best.d) best = { x: px, y: py, d }; }
      if (best) near(best.x, best.y, label, 2);
    }
  }
  cands.sort((a, b) => a.pri - b.pri || a.d - b.d);
  if (cands[0]) return cands[0];
  return { x: Math.round(raw.x * 10) / 10, y: Math.round(raw.y * 10) / 10, type: 'Grilla 10 cm' };
}
let previewLine = null;
function updateDrawPreview() {
  if (previewLine) { drawGroup.remove(previewLine); previewLine.geometry.dispose(); previewLine = null; }
  if (!drawing) return;
  const z = levelZ() + 0.03, pts = [...drawing.points]; if (drawing.cursor) pts.push([drawing.cursor.x, drawing.cursor.y]);
  if (pts.length < 2) return;
  previewLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(p[0], p[1], z))), drawMat); previewLine.renderOrder = 9; drawGroup.add(previewLine);
}
function drawMove(e) {
  const raw = planePoint(e, levelZ()); if (!raw) { marker.visible = false; return; }
  const s = snapPoint(e, raw); drawing.cursor = s; marker.position.set(s.x, s.y, levelZ() + 0.03); marker.visible = true;
  const last = drawing.points.at(-1), lab = $('cursor-label');
  lab.textContent = last ? `${fmt(Math.hypot(s.x - last[0], s.y - last[1]), 2)} m · ${s.type}` : s.type;
  const r = viewport.getBoundingClientRect(); lab.style.left = `${e.clientX - r.left + 16}px`; lab.style.top = `${e.clientY - r.top + 14}px`; lab.hidden = false;
  updateDrawPreview();
}
function drawClick(e) {
  const raw = planePoint(e, levelZ()); if (!raw) return;
  const s = snapPoint(e, raw), pts = drawing.points;
  if (s.type === 'Cerrar') { finishWall(true); return; }
  const last = pts.at(-1); if (last && Math.hypot(s.x - last[0], s.y - last[1]) < 0.05) return;
  pts.push([s.x, s.y]); updateDrawPreview();
}
function finishWall(close = false) {
  if (!drawing) return;
  const pts = drawing.points;
  if (pts.length >= 2) {
    beginEdit(); const base = levelZ();
    const above = levelOptions().map(([k]) => k / 100).filter(z => z > base + 1.5).sort((a, b) => a - b)[0];
    const w = createWall(pts, { name: `Muro ${String(state.walls.length + 1).padStart(2, '0')}`, base, closed: close && pts.length > 2, height: above ? Math.round((above - 0.2 - base) * 100) / 100 : 2.6 });
    state.walls.push(w); selection = { type: 'wall', id: w.id }; renderEditor(); changed(); toast(`${w.name}: ${fmt(wallLength(w), 2)} m`);
  }
  drawing.points = []; drawing.cursor = null; updateDrawPreview();
}
function placeOpening(e) {
  const w = findSel(); if (selection?.type !== 'wall' || !w) { setTool(null); return; }
  raycaster.setFromCamera(pointerNdc(e), view.camera);
  const hit = raycaster.intersectObjects(wallMeshes, false).find(h => h.object.userData.id === w.id && visibleThroughCuts(h.point));
  let at = hit?.point;
  if (!at) { const q = planePoint(e, w.base + 1); if (q && nearestOnWall(w, q.x, q.y).dist < 0.6) at = q; }
  if (!at) return toast('Hacé clic sobre el muro seleccionado.');
  const n = nearestOnWall(w, at.x, at.y), o = createOpening(tool.type, n.seg, Math.round(n.at * 20) / 20);
  if (n.L < o.width + 0.2) return toast('Ese tramo es demasiado corto para la abertura.');
  beginEdit(); w.openings.push(o); setTool(null); renderEditor(); changed();
}

// ---------- Picking, selection and the person ----------
function visibleThroughCuts(p) { return sections.buildingPlanes().every(pl => pl.distanceToPoint(p) >= -0.02); }
function pick(e, objects) { raycaster.setFromCamera(pointerNdc(e), view.camera); return raycaster.intersectObjects(objects, true).find(h => visibleThroughCuts(h.point) && h.object.visible && h.object.isMesh); }
function personTarget(e) {
  const floors = [ground, ...($('show-floors').checked ? slabMeshes : [])];
  if (view.name === 'perspective' || view.name === 'top') { raycaster.setFromCamera(pointerNdc(e), view.camera); const h = raycaster.intersectObjects(floors, false).find(h => visibleThroughCuts(h.point) || h.object === ground); return h ? h.point : null; }
  const dir = new THREE.Vector3(...VIEWS[view.name].dir), pos = personGroup.position, plane = new THREE.Plane(dir, -dir.dot(pos));
  raycaster.setFromCamera(pointerNdc(e), view.camera); const p = raycaster.ray.intersectPlane(plane, new THREE.Vector3()); if (!p) return null;
  raycaster.set(new THREE.Vector3(p.x, p.y, p.z + 0.8), DOWN); const h = raycaster.intersectObjects(floors, false)[0]; return h ? h.point : new THREE.Vector3(p.x, p.y, dropZ(p.x, p.y));
}
viewport.addEventListener('pointerdown', e => {
  if (e.button !== 0 || tool || !personGroup.visible || e.target !== renderer.domElement) return;
  if (gizmo.axis) return;
  if (pick(e, [personGroup])) { personDrag = { moved: false }; beginEdit(); view.controls.enabled = false; selection = { type: 'person', id: 'person' }; renderEditor(); buildPerson(); renderer.domElement.setPointerCapture(e.pointerId); }
}, true);
let down = null;
renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointermove', e => {
  if (personDrag) { const p = personTarget(e); if (p) { state.person = { x: p.x, y: p.y, z: p.z }; personGroup.position.copy(p); personDrag.moved = true; } return; }
  if (tool === 'wall' && drawing) drawMove(e);
});
renderer.domElement.addEventListener('pointerup', e => {
  if (personDrag) { view.controls.enabled = true; const moved = personDrag.moved; personDrag = null; if (moved) { saveLocal(); $('undo').disabled = false; } else history.pop(); return; }
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || gizmo.dragging || (gizmo.enabled && gizmo.axis)) return;
  if (e.button !== 0) return;
  if (tool === 'wall') return drawClick(e);
  if (tool?.kind === 'opening') return placeOpening(e);
  const hit = pick(e, [personGroup, wallGroup, buildingGroup]);
  if (!hit) { if (selection) select(null); return; }
  if (hit.object.userData.person) return select('person', 'person');
  select(hit.object.userData.type, hit.object.userData.id);
});
renderer.domElement.addEventListener('dblclick', () => { if (tool === 'wall') finishWall(); });
renderer.domElement.addEventListener('pointerleave', () => { marker.visible = false; $('cursor-label').hidden = true; });

// ---------- Gizmo ----------
function syncPositionControls() { const b = findSel(); if (selection?.type !== 'body' || !b) return; document.querySelectorAll('#position-controls input').forEach(i => { const f = i.dataset.field; if (f in b) i.value = Math.round(b[f] * 10) / 10; }); }
gizmo.addEventListener('dragging-changed', e => {
  view.controls.enabled = !e.value;
  if (e.value) { beginEdit(); return; }
  if (selection?.type === 'wall') {
    const w = findSel(), g = wallGroups.get(w.id), c = wallCentroid(w), a = g.rotation.z, cs = Math.cos(a), sn = Math.sin(a);
    w.points = w.points.map(([x, y]) => { const dx = x - c[0], dy = y - c[1]; return [Math.round((g.position.x + cs * dx - sn * dy) * 1000) / 1000, Math.round((g.position.y + sn * dx + cs * dy) * 1000) / 1000]; });
  }
  syncPositionControls(); changed();
});
gizmo.addEventListener('objectChange', () => {
  if (selection?.type !== 'body') return;
  const b = findSel(), g = bodyGroups.get(b.id); if (!b || !g) return;
  b.x = g.position.x; b.y = g.position.y; b.z = g.position.z; b.yaw = THREE.MathUtils.radToDeg(g.rotation.z);
  const cached = gen.bodies.get(b.id); if (cached) cached.world = worldBody(b, cached.local);
  syncPositionControls(); changed({ rebuild: false });
});
function setMode(mode) { currentMode = mode; for (const m of ['select', 'move', 'rotate']) $('mode-' + m).classList.toggle('active', m === mode); if (mode !== 'select' && tool) setTool(null); attachSelected(); }
for (const m of ['select', 'move', 'rotate']) $('mode-' + m).onclick = () => setMode(m);

// ---------- Views ----------
const lotBox = lotRing.reduce((b, p) => ({ minX: Math.min(b.minX, p[0]), maxX: Math.max(b.maxX, p[0]), minY: Math.min(b.minY, p[1]), maxY: Math.max(b.maxY, p[1]) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
// In elevations the terrain is cropped to the lot (plus 1 m), so the surroundings do not hide the refuge.
const lotCrop = lotRing.map((p, i) => { const { a, n } = inwardLine([p, lotRing[(i + 1) % lotRing.length]]); return new THREE.Plane(new THREE.Vector3(n[0], n[1], 0), -(n[0] * a[0] + n[1] * a[1]) + 1); });
const cropPlanes = { front: lotCrop, right: lotCrop };
function onViewChange(name) {
  if (!appReady) return;
  sections.crop = cropPlanes[name] ?? null; groundPlane.visible = !sections.crop; labelGroup.visible = !sections.crop;
  contourGroup.children[0].material.clippingPlanes = sections.crop ?? []; rebuildCuts();
  document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === name); b.setAttribute('aria-selected', b.dataset.view === name); });
  gizmo.camera = view.camera;
  viewport.dataset.view = name; applyToolToControls(); updateNavHint();
}
function updateNavHint() {
  $('nav-hint').textContent = tool === 'wall' ? 'Clic: vértice · doble clic / Enter: terminar · Shift: ortogonal · Backspace: deshacer punto · Esc: salir'
    : view.isOrtho ? `${VIEWS[view.name].label} · vista paralela · arrastrá para desplazar · rueda para acercar` : 'Arrastrá para orbitar · botón derecho para desplazar · rueda para acercar';
}
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => view.set(b.dataset.view));
$('frame').onclick = () => view.frame();

// ---------- Metrics ----------
const worker = new Worker(new URL('./metrics.worker.js', import.meta.url), { type: 'module' }); worker.postMessage({ site: { ...site, terrain: undefined } });
function metricInput() {
  const bodies = state.bodies.map(b => gen.bodies.get(b.id)?.world).filter(Boolean);
  const walls = state.walls.map(w => gen.walls.get(w.id)).filter(Boolean).map(({ id, base, top, positions, indices, footprints }) => ({ id, base, top, positions, indices, footprints }));
  return { bodies, walls };
}
function queueMetrics() { revision++; $('eval-status').textContent = 'Calculando…'; $('eval-status').className = 'busy'; pendingMetrics = { revision, ...metricInput(), sun: { ...state.sun } }; if (!metricsBusy) runMetrics(); }
function runMetrics() { if (!pendingMetrics) return; metricsBusy = true; worker.postMessage(pendingMetrics); pendingMetrics = null; }
const METRIC_IDS = ['occupation', 'free', 'covered', 'usable', 'height', 'margin', 'shadow', 'efficiency'];
worker.onmessage = ({ data }) => {
  metricsBusy = false;
  if (data.revision === revision) {
    if (data.error) { lastMetrics = null; $('eval-status').textContent = 'Revisar geometría'; $('alerts').textContent = `No se pudo calcular: ${data.error}`; for (const id of METRIC_IDS) $('m-' + id).textContent = '—'; }
    else { lastMetrics = data.metrics; renderMetrics(data.metrics, data.elapsed); }
  }
  if (pendingMetrics) runMetrics();
};
worker.onerror = e => { $('eval-status').textContent = 'Error de cálculo'; toast('No se pudo iniciar el cálculo. Recargá el prototipo.'); console.error(e); };
function metric(id, value, unit, d = 1) { const el = $('m-' + id); el.replaceChildren(); if (value === null || !Number.isFinite(value)) { el.textContent = '—'; return; } el.append(document.createTextNode(fmt(value, d))); const s = document.createElement('span'); s.className = 'unit'; s.textContent = unit; el.append(s); }
function applyBadges(m) { for (const it of m?.perItem ?? []) { const row = [...$('body-list').children].find(r => r.dataset.id === it.id), badge = row?.querySelector('.body-status'); if (badge) { badge.textContent = it.violates ? 'Límite' : 'Dentro'; badge.style.color = it.violates ? '#b0512a' : '#4f6f58'; } } }
function renderMetrics(m, elapsed) {
  metric('occupation', m.occupation, 'm²'); metric('free', m.free, 'm²'); metric('covered', m.covered, 'm²'); metric('usable', m.usable, 'm²');
  metric('height', m.high, 'm', 2); metric('margin', m.margin, 'm', 2); metric('shadow', m.shadow, 'm²'); metric('efficiency', m.efficiency, '%', 0);
  $('m-margin').parentElement.classList.toggle('negative', m.margin < -0.01);
  $('occupation-fill').style.width = `${Math.min(100, m.occupationPercent)}%`; $('occupation-label').textContent = `${fmt(m.occupationPercent)} % ocupado`;
  $('calc-time').textContent = `${Math.round(elapsed)} ms`;
  const lt = $('level-table'); lt.replaceChildren();
  if (m.perLevel.length) {
    const t = document.createElement('table'); t.innerHTML = '<thead><tr><th>Nivel</th><th>Cota</th><th>Cubierta</th><th>Útil</th></tr></thead>';
    const tb = document.createElement('tbody');
    m.perLevel.forEach((L, i) => { const tr = document.createElement('tr'); for (const v of [i === 0 ? 'PB' : `N${i}`, `+${fmt(L.top, 2)}`, `${fmt(L.covered)} m²`, `${fmt(L.usable)} m²`]) { const td = document.createElement('td'); td.textContent = v; tr.append(td); } tb.append(tr); });
    t.append(tb); lt.append(t);
  }
  const alerts = [];
  if (m.outsideArea > 0.01) alerts.push(['warn', `${fmt(m.outsideArea)} m² de proyección fuera del lote.`]);
  if (m.setbackArea > 0.01) alerts.push(['warn', `${fmt(m.setbackArea)} m² de proyección invaden retiros.`]);
  if (m.margin < -0.01) alerts.push(['warn', `Supera la altura máxima en ${fmt(-m.margin, 2)} m (incluye losas y muros).`]);
  for (const b of state.bodies) { const g = gen.bodies.get(b.id); if (g?.local.skipped.length) alerts.push(['note', `${b.name}: ${g.local.skipped.map(levelName).join(', ')} no entra${g.local.skipped.length > 1 ? 'n' : ''} en la forma. Subí la altura o bajá los pisos.`]); }
  const wallIssues = new Set(); for (const w of state.walls) for (const i of gen.walls.get(w.id)?.issues ?? []) wallIssues.add(`${w.name}: ${i}`);
  for (const i of wallIssues) alerts.push(['note', i]);
  const empty = !state.bodies.length && !state.walls.length;
  if (!alerts.some(a => a[0] === 'warn') && !empty) alerts.unshift(['ok', 'Todo está dentro del sobre.']);
  if (empty) alerts.push(['note', 'Añadí un cuerpo o dibujá un muro para explorar.']);
  if (m.partial) alerts.push(['note', 'Los OBJ importados no tienen losas: no suman superficie.']);
  if (m.low !== null && m.low < -0.02) alerts.push(['note', 'Parte de la geometría queda bajo la cota de referencia.']);
  $('alerts').replaceChildren(...alerts.map(([k, t]) => { const p = document.createElement('p'); p.className = `alert ${k}`; p.textContent = t; return p; }));
  const bad = alerts.some(a => a[0] === 'warn');
  $('eval-status').textContent = bad ? 'Fuera de algún límite' : empty ? 'Sin geometría' : 'Dentro del sobre'; $('eval-status').className = bad ? 'warn' : '';
  applyBadges(m);
  const comparisons = [['occupation', 'occupation', 'Proyección sin solapes', 'm²'], ['free', 'free', 'Libre de proyección', 'm²'], ['covered', 'covered', 'Losas a cara exterior de piel', 'm²'], ['usable', 'usable', 'Descontando piel y muros', 'm²'], ['height', 'high', 'Desde la cota media', 'm'], ['shadow', 'shadow', 'Sobre el relieve · aprox.', 'm²'], ['efficiency', 'efficiency', 'Cuánto espacio queda para habitar', '%']];
  for (const [id, key, label, unit] of comparisons) {
    const el = $('d-' + id), comparable = baseline && Number.isFinite(m[key]) && Number.isFinite(baseline.metrics[key]) && (key !== 'shadow' || JSON.stringify(state.sun) === JSON.stringify(baseline.sun));
    if (comparable) { const d = m[key] - baseline.metrics[key]; el.textContent = `${d >= 0 ? '+' : ''}${fmt(d)} ${unit} vs. referencia`; } else el.textContent = baseline && key === 'shadow' ? 'Sol distinto a la referencia' : label;
  }
}
$('compare').onclick = () => {
  if (!lastMetrics || metricsBusy || pendingMetrics) return toast('Esperá a que termine el cálculo.');
  baseline = { metrics: structuredClone(lastMetrics), sun: { ...state.sun } }; $('compare').classList.add('is-set'); $('compare').textContent = '◎ Actualizar alternativa de referencia';
  $('comparison-info').textContent = 'Diferencias respecto de este diseño. La comparación de sombras conserva el mismo sol.'; renderMetrics(lastMetrics, 0); toast('Alternativa fijada para comparar');
};

// ---------- Sun ----------
function updateSun() {
  const d = sunVector(state.sun.azimuth, state.sun.elevation); sunlight.position.set(...d.map(v => v * 115)); sunlight.target.position.set(0, 0, 0);
  const t = rad(state.sun.elevation); $('sun-marker').setAttribute('cx', 120 + 95 * Math.cos(t)); $('sun-marker').setAttribute('cy', 65 - 55 * Math.sin(t));
  const names = ['NORTE', 'NORESTE', 'ESTE', 'SURESTE', 'SUR', 'SUROESTE', 'OESTE', 'NOROESTE']; $('sun-direction-label').textContent = names[Math.round(state.sun.azimuth / 45) % 8];
}
const sunInputs = {};
function updateSunUI() { for (const f of ['azimuth', 'elevation']) { sunInputs[f].range.value = sunInputs[f].number.value = state.sun[f]; } }
sunInputs.azimuth = control('azimuth', ['Azimut', 0, 360, 1, '°'], $('solar-controls'), () => state.sun.azimuth, v => { state.sun.azimuth = v; updateSun(); changed({ rebuild: false }); });
sunInputs.elevation = control('elevation', ['Elevación solar', 5, 85, 1, '°'], $('solar-controls'), () => state.sun.elevation, v => { state.sun.elevation = v; updateSun(); changed({ rebuild: false }); });
document.querySelectorAll('[data-sun]').forEach(b => b.onclick = () => { beginEdit(); const [a, e] = b.dataset.sun.split(',').map(Number); state.sun = { azimuth: a, elevation: e }; updateSunUI(); updateSun(); changed({ rebuild: false }); });

// ---------- Sections UI ----------
const lotAxis = (() => { const f = site.front, dx = f[1][0] - f[0][0], dy = f[1][1] - f[0][1]; return THREE.MathUtils.radToDeg(Math.atan2(dy, dx)); })();
const cutAngles = { 'lot-long': lotAxis, 'lot-short': lotAxis + 90, ns: 0, ew: 90 };
function applyCutDirection() { sections.cut.angle = cutAngles[$('cut-direction').value]; }
applyCutDirection();
const planCtl = control('planZ', ['Altura del plano', 0.1, 9, 0.05, 'm'], $('plan-controls'), () => sections.plan.z, v => { sections.plan.z = v; rebuildCuts(); });
function setPlanZ(z) { sections.plan.z = Math.round(z * 100) / 100; planCtl.range.value = planCtl.number.value = sections.plan.z; }
control('cutOffset', ['Posición del plano', -40, 40, 0.1, 'm'], $('cut-controls'), () => sections.cut.offset, v => { sections.cut.offset = v; rebuildCuts(); });
$('plan-cut').onchange = e => { sections.plan.enabled = e.target.checked; autoPlan = false; syncScene(); };
$('vertical-cut').onchange = e => { sections.cut.enabled = e.target.checked; syncScene(); };
$('cut-direction').onchange = () => { applyCutDirection(); rebuildCuts(); };
$('cut-flip').onclick = () => { sections.cut.flip = !sections.cut.flip; rebuildCuts(); };

// ---------- Scene options ----------
$('show-envelope').onchange = e => envelopeGroup.visible = e.target.checked;
$('show-terrain').onchange = e => { terrainGroup.visible = e.target.checked; contourGroup.visible = e.target.checked && $('show-contours').checked; rebuildCuts(); };
$('show-contours').onchange = e => contourGroup.visible = e.target.checked && $('show-terrain').checked;
$('show-wire').onchange = syncScene; $('show-floors').onchange = syncScene; $('show-person').onchange = buildPerson;

// ---------- Resize and render loop ----------
function resize() { const r = viewport.getBoundingClientRect(); renderer.setSize(r.width, r.height); view.setAspect(r.width / r.height); sections.setResolution(r.width, r.height); }
new ResizeObserver(resize).observe(viewport); resize(); view.frame();
const northBadge = document.querySelector('.north-badge svg');
function animate() {
  requestAnimationFrame(animate); view.update();
  const c = new THREE.Vector3(0, 0, 0).project(view.camera), n = new THREE.Vector3(site.north[0], site.north[1], 0).multiplyScalar(10).project(view.camera);
  northBadge.style.transform = `rotate(${Math.atan2(n.x - c.x, n.y - c.y)}rad)`;
  renderer.render(scene, view.camera);
}
animate();

// ---------- Files ----------
function exportMeshes() { const { bodies } = metricInput(); const walls = state.walls.map(w => gen.walls.get(w.id)).filter(Boolean); return collectMeshes(bodies, walls); }
$('export-toggle').onclick = e => { e.stopPropagation(); const open = $('export-list').hidden; $('export-list').hidden = !open; $('export-toggle').setAttribute('aria-expanded', open); };
document.addEventListener('click', () => { $('export-list').hidden = true; $('export-toggle').setAttribute('aria-expanded', false); });
document.querySelectorAll('[data-export]').forEach(b => b.onclick = () => {
  if (!state.bodies.length && !state.walls.length) return toast('No hay geometría para exportar.');
  const ms = exportMeshes(), kind = b.dataset.export;
  try {
    if (kind === 'obj') download(exportOBJ(ms, site), 'refugio-rhino-metros.obj');
    if (kind === 'fbx') download(new Blob([exportFBX(ms, site)], { type: 'application/octet-stream' }), 'refugio.fbx');
    if (kind === 'ifc') download(exportIFC(ms, site), 'refugio.ifc', 'application/x-step');
    toast(`${kind.toUpperCase()} exportado · metros, Z vertical, coordenadas originales de Rhino`);
  } catch (err) { console.error(err); toast(`No se pudo exportar: ${err.message}`); }
});
$('save-project').onclick = () => { download(JSON.stringify({ ...state, source: { units: 'm', origin: site.origin, sourceFile: site.sourceFile } }, null, 2), 'refugio-proyecto.json', 'application/json'); toast('Proyecto editable guardado'); };
$('open-project').onclick = () => $('project-file').click();
$('project-file').onchange = async e => {
  try {
    const f = e.target.files[0]; if (!f) return; if (f.size > 20e6) throw Error('El archivo supera 20 MB.');
    const next = validateState(JSON.parse(await f.text()), site); beginEdit(); state = next; if (!state.person) state.person = { x: 9, y: -4, z: dropZ(9, -4) };
    selection = state.bodies[0] ? { type: 'body', id: state.bodies[0].id } : null; baseline = null;
    $('comparison-info').textContent = 'Guardá un punto de partida y observá qué cambia.'; renderEditor(); updateSunUI(); updateSun(); changed(); toast('Proyecto recuperado');
  } catch (error) { toast(error.message); } finally { e.target.value = ''; }
};
$('import-obj').onclick = () => { toast('OBJ: metros y Z vertical. Se centrará la geometría en el lote.'); $('obj-file').click(); };
$('obj-file').onchange = async e => {
  try {
    const file = e.target.files[0]; if (!file) return; if (file.size > 12e6) throw Error('Usá un OBJ menor de 12 MB.');
    const obj = new OBJLoader().parse(await file.text()); obj.updateMatrixWorld(true);
    const positions = [], indices = [];
    obj.traverse(o => { if (!o.isMesh) return; const g = o.geometry.toNonIndexed?.() || o.geometry, p = g.getAttribute('position'); for (let i = 0; i < p.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); positions.push(v.x, v.y, v.z); indices.push(indices.length); } });
    if (!positions.length) throw Error('El OBJ no contiene superficies.'); if (indices.length / 3 > 15000) throw Error('Simplificá el OBJ a menos de 15.000 triángulos para este prototipo.');
    const bounds = new THREE.Box3(); for (let i = 0; i < positions.length; i += 3) bounds.expandByPoint(new THREE.Vector3(...positions.slice(i, i + 3)));
    const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
    if (Math.max(size.x, size.y, size.z) > 150 || Math.min(size.x, size.y, size.z) < 0.01) throw Error('Revisá las unidades o la geometría del OBJ: se esperan metros y un volumen de menos de 150 m.');
    for (let i = 0; i < positions.length; i += 3) { positions[i] -= center.x; positions[i + 1] -= center.y; positions[i + 2] -= bounds.min.z; }
    beginEdit(); const body = createBody('block', { kind: 'imported', name: file.name.slice(0, 75), width: size.x, depth: size.y, height: size.z, yaw: 0, mesh: { positions, indices, nativeSize: [size.x, size.y, size.z] } });
    state.bodies.push(body); selection = { type: 'body', id: body.id }; renderEditor(); changed(); toast('OBJ añadido. Podés moverlo y rotarlo.');
  } catch (error) { toast(`No se pudo importar: ${error.message}`); } finally { e.target.value = ''; }
};
$('site-info').onclick = () => $('info-dialog').showModal(); document.querySelector('.close-dialog').onclick = () => $('info-dialog').close();
$('info-dialog').addEventListener('click', e => { if (e.target === $('info-dialog')) $('info-dialog').close(); });
$('area-caption').textContent = `${fmt(site.area)} m² de terreno`; $('source-note').textContent = `Lote ${fmt(site.area)} m² en planta · referencia fija`;
$('info-content').innerHTML = `<table><tr><td>Superficie horizontal calculada</td><td>${fmt(site.area, 3)} m²</td></tr><tr><td>Medición comunicada de Rhino</td><td>${fmt(site.reportedRhinoArea, 3)} m²</td></tr><tr><td>Superficie declarada del ejercicio</td><td>921 m²</td></tr><tr><td>Cota media de referencia (Rhino)</td><td>Z ${fmt(site.baseElevation, 3)} m</td></tr><tr><td>Retiro frente / fondo</td><td>10 m / 10 m</td></tr><tr><td>Altura sobre la cota media</td><td>8 m, incluye losas, muros y piel</td></tr></table>
<p>Perímetro y reglas extraídos de <b>refugio_laboratorio.3dm</b>. La malla completa proviene de <b>Terreno en Rhino5.3dm</b>. Norte +Y, conforme a la línea dibujada. Frente: extremo sur.</p>
<p><b>Superficie cubierta</b>: por nivel, la unión de las losas medidas hasta la cara exterior de la piel. <b>Superficie útil</b>: el interior de las losas descontando el espesor de piel y los muros que apoyan en ese nivel. Es una estimación de diseño.</p>
<p>Cada nivel define su altura de piso a piso; la losa (0,20 m por defecto) se ubica al pie de cada nivel. Los muros pueden llegar "hasta la piel": su borde superior sigue la cara interior del refugio o la losa superior.</p>
<p>Ocupación: unión de la proyección de cuerpos y muros dentro del lote. Sombras por rayos sobre el relieve con muestreo de 0,7 m, sin fecha ni hora solar real.</p>
<p>El naranja identifica partes que exceden retiros, lote o techo. Se puede seguir diseñando fuera de los límites. No se verifica estructura, accesibilidad ni cimentación.</p>
<p>Exportación en metros, Z vertical y coordenadas originales de Rhino. <b>OBJ</b> y <b>FBX</b> incluyen piel, losas y muros como mallas. <b>IFC 4</b> organiza por niveles: piel (elemento genérico), losas, muros, puertas y ventanas.</p>`;
document.addEventListener('keydown', e => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) || $('info-dialog').open) return;
  if (tool === 'wall') {
    if (e.key === 'Enter') { e.preventDefault(); finishWall(); return; }
    if (e.key === 'Escape') { if (drawing.points.length) { drawing.points = []; updateDrawPreview(); } else setTool(null); return; }
    if (e.key === 'Backspace') { e.preventDefault(); drawing.points.pop(); updateDrawPreview(); return; }
  }
  if (e.key === 'Escape' && tool) { setTool(null); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); $(e.shiftKey ? 'redo' : 'undo').click(); }
  else if (e.key === 'Delete') $('delete').click();
  else if (e.key.toLowerCase() === 'q') setMode('select'); else if (e.key.toLowerCase() === 'w') setMode('move'); else if (e.key.toLowerCase() === 'e') setMode('rotate');
});
appReady = true; onViewChange(view.name); renderEditor(); updateSun(); syncScene(); queueMetrics(); $('loading').classList.add('hidden');
// Read-only diagnostics for local QA.
window.refugioLab = {
  getState: () => structuredClone(state), getMetrics: () => lastMetrics && structuredClone(lastMetrics), isReady: () => !!lastMetrics && !metricsBusy && !pendingMetrics,
  view: () => view.name,
  focus: (x, y, z, dx, dy, dz) => { view.camera.position.set(x + dx, y + dy, z + dz); view.controls.target.set(x, y, z); view.controls.update(); }, exportMeshes: () => exportMeshes().map(m => ({ name: m.name, kind: m.kind, tris: m.indices.length / 3 })),
  project: (x, y, z) => { const [sx, sy] = toScreen(x, y, z), r = renderer.domElement.getBoundingClientRect(); return [sx + r.left, sy + r.top]; }
};
