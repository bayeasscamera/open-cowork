const WebSocket = require('ws');
const http = require('http');
function getTargets(port){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port,path:'/json/list'},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}
function evaluate(port,expression,timeoutMs=120000){return new Promise(async(resolve,reject)=>{const t=await getTargets(port);const page=t.find(x=>x.type==='page');if(!page)return reject(new Error('no page'));const ws=new WebSocket(page.webSocketDebuggerUrl,{maxPayload:256*1024*1024});const timer=setTimeout(()=>{try{ws.close();}catch{}reject(new Error('timeout'));},timeoutMs);ws.on('open',()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}})));ws.on('message',m=>{const o=JSON.parse(m);if(o.id===1){clearTimeout(timer);ws.close();if(o.result?.exceptionDetails)return reject(new Error((o.result.exceptionDetails.exception?.description||o.result.exceptionDetails.text||'').slice(0,200)));resolve(o.result?.result?.value??null);}});ws.on('error',e=>{clearTimeout(timer);reject(e);});});}
const MINE=['stop-slop','writing-principles','llm-writing','creative-writing-craft','creative-writing-modes','creative-writing-muse','story-review'];
(async()=>{
  // The manager needs time; retry until it answers.
  let last;
  for (let attempt=1; attempt<=12; attempt++) {
    const expr = `(async()=>{ try { const all = await window.electronAPI.skills.getAll();
      const list = Array.isArray(all) ? all : (all && all.skills) || [];
      return JSON.stringify({ ok:true, total:list.length,
        writing: list.filter(s=>${JSON.stringify(MINE)}.includes(s.name)).map(s=>({name:s.name,len:(s.description||'').length})) });
    } catch(e) { return JSON.stringify({ ok:false, err:String(e.message).slice(0,80) }); } })()`;
    const raw = await evaluate(9223, expr, 30000).catch(e => ({error:e.message}));
    last = raw;
    if (raw && raw.includes('"ok":true')) { console.log(raw); return; }
    await new Promise(r=>setTimeout(r,5000));
  }
  console.log('ÉCHEC:', last);
})();
