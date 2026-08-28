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
// Verified codes: KANIN + VOGEL report data; BOVEC exists but is often "no data";
// KREDARICA 404s (no such AMS file) so it is not listed. Stations with no current
// readings are skipped automatically below.
const ARSO = [
  { code: 'KANIN', name: 'Kanin (ARSO)', lat: 46.3585, lon: 13.4746, elev: 2260 },
  { code: 'VOGEL', name: 'Vogel (ARSO)', lat: 46.2597, lon: 13.8404, elev: 1515 },
  { code: 'BOVEC', name: 'Bovec valley (ARSO)', lat: 46.3306, lon: 13.5546, elev: 452 },
];
const ARSO_URL = c => `https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/observationAms_${c}_history.html`;
// Kredarica has NO individual history file (all code variants 404), but it IS in ARSO's
// combined current-conditions table — so we pull its current reading from there (no 6h history).
const ARSO_COMBINED = 'https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/observationAms_si_latest.html';

// ---- Wunderground personal weather stations (PWS) ----
// Needs a WU API key, supplied at runtime via the WU_KEY env var (GitHub Actions secret) —
// never hard-coded. If WU_KEY is unset, WU stations are simply skipped.
const WU_KEY = process.env.WU_KEY || '';
const WU_STATIONS = ['IKOBAR10','IKOBAR8','ITOLMI33','IBOVEC5','IBOVEC12','IBOVEC9'];

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
      out.push({ id:'sky_'+id.slice(0,8), name:meta.name, src:'skytech', web:'https://skytech.si/', lat:meta.lat, lon:meta.lon, elev:meta.elev, temp:temp!=null?temp:null, dir, real:true, rw, rg, series:rw.slice(-12), gust:rg[rg.length-1], obsTs:ts, cam:false, camUrl:'' });
    }
    return out;
  }, SKY_META);
}

async function collectArso(page, st) {
  try {
    await page.goto(ARSO_URL(st.code), { waitUntil: 'domcontentloaded', timeout: 60000 });
    const r = await page.evaluate(() => {
      const t = document.querySelector('table'); if(!t) return null;
      if(/niso na voljo/i.test(t.textContent)) return null; // "data currently not available"
      const rows = [...t.querySelectorAll('tr')];
      const hdr = [...rows[0].querySelectorAll('th,td')].map(c=>c.textContent.trim());
      // ARSO headers appear in English OR Slovenian depending on the page/time — match both.
      const find = re => hdr.findIndex(h=>re.test(h.toLowerCase()));
      const iTemp=find(/temperatur/), iWind=find(/hitrost vetra|wind speed/), iDir=find(/smer vetra|wind.*°|direction/), iGust=find(/sunki|wind gust/);
      if(iWind<0 || iGust<0) return null;
      const num = v => { const n=parseFloat((v||'').replace(',','.')); return isNaN(n)?null:n; };
      const data = rows.slice(1).map(tr=>[...tr.querySelectorAll('td,th')].map(c=>c.textContent.trim()));
      const recent = data.slice(0,36).reverse();
      if(!recent.length) return null;
      const rw = recent.map(r=>{const n=num(r[iWind]);return n==null?0:n;});
      const rg = recent.map(r=>{const n=num(r[iGust]);return n==null?0:n;});
      if(!rw.some(v=>v>0) && !rg.some(v=>v>0)) return null; // no real readings -> skip station
      const newest = recent[recent.length-1];
      const tm = (newest[0]||'').match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
      const obsTs = tm ? Date.UTC(+tm[3],+tm[2]-1,+tm[1],+tm[4]-2,+tm[5]) : null;
      return { temp:num(newest[iTemp]), dir:num(newest[iDir])||0, rw, rg, series:rw.slice(-12), gust:rg[rg.length-1], obsTs };
    });
    if(!r) { console.error('ARSO', st.code, 'no usable data — skipped'); return null; }
    return { id:'arso_'+st.code.toLowerCase(), name:st.name, src:'ARSO', web:'https://meteo.arso.gov.si/', lat:st.lat, lon:st.lon, elev:st.elev, real:true, cam:false, camUrl:'', ...r };
  } catch(e) { console.error('ARSO', st.code, 'failed:', e.message); return null; }
}

