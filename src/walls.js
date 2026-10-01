// Walls drawn as polylines in plan. Pure geometry; `rayUp` is injected by the viewer to follow the skin.
import { triangulate, signedArea } from './geometry.js';

export const OPENING_DEFAULTS = {
  door: { width: 0.9, height: 2.05, sill: 0 },
  window: { width: 1.2, height: 1.1, sill: 0.9 }
};
export function createWall(points, overrides = {}) {
  return { id: globalThis.crypto?.randomUUID?.() ?? String(Math.random()), name: 'Muro', points: points.map(p => [p[0], p[1]]), closed: false,
    base: 0, heightMode: 'skin', height: 2.6, thickness: 0.2, openings: [], ...overrides };
}
export function createOpening(type, seg, at) { return { id: globalThis.crypto?.randomUUID?.() ?? String(Math.random()), type, seg, at, ...OPENING_DEFAULTS[type] }; }

export function wallSegments(wall) {
  const pts = wall.points, segs = [], n = pts.length, count = wall.closed ? n : n - 1;
  for (let k = 0; k < count; k++) {
    const P = pts[k], Q = pts[(k + 1) % n], dx = Q[0] - P[0], dy = Q[1] - P[1], L = Math.hypot(dx, dy);
    if (L < 1e-3) continue;
    const u = [dx / L, dy / L], m = [u[1], -u[0]];
    const joinStart = wall.closed || k > 0, joinEnd = wall.closed || k < count - 1;
    segs.push({ index: k, P, Q, L, u, m, e0: joinStart ? wall.thickness / 2 : 0, e1: joinEnd ? wall.thickness / 2 : 0 });
  }
  return segs;
}

/**
 * Builds the wall mesh (world coordinates), plan footprints and diagnostics.
 * rayUp(x, y, z) -> z of the first surface above, or null.
 */
