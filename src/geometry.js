// Geometry in meters, right-handed XYZ, Z up. Independent from the renderer (runs in the worker too).
import earcut from './earcut.js';

export const rad = d => d * Math.PI / 180;
export const SLAB_DEFAULT = 0.2;
export const PERSON_HEIGHT = 1.75;

export function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
export function closed(ring) { return [...ring.map(p => p.slice()), ring[0].slice()]; }
export function areaMulti(mp) { return mp.reduce((a, p) => a + Math.abs(signedArea(p[0])) - p.slice(1).reduce((b, h) => b + Math.abs(signedArea(h)), 0), 0); }
export function inwardLine(edge, center = [0, 0]) {
  const [a, b] = edge, dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  let n = [-dy / len, dx / len];
  if ((center[0] - a[0]) * n[0] + (center[1] - a[1]) * n[1] < 0) n = n.map(v => -v);
  return { a, n };
}
export function clipHalfPlane(ring, { a, n }, distance) {
  const input = ring.slice();
  if (input.length > 1 && Math.hypot(input[0][0] - input.at(-1)[0], input[0][1] - input.at(-1)[1]) < 1e-8) input.pop();
  const out = [], d = p => (p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1] - distance;
  for (let i = 0; i < input.length; i++) {
    const p = input[i], q = input[(i + 1) % input.length], dp = d(p), dq = d(q);
    if (dp >= -1e-9) out.push(p);
    if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
  }
  return out;
}
export function envelopeFootprint(site) { return clipHalfPlane(clipHalfPlane(site.lot, inwardLine(site.front), site.setback), inwardLine(site.back), site.setback); }
export function sunVector(azimuth, elevation) { const a = rad(azimuth), e = rad(elevation); return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)]; }

/** Inward offset of a CCW ring by d (mitred, clamped). Returns null if the ring collapses. */
export function offsetRing(ring, d) {
  if (d <= 1e-6) return ring.map(p => p.slice(0, 2));
  const ccw = signedArea(ring) > 0, n = ring.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n], p = ring[i], b = ring[(i + 1) % n];
    const e1 = norm2([p[0] - a[0], p[1] - a[1]]), e2 = norm2([b[0] - p[0], b[1] - p[1]]);
    let n1 = [-e1[1], e1[0]], n2 = [-e2[1], e2[0]];
    if (!ccw) { n1 = n1.map(v => -v); n2 = n2.map(v => -v); }
    let m = norm2([n1[0] + n2[0], n1[1] + n2[1]]);
    if (!Number.isFinite(m[0])) m = n1;
    const k = Math.max(0.35, m[0] * n1[0] + m[1] * n1[1]);
    out.push([p[0] + m[0] * d / k, p[1] + m[1] * d / k]);
  }
  const a0 = Math.abs(signedArea(ring)), a1 = signedArea(out) * (ccw ? 1 : -1);
  if (!(a1 > 0.05) || a1 > a0) return null;
  return out;
}
function norm2(v) { const l = Math.hypot(v[0], v[1]); return [v[0] / l, v[1] / l]; }

/** Triangulate a simple ring (with optional holes). Returns index triples into the flattened list. */
export function triangulate(ring, holes = []) {
  const flat = [], holeIdx = [];
  for (const p of ring) flat.push(p[0], p[1]);
  for (const h of holes) { holeIdx.push(flat.length / 2); for (const p of h) flat.push(p[0], p[1]); }
  return earcut(flat, holeIdx.length ? holeIdx : null, 2);
}

export const presets = {
  seed: { label: 'Semilla', width: 10, depth: 17, height: 5.8, bulge: 0.26, taper: 0.7, twist: 15, lobes: 0, ripple: 0, waist: 0.1 },
  corolla: { label: 'Corola', width: 11, depth: 14, height: 6.5, bulge: 0.1, taper: 0.25, twist: 45, lobes: 5, ripple: 0.18, waist: 0.25 },
  strata: { label: 'Estratos', width: 10, depth: 14, height: 5.8, bulge: 0.1, taper: 0.2, twist: 30, lobes: 3, ripple: 0.07, waist: 0.08 },
  block: { label: 'Prisma', width: 8, depth: 12, height: 4, bulge: 0, taper: 0, twist: 0, lobes: 0, ripple: 0, waist: 0 }
};
export function createBody(kind = 'seed', overrides = {}) {
  const p = presets[kind] || presets.seed;
  const { label, ...shape } = p;
  return { id: globalThis.crypto?.randomUUID?.() ?? String(Math.random()), name: 'Refugio', kind, ...shape, x: 0, y: 0, z: 0, yaw: -30,
    levels: [3], slab: SLAB_DEFAULT, shell: 0, color: '#f4f4f1', ...overrides };
}

