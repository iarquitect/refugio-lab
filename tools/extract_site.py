"""Extract immutable site data from saved 3DM without running Rhino."""
import hashlib, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '.tools' / 'python'))
import numpy as np
import rhino3dm as r
from shapely.geometry import Polygon, box

root = Path(__file__).resolve().parents[1]
source = root.parent / 'rhino' / 'refugio_laboratorio.3dm'
model = r.File3dm.Read(str(source))
assert model.Settings.ModelUnitSystem == r.UnitSystem.Meters, 'Verificar escala'
layers = {a.Index:a.Name for a in model.Layers}
curves = [o for o in model.Objects if layers.get(o.Attributes.LayerIndex)=='01_LOTE' and isinstance(o.Geometry,r.Curve) and o.Geometry.IsClosed]
assert len(curves)==1, 'Perímetro ambiguo'
lot_raw = np.array([[p.X,p.Y,p.Z] for p in curves[0].Geometry.TryGetPolyline()])
lot = Polygon(lot_raw[:,:2])
assert lot.is_valid and 900 < lot.area < 1000
center = np.array([lot.centroid.x,lot.centroid.y])
rules=[]
for o in model.Objects:
    if layers.get(o.Attributes.LayerIndex)=='02_REGLAS' and isinstance(o.Geometry,r.Curve):
        a,b=o.Geometry.PointAtStart,o.Geometry.PointAtEnd
        rules.append(np.array([[a.X,a.Y],[b.X,b.Y]]))
edges=[x for x in rules if np.linalg.norm(x.mean(axis=0)-center)<50]
assert len(edges)==2
edges.sort(key=lambda x:x[:,1].mean())
northline=[x for x in rules if np.linalg.norm(x.mean(axis=0)-center)>50]
assert len(northline)==1
north=northline[0][1]-northline[0][0]
north/=np.linalg.norm(north)
terrain_source=Path(r'C:\Users\matvi\Downloads\Curso 2026\4. Terreno\Terreno en Rhino5.3dm')
terrain_model=r.File3dm.Read(str(terrain_source))
mesh_objs=[o for o in terrain_model.Objects if isinstance(o.Geometry,r.Mesh) and str(o.Attributes.Id)=='6e8a72b2-8e8e-4637-ad0e-31ed0156a146']
assert len(mesh_objs)==1
mesh=mesh_objs[0].Geometry
vertices=np.array([[p.X,p.Y,p.Z] for p in mesh.Vertices])
faces=[]
for a,b,c,d in mesh.Faces:
    faces.append([a,b,c])
    if c!=d: faces.append([a,c,d])
faces=np.array(faces)
tri=vertices[faces]
minimum,maximum=np.array(lot.bounds[:2]),np.array(lot.bounds[2:])
mask=np.all(tri[:,:,:2].max(axis=1)>=minimum,axis=1)&np.all(tri[:,:,:2].min(axis=1)<=maximum,axis=1)
candidate=tri[mask]
area_sum,z_sum=0.,0.
for t in candidate:
    region=Polygon(t[:,:2]).intersection(lot)
    if region.area<1e-9: continue
    p=region.centroid
    coefficients=np.linalg.solve(np.column_stack([t[:,:2],np.ones(3)]),t[:,2])
    area_sum+=region.area
    z_sum+=region.area*np.dot(coefficients,[p.x,p.y,1.])
base_z=z_sum/area_sum

def heights(points):
    values=np.full(len(points),np.nan)
    for t in candidate:
        a,b,c=t
        det=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
        if abs(det)<1e-12: continue
        u=((b[1]-c[1])*(points[:,0]-c[0])+(c[0]-b[0])*(points[:,1]-c[1]))/det
        v=((c[1]-a[1])*(points[:,0]-c[0])+(a[0]-c[0])*(points[:,1]-c[1]))/det
        w=1-u-v
        valid=(u>=-1e-8)&(v>=-1e-8)&(w>=-1e-8)
        values[valid]=np.fmax(values[valid],u[valid]*a[2]+v[valid]*b[2]+w[valid]*c[2])
    return values

samples=[]
step=0.7
for x in np.arange(minimum[0],maximum[0],step):
    for y in np.arange(minimum[1],maximum[1],step):
        cell=lot.intersection(box(x,y,x+step,y+step))
        if cell.area>1e-8:
            p=cell.centroid
            samples.append([p.x,p.y,cell.area])
samples=np.array(samples)
sample_z=heights(samples[:,:2])
assert np.all(np.isfinite(sample_z))
base_z=float(np.average(sample_z,weights=samples[:,2]))
origin=np.array([center[0],center[1],base_z])
site={
    'version':1,'id':'refugio-lote-967','sourceFile':source.name,
    'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
    'sourceObjectId':str(curves[0].Attributes.Id),'units':'m','origin':origin.tolist(),
    'terrainSource':terrain_source.name,'terrainSha256':hashlib.sha256(terrain_source.read_bytes()).hexdigest(),
    'declaredArea':921.,'reportedRhinoArea':967.853594,'area':lot.area,
    'baseElevation':base_z,'baseMethod':'media de la superficie superior, muestreo de 0.7 m ponderado por área de celda recortada al lote',
    'terrainRange':[float(sample_z.min()),float(sample_z.max())],
    'lot':(lot_raw[:,:2]-center).tolist(),
    'front':(edges[0]-center).tolist(),'back':(edges[1]-center).tolist(),
    'north':north.tolist(),'setback':10.,'maxHeight':8.,'sampleStep':step,
    'samples':[[round(p[0]-center[0],5),round(p[1]-center[1],5),round(z-base_z,5),round(p[2],8)] for p,z in zip(samples,sample_z)],
    'terrain':{'positions':np.round(vertices-origin,5).reshape(-1).tolist(),'indices':faces.reshape(-1).tolist()}
}
target=root/'public'/'site.json'
target.parent.mkdir(exist_ok=True)
target.write_text(json.dumps(site,separators=(',',':')),encoding='utf-8')
print(json.dumps({k:site[k] for k in ['area','baseElevation','terrainRange','origin','north','front','back']},indent=2))
print(f'{len(faces)} triángulos; {len(samples)} muestras; {target.stat().st_size} bytes; fuente intacta')
