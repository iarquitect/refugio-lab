import { Earcut } from 'three/src/extras/Earcut.js';
export default function earcut(data, holeIndices, dim = 2) { return Earcut.triangulate(data, holeIndices, dim); }
