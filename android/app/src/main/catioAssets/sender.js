/* Catio offline sender. Uses the unmodified, pinned libcimbar WASM engine. */
'use strict';
var Wormhole = (() => {
  const zh = (new URL(location.href).searchParams.get('lang') || navigator.language).toLowerCase().startsWith('zh');
  const copy = zh ? {
    eyebrow:'WORMHOLE · 虫洞', title:'从这里，传向另一端', subtitle:'选择一个文件，让另一台设备扫描接收。', ready:'准备发送', readyHint:'文件会变成一束可被读取的光。无需配对，无需网络。', noFile:'尚未选择文件', loading:'正在准备离线编码器…', readyStatus:'所有设置已准备就绪', choose:'选择文件', change:'更换文件', warning:'动态画面会快速闪烁，对闪光敏感者请勿直视。', encoding:'正在准备文件…', playing:'正在播放 · 接收进度请查看另一台设备', failed:'无法编码，请重新选择文件或重新进入此页。', large:'文件超过 128 MiB，请选择较小的文件。'
  } : {
    eyebrow:'WORMHOLE', title:'A file. A beam. Delivered.', subtitle:'Choose a file, then scan with another device.', ready:'Ready to send', readyHint:'Turn your file into light. No pairing or network needed.', noFile:'No file selected', loading:'Preparing offline encoder…', readyStatus:'Everything is ready', choose:'Choose a file', change:'Choose another file', warning:'Rapidly flashing images. Do not watch if you are sensitive to flashing light.', encoding:'Preparing your file…', playing:'Playing · Check reception on the other device', failed:'Encoding failed. Choose the file again or reopen this page.', large:'This file exceeds 128 MiB. Choose a smaller file.'
  };
  document.documentElement.lang=zh?'zh-CN':'en';
  document.querySelectorAll('[data-copy]').forEach(el=>el.textContent=copy[el.dataset.copy]);
  let ready=false, busy=false, loaded=false, raf=0, due=0;
  const status=document.getElementById('status'), choose=document.getElementById('choose');
  function pause(){ cancelAnimationFrame(raf); raf=0; }
  function fail(message){ pause(); busy=false; loaded=false; document.body.classList.remove('playing'); document.getElementById('active-dot').hidden=true; status.textContent=message||copy.failed; choose.disabled=!ready; }
  function render(time){
    try { if(time+.5>=due){ if(Module._cimbare_next_frame(0)<0 || Module._cimbare_render()<0) throw Error(); due=Math.max(due+1000/30,time); } raf=requestAnimationFrame(render); }
    catch(_){ fail(); }
  }
  function resume(){ if(loaded && !raf && !document.hidden){ due=0; raf=requestAnimationFrame(render); } }
  async function importFile(file){
    if(!ready || busy || !file) return;
    if(file.size>128*1024*1024){ status.textContent=copy.large; return; }
    pause(); busy=true; loaded=false; choose.disabled=true; document.body.classList.remove('playing');
    document.getElementById('active-dot').hidden=true; document.getElementById('filename').textContent=file.name; status.textContent=copy.encoding;
    let ptr=0;
    try {
      const name=new TextEncoder().encode(file.name);
      if(name.length>1024) throw Error();
      ptr=Module._malloc(name.length||1); if(!ptr)throw Error(); Module.HEAPU8.set(name,ptr);
      if(Module._cimbare_init_encode(ptr,name.length,-1)<0)throw Error(); Module._free(ptr); ptr=0;
      const size=Module._cimbare_encode_bufsize()*16; ptr=Module._malloc(size); if(!ptr)throw Error();
      let result=1;
      for(let offset=0;offset<file.size;offset+=size){ const bytes=new Uint8Array(await file.slice(offset,offset+size).arrayBuffer()); Module.HEAPU8.set(bytes,ptr); result=Module._cimbare_encode(ptr,bytes.length); bytes.fill(0); if(result<0)throw Error(); }
      if(result>0 && Module._cimbare_encode(ptr,0)!==0)throw Error();
      loaded=true; document.body.classList.add('playing'); document.getElementById('active-dot').hidden=false;
      status.textContent=copy.playing; choose.textContent=copy.change; resume();
    } catch(_){ fail(); } finally { if(ptr)Module._free(ptr); busy=false; choose.disabled=false; }
  }
  choose.onclick=()=>document.getElementById('file').click();
  document.getElementById('file').onchange=e=>{void importFile(e.target.files[0]);e.target.value='';};
  document.addEventListener('visibilitychange',()=>document.hidden?pause():resume());
  document.getElementById('canvas').addEventListener('webglcontextlost',e=>{e.preventDefault();ready=false;fail();});
  return { importFile, pause, resume, fail, ready:()=>ready, initialize(){
    try { if(Module._cimbare_init_window(0,0)<0 || Module._cimbare_configure(68,-1)<0)throw Error(); ready=true; choose.disabled=false; status.textContent=copy.readyStatus; } catch(_){fail();}
  }};
})();
var Module={canvas:document.getElementById('canvas'),print:()=>{},printErr:()=>{},onAbort:()=>Wormhole.fail(),onRuntimeInitialized:()=>Wormhole.initialize()};
