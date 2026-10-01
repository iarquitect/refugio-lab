// Minimal binary FBX 7.4 writer (meshes + one material per kind). Z up, meters (UnitScaleFactor 100 = 1 unit is 1 m).
import { safeName } from './export.js';

const FILE_ID = [0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1];
const FOOT_ID = [0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e];
const FOOT_MAGIC = [0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b];
const TIME = '1970-01-01 10:00:00:000';
const enc = new TextEncoder();

class Buf {
  constructor() { this.chunks = []; this.length = 0; }
  bytes(u8) { this.chunks.push(u8); this.length += u8.length; }
  u8(v) { this.bytes(Uint8Array.of(v)); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); this.bytes(b); }
  out() { const r = new Uint8Array(this.length); let o = 0; for (const c of this.chunks) { r.set(c, o); o += c.length; } return r; }
}
// Property constructors
const I = v => ({ t: 'I', v }), D = v => ({ t: 'D', v }), L = v => ({ t: 'L', v }), S = v => ({ t: 'S', v }), C = v => ({ t: 'C', v }), R = v => ({ t: 'R', v });
const di = v => ({ t: 'd', v }), ii = v => ({ t: 'i', v });
function propBytes(p) {
  const b = new Buf(); b.bytes(enc.encode(p.t));
  const dv = (n, fn) => { const a = new Uint8Array(n); fn(new DataView(a.buffer)); b.bytes(a); };
  switch (p.t) {
    case 'I': dv(4, d => d.setInt32(0, p.v, true)); break;
    case 'D': dv(8, d => d.setFloat64(0, p.v, true)); break;
    case 'L': dv(8, d => d.setBigInt64(0, BigInt(p.v), true)); break;
    case 'C': b.u8(p.v ? 1 : 0); break;
    case 'S': { const s = typeof p.v === 'string' ? enc.encode(p.v) : Uint8Array.from(p.v); b.u32(s.length); b.bytes(s); break; }
    case 'R': b.u32(p.v.length); b.bytes(Uint8Array.from(p.v)); break;
    case 'd': b.u32(p.v.length); b.u32(0); b.u32(p.v.length * 8); dv(p.v.length * 8, d => p.v.forEach((x, i) => d.setFloat64(i * 8, x, true))); break;
    case 'i': b.u32(p.v.length); b.u32(0); b.u32(p.v.length * 4); dv(p.v.length * 4, d => p.v.forEach((x, i) => d.setInt32(i * 4, x, true))); break;
  }
  return b.out();
}
const N = (name, props = [], children = []) => ({ name, props, children });
const P = (name, type, label, flags, ...vals) => N('P', [S(name), S(type), S(label), S(flags), ...vals]);

function writeNode(buf, node, start) {
  const props = node.props.map(propBytes), plen = props.reduce((a, p) => a + p.length, 0), name = enc.encode(node.name);
  const head = new Buf();
  const body = new Buf();
  for (const p of props) body.bytes(p);
  const needSentinel = node.children.length > 0 || node.props.length === 0;
  let offset = start + 13 + name.length + plen;
  const kids = new Buf();
  for (const c of node.children) offset = writeNode(kids, c, offset);
  if (needSentinel) { kids.bytes(new Uint8Array(13)); offset += 13; }
  head.u32(offset); head.u32(node.props.length); head.u32(plen); head.u8(name.length); head.bytes(name);
  buf.bytes(head.out()); buf.bytes(body.out()); buf.bytes(kids.out());
  return offset;
}

