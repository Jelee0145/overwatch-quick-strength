function exportNote(missing){return missing.length?' · 缺少素材：'+missing.join('、'):'';}
function exportBusy(value){['png','svg'].forEach(id=>$(id).disabled=value);}
async function svgBlob(){return QS_ASSETS.exportSvg($('chart').querySelector('svg'));}
$('svg').onclick=async()=>{exportBusy(true);try{const out=await svgBlob();download(out.blob,fileName('svg'));status('已导出 SVG'+exportNote(out.missing),!!out.missing.length);}catch(e){status('导出失败：'+e.message,true);}finally{exportBusy(false);}};
$('png').onclick=async()=>{
 const source=$('chart').querySelector('svg'),width=Number(source.getAttribute('width'))*2,height=Number(source.getAttribute('height'))*2;
 exportBusy(true);status(`正在导出 ${width} × ${height} 高清 PNG…`);let url;
 try{const out=await svgBlob(),image=new Image();url=URL.createObjectURL(out.blob);await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('SVG 图片解码失败'));image.src=url;});const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d').drawImage(image,0,0,width,height);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('图片生成失败');download(blob,fileName('png'));status('已导出高清 PNG'+exportNote(out.missing),!!out.missing.length);}catch(e){status('导出失败：'+e.message,true);}finally{if(url)URL.revokeObjectURL(url);exportBusy(false);}
};
