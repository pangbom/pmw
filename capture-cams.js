/*
 * PMW cam capture — grabs each whatsupcams direct snapshot JPEG and stores a rolling
 * 24h history of frames, so the board can show a scrollable timelapse per cam.
 *
 * Runs on the GitHub runner (open internet) inside the refresh loop. Writes:
 *   - frames  -> $CAM_DIR/cams/<id>/<epochMs>.jpg   (camstore worktree; force-amended, no bloat)
 *   - manifest-> $CAM_DIR/cams/manifest.json         (24h frame list, for the scrubber)
 *   - latest  -> $LATEST_OUT (cams-latest.json)      (newest frame per cam; committed on main, served fresh)
 *
 * Frames older than the retention window are deleted each pass. Identical consecutive
 * frames (a cam that hasn't refreshed) are skipped so slow cams don't bloat the history.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RETENTION_H = Number(process.env.RETENTION_H || 24);
const RETENTION_MS = RETENTION_H * 3600 * 1000;
const CAM_DIR = process.env.CAM_DIR || 'camstore';           // camstore worktree root
const LATEST_OUT = process.env.LATEST_OUT || 'cams-latest.json';
const RAW_BASE = process.env.RAW_BASE || 'https://raw.githubusercontent.com/pangbom/pmw/camstore/';
// Each cam in cams.json carries its own direct-image URL (ARSO / DARS / whatsupcams / …).
const bust = u => u + (u.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
// Some sources (DARS) block GitHub's runner IPs — route them through the wsrv.nl image proxy.
// Cache-bust the INNER url so the proxy fetches a fresh frame each pass.
function fetchUrl(cam){
  if(cam.proxy === 'wsrv') return 'https://wsrv.nl/?url=' + encodeURIComponent(bust(cam.url)) + '&output=jpg';
  return bust(cam.url);
}
// Real webcam JPEGs are several KB+. Anything tiny is an "image not available" placeholder
// (e.g. ARSO's ~1.6 KB offline card) — skip it so offline cams don't pollute the timelapse.
const MIN_BYTES = 4000;

const cams = JSON.parse(fs.readFileSync('cams.json', 'utf8'));

function sha1(buf){ return crypto.createHash('sha1').update(buf).digest('hex'); }
// A frame is only usable if it's a COMPLETE JPEG: starts with SOI (FF D8) and ends with EOI
// (FF D9). Truncated downloads (proxy cut the body short) still start valid but never reach EOI,
// so they render as a half-image with a grey lower band — this rejects those.
function jpegComplete(buf){
  if(!buf || buf.length < 1024) return false;
  if(buf[0] !== 0xFF || buf[1] !== 0xD8) return false;
  for(let i = buf.length - 2; i >= Math.max(2, buf.length - 32); i--){
    if(buf[i] === 0xFF && buf[i+1] === 0xD9) return true;
  }
  return false;
}
function frameEpoch(fname){ const m = fname.match(/^(\d+)\.jpg$/); return m ? +m[1] : null; }
// Some sources occasionally deliver a half image that gets re-encoded WHOLE (valid SOI+EOI) with a
// flat mid-grey band baked into the bottom. jpegComplete can't catch that, so we DECODE the frame
// and reject one whose bottom band is flat (~zero variance) and mid-grey (~128). Genuine haze/cloud/
// snow/night has real variance or a non-grey mean, so it passes. Keeps grey frames out of storage.
let jpegDec=null; try{ jpegDec=require('jpeg-js'); }catch(e){ console.error('jpeg-js unavailable'); }
let sharp=null; try{ sharp=require('sharp'); }catch(e){ console.error('sharp unavailable'); }
const MODS = { sharp: !!sharp, jpegjs: !!jpegDec };
console.log('grey-check modules — sharp:', MODS.sharp, ' jpeg-js:', MODS.jpegjs);
// Downscale a full-res source buffer LOCALLY with sharp (never through wsrv, which is what baked the
// grey band in). STRICT: returns the downscaled JPEG ONLY when it is proven NOT grey; otherwise null
// (grey, undecidable, or no sharp) so the caller can fall back / skip.
async function downscaleClean(raw, w, q){
  if(!sharp) return null;
  try{ const out = await sharp(raw).resize({ width:w, withoutEnlargement:true }).jpeg({ quality:q }).toBuffer();
       return (await greyFrame(out)) === false ? out : null; }
  catch(e){ return null; }
}
// Measure the bottom-40% luminance {mean, sd}. PREFERRED path is sharp (a native decode that loads far
// more reliably on the runner than jpeg-js, and is already used for downscaling); jpeg-js is a pure-JS
// fallback. Returns null when NEITHER can decode, so callers treat "unknown" as unsafe for s53.
async function greyBand(buf){
  if(sharp){
    try{
      const meta = await sharp(buf).metadata();
      const w = meta.width, h = meta.height;
      if(w && h){
        const top = Math.floor(h*0.6);
        const { data } = await sharp(buf).extract({ left:0, top, width:w, height:Math.max(1,h-top) })
          .greyscale().raw().toBuffer({ resolveWithObject:true });
        let sum=0; for(let i=0;i<data.length;i++) sum+=data[i];
        const m=sum/data.length; let v=0; for(let i=0;i<data.length;i++){ const d=data[i]-m; v+=d*d; }
        return { m, sd: Math.sqrt(v/data.length) };
      }
    }catch(e){}
  }
  if(jpegDec){
    try{
      const img=jpegDec.decode(buf,{formatAsRGBA:true,maxMemoryUsageInMB:1024});
      const w=img.width,h=img.height,d=img.data;
      if(w && h){
        const y0=Math.floor(h*0.6), xs=Math.max(1,Math.floor(w/48)); let sum=0; const vals=[];
        for(let y=y0;y<h;y+=2){ for(let x=0;x<w;x+=xs){ const i=(y*w+x)*4; const L=(d[i]+d[i+1]+d[i+2])/3; vals.push(L); sum+=L; } }
        if(vals.length){ const m=sum/vals.length; let v=0; for(const L of vals) v+=(L-m)*(L-m); return { m, sd: Math.sqrt(v/vals.length) }; }
      }
    }catch(e){}
  }
  return null;
}
// true = grey (reject), false = clean (keep), null = couldn't decode (treated as unsafe for s53).
async function greyFrame(buf){
  const b = await greyBand(buf);
  if(!b) return null;
  return b.sd < 6 && b.m > 95 && b.m < 165;
}

const DIAG = [];
const sleep = ms => new Promise(r=>setTimeout(r, ms));
async function grabOnce(cam){
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), 12000);
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/*,*/*'
    };
    if(cam.referer){ headers['Referer'] = cam.referer; headers['Origin'] = cam.referer.replace(/\/$/,''); }
    const r = await fetch(fetchUrl(cam), { signal: ctrl.signal, headers });
    const buf = Buffer.from(await r.arrayBuffer());
    const jpeg = jpegComplete(buf);   // complete JPEG only — rejects truncated / half-loaded frames
    return { status: r.status, ok: r.ok, buf, jpeg };
  } finally { clearTimeout(timer); }
}
async function grab(cam){
  for(let attempt=1; attempt<=3; attempt++){
    try {
      const r = await grabOnce(cam);
      const g = (r.jpeg && r.buf.length >= MIN_BYTES) ? await greyFrame(r.buf) : null;
      const grey = g === true;   // simple cams fetch direct & rarely grey — reject only a definite grey frame
      const good = r.ok && r.jpeg && r.buf.length >= MIN_BYTES && !grey;
      if(attempt===3 || good) DIAG.push({ id: cam.id, status: r.status, bytes: r.buf.length, jpeg: r.jpeg, grey: grey||undefined, placeholder: (r.jpeg && r.buf.length < MIN_BYTES) || undefined, attempt });
      if(good) return r.buf;
      if(grey) console.log('cam', cam.id, 'grey frame — retrying ('+attempt+')');
      else if(r.jpeg && r.buf.length < MIN_BYTES) console.log('cam', cam.id, 'placeholder/offline ('+r.buf.length+'B) — skipped');
      else console.error('cam', cam.id, 'HTTP', r.status, 'jpeg', r.jpeg, '(attempt', attempt+')');
    } catch(e){
      if(attempt===3) DIAG.push({ id: cam.id, error: e.message, attempt });
      console.error('cam', cam.id, 'failed (attempt', attempt+'):', e.message);
    }
    if(attempt<3) await sleep(1000);
  }
  return null;
}

