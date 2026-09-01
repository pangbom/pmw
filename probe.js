// Probe the Bovec valley WeeWX station: runner reachability + raw-HTML wind parse.
const fs=require('fs');
const URL='https://freeweb.t-2.net/vreme/bovec/index.html';
(async()=>{
  const out={url:URL};
  try{
    const c=new AbortController(); const t=setTimeout(()=>c.abort(),20000);
    const r=await fetch(URL,{signal:c.signal,headers:{'User-Agent':'Mozilla/5.0 PMW'}});
    clearTimeout(t);
    const html=await r.text();
    out.status=r.status; out.len=html.length;
    const windM = html.match(/Hitrost vetra:\s*([\d.,]+)\s*m\/s\s*([A-Za-zČŠŽčšž\-]*)/);
    const gustM = html.match(/Sunki vetra:\s*([\d.,]+)\s*m\/s/);
    const tempM = html.match(/([\d.,]+)\s*°C/);
    const timeM = html.match(/(\d{2})\.\s*(\d{2})\.\s*(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
    // km/h variant fallback
    const windKmh = html.match(/Hitrost vetra:\s*([\d.,]+)\s*km\/h\s*([A-Za-zČŠŽčšž\-]*)/);
    out.wind_ms = windM ? {v:windM[1],dir:windM[2]} : null;
    out.gust_ms = gustM ? gustM[1] : null;
    out.wind_kmh = windKmh ? {v:windKmh[1],dir:windKmh[2]} : null;
    out.temp = tempM ? tempM[1] : null;
    out.time = timeM ? timeM[0] : null;
    // also capture any "m/s" contexts to see direction format when windy
    out.msSamples = (html.match(/[\d.,]+\s*m\/s[^<]{0,12}/g)||[]).slice(0,6);
  }catch(e){ out.error=(e.cause&&(e.cause.code||e.cause.message))||e.message; }
  fs.writeFileSync('probe-out.json', JSON.stringify(out,null,1));
  console.log(JSON.stringify(out,null,1));
})();