export function exportFBX(meshes, site) {
  const o = site.origin; let nextId = 1000000n;
  const id = () => Number(nextId++);
  const palette = { skin: [0.94, 0.94, 0.92], slab: [0.72, 0.72, 0.70], wall: [0.86, 0.84, 0.80] };
  const mats = {}, objects = [], connections = [];
  for (const [kind, rgb] of Object.entries(palette)) {
    const mid = id(); mats[kind] = mid;
    objects.push(N('Material', [L(mid), S(`${kind}\x00\x01Material`), S('')], [
      N('Version', [I(102)]), N('ShadingModel', [S('lambert')]), N('MultiLayer', [I(0)]),
      N('Properties70', [], [P('DiffuseColor', 'Color', '', 'A', D(rgb[0]), D(rgb[1]), D(rgb[2])), P('Diffuse', 'Vector3D', 'Vector', '', D(rgb[0]), D(rgb[1]), D(rgb[2]))])
    ]));
  }
  const used = new Set();
  for (const m of meshes) {
    let base = safeName(m.name), name = base, k = 2; while (used.has(name)) name = `${base}_${k++}`; used.add(name);
    const gid = id(), mid = id();
    const verts = []; for (let i = 0; i < m.positions.length; i += 3) verts.push(m.positions[i] + o[0], m.positions[i + 1] + o[1], m.positions[i + 2] + o[2]);
    const pvi = []; for (let i = 0; i < m.indices.length; i += 3) pvi.push(m.indices[i], m.indices[i + 1], -m.indices[i + 2] - 1);
    objects.push(N('Geometry', [L(gid), S(`${name}\x00\x01Geometry`), S('Mesh')], [
      N('Properties70'), N('GeometryVersion', [I(124)]),
      N('Vertices', [di(verts)]), N('PolygonVertexIndex', [ii(pvi)]),
      N('LayerElementMaterial', [I(0)], [N('Version', [I(101)]), N('Name', [S('')]), N('MappingInformationType', [S('AllSame')]), N('ReferenceInformationType', [S('IndexToDirect')]), N('Materials', [ii([0])])]),
      N('Layer', [I(0)], [N('Version', [I(100)]), N('LayerElement', [], [N('Type', [S('LayerElementMaterial')]), N('TypedIndex', [I(0)])])])
    ]));
    objects.push(N('Model', [L(mid), S(`${name}\x00\x01Model`), S('Mesh')], [
      N('Version', [I(232)]),
      N('Properties70', [], [P('DefaultAttributeIndex', 'int', 'Integer', '', I(0)), P('Lcl Translation', 'Lcl Translation', '', 'A', D(0), D(0), D(0))]),
      N('MultiLayer', [I(0)]), N('MultiTake', [I(0)]), N('Shading', [C(true)]), N('Culling', [S('CullingOff')])
    ]));
    connections.push(N('C', [S('OO'), L(mid), L(0)]), N('C', [S('OO'), L(gid), L(mid)]), N('C', [S('OO'), L(mats[m.kind] ?? mats.skin), L(mid)]));
  }
  const nModels = meshes.length;
  const now = new Date();
  const root = [
    N('FBXHeaderExtension', [], [
      N('FBXHeaderVersion', [I(1003)]), N('FBXVersion', [I(7400)]), N('EncryptionType', [I(0)]),
      N('CreationTimeStamp', [], [N('Version', [I(1000)]), N('Year', [I(now.getFullYear())]), N('Month', [I(now.getMonth() + 1)]), N('Day', [I(now.getDate())]), N('Hour', [I(now.getHours())]), N('Minute', [I(now.getMinutes())]), N('Second', [I(now.getSeconds())]), N('Millisecond', [I(0)])]),
      N('Creator', [S('Refugio Lab')])
    ]),
    N('FileId', [R(FILE_ID)]), N('CreationTime', [S(TIME)]), N('Creator', [S('Refugio Lab')]),
    N('GlobalSettings', [], [N('Version', [I(1000)]), N('Properties70', [], [
      P('UpAxis', 'int', 'Integer', '', I(2)), P('UpAxisSign', 'int', 'Integer', '', I(1)),
      P('FrontAxis', 'int', 'Integer', '', I(1)), P('FrontAxisSign', 'int', 'Integer', '', I(-1)),
      P('CoordAxis', 'int', 'Integer', '', I(0)), P('CoordAxisSign', 'int', 'Integer', '', I(1)),
      P('OriginalUpAxis', 'int', 'Integer', '', I(2)), P('OriginalUpAxisSign', 'int', 'Integer', '', I(1)),
      P('UnitScaleFactor', 'double', 'Number', '', D(100)), P('OriginalUnitScaleFactor', 'double', 'Number', '', D(100))
    ])]),
    N('Documents', [], [N('Count', [I(1)]), N('Document', [L(id()), S(''), S('Scene')], [N('Properties70', [], [P('SourceObject', 'object', '', ''), P('ActiveAnimStackName', 'KString', '', '', S(''))]), N('RootNode', [L(0)])])]),
    N('References'),
    N('Definitions', [], [N('Version', [I(100)]), N('Count', [I(1 + nModels * 2 + 3)]),
      N('ObjectType', [S('GlobalSettings')], [N('Count', [I(1)])]),
      N('ObjectType', [S('Model')], [N('Count', [I(nModels)])]),
      N('ObjectType', [S('Geometry')], [N('Count', [I(nModels)])]),
      N('ObjectType', [S('Material')], [N('Count', [I(3)])])]),
    N('Objects', [], objects),
    N('Connections', [], connections)
  ];
  const buf = new Buf();
  buf.bytes(enc.encode('Kaydara FBX Binary  \x00')); buf.u8(0x1a); buf.u8(0x00); buf.u32(7400);
  let offset = buf.length;
  for (const n of root) offset = writeNode(buf, n, offset);
  buf.bytes(new Uint8Array(13)); offset += 13;
  buf.bytes(Uint8Array.from(FOOT_ID)); buf.bytes(new Uint8Array(4)); offset += 20;
  let pad = ((offset + 15) & ~15) - offset; if (pad === 0) pad = 16;
  buf.bytes(new Uint8Array(pad)); buf.u32(7400); buf.bytes(new Uint8Array(120)); buf.bytes(Uint8Array.from(FOOT_MAGIC));
  return buf.out();
}