// Run async tasks with limited concurrency so total time stays bounded (10 cams, some slow).
async function pool(items, n, fn){
  const out = new Array(items.length); let idx = 0;
  async function worker(){ while(idx < items.length){ const i = idx++; out[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({length: Math.min(n, items.length)}, worker));
  return out;
}

// ---- s53mv archive cams (s53mv.s5tech.net) ----
// These serve a listable folder of timestamped 1920x1080 frames (~11 min cadence, ~3 days kept),
// so we can pull the last 24h directly for an instant timelapse. Filenames encode LOCAL
// (Europe/Ljubljana) time; convert to a UTC epoch. Frames are downscaled via wsrv to keep the
// branch small. Backfill is capped per pass so the first fill spreads over a few cycles.
const S53_BASE = 'http://s53mv.s5tech.net/ipcam/';
const S53_BACKFILL_CAP = 14;   // newest-missing frames to fetch per cam per pass
const S53_W = 1024, S53_Q = 72; // downscale width / quality via wsrv
// Cam filename clocks are inconsistent across s53mv cams, so we take each frame's time from the
// server's directory-listing modified-date (IIS autoindex: "M/D/YYYY h:mm AM/PM  size  file"),
// which is uniform server-local (Europe/Ljubljana). Returns [{fn, ep}] newest-last.
const S53_ROW_RE = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\b[\s\S]{0,60}?([\w.\-]+_\d{2}_\d{14}(?:\d{3})?(?:_TIMING)?\.jpg)/gi;
function modEpoch(M,D,Y,h,m,ampm){
  let H = h % 12; if(/pm/i.test(ampm)) H += 12;
  const offH = (M>=4 && M<=10) ? 2 : 1; // CEST / CET (DST edge days ignored)
  return Date.UTC(Y, M-1, D, H, m, 0) - offH*3600*1000;
}
async function s53List(loc){
  const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), 20000);
  try {
    const r = await fetch(S53_BASE+loc+'/', { signal: ctrl.signal, headers: { 'User-Agent':'Mozilla/5.0 PMW' } });
    const txt = await r.text();
    const seen = new Set(); const rows = [];
    let m; S53_ROW_RE.lastIndex = 0;
    while((m = S53_ROW_RE.exec(txt))){
      const fn = m[7]; if(seen.has(fn)) continue; seen.add(fn);
      rows.push({ fn, ep: modEpoch(+m[1],+m[2],+m[3],+m[4],+m[5],m[6]) });
    }
    return rows.sort((a,b)=>a.ep-b.ep);
  } catch(e){ console.error('s53mv', loc, 'list failed:', e.message); return []; }
  finally { clearTimeout(t); }
}
async function s53Frame(loc, fname){
  const src = S53_BASE+loc+'/'+fname;
  // PRIMARY: fetch the source DIRECTLY (the runner can reach s53mv) and downscale locally with sharp.
  // The direct source is the real, clean image; wsrv is what baked in the grey band, so we avoid it.
  for(let att=1; att<=3; att++){
    const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), 15000);
    try {
      const u = src + (att>1 ? ((src.indexOf('?')<0?'?':'&')+'cb='+Date.now()) : '');
      const r = await fetch(u, { signal: ctrl.signal, headers: { 'User-Agent':'Mozilla/5.0 PMW' } });
      const raw = Buffer.from(await r.arrayBuffer());
      if(r.ok && jpegComplete(raw)){ const out = await downscaleClean(raw, S53_W, S53_Q); if(out) return out; }
      else if(r.ok) console.log('s53', loc, fname, 'direct incomplete — retry ('+att+')');
    } catch(e){} finally { clearTimeout(t); }
    if(att<3) await sleep(500);
  }
  // FALLBACK (direct failed, or no sharp): wsrv downscale, still reject grey.
  for(let att=1; att<=2; att++){
    const url = 'https://wsrv.nl/?url='+encodeURIComponent(src)+'&w='+S53_W+'&q='+S53_Q+'&output=jpg'+(att>1?('&cb='+Date.now()):'');
    const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), 15000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent':'Mozilla/5.0 PMW' } });
      const buf = Buffer.from(await r.arrayBuffer());
      if(r.ok && jpegComplete(buf) && (await greyFrame(buf)) === false) return buf;
    } catch(e){} finally { clearTimeout(t); }
    if(att<2) await sleep(400);
  }
  return null;
}