// Kredarica: current-only, parsed from ARSO's combined table (no per-station history file exists).
async function collectKredarica(page) {
  try {
    await page.goto(ARSO_COMBINED, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('tr')];
      if(!rows.length) return null;
      const hdr = [...rows[0].querySelectorAll('th,td')].map(c=>c.textContent.trim());
      const find = re => hdr.findIndex(h=>re.test(h.toLowerCase()));
      const iTemp=find(/temperatur/), iWind=find(/hitrost vetra|wind speed/), iDir=find(/smer vetra|wind.*°|direction/), iGust=find(/sunki|wind gust/);
      const num = v => { const n=parseFloat((v||'').replace(',','.')); return isNaN(n)?null:n; };
      let row=null;
      for(const rr of rows){ const c=rr.querySelector('td,th'); if(c && /kredarica/i.test(c.textContent)){ row=[...rr.querySelectorAll('td,th')].map(x=>x.textContent.trim()); break; } }
      if(!row) return null;
      const tm = document.body.textContent.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
      const obsTs = tm ? Date.UTC(+tm[3],+tm[2]-1,+tm[1],+tm[4]-2,+tm[5]) : null;
      const w=num(row[iWind]), g=num(row[iGust]);
      if(w==null && g==null) return null;
      return { w: w==null?0:w, g: g==null?0:g, dir: num(row[iDir]), temp: num(row[iTemp]), obsTs };
    });
    if(!r) { console.error('Kredarica: no data'); return null; }
    return { id:'arso_kredarica', name:'Kredarica (ARSO)', src:'ARSO', web:'https://meteo.arso.gov.si/', lat:46.3789, lon:13.8489, elev:2514,
      real:true, cam:false, camUrl:'', temp:r.temp, dir:r.dir==null?0:r.dir, rw:[r.w,r.w], rg:[r.g,r.g], series:[r.w,r.w], gust:r.g, obsTs:r.obsTs };
  } catch(e) { console.error('Kredarica failed:', e.message); return null; }
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
    let rw=[], rg=[];
    try {
      const hist = await fetch(base+'all/1day?stationId='+id+q).then(r=>r.json());
      const obs = (hist.observations || []).slice(-36);
      rw = obs.map(x => (x.metric && x.metric.windspeedAvg!=null) ? Math.round(x.metric.windspeedAvg) : 0);
      rg = obs.map(x => (x.metric && x.metric.windgustHigh!=null) ? Math.round(x.metric.windgustHigh) : 0);
      const n=Math.min(rw.length,rg.length); rw=rw.slice(0,n); rg=rg.slice(0,n);
    } catch(e) { /* history optional */ }
    const cw = m.windSpeed!=null ? Math.round(m.windSpeed) : 0;
    const cg = m.windGust!=null ? Math.round(m.windGust) : 0;
    if(rw.length < 2) { rw=[cw,cw]; rg=[cg,cg]; }
    return { id:'wu_'+id.toLowerCase(), name:(o.neighborhood||id)+' (WU)', src:'Wunderground', web:'https://www.wunderground.com/dashboard/pws/'+id,
      lat:o.lat, lon:o.lon, elev:(m.elev!=null?m.elev:null), real:true, cam:false, camUrl:'',
      temp:(m.temp!=null?m.temp:null), dir:(o.winddir!=null?o.winddir:0), rw, rg, series:rw.slice(-12), gust:rg[rg.length-1],
      obsTs: o.obsTimeUtc ? Date.parse(o.obsTimeUtc) : null };
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
  for (const st of ARSO) { const s = await collectArso(page, st); if(s) stations.push(s); }
  const kred = await collectKredarica(page); if(kred) stations.push(kred);
  await browser.close();
  // Wunderground (plain HTTPS JSON, no browser needed)
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