export function generateWall(wall, rayUp = () => null) {
  const positions = [], indices = [], footprints = [], issues = [], openingsOut = [];
  const t = wall.thickness, base = wall.base;
  let top = base;
  for (const seg of wallSegments(wall)) {
    const { P, L, u, m, e0, e1 } = seg, s0 = -e0, s1 = L + e1;
    const world = (s, h, w) => [P[0] + u[0] * s + m[0] * w, P[1] + u[1] * s + m[1] * w, base + h];
    // Openings on this segment, clamped and sorted.
    const ops = wall.openings.filter(o => o.seg === seg.index).map(o => {
      const w = Math.min(o.width, L - 0.1), at = Math.min(Math.max(o.at, w / 2 + 0.05), L - w / 2 - 0.05);
      return { ...o, a: at - w / 2, b: at + w / 2 };
    }).sort((x, y) => x.a - y.a);
    const valid = [];
    for (const o of ops) { if (valid.length && o.a < valid.at(-1).b + 0.05) { issues.push(`Aberturas superpuestas en el tramo ${seg.index + 1}.`); continue; } valid.push(o); }
    // Top profile.
    const ss = new Set([s0, s1]);
    for (let s = s0; s < s1; s += 0.3) ss.add(s);
    for (const o of valid) { ss.add(o.a); ss.add(o.b); }
    const samples = [...ss].sort((a, b) => a - b);
    const heightAt = s => {
      if (wall.heightMode !== 'skin') return wall.height;
      let best = null;
      for (const w of [0, t / 2 - 0.01, -t / 2 + 0.01]) {
        const p = world(s, 0, w), z = rayUp(p[0], p[1], base + 0.02);
        if (z !== null && z !== undefined && Number.isFinite(z)) best = best === null ? z : Math.min(best, z);
      }
      return best === null ? wall.height : Math.max(0.3, Math.min(15, best - base));
    };
    const prof = samples.map(s => [s, heightAt(s)]);
    const hAt = s => { for (let i = 0; i < prof.length - 1; i++) if (s >= prof[i][0] - 1e-9 && s <= prof[i + 1][0] + 1e-9) { const [a, ha] = prof[i], [b, hb] = prof[i + 1]; return b - a < 1e-9 ? ha : ha + (hb - ha) * (s - a) / (b - a); } return prof.at(-1)[1]; };
    const minH = (a, b) => Math.min(...prof.filter(p => p[0] >= a - 1e-9 && p[0] <= b + 1e-9).map(p => p[1]), hAt(a), hAt(b));
    // Outline (CCW in s,h): bottom with door notches, then top profile backwards.
    const outline = [[s0, 0]], holes = [];
    for (const o of valid) {
      const room = minH(o.a, o.b) - 0.1;
      let sill = Math.max(0, o.sill), h = o.height;
      if (sill + h > room) { h = room - sill; issues.push(`${o.type === 'door' ? 'Puerta' : 'Ventana'} recortada: no entra bajo la altura del muro.`); }
      if (h < 0.3) { issues.push(`${o.type === 'door' ? 'Puerta' : 'Ventana'} sin espacio en el tramo ${seg.index + 1}.`); continue; }
      openingsOut.push({ id: o.id, type: o.type, seg: seg.index, a: o.a, b: o.b, sill, height: h,
        corners: [world(o.a, sill, 0), world(o.b, sill, 0), world(o.b, sill + h, 0), world(o.a, sill + h, 0)], u, m, thickness: t });
      if (sill < 0.01) outline.push([o.a, 0], [o.a, h], [o.b, h], [o.b, 0]);
      else holes.push([[o.a, sill], [o.a, sill + h], [o.b, sill + h], [o.b, sill]]); // CW
    }
    outline.push([s1, 0]);
    for (let i = prof.length - 1; i >= 0; i--) outline.push(prof[i]);
    top = Math.max(top, base + Math.max(...prof.map(p => p[1])));
    // Faces.
    const addFace = (loop2d, holeLoops, w, facing) => {
      const tri = triangulate(loop2d, holeLoops), all = [...loop2d, ...holeLoops.flat()], off = positions.length / 3;
      for (const p of all) positions.push(...world(p[0], p[1], w));
      for (let i = 0; i < tri.length; i += 3) {
        let [a, b, c] = [tri[i], tri[i + 1], tri[i + 2]];
        const ccw = signedArea([all[a], all[b], all[c]]) > 0;
        if (ccw !== (facing > 0)) [b, c] = [c, b];
        indices.push(off + a, off + b, off + c);
      }
    };
    addFace(outline, holes, t / 2, 1);
    addFace(outline, holes, -t / 2, -1);
    const sides = (loop, interiorLeft) => {
      for (let i = 0; i < loop.length; i++) {
        const p = loop[i], q = loop[(i + 1) % loop.length];
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-9) continue;
        const off = positions.length / 3;
        positions.push(...world(p[0], p[1], t / 2), ...world(q[0], q[1], t / 2), ...world(q[0], q[1], -t / 2), ...world(p[0], p[1], -t / 2));
        // Outward (in s,h) is to the right of p->q when interior is on the left.
        const ds = q[0] - p[0], dh = q[1] - p[1], out2 = interiorLeft ? [dh, -ds] : [-dh, ds];
        const outW = [u[0] * out2[0], u[1] * out2[0], out2[1]];
        const A = positions.slice(off * 3, off * 3 + 3), B = positions.slice(off * 3 + 3, off * 3 + 6), C = positions.slice(off * 3 + 6, off * 3 + 9);
        const n = cross(subv(B, A), subv(C, A)), flip = n[0] * outW[0] + n[1] * outW[1] + n[2] * outW[2] < 0;
        if (flip) indices.push(off, off + 2, off + 1, off, off + 3, off + 2); else indices.push(off, off + 1, off + 2, off, off + 2, off + 3);
      }
    };
    sides(outline, signedArea(outline) > 0);
    for (const h of holes) sides(h, !(signedArea(h) > 0)); // interior of the solid is outside the hole
    const c = (s, w) => { const p = world(s, 0, w); return [p[0], p[1]]; };
    footprints.push([c(s0, -t / 2), c(s1, -t / 2), c(s1, t / 2), c(s0, t / 2)]);
  }
  return { id: wall.id, name: wall.name, base, top, positions, indices, footprints, openings: openingsOut, issues };
}
function subv(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

/** Closest point on the wall centerline to (x, y): {seg, at, dist}. */
export function nearestOnWall(wall, x, y) {
  let best = null;
  for (const s of wallSegments(wall)) {
    const at = Math.max(0, Math.min(s.L, (x - s.P[0]) * s.u[0] + (y - s.P[1]) * s.u[1]));
    const px = s.P[0] + s.u[0] * at, py = s.P[1] + s.u[1] * at, dist = Math.hypot(x - px, y - py);
    if (!best || dist < best.dist) best = { seg: s.index, at, dist, L: s.L };
  }
  return best;
}
