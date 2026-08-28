/*
 * PMW collector — Pure Mountain Weather
 * Runs a headless browser, pulls OBSERVED wind for the Soča / Bovec launches
 * from skytech.si (launch anemometers) + ARSO (official high stations),
 * converts to the board's STATIONS shape, and writes data.json.
 *
 * Designed to run unattended in GitHub Actions (open internet). Also runnable
 * locally with:  node collector.js
 *
 * NO forecasts — observed measurements + history only.
 */
const fs = require('fs');
const { chromium } = require('playwright');

// ---- skytech launch stations (id from the tabela row's show('graf','<id>')) ----
const SKY_META = {
  c454085df514ce66b7d124ee8d60fb85: { name: 'Planja nad Bovcem', lat: 46.353, lon: 13.586, elev: 1400 },
  b80c1266094cabce865a616424be25d4: { name: 'Mangrt', lat: 46.438, lon: 13.636, elev: 2055 },
  daeca69ffaa4263cdb3a1d7e90255ae9: { name: 'Učeja pod Stolom', lat: 46.300, lon: 13.440, elev: 700 },
  '7cb4c2a7a43cb46bf867601576e96a7e': { name: 'Stol', lat: 46.283, lon: 13.478, elev: 1600 },
  '4512a867ca0d18bbd33ccdb36b0ea333': { name: 'Kobala', lat: 46.196, lon: 13.706, elev: 1050 },
  '02733e47c412ef533fa6c4d8fa0655a7': { name: 'Srednji vrh (Matajur)', lat: 46.178, lon: 13.553, elev: 1400 },
  '79d47c5a18523edc5727a8953de1b891': { name: 'Kuk', lat: 46.263, lon: 13.535, elev: 1100 },
  a84ab4e780a3f8bf63dbcaea6060ccf7: { name: 'Vogel', lat: 46.259, lon: 13.840, elev: 1535 },
};

// ---- ARSO official high stations ----
// Pulled from ARSO's own JSON observations API (vreme.si) rather than scraping HTML — clean,
// robust, and it carries full wind history (ff=speed km/h, ffmax=gust km/h, dd=direction deg)
// plus coordinates. Kredarica lives here too (its per-station HTML file uses the odd code
// "KREDA-ICA"; the API by name is far simpler). Bovec valley returns nothing here (offline).
const ARSO_LOCS = [
  { loc: 'Kanin',     name: 'Kanin (ARSO)',     elev: 2260 },
  { loc: 'Vogel',     name: 'Vogel (ARSO)',     elev: 1515 },
  { loc: 'Kredarica', name: 'Kredarica (ARSO)', elev: 2514 },
];
const ARSO_API = loc => `https://www.vreme.si/api/1.0/location/observations/?location=${encodeURIComponent(loc)}&lang=sl`;

// ---- Wunderground personal weather stations (PWS) ----
// Needs a WU API key, supplied at runtime via the WU_KEY env var (GitHub Actions secret) —
// never hard-coded. If WU_KEY is unset, WU stations are simply skipped.
const WU_KEY = process.env.WU_KEY || '';
const WU_STATIONS = ['IKOBAR10','IKOBAR8','ITOLMI33','IBOVEC5','IBOVEC12','IBOVEC9'];
// Curated names: Wunderground labels these three "Bovec" (the municipality), but they sit in
// distinct settlements up the Koritnica valley (confirmed by reverse-geocoding their coords).
const WU_NAMES = { IBOVEC5:'Log pod Mangartom', IBOVEC12:'Kal-Koritnica', IBOVEC9:'Spodnji Log' };

