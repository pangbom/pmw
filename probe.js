// Reachability probe from the GitHub runner. Tests relaying the DARS road cams (which block
// the runner directly) through the free wsrv.nl image proxy, plus candidate dropzone cams.
const fs = require('fs');
const enc = encodeURIComponent;
const DARS_PREDEL = 'https://kamere.dars.si/kamere/drsi_vgrc/Predel_Pre1_0001.jpg';
const DARS_UCJA   = 'https://kamere.dars.si/kamere/drsi_vgrc/Ucja_Ucj1_0001.jpg';

const URLS = [
  ['dars_predel_direct', DARS_PREDEL],
  ['dars_predel_wsrv',   'https://wsrv.nl/?url=' + enc(DARS_PREDEL) + '&output=jpg'],
  ['dars_ucja_wsrv',     'https://wsrv.nl/?url=' + enc(DARS_UCJA) + '&output=jpg'],
  ['dars_predel_weserv', 'https://images.weserv.nl/?url=' + enc(DARS_PREDEL) + '&output=jpg'],
  ['arso_bovec_nw',      'https://meteo.arso.gov.si/uploads/probase/www/observ/webcam/BOVEC_dir/siwc_BOVEC_nw_pda.jpg'],
];
const H = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', 'Accept': 'image/*,*/*' };

async function one(url){
  const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: H });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, bytes: buf.length, jpeg: buf.length>1024 && buf[0]===0xFF && buf[1]===0xD8, ct: r.headers.get('content-type') };
  } finally { clearTimeout(t); }
}

(async () => {
  const out = [];
  for(const [id,url] of URLS){
    let rec;
    try { rec = await one(url); }
    catch(e){ rec = { error: (e.cause && (e.cause.code||e.cause.message)) || e.message }; }
    out.push({ id, ...rec });
    console.log(id, JSON.stringify(rec));
  }
  fs.writeFileSync('probe-out.json', JSON.stringify({ generated:new Date().toISOString(), results: out }, null, 1));
})();
