'use strict';

const DEG = Math.PI / 180;
const HAZARDS = ['road', 'highway', 'power', 'housing', 'settlement', 'rail', 'airport', 'trees', 'public', 'water'];
const WEIGHTS = { road: 18, highway: 26, power: 28, housing: 35, settlement: 42, rail: 24, airport: 45, trees: 18, public: 24, water: 26 };

function clamp(v, min, max) { return Math.max(min, Math.min(max, Number.isFinite(v) ? v : min)); }
function category(tags) {
  if (tags.aeroway) return 'airport';
  if (['line', 'minor_line', 'tower', 'pole'].includes(tags.power)) return 'power';
  if (tags.natural === 'water' || tags.waterway || ['reservoir', 'basin'].includes(tags.landuse)) return 'water';
  if (tags.place && ['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'quarter'].includes(tags.place)) return 'settlement';
  if (tags.building || ['residential', 'industrial', 'commercial', 'retail', 'construction', 'brownfield', 'garages', 'cemetery', 'farmyard'].includes(tags.landuse) || ['school', 'kindergarten', 'college', 'university', 'hospital', 'clinic', 'place_of_worship', 'community_centre'].includes(tags.amenity)) return 'housing';
  if (tags.railway) return 'rail';
  if (tags.highway) return ['motorway', 'trunk', 'primary', 'secondary'].includes(tags.highway) ? 'highway' : 'road';
  if (tags.natural === 'wood' || tags.natural === 'tree' || tags.natural === 'tree_row' || ['forest', 'orchard', 'vineyard', 'plant_nursery'].includes(tags.landuse)) return 'trees';
  if (['park', 'playground', 'sports_centre', 'recreation_ground'].includes(tags.leisure)) return 'public';
  if (['farmland', 'meadow', 'grass', 'allotments'].includes(tags.landuse) || ['grassland', 'heath', 'scrub', 'bare_rock', 'sand'].includes(tags.natural) || tags.leisure === 'pitch') return 'field';
  return 'other';
}
function isArea(elm, tags, points) {
  if (points.length < 3) return false;
  if (elm.type === 'relation' || tags.area === 'yes' || tags.building || tags.landuse || tags.leisure || tags.amenity || tags.place || tags.natural === 'water') return true;
  const a = points[0], b = points[points.length - 1];
  return points.length > 3 && Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6;
}
function runwayCorridor(points, id) {
  if (points.length < 2) return null;
  const a = points[0], b = points[points.length - 1];
  const lat0 = (a.lat + b.lat) / 2, cos = Math.max(.2, Math.cos(lat0 * DEG));
  const dx = (b.lon - a.lon) * 111320 * cos, dy = (b.lat - a.lat) * 111320;
  const len = Math.hypot(dx, dy); if (len < 50) return null;
  const ux = dx / len, uy = dy / len, px = -uy, py = ux;
  const project = (origin, along, across) => ({ lat: origin.lat + (uy * along + py * across) / 111320, lon: origin.lon + (ux * along + px * across) / (111320 * cos) });
  const reach = 10000, near = 250, far = 2000;
  return { id: `corridor/${id}`, category: 'airport', isArea: true, points: [project(a, -reach, far), project(a, 0, near), project(b, 0, near), project(b, reach, far), project(b, reach, -far), project(b, 0, -near), project(a, 0, -near), project(a, -reach, -far)] };
}
function normalize(elements) {
  const out = [];
  for (const elm of elements) {
    const tags = elm.tags || {}, points = Array.isArray(elm.geometry) ? elm.geometry.map(p => ({ lat: p.lat, lon: p.lon })) : elm.lat != null ? [{ lat: elm.lat, lon: elm.lon }] : elm.center ? [{ lat: elm.center.lat, lon: elm.center.lon }] : [];
    const cat = category(tags); if (!points.length || cat === 'other') continue;
    out.push({ id: `${elm.type}/${elm.id}`, category: cat, points, isArea: isArea(elm, tags, points) });
    if (tags.aeroway === 'runway') { const corridor = runwayCorridor(points, elm.id); if (corridor) out.push(corridor); }
  }
  return out;
}
function haversine(a, b, c, d) { const x = (c-a)*DEG, y=(d-b)*DEG, q=Math.sin(x/2)**2+Math.cos(a*DEG)*Math.cos(c*DEG)*Math.sin(y/2)**2; return 6371*2*Math.asin(Math.sqrt(q)); }
function inside(p, poly) { let yes=false; for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if(((a.lat>p.lat)!==(b.lat>p.lat))&&p.lon<(b.lon-a.lon)*(p.lat-a.lat)/((b.lat-a.lat)||1e-12)+a.lon)yes=!yes;} return yes; }
function segment(p,a,b){const c=Math.max(.2,Math.cos(p.lat*DEG)),ax=(a.lon-p.lon)*111320*c,ay=(a.lat-p.lat)*111320,bx=(b.lon-p.lon)*111320*c,by=(b.lat-p.lat)*111320,vx=bx-ax,vy=by-ay,l=vx*vx+vy*vy;if(!l)return Math.hypot(ax,ay);const t=clamp(-(ax*vx+ay*vy)/l,0,1);return Math.hypot(ax+vx*t,ay+vy*t);}
function distance(p,f){if(f.isArea&&inside(p,f.points))return 0;let best=Infinity;for(const q of f.points)best=Math.min(best,haversine(p.lat,p.lon,q.lat,q.lon)*1000);for(let i=0;i<f.points.length-1;i++)best=Math.min(best,segment(p,f.points[i],f.points[i+1]));if(f.isArea&&f.points.length>1)best=Math.min(best,segment(p,f.points[f.points.length-1],f.points[0]));return best;}
function grid(cfg){const out=[],step=cfg.spacingM/1000;for(let y=-cfg.radiusKm;y<=cfg.radiusKm;y+=step)for(let x=-cfg.radiusKm;x<=cfg.radiusKm;x+=step){const p={lat:cfg.lat+y/111.32,lon:cfg.lon+x/(111.32*Math.max(.2,Math.cos(cfg.lat*DEG)))};if(haversine(cfg.lat,cfg.lon,p.lat,p.lon)<=cfg.radiusKm)out.push(p);}return out;}
function index(cfg,features){const size=1000,cos=Math.max(.2,Math.cos(cfg.lat*DEG)),maps=new Map(),ranges={field:cfg.fieldPref==='ignore'?0:600};for(const k of HAZARDS)if(cfg.enabled[k])ranges[k]=Math.max(cfg.buffers[k],k==='settlement'?600:k==='highway'?300:['rail','power'].includes(k)?80:k==='housing'?150:k==='water'?50:0);const xy=p=>({x:(p.lon-cfg.lon)*111320*cos,y:(p.lat-cfg.lat)*111320}),cell=n=>Math.floor(n/size),key=(x,y)=>`${x},${y}`;for(const f of features){if(!ranges[f.category])continue;let x1=Infinity,y1=Infinity,x2=-Infinity,y2=-Infinity;for(const q of f.points){const p=xy(q);x1=Math.min(x1,p.x);x2=Math.max(x2,p.x);y1=Math.min(y1,p.y);y2=Math.max(y2,p.y);}let m=maps.get(f.category);if(!m)maps.set(f.category,m=new Map());for(let y=cell(y1);y<=cell(y2);y++)for(let x=cell(x1);x<=cell(x2);x++){const k=key(x,y),b=m.get(k);b?b.push(f):m.set(k,[f]);}}
 return p=>{const q=xy(p),out=[],seen=new Set();for(const [cat,r] of Object.entries(ranges)){const m=maps.get(cat);if(!m||!r)continue;for(let y=cell(q.y-r);y<=cell(q.y+r);y++)for(let x=cell(q.x-r);x<=cell(q.x+r);x++)for(const f of m.get(key(x,y))||[])if(!seen.has(f.id)){seen.add(f.id);out.push(f);}}return out;};}
function scorePoint(p,cfg,features){const nearest=Object.fromEntries([...HAZARDS,'field'].map(k=>[k,Infinity])),area=new Set();for(const f of features){const d=distance(p,f);nearest[f.category]=Math.min(nearest[f.category],d);if(d===0&&f.isArea)area.add(f.category);}const e=cfg.enabled,b=cfg.buffers,reject=(e.housing&&area.has('housing'))||(e.settlement&&area.has('settlement'))||(e.airport&&area.has('airport'))||(e.public&&area.has('public'))||(e.trees&&area.has('trees'))||(e.water&&area.has('water'))||(e.housing&&nearest.housing<Math.max(150,b.housing*.55))||(e.settlement&&nearest.settlement<Math.max(600,b.settlement*.85))||(e.airport&&nearest.airport<b.airport*.7)||(e.highway&&nearest.highway<Math.max(300,b.highway*.85))||(e.rail&&nearest.rail<Math.max(80,b.rail*.55))||(e.power&&nearest.power<Math.max(80,b.power*.5))||(e.water&&nearest.water<Math.max(50,b.water*.5))||(cfg.fieldPref==='require'&&nearest.field>350);if(reject)return null;let score=100;for(const k of HAZARDS)if(e[k]&&nearest[k]<b[k])score-=WEIGHTS[k]*(1-nearest[k]/b[k]);if(cfg.fieldPref!=='ignore'){if(nearest.field<180)score+=12;else if(nearest.field<350)score+=5;else score-=22;if(nearest.field>600)score=Math.min(score,68);}if(e.housing&&nearest.housing<b.housing*.65)score=Math.min(score,52);if(e.settlement&&nearest.settlement<b.settlement)score=Math.min(score,48);score=Math.round(clamp(score,0,100));const risks=[];for(const k of HAZARDS)if(e[k]&&Number.isFinite(nearest[k])&&nearest[k]<b[k])risks.push(`${k} ${Math.round(nearest[k])}m`);if(cfg.fieldPref!=='ignore'&&nearest.field>350)risks.push('no mapped open field nearby');if(!risks.length)risks.push(nearest.field<180?'open field nearby':'clear by map data');return {...p,score,nearest,risks};}
function analyze(cfg,elements){const features=normalize(elements),near=index(cfg,features),all=[];for(const p of grid(cfg)){const c=scorePoint(p,cfg,near(p));if(c&&c.score>=Math.max(78,cfg.minScore))all.push(c);}const sorter=cfg.sort==='distance'?(a,b)=>haversine(cfg.lat,cfg.lon,a.lat,a.lon)-haversine(cfg.lat,cfg.lon,b.lat,b.lon):cfg.sort==='field'?(a,b)=>(a.nearest.field-b.nearest.field)||(b.score-a.score):(a,b)=>b.score-a.score;all.sort(sorter);const counts={};for(const f of features)counts[f.category]=(counts[f.category]||0)+1;return {candidates:all.slice(0,cfg.results),green:all.slice(0,1200),featureCounts:counts,featureCount:features.length};}

module.exports = { analyze };
