// Find the real image folder for each s53mv loc (4h.php reveals it), + tz sanity for Stol.
const fs=require('fs');
const LOCS=['StolN','Kuk','Kobarid','Crnaprst','Stol','Kanin','Bovec'];
const H={'User-Agent':'Mozilla/5.0 PMW'};
async function txt(url){ const c=new AbortController(); const t=setTimeout(()=>c.abort(),15000);
  try{ const r=await fetch(url,{signal:c.signal,headers:H}); return await r.text(); }catch(e){ return 'ERR:'+e.message; } finally{ clearTimeout(t); } }
function s53Epoch(fn){ const m=fn.match(/_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})_/); if(!m)return null;
  const Y=+m[1],Mo=+m[2],D=+m[3],H2=+m[4],Mi=+m[5],S=+m[6],ms=+m[7]; const off=(Mo>=4&&Mo<=10)?2:1;
  return Date.UTC(Y,Mo-1,D,H2,Mi,S,ms)-off*3600*1000; }
(async()=>{
  const out=[];
  for(const loc of LOCS){
    const html=await txt('http://s53mv.s5tech.net/ipcam/4h.php?loc='+loc);
    const m=html.match(/ipcam\/([^\/"']+)\/([0-9.]+_01_\d{17}_TIMING\.jpg)/);
    const folder=m?m[1]:null, sample=m?m[2]:null;
    const ep=sample?s53Epoch(sample):null;
    out.push({loc, folder, sample, newestISO: ep?new Date(ep).toISOString():null, ageMin: ep?Math.round((Date.now()-ep)/60000):null});
  }
  fs.writeFileSync('probe-out.json', JSON.stringify({generated:new Date().toISOString(), nowISO:new Date().toISOString(), results:out},null,1));
  console.log(JSON.stringify(out,null,1));
})();
