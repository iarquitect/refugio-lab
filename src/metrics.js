import pc from 'polygon-clipping';
import { areaMulti, signedArea, closed, envelopeFootprint, sunVector } from './geometry.js';

export function union(polygons) { if (!polygons.length) return []; let accum = []; for (let i = 0; i < polygons.length; i += 80) accum = pc.union(accum, ...polygons.slice(i, i + 80)); return accum; }
const asPoly = ring => [closed(ring)];
export function projectMesh(g) {
  const polys = [];
  for (let i = 0; i < g.indices.length; i += 3) {
    const ring = g.indices.slice(i, i + 3).map(k => [g.positions[k * 3], g.positions[k * 3 + 1]]);
    if (Math.abs(signedArea(ring)) > 1e-8) polys.push([closed(ring)]);
  }
  return union(polys);
}
function zRange(positions) { let lo = Infinity, hi = -Infinity; for (let j = 2; j < positions.length; j += 3) { lo = Math.min(lo, positions[j]); hi = Math.max(hi, positions[j]); } return [lo, hi]; }

// Triangles grouped by object with an AABB for a quick reject.
function makeGroups(meshes) {
  return meshes.filter(m => m.indices.length).map(g => {
    const p = g.positions, tris = [], min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]); }
    for (let i = 0; i < g.indices.length; i += 3) {
      const a = g.indices[i] * 3, b = g.indices[i + 1] * 3, c = g.indices[i + 2] * 3;
      tris.push([p[a], p[a + 1], p[a + 2], p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2], p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]]);
    }
    return { min, max, tris };
  });
}
function rayBox(o, d, min, max) {
  let t0 = 0, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-12) { if (o[k] < min[k] || o[k] > max[k]) return false; continue; }
    let a = (min[k] - o[k]) / d[k], b = (max[k] - o[k]) / d[k]; if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) return false;
  }
  return true;
}
function rayHits(p, d, t) {
  const hx = d[1] * t[8] - d[2] * t[7], hy = d[2] * t[6] - d[0] * t[8], hz = d[0] * t[7] - d[1] * t[6], det = t[3] * hx + t[4] * hy + t[5] * hz;
  if (Math.abs(det) < 1e-9) return false;
  const inv = 1 / det, sx = p[0] - t[0], sy = p[1] - t[1], sz = p[2] - t[2];
  const u = (sx * hx + sy * hy + sz * hz) * inv; if (u < 0 || u > 1) return false;
  const qx = sy * t[5] - sz * t[4], qy = sz * t[3] - sx * t[5], qz = sx * t[4] - sy * t[3];
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (v < 0 || u + v > 1) return false;
  return (t[6] * qx + t[7] * qy + t[8] * qz) * inv > 1e-5;
}

/**
 * bodies: worldBody() results. walls: generateWall() results.
 * Covered area ("cubierta"): per level, union of slab outlines measured to the outer face of the skin.
 * Usable area ("útil"): per level, union of slab interiors minus walls standing on that level.
 */
export function calculateMetrics(bodies, walls, site, sun, { withShadow = true } = {}) {
  const lot = [asPoly(site.lot.slice(0, -1))], buildable = [asPoly(envelopeFootprint(site))];
  const items = [
    ...bodies.map(b => ({ id: b.id, type: 'body', proj: projectMesh(b), meshes: [b, ...b.slabs] })),
    ...walls.map(w => ({ id: w.id, type: 'wall', proj: union(w.footprints.map(asPoly)), meshes: [w] }))
  ];
  const all = union(items.map(i => i.proj).filter(p => p.length));
  const inside = all.length ? pc.intersection(all, lot) : [], outside = all.length ? pc.difference(all, lot) : [];
  const retreat = all.length ? pc.intersection(pc.difference(all, buildable), lot) : [];
  let high = -Infinity, low = Infinity, partial = false;
  const perItem = items.map(it => {
    let hi = -Infinity, lo = Infinity;
    for (const m of it.meshes) { const [a, b] = zRange(m.positions); lo = Math.min(lo, a); hi = Math.max(hi, b); }
    high = Math.max(high, hi); low = Math.min(low, lo);
    const out = it.proj.length ? areaMulti(pc.difference(it.proj, lot)) : 0;
    const ret = it.proj.length ? areaMulti(pc.intersection(pc.difference(it.proj, buildable), lot)) : 0;
    return { id: it.id, type: it.type, high: hi, outside: out, setback: ret, violates: hi > site.maxHeight + 0.01 || out > 0.01 || ret > 0.01 };
  });
  // Levels keyed by slab top (cm).
  const levels = new Map(), key = z => Math.round(z * 100);
  for (const b of bodies) {
    if (b.kind === 'imported') partial = true;
    for (const s of b.slabs) { const k = key(s.top); if (!levels.has(k)) levels.set(k, { top: s.top, outer: [], inner: [], walls: [] }); const L = levels.get(k); L.outer.push(asPoly(s.outer)); L.inner.push(asPoly(s.inner)); }
  }
  for (const w of walls) { const L = levels.get(key(w.base)); if (L) L.walls.push(...w.footprints.map(asPoly)); }
  let covered = 0, usable = 0;
  const perLevel = [];
  for (const L of [...levels.values()].sort((a, b) => a.top - b.top)) {
    const c = areaMulti(union(L.outer)), innerU = union(L.inner), wallsU = union(L.walls);
    const u = areaMulti(wallsU.length ? pc.difference(innerU, wallsU) : innerU);
    covered += c; usable += u; perLevel.push({ top: L.top, covered: c, usable: u });
  }
  let shadow = null;
  if (withShadow && sun.elevation > 0) {
    shadow = 0; const d = sunVector(sun.azimuth, sun.elevation), groups = makeGroups(items.flatMap(i => i.meshes));
    for (const s of site.samples) {
      const p = [s[0], s[1], s[2] + 0.025];
      if (groups.some(g => rayBox(p, d, g.min, g.max) && g.tris.some(t => rayHits(p, d, t)))) shadow += s[3];
    }
  }
  const any = items.length > 0, occupation = areaMulti(inside);
  return {
    occupation, occupationPercent: occupation / site.area * 100, free: Math.max(0, site.area - occupation),
    covered: partial && !levels.size ? null : covered, usable: partial && !levels.size ? null : usable,
    efficiency: covered > 0 ? usable / covered * 100 : null, perLevel,
    high: any ? high : null, margin: any ? site.maxHeight - high : site.maxHeight, low: any ? low : null,
    outsideArea: areaMulti(outside), setbackArea: areaMulti(retreat), shadow, perItem, partial, levels: levels.size
  };
}