async function collectSkytech(page) {
  await page.goto('https://skytech.si/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  return await page.evaluate(async (META) => {
    const DIRMAP = { S:0, SSV:22.5, SV:45, VSV:67.5, V:90, VJV:112.5, JV:135, JJV:157.5, J:180, JJZ:202.5, JZ:225, ZJZ:247.5, Z:270, ZSZ:292.5, SZ:315, SSZ:337.5 };
    const parseTs = s => { const m = s.match(/(\d{2}):(\d{2})\s+(\d{2})\.(\d{2})\.(\d{4})/); if(!m) return null; return Date.UTC(+m[5],+m[4]-1,+m[3],+m[1]-2,+m[2]); };
    const post = body => fetch('https://skytech.si/skytechsys/data.php', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest'}, body }).then(r=>r.text());
    const html = await post('c=tabela&l=x');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rowById = {};
    [...doc.querySelectorAll('tr')].forEach(tr => { const tds=[...tr.querySelectorAll('td')]; if(!tds.length) return; const oc=(tds[0].querySelector('[onclick]')?.getAttribute('onclick'))||tds[0].getAttribute('onclick')||''; const m=oc.match(/show\(['"]graf['"]\s*,\s*['"]([^'"]+)['"]\)/); if(m) rowById[m[1]]=tds.map(td=>td.textContent.trim()); });
    const nums = s => s.split(',').map(x=>x.trim().replace(/^['"]|['"]$/g,'')).filter(x=>x!=='').map(Number);
    const out = [];
    for (const id of Object.keys(META)) {
      const meta = META[id], row = rowById[id];
      let rw = [], rg = [];
      try {
        const gtxt = await post('c=graf&l=' + id);
        const arrs = [...gtxt.matchAll(/data\s*:\s*\[([^\]]*)\]/g)].map(m => nums(m[1]));
        rw = (arrs[0]||[]).map(v => +(v*3.6).toFixed(1));
        rg = (arrs[1]||[]).map(v => +(v*3.6).toFixed(1));
        const n = Math.min(rw.length, rg.length); rw = rw.slice(0,n); rg = rg.slice(0,n);
      } catch(e) {}
      let curWms=null, curGms=null, dirStr=null, temp=null, ts=null;
      if (row) { curWms=parseFloat(row[1]); curGms=parseFloat(row[2]); dirStr=row[3]; temp=parseFloat(row[4]); ts=parseTs(row[5]); }
      if (rw.length < 2) { const w = curWms!=null?+(curWms*3.6).toFixed(1):0, g = curGms!=null?+(curGms*3.6).toFixed(1):0; rw=[w,w]; rg=[g,g]; }
      const dir = (dirStr!=null && DIRMAP[dirStr]!=null) ? DIRMAP[dirStr] : 0;
      out.push({ id:'sky_'+id.slice(0,8), name:meta.name, src:'skytech', web:'https://skytech.si/', lat:meta.lat, lon:meta.lon, elev:meta.elev, temp:temp!=null?temp:null, dir, real:true, rw, rg, series:rw.slice(-12), gust:rg[rg.length-1], obsTs:ts, stepMs:600000, cam:false, camUrl:'' });
    }
    return out;
  }, SKY_META);
}

// median gap (ms) between consecutive timestamps — used so the board plots history at the
// station's real cadence (skytech/ARSO ~10 min, Kredarica ~30 min, WU ~5 min).
function medianStep(times){
  const d=[]; for(let i=1;i<times.length;i++){ const g=times[i]-times[i-1]; if(g>0) d.push(g); }
  if(!d.length) return 600000; d.sort((a,b)=>a-b); return d[Math.floor(d.length/2)];
}

// ARSO via the official JSON observations API (vreme.si). Full history, coords included.
async function collectArso(st) {
  try {
    const j = await fetch(ARSO_API(st.loc)).then(r=>r.json());
    const f = j.features && j.features[0];
    if(!f) { console.error('ARSO', st.loc, 'no feature'); return null; }
    const num = v => { const n=parseFloat(String(v==null?'':v).replace(',','.')); return isNaN(n)?null:n; };
    let all = [].concat(...((f.properties.days)||[]).map(d=>d.timeline||[]))
      .filter(p => p.valid && p.ff_val!=='' && p.ff_val!=null)
      .sort((a,b)=>Date.parse(a.valid)-Date.parse(b.valid));
    if(!all.length) { console.error('ARSO', st.loc, 'no wind points'); return null; }
    const recent = all.slice(-36);
    const rw = recent.map(p=>{ const n=num(p.ff_val); return n==null?0:n; });
    const rg = recent.map(p=>{ const n=num(p.ffmax_val); return n==null?(num(p.ff_val)||0):n; });
    const times = recent.map(p=>Date.parse(p.valid));
    const newest = recent[recent.length-1];
    const coords = (f.geometry && f.geometry.coordinates) || [null,null];
    return { id:'arso_'+st.loc.toLowerCase(), name:st.name, src:'ARSO', web:'https://www.vreme.si/', lat:coords[1], lon:coords[0], elev:st.elev,
      real:true, cam:false, camUrl:'', temp:num(newest.t), dir:num(newest.dd_val)==null?0:num(newest.dd_val),
      rw, rg, series:rw.slice(-12), gust:rg[rg.length-1], obsTs:Date.parse(newest.valid), stepMs:medianStep(times) };
  } catch(e) { console.error('ARSO', st.loc, 'failed:', e.message); return null; }
}

// Wunderground PWS — server-side JSON API (needs WU_KEY). Returns current + ~3h of 5-min history.
async function collectWU(id) {
  if(!WU_KEY) return null;
  const base = 'https://api.weather.com/v2/pws/observations/';
  const q = '&format=json&units=m&apiKey=' + WU_KEY;
  try {
    const cur = await fetch(base+'current?stationId='+id+q).then(r=>r.json());
    const o = cur.observations && cur.observations[0];
    if(!o) { console.error('WU', id, 'no current obs'); return null; }
    const m = o.metric || {};
    let rw=[], rg=[], times=[];
    try {
      const hist = await fetch(base+'all/1day?stationId='+id+q).then(r=>r.json());
      const obs = (hist.observations || []).slice(-36);
      rw = obs.map(x => (x.metric && x.metric.windspeedAvg!=null) ? Math.round(x.metric.windspeedAvg) : 0);
      rg = obs.map(x => (x.metric && x.metric.windgustHigh!=null) ? Math.round(x.metric.windgustHigh) : 0);
      times = obs.map(x => x.epoch ? x.epoch*1000 : (x.obsTimeUtc?Date.parse(x.obsTimeUtc):0));
      const n=Math.min(rw.length,rg.length); rw=rw.slice(0,n); rg=rg.slice(0,n); times=times.slice(0,n);
    } catch(e) { /* history optional */ }
    const cw = m.windSpeed!=null ? Math.round(m.windSpeed) : 0;
    const cg = m.windGust!=null ? Math.round(m.windGust) : 0;
    if(rw.length < 2) { rw=[cw,cw]; rg=[cg,cg]; times=[]; }
    return { id:'wu_'+id.toLowerCase(), name:(WU_NAMES[id]||o.neighborhood||id), src:'Wunderground', web:'https://www.wunderground.com/dashboard/pws/'+id,
      lat:o.lat, lon:o.lon, elev:(m.elev!=null?m.elev:null), real:true, cam:false, camUrl:'',
      temp:(m.temp!=null?m.temp:null), dir:(o.winddir!=null?o.winddir:0), rw, rg, series:rw.slice(-12), gust:rg[rg.length-1],
      obsTs: o.obsTimeUtc ? Date.parse(o.obsTimeUtc) : null, stepMs: times.length>1 ? medianStep(times) : 300000 };
  } catch(e) { console.error('WU', id, 'failed:', e.message); return null; }
}

function rank(id){ return id.indexOf('sky_')===0?0 : id.indexOf('arso_')===0?1 : 2; }

(async () => {
  // Previous data.json = last-good snapshot. Used to carry stations forward when a source
  // hiccups this run, so a single failed fetch never blanks the board (stale ones just age).
  let prev = {};
  try { const p = JSON.parse(fs.readFileSync('data.json','utf8')); (p.stations||[]).forEach(s=>{ prev[s.id]=s; }); } catch(e) {}

  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' });
  let stations = [];
  // skytech is the core launch data — retry once if it comes back empty/errors.
  for (let attempt=1; attempt<=2 && !stations.length; attempt++) {
    try { const s = await collectSkytech(page); if(s && s.length) stations = stations.concat(s); }
    catch(e) { console.error('skytech attempt', attempt, 'failed:', e.message); }
    if(!stations.length && attempt<2) await page.waitForTimeout(5000);
  }
  await browser.close();
  // ARSO high stations (vreme.si JSON API) and Wunderground — plain HTTPS, no browser needed.
  for (const st of ARSO_LOCS) { const s = await collectArso(st); if(s) stations.push(s); }
  if(WU_KEY){ for(const id of WU_STATIONS){ const s = await collectWU(id); if(s) stations.push(s); } }
  else { console.log('WU_KEY not set — skipping Wunderground stations'); }

  // Merge: freshly collected stations win; anything not collected this run is carried over
  // from the previous snapshot (keeps its old obsTs, so the board shows it aging).
  const freshIds = new Set(stations.map(s=>s.id));
  const carried = Object.keys(prev).filter(id=>!freshIds.has(id));
  carried.forEach(id=>{ stations.push(prev[id]); });
  if(carried.length) console.log('Carried over', carried.length, 'station(s) from last snapshot:', carried.join(', '));
  stations.sort((a,b)=> rank(a.id)-rank(b.id));

  if (!stations.length) { console.error('No stations collected and no previous snapshot — aborting.'); process.exit(1); }
  const out = { generated: new Date().toISOString(), source: 'skytech.si + ARSO + Wunderground PWS', stations };
  fs.writeFileSync('data.json', JSON.stringify(out));
  console.log('Wrote data.json with', stations.length, 'stations at', out.generated);
})();
