// Export helpers. Everything is exported in meters, Z up, at the original Rhino coordinates (site.origin).
export const safeName = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'objeto';

/**
 * Flat list of exportable meshes, in model coordinates (origin not applied).
 * bodies: worldBody() results; walls: generateWall() results.
 */
export function collectMeshes(bodies, walls) {
  const out = [];
  for (const b of bodies) {
    out.push({ name: `${b.name}_piel`, kind: 'skin', level: 0, owner: b.name, positions: b.positions, indices: b.indices });
    for (const s of b.slabs) out.push({ name: `${b.name}_losa_${s.level === 0 ? 'PB' : 'N' + s.level}`, kind: 'slab', level: s.top, z: s.z, owner: b.name, positions: s.positions, indices: s.indices });
  }
  walls.forEach((w, i) => {
    out.push({ name: `${w.name || 'Muro'}_${i + 1}`, kind: 'wall', level: w.base, positions: w.positions, indices: w.indices, openings: w.openings });
  });
  return out;
}

export function exportOBJ(meshes, site) {
  const o = site.origin, lines = ['# Refugio Lab - refugio, losas y muros', '# Unidades: metros. Coordenadas originales de Rhino, Z vertical.', `# Origen: ${o.join(' ')}`, '# Terreno, sobre y ayudas excluidos.'];
  let offset = 1;
  for (const m of meshes) {
    lines.push(`o ${safeName(m.name)}`);
    for (let i = 0; i < m.positions.length; i += 3) lines.push(`v ${(m.positions[i] + o[0]).toFixed(5)} ${(m.positions[i + 1] + o[1]).toFixed(5)} ${(m.positions[i + 2] + o[2]).toFixed(5)}`);
    for (let i = 0; i < m.indices.length; i += 3) lines.push(`f ${m.indices[i] + offset} ${m.indices[i + 1] + offset} ${m.indices[i + 2] + offset}`);
    offset += m.positions.length / 3;
  }
  return lines.join('\n') + '\n';
}

export function download(content, name, type = 'text/plain') {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
