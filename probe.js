// One-shot reachability probe from the GitHub runner. Tests candidate cam URLs,
// reports status/bytes, and retries failures with relaxed TLS (to tell an IP block
// from a cert-chain issue). Writes probe-out.json.
const fs = require('fs');
const https = require('https');
const insecure = new https.Agent({ rejectUnauthorized: false });

const URLS = [
  ['arso_bovec_nw',    'https://meteo.arso.gov.si/uploads/probase/www/observ/webcam/BOVEC_dir/siwc_BOVEC_nw_pda.jpg'],
  ['arso_bovec_ne',    'https://meteo.arso.gov.si/uploads/probase/www/observ/webcam/BOVEC_dir/siwc_BOVEC_ne_pda.jpg'],
  ['arso_bovec_nw_lg', 'https://meteo.arso.gov.si/uploads/probase/www/observ/webcam/BOVEC_dir/siwc_BOVEC_nw_latest.jpg'],
  ['arso_kredarica_e', 'https://meteo.arso.gov.si/uploads/probase/www/observ/webcam/KREDA-ICA_dir/siwc_KREDA-ICA_e_pda.jpg'],
  ['arso_kredarica_se','https://meteo.arso.gov.si/uploads/probase/www/observ/webcam/KREDA-ICA_dir/siwc_KREDA-ICA_se_pda.jpg'],
  ['dars_predel',      'https://kamere.dars.si/kamere/drsi_vgrc/Predel_Pre1_0001.jpg'],
  ['dars_ucja',        'https://kamere.dars.si/kamere/drsi_vgrc/Ucja_Ucj1_0001.jpg'],
  ['wu_logmangart',    'https://cdn.whatsupcams.com/snapshot/si_logmangart01.jpg'],
];
const H = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', 'Accept': 'image/*,*/*' };

async function one(url, agent){
  const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), 15000);
  try {
    const opt = { signal: ctrl.signal, headers: H };
    if(agent) opt.dispatcher = undefined; // node fetch uses undici; fall back to https.get for insecure
    const r = await fetch(url, opt);
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, bytes: buf.length, jpeg: buf.length>1024 && buf[0]===0xFF && buf[1]===0xD8 };
  } finally { clearTimeout(t); }
}
// insecure fetch via raw https (undici can't easily take a custom CA agent in this node)
function oneInsecure(url){
  return new Promise((res)=>{
    const req = https.get(url, { agent: insecure, headers: H, timeout: 15000 }, r=>{
      const chunks=[]; r.on('data',c=>chunks.push(c)); r.on('end',()=>{ const buf=Buffer.concat(chunks); res({ status:r.statusCode, bytes:buf.length, jpeg:buf.length>1024&&buf[0]===0xFF&&buf[1]===0xD8, insecure:true }); });
    });
    req.on('error', e=> res({ error: e.code||e.message, insecure:true }));
    req.on('timeout', ()=>{ req.destroy(); res({ error:'timeout', insecure:true }); });
  });
}

(async () => {
  const out = [];
  for(const [id,url] of URLS){
    let rec;
    try { rec = await one(url); }
    catch(e){ rec = { error: (e.cause && (e.cause.code||e.cause.message)) || e.message }; }
    if(rec.error){ const ins = await oneInsecure(url); rec.retryInsecure = ins; }
    out.push({ id, ...rec });
    console.log(id, JSON.stringify(rec));
  }
  fs.writeFileSync('probe-out.json', JSON.stringify({ generated:new Date().toISOString(), results: out }, null, 1));
})();