function section(body, t) {
  if (body.kind === 'block') return [[-body.width / 2, -body.depth / 2], [body.width / 2, -body.depth / 2], [body.width / 2, body.depth / 2], [-body.width / 2, body.depth / 2]];
  const ring = [], N = 40;
  let scale = (1 - body.taper * t) * (1 + body.bulge * Math.sin(Math.PI * t) - body.waist * Math.sin(2 * Math.PI * t));
  scale = Math.max(0.06, scale);
  const twist = rad(body.twist) * t, c = Math.cos(twist), s = Math.sin(twist);
  for (let i = 0; i < N; i++) {
    const angle = 2 * Math.PI * i / N, r = scale * (1 + body.ripple * Math.cos(body.lobes * angle));
    const x = Math.cos(angle) * body.width / 2 * r, y = Math.sin(angle) * body.depth / 2 * r;
    ring.push([c * x - s * y, s * x + c * y]);
  }
  return ring;
}
export function transformPoint(p, body) { const c = Math.cos(rad(body.yaw)), s = Math.sin(rad(body.yaw)); return [c * p[0] - s * p[1] + body.x, s * p[0] + c * p[1] + body.y, (p[2] ?? 0) + body.z]; }

/** Levels: floor-to-floor heights. Returns slab bottoms (local z) for each level. */
export function levelElevations(body) { const z = []; let acc = 0; for (const h of body.levels) { z.push(acc); acc += h; } return z; }

function prism(ring, z0, z1, positions, indices) {
  const base = positions.length / 3, n = ring.length;
  for (const p of ring) positions.push(p[0], p[1], z0);
  for (const p of ring) positions.push(p[0], p[1], z1);
  const tri = triangulate(ring), ccw = signedArea(ring) > 0;
  for (let i = 0; i < tri.length; i += 3) {
    let [a, b, c] = [tri[i], tri[i + 1], tri[i + 2]];
    if (signedArea([ring[a], ring[b], ring[c]]) < 0) [b, c] = [c, b];
    indices.push(base + n + a, base + n + b, base + n + c); // top, facing +z
    indices.push(base + a, base + c, base + b);             // bottom, facing -z
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, [a, b] = ccw ? [i, j] : [j, i];
    indices.push(base + a, base + b, base + n + b, base + a, base + n + b, base + n + a);
  }
}

