PREVIEW_HTML = r'''<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Trip Recap Preview</title>
  <link href="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css" rel="stylesheet" />
  <script src="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js"></script>
  <style>
    html,body{margin:0;background:#0b0d10;color:#f5f7fa;font-family:system-ui,sans-serif;height:100%}
    #shell{display:grid;grid-template-rows:auto 1fr;height:100vh}
    #toolbar{padding:12px 16px;background:#11151a;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    #map{min-height:500px}
    button,input{font:inherit} button{padding:8px 14px;cursor:pointer}
    #status{opacity:.8}.scooter{font-size:28px;transform-origin:center}
    #media-card{position:absolute;z-index:5;left:50%;bottom:24px;transform:translateX(-50%);max-width:min(82vw,520px);max-height:42vh;background:#111;border-radius:14px;padding:8px;display:none;box-shadow:0 10px 40px #0008}
    #media-card img,#media-card video{display:block;max-width:100%;max-height:38vh;border-radius:10px}
  </style>
</head>
<body>
<div id="shell">
  <div id="toolbar">
    <input id="files" type="file" multiple accept="image/*,video/*" />
    <button id="analyze">Analyze trip</button>
    <button id="replay" disabled>Replay</button>
    <span id="status">Choose original photos/videos with location metadata.</span>
  </div>
  <div style="position:relative"><div id="map"></div><div id="media-card"></div></div>
</div>
<script>
const map = new maplibregl.Map({container:'map',style:'https://demotiles.maplibre.org/style.json',center:[85.324,27.676],zoom:8});
const statusEl=document.getElementById('status');
const replay=document.getElementById('replay');
const mediaCard=document.getElementById('media-card');
let marker=null, trip=null, route=null, timeline=null, tripId=null, raf=null;
window.tripReady=false;

function bearing(a,b){const y=b[0]-a[0],x=b[1]-a[1];return Math.atan2(y,x)*180/Math.PI;}
function nearestIndex(coord, coords){let best=0,dist=Infinity;coords.forEach((p,i)=>{const d=(p[0]-coord[0])**2+(p[1]-coord[1])**2;if(d<dist){dist=d;best=i;}});return best;}
function hideMedia(){mediaCard.style.display='none';mediaCard.innerHTML='';}
function showMedia(media){hideMedia();const url=`/api/trips/${tripId}/media/${media.id}`;if(media.media_type==='video'){mediaCard.innerHTML=`<video src="${url}" autoplay muted playsinline controls></video>`;}else{mediaCard.innerHTML=`<img src="${url}" alt="${media.filename}">`;}mediaCard.style.display='block';}

function installRoute(){
  const data=route || {type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}};
  const empty={type:'Feature',properties:{},geometry:{type:'LineString',coordinates:[]}};
  if(map.getSource('route')){map.getSource('route').setData(data);map.getSource('traveled').setData(empty);}
  else{
    map.addSource('route',{type:'geojson',data});map.addLayer({id:'route',type:'line',source:'route',paint:{'line-color':'#77808c','line-width':5,'line-opacity':.35}});
    map.addSource('traveled',{type:'geojson',data:empty});map.addLayer({id:'traveled',type:'line',source:'traveled',paint:{'line-color':'#111827','line-width':7}});
  }
  const coords=data.geometry.coordinates;
  if(coords.length){const bounds=coords.reduce((b,c)=>b.extend(c),new maplibregl.LngLatBounds(coords[0],coords[0]));map.fitBounds(bounds,{padding:70,duration:700});if(!marker){const el=document.createElement('div');el.className='scooter';el.textContent='🛵';marker=new maplibregl.Marker({element:el,rotationAlignment:'map'}).setLngLat(coords[0]).addTo(map);}else marker.setLngLat(coords[0]);}
}

window.setTripProgress=function(progress){
  if(!route) return;
  const coords=route.geometry.coordinates;if(!coords.length)return;
  const p=Math.max(0,Math.min(1,progress));const raw=p*(coords.length-1);const i=Math.min(Math.floor(raw),coords.length-2);const t=raw-i;
  const a=coords[i],b=coords[Math.min(i+1,coords.length-1)];const pos=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
  marker?.setLngLat(pos).setRotation(bearing(a,b));
  const traveled=coords.slice(0,i+1).concat([pos]);map.getSource('traveled')?.setData({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:traveled}});
};

function animate(){cancelAnimationFrame(raf);hideMedia();const start=performance.now();const duration=Math.max((timeline?.duration_seconds||20)*1000,4000);const mediaEvents=(timeline?.events||[]).filter(e=>e.type==='media_show');const seen=new Set();
  function frame(now){const p=Math.min(1,(now-start)/duration);window.setTripProgress(p);const videoTime=p*(timeline?.duration_seconds||0);for(const e of mediaEvents){if(e.video_time<=videoTime&&!seen.has(e.payload.media_id)){seen.add(e.payload.media_id);const m=trip.media.find(x=>x.id===e.payload.media_id);if(m){showMedia(m);setTimeout(hideMedia,2600);}}}if(p<1)raf=requestAnimationFrame(frame);}raf=requestAnimationFrame(frame);
}

async function loadTrip(id){tripId=id;const [tripRes,routeRes,timelineRes]=await Promise.all([fetch(`/api/trips/${id}`),fetch(`/api/trips/${id}/route`),fetch(`/api/trips/${id}/timeline`)]);trip=await tripRes.json();route=routeRes.ok?await routeRes.json():null;timeline=await timelineRes.json();installRoute();replay.disabled=false;window.tripData=trip;window.routeData=route;window.timelineData=timeline;window.tripReady=true;animate();}

replay.onclick=animate;
document.getElementById('analyze').onclick=async()=>{const files=document.getElementById('files').files;if(!files.length)return;const body=new FormData();for(const file of files)body.append('files',file);statusEl.textContent='Extracting metadata and reconstructing trip…';const response=await fetch('/api/trips/analyze',{method:'POST',body});const payload=await response.json();if(!response.ok){statusEl.textContent=payload.detail||'Analysis failed';return;}const first=payload.trips[0];statusEl.textContent=`${first.media_count} media · ${Math.round(first.distance_meters/1000)} km`;await loadTrip(first.id);};

const params=new URLSearchParams(location.search);map.on('load',()=>{if(params.get('trip_id'))loadTrip(params.get('trip_id'));});
</script>
</body>
</html>'''
