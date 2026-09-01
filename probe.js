// Probe s53mv.s5tech.net reachability from the runner + its directory-listing archive.
const enc = encodeURIComponent;
const LOCS = ['Stol','Kanin','Bovec'];
const H = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' };
const fs = require('fs');

async function get(url, asBuf){
  const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: H });
    if(asBuf){ const b = Buffer.from(await r.arrayBuffer()); return { status:r.status, bytes:b.length, jpeg:b.length>1024&&b[0]===0xFF&&b[1]===0xD8 }; }
    const txt = await r.text(); return { status:r.status, len:txt.length, txt };
  } catch(e){ return { error: (e.cause&&(e.cause.code||e.cause.message))||e.message }; } finally { clearTimeout(t); }
}

(async () => {
  const out = [];
  for(const loc of LOCS){
    const listUrl = 'http://s53mv.s5tech.net/ipcam/'+loc+'/';
    const L = await get(listUrl, false);
    if(L.error || !L.txt){ out.push({ loc, list: L }); continue; }
    const frames = [...new Set((L.txt.match(/[0-9.]+_01_\d{17}_TIMING\.jpg/g))||[])].sort();
    const newest = frames[frames.length-1];
    let frame = null;
    if(newest) frame = await get('http://s53mv.s5tech.net/ipcam/'+loc+'/'+newest, true);
    // parse span
    const ts = f => { const m=f.match(/_(\d{14})\d{3}_/); return m?m[1]:null; };
    out.push({ loc, listStatus:L.status, frameCount:frames.length, oldest:ts(frames[0]||''), newest:ts(newest||''), newestFrame:frame });
  }
  // also test relaying the listing HTML via wsrv (in case direct is blocked) — wsrv is image-only, expect fail/HTML-as-image
  fs.writeFileSync('probe-out.json', JSON.stringify({ generated:new Date().toISOString(), results: out }, null, 1));
  console.log(JSON.stringify(out,null,1));
})();
