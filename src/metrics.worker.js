import { calculateMetrics } from './metrics.js';
let site;
self.onmessage = ({ data }) => {
  if (data.site) { site = data.site; return; }
  const start = performance.now();
  try { const metrics = calculateMetrics(data.bodies, data.walls, site, data.sun); self.postMessage({ revision: data.revision, metrics, elapsed: performance.now() - start }); }
  catch (error) { self.postMessage({ revision: data.revision, error: error.message }); }
};
