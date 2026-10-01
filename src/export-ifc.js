// IFC4 (STEP) writer: project > site > building > storeys; skins as proxies, slabs, walls, doors and windows.
// Geometry as IfcTriangulatedFaceSet in meters. The site placement carries the original Rhino origin.

const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
export function ifcGuid() {
  const bytes = new Uint8Array(16); globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = ''; for (let i = 0; i < 22; i++) { s = B64[Number(n & 63n)] + s; n >>= 6n; }
  return s;
}
const str = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[^\x20-\x7e]/g, c => `\\X2\\${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}\\X0\\`)}'`;
const num = v => { const s = (Math.abs(v) < 1e-12 ? 0 : v).toFixed(6).replace(/0+$/, ''); return s.endsWith('.') ? s : s; };

export function exportIFC(meshes, site, { project = 'Refugio Lab', author = '' } = {}) {
  const lines = []; let n = 0;
  const e = txt => { n++; lines.push(`#${n}=${txt};`); return `#${n}`; };
  const pt = (x, y, z) => e(`IFCCARTESIANPOINT((${num(x)},${num(y)},${num(z)}))`);
  const dir = (x, y, z) => e(`IFCDIRECTION((${num(x)},${num(y)},${num(z)}))`);
  const origin = pt(0, 0, 0), zdir = dir(0, 0, 1), xdir = dir(1, 0, 0);
  const axis = e(`IFCAXIS2PLACEMENT3D(${origin},${zdir},${xdir})`);
  const ctx = e(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${axis},${e('IFCDIRECTION((0.,1.))')})`);
  const body = e(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const units = e(`IFCUNITASSIGNMENT((${[
    e('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)'), e('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)'),
    e('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)'), e('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)')].join(',')}))`);
  const proj = e(`IFCPROJECT('${ifcGuid()}',$,${str(project)},$,$,$,$,(${ctx}),${units})`);
  const o = site.origin;
  const sitePl = e(`IFCLOCALPLACEMENT($,${e(`IFCAXIS2PLACEMENT3D(${pt(o[0], o[1], o[2])},${zdir},${xdir})`)})`);
  const siteE = e(`IFCSITE('${ifcGuid()}',$,'Lote del ejercicio',${str(`Lote ${site.area.toFixed(2)} m2 en planta; retiros ${site.setback} m; altura maxima ${site.maxHeight} m`)},$,${sitePl},$,$,.ELEMENT.,$,$,${num(o[2])},$,$)`);
  const bldPl = e(`IFCLOCALPLACEMENT(${sitePl},${axis})`);
  const bld = e(`IFCBUILDING('${ifcGuid()}',$,'Refugio',$,$,${bldPl},$,$,.ELEMENT.,$,$,$)`);
  e(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${proj},(${siteE}))`);
  e(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${siteE},(${bld}))`);
  // Storeys by level (slab top), plus ground.
  let keys = [...new Set(meshes.filter(m => m.kind === 'slab').map(m => Math.round(m.level * 100)))].sort((a, b) => a - b);
  if (!keys.length) keys = [0];
  const storeys = new Map();
  keys.forEach((k, i) => {
    const pl = e(`IFCLOCALPLACEMENT(${bldPl},${axis})`);
    storeys.set(k, { ref: e(`IFCBUILDINGSTOREY('${ifcGuid()}',$,${str(i === 0 ? 'Planta baja' : `Nivel ${i}`)},$,$,${pl},$,$,.ELEMENT.,${num(k / 100)})`), pl, items: [] });
  });
  e(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${bld},(${[...storeys.values()].map(s => s.ref).join(',')}))`);
  const storeyFor = z => { let best = keys[0]; for (const k of keys) if (k <= Math.round(z * 100) + 1) best = k; return storeys.get(best); };
  // Styles
  const style = {};
  for (const [kind, rgb, label] of [['skin', [0.94, 0.94, 0.92], 'Piel'], ['slab', [0.72, 0.72, 0.7], 'Losa'], ['wall', [0.86, 0.84, 0.8], 'Muro'], ['door', [0.55, 0.42, 0.3], 'Puerta'], ['window', [0.6, 0.78, 0.88], 'Vidrio']]) {
    const col = e(`IFCCOLOURRGB($,${num(rgb[0])},${num(rgb[1])},${num(rgb[2])})`);
    const rend = e(`IFCSURFACESTYLERENDERING(${col},${kind === 'window' ? '0.5' : '0.'},$,$,$,$,$,$,.NOTDEFINED.)`);
    style[kind] = e(`IFCSURFACESTYLE(${str(label)},.BOTH.,(${rend}))`);
  }
  const shape = (positions, indices, kind) => {
    const coords = []; for (let i = 0; i < positions.length; i += 3) coords.push(`(${num(positions[i])},${num(positions[i + 1])},${num(positions[i + 2])})`);
    const tris = []; for (let i = 0; i < indices.length; i += 3) tris.push(`(${indices[i] + 1},${indices[i + 1] + 1},${indices[i + 2] + 1})`);
    const list = e(`IFCCARTESIANPOINTLIST3D((${coords.join(',')}))`);
    const fs = e(`IFCTRIANGULATEDFACESET(${list},$,$,(${tris.join(',')}),$)`);
    e(`IFCSTYLEDITEM(${fs},(${style[kind]}),$)`);
    const rep = e(`IFCSHAPEREPRESENTATION(${body},'Body','Tessellation',(${fs}))`);
    return e(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`);
  };
  const place = st => e(`IFCLOCALPLACEMENT(${st.pl},${axis})`);
  for (const m of meshes) {
    if (!m.indices.length) continue;
    const st = m.kind === 'skin' ? storeys.get(keys[0]) : storeyFor(m.level), rep = shape(m.positions, m.indices, m.kind);
    let ref;
    if (m.kind === 'skin') ref = e(`IFCBUILDINGELEMENTPROXY('${ifcGuid()}',$,${str(m.name)},'Envolvente del refugio',$,${place(st)},${rep},$,.NOTDEFINED.)`);
    else if (m.kind === 'slab') ref = e(`IFCSLAB('${ifcGuid()}',$,${str(m.name)},$,$,${place(st)},${rep},$,.FLOOR.)`);
    else ref = e(`IFCWALL('${ifcGuid()}',$,${str(m.name)},$,$,${place(st)},${rep},$,.STANDARD.)`);
    st.items.push(ref);
    for (const op of m.openings ?? []) {
      const box = panel(op), r2 = shape(box.positions, box.indices, op.type);
      const w = num(op.b - op.a), h = num(op.height);
      st.items.push(op.type === 'door'
        ? e(`IFCDOOR('${ifcGuid()}',$,'Puerta',$,$,${place(st)},${r2},$,${h},${w},.DOOR.,.SINGLE_SWING_LEFT.,$)`)
        : e(`IFCWINDOW('${ifcGuid()}',$,'Ventana',$,$,${place(st)},${r2},$,${h},${w},.WINDOW.,.SINGLE_PANEL.,$)`));
    }
  }
  for (const st of storeys.values()) if (st.items.length) e(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${ifcGuid()}',$,$,$,(${st.items.join(',')}),${st.ref})`);
  const now = new Date().toISOString().slice(0, 19);
  return ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
    `FILE_NAME('refugio.ifc','${now}',(${str(author)}),(''),'Refugio Lab','Refugio Lab','');`, "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
}

// Thin panel centered in the opening (a simple leaf or pane), in model coordinates.
function panel(op) {
  const [a, b, c, d] = op.corners, th = Math.min(0.05, op.thickness * 0.4), m = op.m;
  const pos = [], off = s => [m[0] * s, m[1] * s, 0];
  for (const s of [-th / 2, th / 2]) for (const p of [a, b, c, d]) { const q = off(s); pos.push(p[0] + q[0], p[1] + q[1], p[2]); }
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions: pos, indices: idx };
}