/** Local geometry of a body: skin (with optional thickness), rings, slabs. */
export function generateBody(body) {
  if (body.kind === 'imported') return { positions: body.mesh.positions.slice(), indices: body.mesh.indices.slice(), rings: [], slabs: [], skipped: [] };
  const positions = [], indices = [], rings = [], bands = body.kind === 'block' ? 1 : 16;
  for (let j = 0; j <= bands; j++) { const t = j / bands; rings.push(section(body, t).map(p => [...p, t * body.height])); }
  const N = rings[0].length, shell = Math.max(0, body.shell || 0);
  const grid = (off, list) => { for (const r of list) for (const p of r) positions.push(...p); return off; };
  // Outer skin
  grid(0, rings);
  for (let j = 0; j < bands; j++) for (let i = 0; i < N; i++) { const a = j * N + i, b = j * N + (i + 1) % N, c = (j + 1) * N + i, d = (j + 1) * N + (i + 1) % N; indices.push(a, b, d, a, d, c); }
  const topC = positions.length / 3; positions.push(0, 0, body.height);
  for (let i = 0; i < N; i++) indices.push(topC, bands * N + i, bands * N + (i + 1) % N);
  if (shell < 0.01) {
    const botC = positions.length / 3; positions.push(0, 0, 0);
    for (let i = 0; i < N; i++) indices.push(botC, (i + 1) % N, i);
  } else {
    // Inner skin: offset each vertex along the side normal; top closed at height - shell.
    const inner = [], ztop = body.height - shell;
    for (let j = 0; j <= bands; j++) {
      const ring = [];
      for (let i = 0; i < N; i++) {
        const P = rings[j][i];
        let n;
        if (body.kind === 'block') { const q = offsetRing(rings[j].map(p => p.slice(0, 2)), shell); ring.push(q ? [q[i][0], q[i][1], Math.min(P[2], ztop)] : [P[0] * 0.5, P[1] * 0.5, Math.min(P[2], ztop)]); continue; }
        const A = rings[j][(i - 1 + N) % N], B = rings[j][(i + 1) % N];
        const D = rings[Math.max(0, j - 1)][i], U = rings[Math.min(bands, j + 1)][i];
        const du = sub(B, A), dv = sub(U, D);
        n = cross(du, dv);
        if (j === 0) n[2] = 0;
        n = norm3(n);
        let q = [P[0] - n[0] * shell, P[1] - n[1] * shell, P[2] - n[2] * shell];
        if (j === 0) q[2] = 0;
        if (q[2] > ztop) q[2] = ztop;
        ring.push(q);
      }
      inner.push(ring);
    }
    const off = positions.length / 3; grid(off, inner);
    for (let j = 0; j < bands; j++) for (let i = 0; i < N; i++) { const a = off + j * N + i, b = off + j * N + (i + 1) % N, c = off + (j + 1) * N + i, d = off + (j + 1) * N + (i + 1) % N; indices.push(a, d, b, a, c, d); }
    const ic = positions.length / 3; positions.push(0, 0, ztop);
    for (let i = 0; i < N; i++) indices.push(ic, off + bands * N + (i + 1) % N, off + bands * N + i);
    for (let i = 0; i < N; i++) { const a = i, b = (i + 1) % N, c = off + i, d = off + (i + 1) % N; indices.push(a, c, d, a, d, b); }
  }
  // Slabs: one per level, from z to z + slab, inside the skin.
  const slabs = [], skipped = [], slab = body.slab ?? SLAB_DEFAULT;
  levelElevations(body).forEach((z, i) => {
    const top = z + slab, limit = body.height - Math.max(shell, 0.02);
    if (top > limit - 0.3) { skipped.push(i); return; }
    const r0 = section(body, z / body.height), r1 = section(body, top / body.height);
    const outer = Math.abs(signedArea(r0)) <= Math.abs(signedArea(r1)) ? r0 : r1;
    const inner = offsetRing(outer, shell);
    if (!inner || Math.abs(signedArea(inner)) < 1) { skipped.push(i); return; }
    const sp = [], si = [];
    prism(inner, z, top, sp, si);
    slabs.push({ level: i, z, top, outer, inner, positions: sp, indices: si });
  });
  return { positions, indices, rings, slabs, skipped };
}
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm3(v) { const l = Math.hypot(...v) || 1; return v.map(x => x / l); }

function transformFlat(positions, body) { const out = new Array(positions.length); for (let i = 0; i < positions.length; i += 3) { const q = transformPoint([positions[i], positions[i + 1], positions[i + 2]], body); out[i] = q[0]; out[i + 1] = q[1]; out[i + 2] = q[2]; } return out; }
/** World-space body data used by metrics and export. */
export function worldBody(body, g = generateBody(body)) {
  const t2 = r => r.map(p => transformPoint(p, body).slice(0, 2));
  return {
    id: body.id, name: body.name, kind: body.kind,
    positions: transformFlat(g.positions, body), indices: g.indices,
    slabs: g.slabs.map(s => ({ level: s.level, z: s.z + body.z, top: s.top + body.z, outer: t2(s.outer), inner: t2(s.inner), positions: transformFlat(s.positions, body), indices: s.indices })),
    skipped: g.skipped
  };
}