(async () => {
  const now = Date.now();
  const simpleCams  = cams.filter(c => c.type !== 's53mv');
  const archiveCams = cams.filter(c => c.type === 's53mv');

  // Prune >retention frames and snapshot each cam's existing frame list.
  const existing = {};
  for(const c of cams){
    const dir = path.join(CAM_DIR, 'cams', c.id);
    fs.mkdirSync(dir, { recursive: true });
    let files = fs.readdirSync(dir).filter(f => frameEpoch(f) != null).sort((a,b)=>frameEpoch(a)-frameEpoch(b));
    for(const f of files){ if(now - frameEpoch(f) > RETENTION_MS){ try{ fs.unlinkSync(path.join(dir,f)); }catch(e){} } }
    existing[c.id] = fs.readdirSync(dir).filter(f => frameEpoch(f) != null).sort((a,b)=>frameEpoch(a)-frameEpoch(b));
  }

  // --- simple single-URL cams: one fresh grab each, dedup-write ---
  const bufs = await pool(simpleCams, 4, c => grab(c));
  simpleCams.forEach((c, ci) => {
    const dir = path.join(CAM_DIR, 'cams', c.id);
    const files = existing[c.id];
    const buf = bufs[ci];
    if(buf){
      let dup = false;
      if(files.length){ try { const prev = fs.readFileSync(path.join(dir, files[files.length-1])); dup = (prev.length===buf.length && sha1(prev)===sha1(buf)); } catch(e){} }
      if(!dup){ fs.writeFileSync(path.join(dir, now + '.jpg'), buf); files.push(now + '.jpg'); }
      else { console.log('cam', c.id, 'unchanged — skipped'); }
    }
  });

  // --- s53mv archive cams: sync the last 24h from their folder listing ---
  const lists = await pool(archiveCams, 4, async c => ({ c, list: await s53List(c.loc) }));
  const tasks = [];
  for(const { c, list } of lists){
    const have = new Set(existing[c.id].map(f => +f.replace('.jpg','')));
    const wanted = list
      .filter(x => x.ep != null && (now - x.ep) <= RETENTION_MS && (now - x.ep) >= -300000 && !have.has(x.ep))
      .sort((a,b)=>b.ep-a.ep).slice(0, S53_BACKFILL_CAP);   // newest-missing first, capped
    wanted.forEach(w => tasks.push({ c, fn:w.fn, ep:w.ep }));
    DIAG.push({ id:c.id, listed:list.length, downloading:wanted.length });
  }
  const s53Out = {};
  await pool(tasks, 4, async (task) => {
    const buf = await s53Frame(task.c.loc, task.fn);
    const o = s53Out[task.c.id] || (s53Out[task.c.id] = { stored:0, skipped:0 });
    if(buf){ fs.writeFileSync(path.join(CAM_DIR,'cams',task.c.id, task.ep+'.jpg'), buf); o.stored++; }
    else { o.skipped++; }
  });
  for(const id in s53Out) DIAG.push({ id, s53stored: s53Out[id].stored, s53skipped: s53Out[id].skipped });

  // Peel any grey frames off the TOP of each cam so the "latest" pointer is always a clean frame. This
  // also cleans historical grey frames stored before the strict check existed. Only the newest few
  // frames per cam are re-decoded each pass (cheap), and it converges within a pass or two.
  for(const c of cams){
    const dir = path.join(CAM_DIR, 'cams', c.id);
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => frameEpoch(f) != null).sort((a,b)=>frameEpoch(a)-frameEpoch(b)); } catch(e){}
    let peeled = 0;
    for(let k=0; k<6 && files.length; k++){
      const top = files[files.length-1];
      let buf; try{ buf = fs.readFileSync(path.join(dir, top)); }catch(e){ break; }
      if((await greyFrame(buf)) === true){ try{ fs.unlinkSync(path.join(dir, top)); }catch(e){} files.pop(); peeled++; }
      else break;
    }
    if(peeled) console.log('cam', c.id, 'peeled', peeled, 'grey frame(s) off top');
  }

  // Build latest-frame pointers for every cam from what's now on disk.
  const latest = cams.map((c) => {
    const dir = path.join(CAM_DIR, 'cams', c.id);
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => frameEpoch(f) != null).sort((a,b)=>frameEpoch(a)-frameEpoch(b)); } catch(e){}
    const newest = files.length ? files[files.length-1] : null;
    return { id:c.id, name:c.name, area:c.area, place:c.place||null,
      latest: newest ? ('cams/'+c.id+'/'+newest) : null,
      t: newest ? frameEpoch(newest) : null,
      count: files.length };
  });

  // Remove folders for cams no longer in cams.json (keeps the branch clean when the set changes).
  const keep = new Set(cams.map(c=>c.id));
  try { fs.readdirSync(path.join(CAM_DIR, 'cams'), { withFileTypes:true })
    .filter(d => d.isDirectory() && !keep.has(d.name))
    .forEach(d => { try { fs.rmSync(path.join(CAM_DIR,'cams',d.name), { recursive:true, force:true }); console.log('removed retired cam dir', d.name); } catch(e){} }); } catch(e){}

  // Manifest (full 24h frame list) → camstore.
  const manifest = { generated: new Date(now).toISOString(), retentionH: RETENTION_H, base: RAW_BASE,
    cams: cams.map(c => {
      const dir = path.join(CAM_DIR, 'cams', c.id);
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => frameEpoch(f) != null).sort((a,b)=>frameEpoch(a)-frameEpoch(b)); } catch(e){}
      return { id:c.id, name:c.name, area:c.area, place:c.place||null, frames: files.map(f => ({ t: frameEpoch(f), f: 'cams/'+c.id+'/'+f })) };
    }) };
  fs.mkdirSync(path.join(CAM_DIR, 'cams'), { recursive: true });
  fs.writeFileSync(path.join(CAM_DIR, 'cams', 'manifest.json'), JSON.stringify(manifest));

  // Latest pointers → main (served fresh from Pages).
  fs.writeFileSync(LATEST_OUT, JSON.stringify({ generated: new Date(now).toISOString(), base: RAW_BASE, cams: latest }));
  if(process.env.DIAG_OUT){ fs.writeFileSync(process.env.DIAG_OUT, JSON.stringify({ generated: new Date(now).toISOString(), mods: MODS, probes: DIAG })); }

  const got = latest.filter(x=>x.t && (now - x.t) < 120000).length;
  console.log('cam capture: '+got+'/'+cams.length+' fresh this pass; frames/cam:', latest.map(x=>x.id+'='+x.count).join(' '));
})();
