"""Read-only inventory; never opens Rhino or modifies a source model."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '.tools' / 'python'))
import rhino3dm as r

path = Path(sys.argv[1])
model = r.File3dm.Read(str(path))
if model is None:
    raise RuntimeError('No se pudo leer el 3DM')
layers = {layer.Index: layer.Name for layer in model.Layers}
result = {'source': str(path), 'units': str(model.Settings.ModelUnitSystem), 'layers': layers, 'objects': []}
for obj in model.Objects:
    g = obj.Geometry
    b = g.GetBoundingBox()
    row = {'id': str(obj.Attributes.Id), 'layer': layers.get(obj.Attributes.LayerIndex), 'name': obj.Attributes.Name,
           'type': type(g).__name__, 'bbox': [[b.Min.X, b.Min.Y, b.Min.Z], [b.Max.X, b.Max.Y, b.Max.Z]]}
    if isinstance(g, r.Curve):
        row['closed'] = g.IsClosed
        poly = g.TryGetPolyline()
        if poly:
            row['points'] = [[p.X, p.Y, p.Z] for p in poly]
        else:
            row['ends'] = [[g.PointAtStart.X,g.PointAtStart.Y,g.PointAtStart.Z],[g.PointAtEnd.X,g.PointAtEnd.Y,g.PointAtEnd.Z]]
    if isinstance(g, r.Mesh):
        row['vertices'], row['faces'] = len(g.Vertices), len(g.Faces)
    if isinstance(g, r.Brep):
        row['edges'] = []
        for edge in g.Edges:
            a, z = edge.PointAtStart, edge.PointAtEnd
            row['edges'].append([[a.X,a.Y,a.Z],[z.X,z.Y,z.Z]])
    result['objects'].append(row)
print(json.dumps(result, indent=2, ensure_ascii=False))