export function migrateBody(b) {
  const out = { ...b };
  if (!Array.isArray(out.levels)) { const n = Math.max(1, Math.min(5, Math.round(out.levels || 1))); out.levels = Array.from({ length: n }, () => Math.round(out.height / n * 100) / 100); }
  out.slab ??= SLAB_DEFAULT; out.shell ??= 0;
  if (out.color === '#dde9d5') out.color = '#f4f4f1';
  return out;
}
export function validateState(input, site) {
  if (input?.format !== 'refugio-lab' || ![1, 2].includes(input.version) || input.siteId !== site.id || !Array.isArray(input.bodies) || input.bodies.length > 30) throw Error('Este archivo no es un proyecto compatible con este lote.');
  const state = structuredClone(input);
  state.bodies = state.bodies.map(migrateBody);
  state.walls = Array.isArray(state.walls) ? state.walls : [];
  state.person ??= null;
  const ids = new Set();
  const fields = { x: [-500, 500], y: [-500, 500], z: [-100, 100], yaw: [-3600, 3600], width: [0.1, 150], depth: [0.1, 150], height: [0.1, 100], bulge: [0, 1], taper: [0, 0.95], twist: [-180, 180], lobes: [0, 12], ripple: [0, 0.35], waist: [0, 0.6], slab: [0.05, 1], shell: [0, 2] };
  for (const b of state.bodies) {
    if (typeof b.id !== 'string' || ids.has(b.id) || typeof b.name !== 'string' || b.name.length > 100 || !(b.kind in presets || b.kind === 'imported')) throw Error('Datos de cuerpo inválidos.');
    ids.add(b.id);
    for (const [f, [a, z]] of Object.entries(fields)) if (!Number.isFinite(b[f]) || b[f] < a || b[f] > z) throw Error(`Parámetro inválido: ${f}`);
    if (!Number.isInteger(b.lobes) || !Array.isArray(b.levels) || b.levels.length < 1 || b.levels.length > 6 || !b.levels.every(h => Number.isFinite(h) && h >= 1.5 && h <= 12)) throw Error('Niveles inválidos.');
    if (!/^#[0-9a-f]{6}$/i.test(b.color)) throw Error('Color inválido.');
    if (b.kind === 'imported') { const m = b.mesh; if (!m || !Array.isArray(m.positions) || m.positions.length % 3 || m.positions.length > 180000 || !m.positions.every(Number.isFinite) || !Array.isArray(m.indices) || m.indices.length % 3 || m.indices.length > 240000 || !m.indices.every(i => Number.isInteger(i) && i >= 0 && i < m.positions.length / 3)) throw Error('Malla importada inválida.'); }
  }
  if (state.walls.length > 200) throw Error('Demasiados muros.');
  for (const w of state.walls) {
    if (typeof w.id !== 'string' || ids.has(w.id) || !Array.isArray(w.points) || w.points.length < 2 || w.points.length > 200 || !w.points.every(p => Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(v) && Math.abs(v) < 500))) throw Error('Datos de muro inválidos.');
    ids.add(w.id);
    if (!Number.isFinite(w.base) || !Number.isFinite(w.height) || w.height < 0.3 || w.height > 20 || !Number.isFinite(w.thickness) || w.thickness < 0.05 || w.thickness > 1.5 || !['skin', 'fixed'].includes(w.heightMode)) throw Error('Parámetros de muro inválidos.');
    w.openings = Array.isArray(w.openings) ? w.openings : [];
    for (const o of w.openings) if (!['door', 'window'].includes(o.type) || ![o.seg, o.at, o.width, o.height, o.sill].every(Number.isFinite)) throw Error('Abertura inválida.');
  }
  if (state.person && !['x', 'y', 'z'].every(k => Number.isFinite(state.person[k]))) state.person = null;
  if (!state.sun || !Number.isFinite(state.sun.azimuth) || state.sun.azimuth < 0 || state.sun.azimuth > 360 || !Number.isFinite(state.sun.elevation) || state.sun.elevation < -90 || state.sun.elevation > 90) throw Error('Sol inválido.');
  state.version = 2;
  return state;
}

/** Horizontal section of a body at local height z: outer and inner (skin-offset) rings, world XY. */
export function ringsAt(body, zLocal) {
  if (body.kind === 'imported' || zLocal < 0 || zLocal > body.height) return null;
  const outer = section(body, zLocal / body.height), inner = offsetRing(outer, body.shell || 0);
  const w = r => r && r.map(p => transformPoint(p, body).slice(0, 2));
  return { outer: w(outer), inner: w(inner) };
}
