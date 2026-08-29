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
const SNAP = id => `https://cdn.whatsupcams.com/snapshot/${id}.jpg`;

const cams = JSON.parse(fs.readFileSync('cams.json', 'utf8'));

function sha1(buf){ return crypto.createHash('sha1').update(buf).digest('hex'); }
function frameEpoch(fname){ const m = fname.match(/^(\d+)\.jpg$/); return m ? +m[1] : null; }

const DIAG = [];
async function grab(id){
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), 15000);
  try {
    const r = await fetch(SNAP(id), { signal: ctrl.signal, headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      'Referer': 'https://services.whatsupcams.com/',
      'Origin': 'https://services.whatsupcams.com',
      'Accept': 'image/avif,image/webp,image/*,*/*'
    } });
    const buf = Buffer.from(await r.arrayBuffer());
    const jpeg = buf.length > 1024 && buf[0] === 0xFF && buf[1] === 0xD8;
    DIAG.push({ id, status: r.status, bytes: buf.length, jpeg });
    if(!r.ok){ console.error('cam', id, 'HTTP', r.status); return null; }
    if(!jpeg){ console.error('cam', id, 'not a JPEG (', buf.length, 'bytes)'); return null; }
    return buf;
  } catch(e){ DIAG.push({ id, error: e.message }); console.error('cam', id, 'failed:', e.message); return null; }
  finally { clearTimeout(timer); }
}

(async () => {
  const now = Date.now();
  const latest = [];
  for(const c of cams){
    const dir = path.join(CAM_DIR, 'cams', c.id);
    fs.mkdirSync(dir, { recursive: true });

    // Existing frames, sorted oldest→newest; prune >retention.
    let files = fs.readdirSync(dir).filter(f => frameEpoch(f) != null).sort((a,b)=>frameEpoch(a)-frameEpoch(b));
    for(const f of files){ if(now - frameEpoch(f) > RETENTION_MS){ try{ fs.unlinkSync(path.join(dir,f)); }catch(e){} } }
    files = fs.readdirSync(dir).filter(f => frameEpoch(f) != null).sort((a,b)=>frameEpoch(a)-frameEpoch(b));

    const buf = await grab(c.id);
    if(buf){
      // Dedup: skip if identical to the newest existing frame.
      let dup = false;
      if(files.length){
        try { const prev = fs.readFileSync(path.join(dir, files[files.length-1])); dup = (prev.length===buf.length && sha1(prev)===sha1(buf)); } catch(e){}
      }
      if(!dup){ fs.writeFileSync(path.join(dir, now + '.jpg'), buf); files.push(now + '.jpg'); }
      else { console.log('cam', c.id, 'unchanged — skipped'); }
    }

    const newest = files.length ? files[files.length-1] : null;
    latest.push({ id:c.id, name:c.name, area:c.area,
      latest: newest ? ('cams/'+c.id+'/'+newest) : null,
      t: newest ? frameEpoch(newest) : null,
      count: files.length });
  }

  // Manifest (full 24h frame list) → camstore.
  const manifest = { generated: new Date(now).toISOString(), retentionH: RETENTION_H, base: RAW_BASE,
    cams: cams.map(c => {
      const dir = path.join(CAM_DIR, 'cams', c.id);
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => frameEpoch(f) != null).sort((a,b)=>frameEpoch(a)-frameEpoch(b)); } catch(e){}
      return { id:c.id, name:c.name, area:c.area, frames: files.map(f => ({ t: frameEpoch(f), f: 'cams/'+c.id+'/'+f })) };
    }) };
  fs.mkdirSync(path.join(CAM_DIR, 'cams'), { recursive: true });
  fs.writeFileSync(path.join(CAM_DIR, 'cams', 'manifest.json'), JSON.stringify(manifest));

  // Latest pointers → main (served fresh from Pages).
  fs.writeFileSync(LATEST_OUT, JSON.stringify({ generated: new Date(now).toISOString(), base: RAW_BASE, cams: latest }));
  if(process.env.DIAG_OUT){ fs.writeFileSync(process.env.DIAG_OUT, JSON.stringify({ generated: new Date(now).toISOString(), probes: DIAG })); }

  const got = latest.filter(x=>x.t && (now - x.t) < 120000).length;
  console.log('cam capture: '+got+'/'+cams.length+' fresh this pass; frames/cam:', latest.map(x=>x.id+'='+x.count).join(' '));
})();
